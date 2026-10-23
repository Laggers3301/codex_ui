import { describe, expect, it, vi } from "vitest";
import { SideChatController, sideChatKey } from "./sideChats";
import type { SideChat, ThreadSummary } from "./types";

function row(parent: string, id = parent + "-side"): SideChat {
  return { id, parentThreadId: parent, userId: "admin", projectId: "project", threadId: parent + "-child", selectedText: parent + " quote", draft: parent + " draft", modelProfileId: "sol", requestId: "r-" + parent, lastPrompt: parent + " question", turnId: "turn-" + parent, status: "complete", error: null, revision: 1, createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z" };
}

function fixture(records: SideChat[]) {
  const data = new Map(records.map(side => [side.parentThreadId, side]));
  const api = {
    read: vi.fn(async (_project: string, parent: string) => ({ data: data.get(parent) ?? null })),
    create: vi.fn(async (_project: string, parent: string, text: string, model: string) => {
      const side = { ...row(parent), threadId: null, requestId: null, turnId: null, lastPrompt: "", status: "ready" as const, selectedText: text, draft: "", modelProfileId: model };
      data.set(parent, side); return { data: side };
    }),
    save: vi.fn(async (side: SideChat, draft: string, model: string) => {
      const updated = { ...side, draft, modelProfileId: model, revision: side.revision + 1 }; data.set(side.parentThreadId, updated); return { data: updated };
    }),
    remove: vi.fn(async (side: SideChat) => { data.delete(side.parentThreadId); return { data: null }; }),
    readThread: vi.fn(async (id: string) => ({ id, cwd: "/test", turns: [] }) as unknown as ThreadSummary)
  };
  const errors = vi.fn(), controller = new SideChatController(api, errors);
  return { data, api, errors, controller };
}

describe("main-thread side chat restoration", () => {
  it("restores independent side chats and drafts in a new page without creating native requests", async () => {
    const f = fixture([row("a"), row("b")]);
    await f.controller.load("admin", "project", "a");
    await f.controller.load("admin", "project", "b");
    expect(f.controller.get("admin", "a")?.draft).toBe("a draft");
    expect(f.controller.get("admin", "b")?.ask.selectedText).toBe("b quote");
    expect(f.controller.get("admin", "missing")).toBeNull();
    expect(f.controller.get("someone-else", "a")).toBeNull();
    expect(f.api.create).not.toHaveBeenCalled();
    const another = new SideChatController(f.api, f.errors);
    await another.load("admin", "project", "a");
    expect(another.get("admin", "a")?.ask.threadId).toBe("a-child");
  });

  it("stores a late response under its own parent after the selection changes", async () => {
    const f = fixture([row("b")]);
    let resolve!: (result: { data: SideChat }) => void;
    f.api.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.controller.activeKey = sideChatKey("admin", "a");
    const first = f.controller.load("admin", "project", "a");
    f.controller.activeKey = sideChatKey("admin", "b");
    await f.controller.load("admin", "project", "b");
    resolve({ data: row("a") }); await first;
    expect(f.controller.get("admin", "b")?.ask.id).toBe("b-side");
    expect(f.controller.get("admin", "a")?.ask.id).toBe("a-side");
    expect(f.controller.activeKey).toBe(sideChatKey("admin", "b"));
  });

  it("does not resurrect a deleted generation from a late save or close response", async () => {
    const f = fixture([row("a")]); await f.controller.load("admin", "project", "a");
    let resolve!: (result: { data: SideChat }) => void;
    f.api.save.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.controller.setDraft("admin", "a", "edited draft");
    const saving = f.controller.flush(sideChatKey("admin", "a"));
    await Promise.resolve();
    f.controller.receive({ ...row("a"), sideChat: null });
    resolve({ data: { ...row("a"), draft: "edited draft", revision: 2 } }); await saving;
    expect(f.controller.get("admin", "a")).toBeNull();
    f.controller.receive({ ...row("a", "new-generation"), sideChat: row("a", "new-generation") });
    f.controller.receive({ ...row("a"), sideChat: null });
    expect(f.controller.get("admin", "a")?.record.id).toBe("new-generation");
  });

  it("routes an acknowledgement to its original parent and preserves both drafts", async () => {
    const f = fixture([row("a"), row("b")]);
    await f.controller.load("admin", "project", "a"); await f.controller.load("admin", "project", "b");
    const ask = f.controller.begin("admin", "a", "pending-a", "question a")!;
    f.controller.activeKey = sideChatKey("admin", "b");
    f.controller.updateAsk({ ...ask, status: "running", turnId: "new-a" });
    expect(f.controller.forRequest("pending-a")?.ask.parentThreadId).toBe("a");
    expect(f.controller.get("admin", "b")?.draft).toBe("b draft");
    expect(f.controller.get("admin", "a")?.draft).toBe("");
  });
});
