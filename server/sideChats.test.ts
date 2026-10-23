import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { closeSideChat, settleClosedSideChat } from "./sideChats.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-side-chat-")), db = path.join(root, "test.sqlite");
  const store = new ProjectStore(db), project = store.createProject({ name: "main", rootPath: root });
  for (const id of ["main-a", "main-b", "child-a", "child-b"]) store.registerThreadOwner({ threadId: id, userId: "admin", projectId: project.id, rootPath: root });
  return { root, db, store, project, dispose: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

describe("side chats bound to main threads", () => {
  it("persists independent bindings and drafts, and makes opening the same parent idempotent", () => {
    const f = fixture(); let reopened: ProjectStore | undefined;
    try {
      const a = f.store.sideChats.create("main-a", "admin", f.project.id, "quote a", "sol-high");
      f.store.sideChats.saveDraft(a.id, "admin", "draft a", "sol-low", null);
      const b = f.store.sideChats.create("main-b", "admin", f.project.id, "quote b", "sol-high");
      expect(f.store.sideChats.create("main-a", "admin", f.project.id, "different quote", "sol-high").id).toBe(a.id);
      reopened = new ProjectStore(f.db);
      expect(reopened.sideChats.get("main-a", "admin", f.project.id)).toMatchObject({ id: a.id, selectedText: "quote a", draft: "draft a", modelProfileId: "sol-low" });
      expect(reopened.sideChats.get("main-b", "admin", f.project.id)).toMatchObject({ id: b.id, selectedText: "quote b", draft: "" });
    } finally { reopened?.close(); f.dispose(); }
  });

  it("enforces both user and workspace ownership, including child-thread attachment", () => {
    const f = fixture();
    try {
      const other = f.store.createProject({ name: "other", rootPath: path.join(f.root, "other") });
      expect(() => f.store.sideChats.create("main-a", "someone-else", f.project.id, "q", "sol")).toThrow("不可访问");
      expect(() => f.store.sideChats.create("main-a", "admin", other.id, "q", "sol")).toThrow("不可访问");
      const a = f.store.sideChats.create("main-a", "admin", f.project.id, "q", "sol");
      expect(() => f.store.sideChats.begin(a.id, "someone-else", f.project.id, "r", "p", null)).toThrow("不可访问");
      f.store.sideChats.begin(a.id, "admin", f.project.id, "r", "p", null);
      expect(() => f.store.sideChats.attach(a.id, "admin", "r", "main-a")).toThrow("归属");
      expect(f.store.sideChats.attach(a.id, "admin", "r", "child-a")).toBe(true);
      expect(() => f.store.sideChats.create("child-a", "admin", f.project.id, "nested", "sol")).toThrow("不可访问");
    } finally { f.dispose(); }
  });

  it("rejects duplicate starts and stale draft saves, and ignores a previous turn's late completion", () => {
    const f = fixture();
    try {
      const side = f.store.sideChats.create("main-a", "admin", f.project.id, "q", "sol");
      f.store.sideChats.begin(side.id, "admin", f.project.id, "r1", "first", null);
      expect(() => f.store.sideChats.begin(side.id, "admin", f.project.id, "r2", "second", null)).toThrow("正在处理");
      expect(() => f.store.sideChats.saveDraft(side.id, "admin", "stale", "sol", null)).toThrow("已更新");
      f.store.sideChats.attach(side.id, "admin", "r1", "child-a");
      f.store.sideChats.accepted(side.id, "admin", "r1", "turn-1");
      f.store.sideChats.turn("child-a", "turn-1", true);
      f.store.sideChats.begin(side.id, "admin", f.project.id, "r2", "second", "child-a");
      f.store.sideChats.turn("child-a", "turn-1", true);
      expect(f.store.sideChats.byId(side.id, "admin")).toMatchObject({ status: "starting", requestId: "r2", turnId: null });
      f.store.sideChats.turn("child-a", "turn-2", false);
      f.store.sideChats.turn("child-a", "turn-2", true);
      f.store.sideChats.accepted(side.id, "admin", "r2", "turn-2");
      expect(f.store.sideChats.byId(side.id, "admin")?.status).toBe("complete");
    } finally { f.dispose(); }
  });

  it("stops only the bound side turn on explicit close and never reopens a deleted generation", async () => {
    const f = fixture(), calls: unknown[] = [];
    try {
      const side = f.store.sideChats.create("main-a", "admin", f.project.id, "q", "sol");
      f.store.sideChats.begin(side.id, "admin", f.project.id, "r", "p", null);
      f.store.sideChats.attach(side.id, "admin", "r", "child-a");
      f.store.sideChats.accepted(side.id, "admin", "r", "turn-1");
      const bridge = { request: async (method: string, params: unknown) => { calls.push({ method, params }); return {}; } } as unknown as CodexBridge;
      await closeSideChat(bridge, f.store, f.store.sideChats.byId(side.id, "admin")!);
      expect(calls).toEqual([{ method: "turn/interrupt", params: { threadId: "child-a", turnId: "turn-1" } }]);
      expect(f.store.userCanAccessThread("main-a", "admin", f.project.id)).toBe(true);
      expect(f.store.userCanAccessThread("child-a", "admin", f.project.id)).toBe(false);
      expect(f.store.sideChats.get("main-a", "admin", f.project.id)).toBeNull();
      const next = f.store.sideChats.create("main-a", "admin", f.project.id, "new q", "sol");
      expect(next.id).not.toBe(side.id);
      expect(f.store.sideChats.attach(side.id, "admin", "r", "child-b")).toBe(false);
      expect(f.store.sideChats.get("main-a", "admin", f.project.id)?.id).toBe(next.id);
    } finally { f.dispose(); }
  });

  it("keeps a running side chat accessible if stopping it fails", async () => {
    const f = fixture();
    try {
      const side = f.store.sideChats.create("main-a", "admin", f.project.id, "q", "sol");
      f.store.sideChats.begin(side.id, "admin", f.project.id, "r", "p", null);
      f.store.sideChats.attach(side.id, "admin", "r", "child-a");
      f.store.sideChats.accepted(side.id, "admin", "r", "turn-1");
      const bridge = { request: async () => { throw new Error("transport disconnected"); } } as unknown as CodexBridge;
      await expect(closeSideChat(bridge, f.store, f.store.sideChats.byId(side.id, "admin")!)).rejects.toThrow("disconnected");
      expect(f.store.sideChats.byId(side.id, "admin")).toMatchObject({ status: "running", turnId: "turn-1" });
      expect(f.store.userCanAccessThread("child-a", "admin", f.project.id)).toBe(true);
    } finally { f.dispose(); }
  });

  it("holds a pending close until native creation can be cancelled without starting a model turn", async () => {
    const f = fixture(), calls: string[] = [];
    try {
      const side = f.store.sideChats.create("main-a", "admin", f.project.id, "q", "sol");
      f.store.sideChats.begin(side.id, "admin", f.project.id, "r", "p", null);
      const bridge = { request: async (method: string) => { calls.push(method); return {}; } } as unknown as CodexBridge;
      await closeSideChat(bridge, f.store, f.store.sideChats.byId(side.id, "admin")!);
      expect(f.store.sideChats.byId(side.id, "admin")?.status).toBe("closing");
      expect(f.store.sideChats.attach(side.id, "admin", "r", "child-a")).toBe(false);
      await settleClosedSideChat(bridge, f.store, side.id, "admin", "child-a", null);
      expect(calls).toEqual([]);
      expect(f.store.sideChats.get("main-a", "admin", f.project.id)).toBeNull();
      expect(f.store.userCanAccessThread("child-a", "admin", f.project.id)).toBe(false);
    } finally { f.dispose(); }
  });
});
