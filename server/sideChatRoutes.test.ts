import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { registerSideChatRoutes } from "./sideChatRoutes.js";

it("restores only the main thread's owned binding, persists drafts, and rejects stale close ids", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "side-chat-routes-")), store = new ProjectStore(path.join(root, "test.sqlite"));
  const project = store.createProject({ name: "main", rootPath: root });
  for (const id of ["a", "b"]) store.registerThreadOwner({ threadId: id, userId: "admin", projectId: project.id, rootPath: root });
  const app = Fastify(), calls: string[] = [];
  const bridge = { request: async (method: string) => { calls.push(method); return {}; } } as unknown as CodexBridge;
  registerSideChatRoutes(app, bridge, store, request => String(request.headers["x-test-user"] ?? "admin"));
  const url = (id: string) => `/api/projects/${project.id}/threads/${id}/side-chat`;
  try {
    expect((await app.inject({ method: "GET", url: url("a") })).json().data).toBeNull();
    const created = await app.inject({ method: "POST", url: url("a"), payload: { selectedText: "quote", modelProfileId: "sol" } });
    expect(created.statusCode).toBe(200);
    const side = created.json().data;
    const duplicate = await app.inject({ method: "POST", url: url("a"), payload: { selectedText: "new quote", modelProfileId: "sol" } });
    expect(duplicate.json().data.id).toBe(side.id);
    const saved = await app.inject({ method: "PATCH", url: url("a"), payload: { id: side.id, draft: "saved draft", modelProfileId: "sol", expectedRequestId: null } });
    expect(saved.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: url("a") })).json().data.draft).toBe("saved draft");
    expect((await app.inject({ method: "GET", url: url("b") })).json().data).toBeNull();
    expect((await app.inject({ method: "GET", url: url("a"), headers: { "x-test-user": "other" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: url("b"), payload: { id: side.id, draft: "wrong", modelProfileId: "sol", expectedRequestId: null } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: url("a") })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: url("a") + "?id=stale" })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: url("a") + "?id=" + side.id })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: url("a") })).json().data).toBeNull();
    expect(calls).toEqual([]);
    const replacement = await app.inject({ method: "POST", url: url("a"), payload: { selectedText: "another quote", modelProfileId: "sol" } });
    expect(replacement.json().data.id).not.toBe(side.id);
    expect((await app.inject({ method: "DELETE", url: url("a") + "?id=" + side.id })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: url("a") })).json().data.id).toBe(replacement.json().data.id);
  } finally { await app.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
