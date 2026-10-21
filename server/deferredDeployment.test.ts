import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
it("waits for the protected turn, restarts outside that turn, and resumes only the other conversation", async () => {
  vi.useFakeTimers();
  const script = fileURLToPath(new URL("../scripts/restart-account-pool.cjs", import.meta.url));
  const protectedThread = "00000000-0000-4000-8000-000000000001";
  const otherThread = "00000000-0000-4000-8000-000000000002";
  let protectedBusy = true, restarted = false, stopped = false;
  const sent: Array<{ type: string; threadId: string; prompt?: string }> = [];
  const writes: string[] = [];
  const events: string[] = [];
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  class FakeSocket extends EventEmitter {
    user: string;
    constructor(_url: string, options: { headers: { cookie: string } }) {
      super();
      const payload = options.headers.cookie.split("=")[1].split(".")[0];
      this.user = JSON.parse(Buffer.from(payload, "base64url").toString()).u;
      queueMicrotask(() => this.emit("message", JSON.stringify({ type: "hello", data: { liveState: { activeTurns:
        this.user === "qa-user" ? (protectedBusy ? [{ threadId: protectedThread }] : []) : (restarted ? [] : [{ threadId: otherThread }])
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
        get: () => sql.includes("SELECT user_id") ? { user_id: "qa-user" } : { project_id: "fixture-project" },
        all: () => [{ id: "qa-user" }, { id: "other" }]
      };
    }
    close() { complete(); }
  }
  const mockedRequire = (name: string) => {
    if (name === "node:fs") return { readFileSync: (file: string) => file.endsWith('account-pool.json') ? '{"accounts":[]}' : file.endsWith('account-pool-state.json') ? '{}' : "fixture-session-secret", writeFileSync: (_file: string, text: string) => writes.push(text) };
    if (name === "node:path") return path;
    if (name === "node:crypto") return crypto;
    if (name === "node:net") return { connect: () => { throw new Error("Unexpected authorization connection in restart fixture"); } };
    if (name === "node:sqlite") return { DatabaseSync: FakeDB };
    if (name === "node:module") return { createRequire: () => () => FakeSocket };
    if (name === "./preserve-auth-failures.cjs") return {
      captureAuthFailures: () => new Map(),
      persistAuthFailures: () => { expect(stopped).toBe(true); expect(restarted).toBe(false); return 0; }
    };
    if (name === "node:child_process") return { execFileSync: (command: string, args: string[]) => {
      expect(protectedBusy).toBe(false);
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
    setTimeout, clearTimeout, process: { argv: ["node", script, "--after-thread", protectedThread], env: {} },
    console: { log: (line: string) => events.push(line), error: (line: string) => { throw new Error(line); } }
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(restarted).toBe(false); expect(sent).toEqual([]); expect(writes).toEqual([]);
  protectedBusy = false;
  await vi.advanceTimersByTimeAsync(5000);
  await completed;
  expect(restarted).toBe(true);
  expect(sent.filter(message => message.type === 'turn.start')).toEqual([expect.objectContaining({ threadId: otherThread, prompt: "继续" })]);
  expect(sent.some(message => message.type === 'turn.queue.list' && message.threadId === otherThread)).toBe(true);
  expect(events.some(line => line.includes("deployment_complete"))).toBe(true);
});
