import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
it.each([[false, false, false], [true, false, false], [true, true, false], [false, false, true]])("deploys with all-idle=%s, final-check race=%s, authorized immediate=%s", async (allIdle, lateRace, immediate) => {
  vi.useFakeTimers();
  const script = fileURLToPath(new URL("../scripts/restart-account-pool.cjs", import.meta.url));
  const protectedThread = "01a0db3e-315e-7461-b9a9-8a7a9236a84e";
  const otherThread = "33badf5c-68ac-44a7-b93c-5fc14da60279";
  const turnIds: Record<string, string> = { [protectedThread]: "turn-protected", [otherThread]: "turn-other" };
  let protectedBusy = true, restarted = false, stopped = false;
  let otherBusy = true;
  const sent: Array<{ type: string; threadId: string; prompt?: string }> = [];
  const writes: string[] = [];
  const events: string[] = [];
  let failure = "";
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  class FakeSocket extends EventEmitter {
    user: string;
    constructor(_url: string, options: { headers: { cookie: string } }) {
      super();
      const payload = options.headers.cookie.split("=")[1].split(".")[0];
      this.user = JSON.parse(Buffer.from(payload, "base64url").toString()).u;
      queueMicrotask(() => this.emit("message", JSON.stringify({ type: "hello", data: { liveState: { activeTurns:
        restarted ? [] : this.user === "qa-user" ? (protectedBusy ? [{ threadId: protectedThread, turnId: turnIds[protectedThread], status: "running" }] : []) : (!otherBusy ? [] : [{ threadId: otherThread, turnId: turnIds[otherThread], status: "running" }])
      } } })));
    }
    close() {}
    terminate() {}
    send(raw: string) {
      const message = JSON.parse(raw); sent.push(message);
      queueMicrotask(() => this.emit("message", JSON.stringify({ type: "ack", requestId: message.requestId, ok: true })));
    }
  }
  class FakeDB {
    prepare(sql: string) {
      return {
        get: (threadId: string) => {
          // Before the restart no turn is stopped or interrupted. Afterwards the backend marks
          // the unfinished turn as interrupted by the deployment (see TurnRetryQueue).
          if (sql.includes("thread_recovery_state")) return restarted
            ? { state_json: JSON.stringify({ error: { code: "backend_restarted" }, interruption: { turnId: turnIds[threadId], source: "backend" } }) }
            : undefined;
          return sql.includes("SELECT user_id") ? { user_id: threadId === protectedThread ? "qa-user" : "other" } : { project_id: "fixture-project" };
        },
        all: () => [{ id: "qa-user" }, { id: "other" }]
      };
    }
    close() { complete(); }
  }
  const mockedRequire = (name: string) => {
    if (name === "node:fs") return { readFileSync: (file: string) => {
      if (file.endsWith('account-pool.json')) return '{"accounts":[]}';
      if (file.endsWith('member-passwords.json')) return '{}';
      if (file.endsWith('account-pool-state.json')) { if (lateRace) otherBusy = true; return '{}'; }
      return "fixture-session-secret";
    }, writeFileSync: (_file: string, text: string) => writes.push(text) };
    if (name === "node:path") return path;
    if (name === "node:crypto") return crypto;
    if (name === "node:net") return { connect: () => { throw new Error("Unexpected authorization connection in restart fixture"); } };
    if (name === "node:sqlite") return { DatabaseSync: FakeDB };
    if (name === "node:module") return { createRequire: () => () => FakeSocket };
    if (name === "./deployment-resume-policy.cjs") return createRequire(script)(name);
    if (name === "./preserve-auth-failures.cjs") return {
      captureAuthFailures: () => new Map(),
      persistAuthFailures: () => { expect(stopped).toBe(true); expect(restarted).toBe(false); return 0; }
    };
    if (name === "node:child_process") return { execFileSync: (command: string, args: string[]) => {
      if (!immediate) expect(protectedBusy).toBe(false);
      if (command === 'journalctl') return '';
      expect(command).toBe("systemctl");
      expect(args[0]).toBe('--user'); expect(args[2]).toBe('codex-account-pool-4576.service');
      if (args[1] === 'stop') { stopped = true; return ''; }
      expect(args[1]).toBe('start'); expect(stopped).toBe(true); restarted = true; return '';
    } };
    throw new Error(`Unexpected dependency ${name}`);
  };
  vm.runInNewContext(fs.readFileSync(script, "utf8"), {
    require: mockedRequire, __dirname: path.dirname(script), Buffer, Date,
    setTimeout, clearTimeout, process: { argv: ["node", script, "--after-thread", protectedThread, ...(allIdle ? ["--all-idle"] : []), ...(immediate ? ["--now", "--resume-current"] : [])], env: {} },
    console: { log: (line: string) => events.push(line), error: (line: string) => { if (lateRace) failure = line; else throw new Error(line); } }
  });
  await vi.advanceTimersByTimeAsync(5000);
  if (immediate) {
    await completed;
    expect(restarted).toBe(true);
    expect(sent.filter(message => message.type === 'turn.start')).toEqual([
      expect.objectContaining({ threadId: otherThread, prompt: '继续' }),
      expect.objectContaining({ threadId: protectedThread, prompt: '继续' })
    ]);
    expect(new Set(sent.filter(message => message.type === 'turn.start').map(message => (message as any).requestId)).size).toBe(2);
    expect(events.some(line => line.includes('deployment_complete'))).toBe(true);
    return;
  }
  expect(restarted).toBe(false); expect(sent).toEqual([]); expect(writes).toEqual([]);
  protectedBusy = false;
  await vi.advanceTimersByTimeAsync(5000);
  if (allIdle) {
    expect(restarted).toBe(false); expect(stopped).toBe(false); expect(writes).toEqual([]);
    // Waiting beyond the former 30-minute deadline must not abandon the job.
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(restarted).toBe(false); expect(stopped).toBe(false);
    otherBusy = false;
    await vi.advanceTimersByTimeAsync(10000);
  }
  await completed;
  if (lateRace) {
    expect(failure).toContain("new active conversation");
    expect(restarted).toBe(false); expect(stopped).toBe(false);
    expect(sent.filter(message => message.type === "turn.start")).toEqual([]);
    return;
  }
  expect(restarted).toBe(true);
  expect(sent.filter(message => message.type === 'turn.start')).toEqual(allIdle ? [] : [expect.objectContaining({ threadId: otherThread, prompt: "继续" })]);
  expect(sent.some(message => message.type === 'turn.queue.list' && message.threadId === otherThread)).toBe(!allIdle);
  expect(events.some(line => line.includes("deployment_complete"))).toBe(true);
});
