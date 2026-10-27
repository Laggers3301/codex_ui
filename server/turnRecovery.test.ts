import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectStore } from "./db.js";
import type { CodexBridge } from "./codexBridge.js";
import { RequestDeduper } from "./requestDeduper.js";
import { TurnRetryQueue } from "./turnRetry.js";
import { runTurnRecovery } from "./turnRecovery.js";

class RecoveryBridge {
  calls: Array<{ method: string; params: any }> = [];
  phase = "idle";
  historyMode = "paginated";
  latest = { id: "failed-turn", status: "interrupted" };
  pending: any[] = [];
  queued: any[] = [];
  readGate?: Promise<void>;
  failStart = false;
  getPendingServerRequests() { return this.pending; }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/read") { await this.readGate; return { thread: { status: { type: this.phase }, historyMode: this.historyMode } }; }
    if (method === "thread/queue/list") return { data: this.queued };
    if (method === "thread/turns/list") return { data: [this.latest] };
    if (method === "turn/start") {
      this.latest = { id: "continued-turn", status: "running" }; this.phase = "active";
      if (this.failStart) throw new Error("lost native acknowledgement");
      return { turn: { id: this.latest.id } };
    }
    return {};
  }
}

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(close => close()));
function fixture(unfinishedTool = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-recovery-"));
  const store = new ProjectStore(path.join(root, "store.sqlite"));
  const project = store.createProject({ name: "recovery", rootPath: root });
  store.registerThreadOwner({ threadId: "thread", userId: "admin", projectId: project.id, rootPath: root });
  const bridge = new RecoveryBridge();
  const guards = { requestDeduper: new RequestDeduper({ ttlMs: 30_000, maxEntries: 100 }), activeTurnsByThread: new Map<string,string>(), startingThreads: new Set<string>() };
  const autoStart = vi.fn(async () => "automatic");
  const queue = new TurnRetryQueue(store, { busy: () => false, start: autoStart, changed: () => {}, tickMs: 1_000_000 });
  queue.watch("admin", "thread", { model: "gpt-6.1-sol", effort: "max", collaborationMode: { mode: "default" }, input: [{ type: "text", text: "private original task" }] });
  queue.started("thread", "failed-turn");
  if (unfinishedTool) queue.toolProgress("thread", "failed-turn", "write-file", false);
  queue.interrupted("admin", "thread", "failed-turn");
  let sequence = 0;
  const beforeContinue = vi.fn(async () => {});
  const run = (action: "check" | "continue", overrides: Record<string, any> = {}) => {
    const state = store.getTurnRecoveryState("thread")!;
    return runTurnRecovery({ bridge: bridge as unknown as CodexBridge, store, retries: queue, guards, userId: "admin", threadId: "thread",
      turnId: state.interruption?.turnId ?? "failed-turn", errorAt: state.error?.at,
      requestId: `recovery-${++sequence}`, action, toolsReviewed: false, beforeContinue,
      accepted: value => { const id = (value as any).turn.id; guards.activeTurnsByThread.set("thread", id); queue.started("thread", id); }, ...overrides });
  };
  cleanup.push(() => { queue.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, project, bridge, guards, queue, run, autoStart, beforeContinue };
}

it("checks bounded metadata without sending messages, preserves the incident time and resumes with a new continuation once", async () => {
  const { store, bridge, run, autoStart } = fixture();
  const at = store.getTurnRecoveryState("thread")!.error!.at;
  await run("check");
  expect(store.getTurnRecoveryState("thread")?.interruption?.inspection?.status).toBe("ready");
  expect(store.getTurnRecoveryState("thread")?.error?.at).toBe(at);
  expect(bridge.calls.every(call => !["turn/start", "turn/interrupt", "thread/resume"].includes(call.method))).toBe(true);
  expect(bridge.calls.find(call => call.method === "thread/read")?.params.includeTurns).toBe(false);
  expect(bridge.calls.find(call => call.method === "thread/turns/list")?.params).toMatchObject({ limit: 1, itemsView: "notLoaded" });
  await run("continue", { requestId: "continue-once" });
  await run("continue", { requestId: "continue-once" });
  const starts = bridge.calls.filter(call => call.method === "turn/start");
  expect(starts).toHaveLength(1);
  expect(starts[0].params).toMatchObject({ model: "gpt-6.1-sol", effort: "max", collaborationMode: { mode: "default" } });
  expect(JSON.stringify(starts[0].params.input)).toContain("先核对上一轮");
  expect(JSON.stringify(starts[0].params.input)).not.toContain("private original task");
  expect(bridge.calls.find(call => call.method === "thread/resume")?.params.excludeTurns).toBe(true);
  expect(autoStart).not.toHaveBeenCalled();
});

it("requires an explicit result review for unfinished tools and rechecks state at continuation time", async () => {
  const { run, store, bridge } = fixture(true);
  await run("check");
  expect(store.getTurnRecoveryState("thread")?.interruption?.inspection?.status).toBe("needs_review");
  await expect(run("continue")).rejects.toMatchObject({ code: "recovery_not_ready" });
  expect(bridge.calls.some(call => call.method === "turn/start")).toBe(false);
  bridge.phase = "active";
  await expect(run("continue", { toolsReviewed: true })).rejects.toMatchObject({ code: "recovery_not_ready" });
  bridge.phase = "idle";
  await run("continue", { toolsReviewed: true });
  expect(bridge.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
});

it.each(["completed", "newer", "approval", "queue", "unknown"])("does not resume when the native result is %s", async condition => {
  const { bridge, run, store } = fixture();
  if (condition === "completed") bridge.latest.status = "completed";
  if (condition === "newer") bridge.latest.id = "newer-turn";
  if (condition === "approval") bridge.pending = [{ params: { threadId: "thread" }, method: "item/tool/requestUserInput" }];
  if (condition === "queue") bridge.queued = [{ id: "queued-user-message" }];
  if (condition === "unknown") bridge.phase = "unknown";
  await expect(run("continue", { toolsReviewed: true })).rejects.toMatchObject({ code: "recovery_not_ready" });
  expect(bridge.calls.some(call => call.method === "turn/start" || call.method === "thread/resume")).toBe(false);
  expect(store.getTurnRecoveryState("thread")?.error).not.toBeNull();
});

it("keeps legacy history intact and requires review when latest-turn metadata is unavailable", async () => {
  const { bridge, run, store } = fixture(); bridge.historyMode = "legacy";
  await run("check");
  expect(store.getTurnRecoveryState("thread")?.interruption?.inspection?.status).toBe("needs_review");
  expect(bridge.calls.some(call => call.method === "thread/turns/list")).toBe(false);
  await expect(run("continue")).rejects.toMatchObject({ code: "recovery_not_ready" });
});

it("rejects stale controls after another client starts a new turn during a check", async () => {
  const { bridge, run, queue } = fixture();
  let release!: () => void; bridge.readGate = new Promise(resolve => { release = resolve; });
  const checking = run("continue");
  await vi.waitFor(() => expect(bridge.calls.some(call => call.method === "thread/read")).toBe(true));
  queue.watch("admin", "thread", {}); queue.started("thread", "other-client-turn");
  release();
  await expect(checking).rejects.toMatchObject({ code: "recovery_changed" });
  expect(bridge.calls.some(call => call.method === "turn/start")).toBe(false);
});

it("does not repeat a continuation whose native acknowledgement was lost", async () => {
  const { bridge, run, store } = fixture(); bridge.failStart = true;
  await expect(run("continue")).rejects.toThrow("lost native acknowledgement");
  const state = store.getTurnRecoveryState("thread")!;
  expect(state.interruption?.previousTurnId).toBe("failed-turn");
  expect(state.error?.code).toBe("recovery_start_unconfirmed");
  bridge.phase = "idle"; bridge.latest.status = "completed";
  await run("check");
  expect(store.getTurnRecoveryState("thread")?.interruption?.inspection?.status).toBe("changed");
  await expect(run("continue", { toolsReviewed: true })).rejects.toMatchObject({ code: "recovery_not_ready" });
  expect(bridge.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
});

it("scopes recovery to the owner and rejects stale error timestamps", async () => {
  const { run, bridge } = fixture();
  await expect(run("continue", { userId: "other" })).rejects.toMatchObject({ code: "recovery_unavailable" });
  await expect(run("continue", { errorAt: "old-error" })).rejects.toMatchObject({ code: "recovery_changed" });
  expect(bridge.calls).toEqual([]);
});

it('preserves readable historical details and their recorded time when first adding a recovery record',async()=>{
  const {queue,run,store}=fixture();queue.cancel('admin','thread',true,'failed-turn');
  const at='2026-10-27T07:36:20.000Z';
  await run('check',{errorAt:at,historicalError:{code:'runtime_terminated',message:'app-server exited SIGABRT',originalMessage:'app-server exited SIGABRT',at}});
  expect(store.getTurnRecoveryState('thread')?.error).toMatchObject({source:'runtime',at,originalMessage:'app-server exited SIGABRT'});
  expect(store.getTurnRecoveryState('thread')?.interruption?.inspection?.status).toBe('needs_review');
});

it('uses current execution and model settings without restoring an older permissive sandbox',async()=>{
  const {store,run,bridge}=fixture();
  const state=store.getTurnRecoveryState('thread')!;state.template!.sandboxPolicy={type:'dangerFullAccess'};store.setTurnRecoveryState(state);
  store.setThreadExecutionSettings('thread','admin','read-only','never');
  store.setThreadModelConfig('thread','admin','gpt-6-astra','medium');
  await run('continue');
  const resume=bridge.calls.find(call=>call.method==='thread/resume')!.params;
  expect(resume).toMatchObject({permissions:':read-only'});
  const start=bridge.calls.find(call=>call.method==='turn/start')!.params;
  expect(start).toMatchObject({model:'gpt-6-astra',effort:'medium',approvalPolicy:'never'});
  expect(start.sandboxPolicy).toBeUndefined();
  expect(start.collaborationMode.settings).toMatchObject({model:'gpt-6-astra',reasoning_effort:'medium'});
});

it('keeps a failed recovery check readable and applies saved permissions to an already loaded actor',async()=>{
  const {store,run,bridge}=fixture();
  store.setThreadExecutionSettings('thread','admin','read-only','on-request');
  const original=bridge.request.bind(bridge);
  bridge.request=async(method,params)=>{
    if(method==='thread/loaded/list'){bridge.calls.push({method,params});return {data:['thread']} as any;}
    if(method==='thread/settings/update'){bridge.calls.push({method,params});throw new Error('permission update unavailable');}
    return original(method,params);
  };
  await expect(run('continue')).rejects.toThrow('permission update unavailable');
  expect(bridge.calls.find(call=>call.method==='thread/settings/update')?.params).toMatchObject({permissions:':read-only',approvalPolicy:'on-request'});
  expect(bridge.calls.some(call=>call.method==='turn/start')).toBe(false);
  expect(store.getTurnRecoveryState('thread')?.interruption?.inspection?.message).toContain('permission update unavailable');
});

it('does not recreate a dismissed incident when a stale tab checks it during a newer turn',async()=>{
  const {queue,guards,run,store,bridge}=fixture();
  queue.watch('admin','thread',{});queue.started('thread','newer-turn');guards.activeTurnsByThread.set('thread','newer-turn');
  await expect(run('check',{turnId:'failed-turn'})).rejects.toMatchObject({code:'recovery_busy'});
  expect(store.getTurnRecoveryState('thread')?.interruption).toBeUndefined();
  expect(store.getTurnRecoveryState('thread')?.activeTurn?.id).toBe('newer-turn');
  expect(bridge.calls).toEqual([]);
});
