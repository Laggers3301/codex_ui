import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "./db.js";
import { LiveStateStore } from "./liveState.js";
import { journalItem, overlayJournal } from "./timelineJournal.js";

describe("durable tool timeline", () => {
  it("keeps nested image tools across snapshot eviction, completion and database reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-journal-"));
    let store = new ProjectStore(path.join(root, "test.sqlite"));
    try {
      const live = new LiveStateStore();
      live.recordNotification({ method: "turn/started", params: { threadId: "thread", turnId: "turn" } });
      for (let n = 0; n < 60; n++) {
        const update = live.recordNotification({ method: "item/completed", params: {
          threadId: "thread", turnId: "turn", item: { id: `nested-${n}`, type: n === 0 ? "imageView" : "commandExecution", command: "x".repeat(8000), output: `out-${n}` }
        } });
        expect(update).not.toBeNull();
        store.saveTimelineItem("thread", "turn", journalItem(update!));
      }
      expect(live.snapshot().toolItems).toHaveLength(48);
      live.recordNotification({ method: "turn/completed", params: { threadId: "thread", turnId: "turn" } });
      expect(live.snapshot().toolItems).toHaveLength(0);
      store.close();
      store = new ProjectStore(path.join(root, "test.sqlite"));
      const saved = store.readTimelineItems("thread", "turn");
      expect(saved).toHaveLength(60);
      expect(saved[0]).toMatchObject({ tool: "view_image", input: "x".repeat(8000) });
      const thread = overlayJournal({ turns: [{ id: "turn", items: [] }] }, (id) => store.readTimelineItems("thread", id), true);
      expect((thread.turns as { items: unknown[] }[])[0].items).toHaveLength(60);
      expect(store.readTimelineItems("other-thread", "turn")).toHaveLength(0);
    } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("overlays the same call once and respects historical page bounds", () => {
    const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
    const entries = [1, 2, 3, 4].map((n) => ({ id: `call-${n}`, type: "toolCall", timelineAt: at(n), tool: "view_image" }));
    const history = { turns: [{ id: "turn", items: [
      { id: "response-2", callId: "call-2", type: "toolCall", timelineAt: at(2) },
      { id: "message", type: "agentMessage", timelineAt: at(3) }
    ] }] };
    const result = overlayJournal(history, () => entries, false);
    expect((result.turns as { items: { id: string }[] }[])[0].items.map((item) => item.id)).toEqual(["response-2", "message", "call-3"]);
  });

  it("restores a turn diff on a historical page without duplicating a native file-change item", () => {
    const diff = { id: "turn-diff:turn", type: "fileChange", source: "turnDiff", changes: [{ path: "a.ts", diff: "+new" }], timelineAt: new Date(1700000009000).toISOString() };
    const history = { turns: [{ id: "turn", items: [{ id: "message", type: "agentMessage", timelineAt: new Date(1700000001000).toISOString() }] }] };
    const restored = overlayJournal(history, () => [diff], false);
    expect((restored.turns as { items: { id: string }[] }[])[0].items.map((item) => item.id)).toContain(diff.id);
    const native = { id: "native", type: "fileChange", changes: [{ path: "a.ts", diff: "+new" }] };
    const deduplicated = overlayJournal({ turns: [{ id: "turn", items: [native] }] }, () => [diff], false);
    expect((deduplicated.turns as { items: { id: string }[] }[])[0].items).toHaveLength(1);
  });
});
