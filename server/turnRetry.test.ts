import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./db.js";
import { TurnRetryQueue, type TurnRecoveryState } from "./turnRetry.js";
import { AppError } from "./appErrors.js";

const fixtures: Array<{ store: ProjectStore; queue: TurnRetryQueue; root: string }> = [];
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(({ store, queue, root }) => { queue.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }); });
const overloaded = { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "server_overloaded" };
function fixture(maxAttempts = 10) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-retry-")), store = new ProjectStore(path.join(root, "db.sqlite"));
  const project = store.createProject({ name: "test", rootPath: root });
  store.registerThreadOwner({ threadId: "thread", userId: "admin", projectId: project.id, rootPath: root });
  const start = vi.fn(async (_state: TurnRecoveryState) => "retry-turn"), changed = vi.fn(), busy = vi.fn(() => false);
  const queue = new TurnRetryQueue(store, { start, changed, busy, maxAttempts, tickMs: 1_000_000 });
  fixtures.push({ root, store, queue });
  queue.watch("admin", "thread", { model: "gpt-6.1-sol", effort: "max", collaborationMode: { mode: "plan" }, input: [{ type: "text", text: "private prompt" }] });
  return { root, store, queue, start, changed, busy };
}

describe("persistent overload retries", () => {
  it("waits exactly 60 seconds, preserves the original model/mode, and isolates private state", async () => {
    const { queue, start } = fixture(); const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    queue.failed("admin", "thread", "failed-turn", overloaded, true);
    expect(queue.snapshot("admin")[0].job?.nextRetryAt).toBe(160_000);
    expect(queue.snapshot("other")).toEqual([]);
    expect(JSON.stringify(queue.snapshot("admin"))).not.toContain("private prompt");
    clock.mockReturnValue(159_999); await queue.drain(); expect(start).not.toHaveBeenCalled();
    clock.mockReturnValue(160_000); await queue.drain();
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][0].template).toMatchObject({ model: "gpt-6.1-sol", effort: "max", collaborationMode: { mode: "plan" } });
    queue.completed("thread", "retry-turn"); expect(queue.snapshot("admin")).toEqual([]);
  });
  it("persists a waiting retry across restart, but never blindly replays an in-flight retry", async () => {
    const { store, queue, start } = fixture(); queue.failed("admin", "thread", "failed", overloaded, true); queue.close();
    const restarted = new TurnRetryQueue(store, { start, busy: () => false, changed: () => {}, tickMs: 1_000_000 });
    try {
      expect(restarted.snapshot("admin")[0].job?.status).toBe("waiting");
      restarted.retryNow("admin", "thread"); await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(store.getTurnRecoveryState("thread")?.job?.activeTurnId).toBe("retry-turn"));
    } finally { restarted.close(); }
    const again = new TurnRetryQueue(store, { start, busy: () => false, changed: () => {}, tickMs: 1_000_000 });
    try { await again.drain(); expect(start).toHaveBeenCalledOnce(); expect(again.snapshot("admin")[0].job).toBeNull(); } finally { again.close(); }
  });
  it("does not race a newer turn, retry approvals/auth/quota errors, or exceed the attempt limit", async () => {
    const { queue, start, busy } = fixture(2); const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    for (const error of [{ message: "401 unauthorized" }, { message: "quota exceeded" }, new AppError("memory_pressure", "memory_pressure")]) {
      queue.failed("admin", "thread", "failed", error, true); expect(queue.snapshot("admin")[0].job).toBeNull();
    }
    queue.failed("admin", "thread", "failed", overloaded, true); clock.mockReturnValue(60_000); busy.mockReturnValue(true);
    await queue.drain(); expect(start).not.toHaveBeenCalled(); busy.mockReturnValue(false); await queue.drain();
    queue.failed("admin", "thread", "retry-turn", overloaded, true); clock.mockReturnValue(120_000); await queue.drain();
    queue.failed("admin", "thread", "retry-turn", overloaded, true); clock.mockReturnValue(240_000); await queue.drain();
    expect(start).toHaveBeenCalledTimes(2); expect(queue.snapshot("admin")[0].job?.status).toBe("exhausted");
  });
  it("honors cancellation even while starting or after another overload, and supersedes retries on a new prompt", async () => {
    const { queue, start, store } = fixture(); const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    let release!: (value: string) => void; start.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    queue.failed("admin", "thread", "failed", overloaded, true); clock.mockReturnValue(60_000);
    const pending = queue.drain(); await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    queue.cancel("admin", "thread"); release("old-retry"); await pending;
    queue.failed("admin", "thread", "old-retry", overloaded, true); expect(store.getTurnRecoveryState("thread")?.job).toBeNull();
    queue.watch("admin", "thread", { model: "gpt-6.1-sol" }); queue.failed("admin", "thread", "new", overloaded, true);
    queue.started("thread", "new-user-turn"); clock.mockReturnValue(240_000); await queue.drain(); expect(start).toHaveBeenCalledOnce();
  });
  it("preserves an unfinished turn across backend restart without replaying tools or guessing the crash cause", async () => {
    const {store,queue,start}=fixture();
    queue.started('thread','unfinished');queue.toolProgress('thread','unfinished','write-file',false);queue.close();
    const restarted=new TurnRetryQueue(store,{start,busy:()=>false,changed:()=>{},tickMs:1_000_000});
    try {
      const state=restarted.snapshot('admin')[0];
      expect(state.error).toMatchObject({code:'backend_restarted',source:'backend',retryable:false});
      expect(state.interruption).toMatchObject({turnId:'unfinished',unresolvedTools:['write-file']});
      expect(JSON.stringify(state)).not.toContain('private prompt');
      expect(state.error?.originalMessage).not.toContain('out of memory');
      await restarted.drain();expect(start).not.toHaveBeenCalled();
      const at=state.error!.at;restarted.close();
      const again=new TurnRetryQueue(store,{start,busy:()=>false,changed:()=>{},tickMs:1_000_000});
      try {expect(again.snapshot('admin')[0].error?.at).toBe(at);}finally{again.close();}
    } finally {restarted.close();}
  });
  it('distinguishes a recorded stop request, an unexplained interruption, and a runtime exit',()=>{
    const {queue}=fixture();queue.started('thread','stop');queue.requestStop('admin','thread','stop');queue.interrupted('admin','thread','stop');
    expect(queue.snapshot('admin')[0].error?.source).toBe('user');
    queue.watch('admin','thread',{});queue.started('thread','unknown');queue.interrupted('admin','thread','unknown');
    expect(queue.snapshot('admin')[0].error?.source).toBe('unknown');
    queue.watch('admin','thread',{});queue.started('thread','exit');queue.interrupted('admin','thread','exit',{code:'runtime_terminated',message:'Codex app-server exited (SIGABRT)'});
    expect(queue.snapshot('admin')[0].error).toMatchObject({source:'runtime',code:'runtime_terminated'});
  });
  it('persists explicit dismissal and clears it when a new user turn starts',()=>{
    const {queue,store}=fixture();queue.started('thread','turn');queue.interrupted('admin','thread','turn');
    queue.cancel('admin','thread',true,'turn');
    expect(queue.snapshot('admin')[0]).toMatchObject({error:null,dismissedTurnId:'turn'});
    expect(store.getTurnRecoveryState('thread')?.interruption).toBeUndefined();
    queue.watch('admin','thread',{});queue.started('thread','next');
    expect(queue.snapshot('admin')).toEqual([]);
  });
  it('does not overwrite a newer active turn with a delayed interruption from an older turn',()=>{
    const {queue,store}=fixture();queue.started('thread','newer');queue.interrupted('admin','thread','older');
    expect(store.getTurnRecoveryState('thread')?.activeTurn?.id).toBe('newer');
    expect(queue.snapshot('admin')).toEqual([]);
  });
});

it("keeps error codes and readable causes while redacting credentials", () => {
  const error = AppError.from({ code: "server_overloaded", message: "capacity Bearer abc-secret-token api_key=secret-value" }).toPublic();
  expect(error.retryable).toBe(true); expect(error.originalMessage).not.toContain("secret-token"); expect(error.originalMessage).not.toContain("secret-value");
});
