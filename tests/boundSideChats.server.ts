import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-side-chat-browser-"));
process.env.CODEX_WEB_DATA_DIR = path.join(root, "data");
process.env.CODEX_THREAD_INDEX_DB = path.join(root, "index.sqlite");
process.env.CODEX_WEB_ACCOUNT_POOL_FILE = "";
const [{ ProjectStore }, { registerSideChatRoutes }, { attachSocketServer }, auth] = await Promise.all([
  import("../server/db.js"), import("../server/sideChatRoutes.js"), import("../server/socket.js"), import("../server/auth.js")
]);
const store = new ProjectStore(path.join(root, "store.sqlite"));
const project = store.createProject({ name: "侧边绑定验收", rootPath: root, defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "high" });
type Thread = { id: string; name: string; cwd: string; status: string; turns: any[]; createdAt: number; updatedAt: number };
const threads = new Map<string, Thread>();
for (const [id, name, quote] of [["main-a", "主会话 A", "第一段正文用于主会话 A 的侧边提问。"], ["main-b", "主会话 B", "第二段正文用于主会话 B 的侧边提问。"], ["main-c", "主会话 C", "这个主会话还没有侧边会话。"]]) {
  store.registerThreadOwner({ threadId: id, userId: "admin", projectId: project.id, rootPath: root });
  threads.set(id, { id, name, cwd: root, status: "idle", createdAt: 1, updatedAt: 1, turns: [{ id: id + "-turn", status: "completed", items: [{ id: id + "-answer", type: "agentMessage", text: quote }] }] });
}

class FixtureBridge extends EventEmitter {
  calls: Array<{ method: string; threadId?: string }> = [];
  creationGate: Promise<void> | null = null;
  releaseCreation: (() => void) | null = null;
  failNextTurn = false;
  getPendingServerRequests() { return []; }
  async request(method: string, params: any = {}) {
    this.calls.push({ method, threadId: params.threadId });
    if (method === "thread/start") {
      await this.creationGate;
      const thread = { id: randomUUID(), name: "侧边聊天", cwd: root, status: "idle", createdAt: 1, updatedAt: 1, turns: [] };
      threads.set(thread.id, thread); return { thread };
    }
    const thread = threads.get(params.threadId);
    if (method === "thread/name/set" && thread) thread.name = params.name;
    if (method === "thread/read" || method === "thread/resume") return { thread };
    if (method === "turn/start" && thread) {
      if (this.failNextTurn) { this.failNextTurn = false; throw new Error("用于选中复制的完整错误详情"); }
      const id = randomUUID(), userText = params.input.map((item: any) => item.text ?? "").join("\n");
      const answer = `侧边回答 ${thread.turns.length + 1}：${userText.split("用户问题：\n").at(-1)}`;
      const turn = { id, status: "running", items: [{ id: id + "-user", type: "userMessage", text: userText }, { id: id + "-answer", type: "agentMessage", text: answer }] };
      thread.turns.push(turn); thread.status = "active";
      this.emit("notification", { method: "turn/started", params: { threadId: thread.id, turn: { id, status: "running" } } });
      setTimeout(() => this.emit("notification", { method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: id, itemId: id + "-answer", delta: answer } }), 30);
      return { turn: { id } };
    }
    if (method === "turn/interrupt" && thread) this.complete(thread.id, "interrupted");
    return {};
  }
  complete(threadId: string, status = "completed") {
    const thread = threads.get(threadId), turn = thread?.turns.at(-1);
    if (!thread || !turn) return;
    turn.status = status; thread.status = "idle";
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { ...turn } } });
  }
  append(threadId: string, delta: string) {
    const turn = threads.get(threadId)?.turns.at(-1), item = turn?.items.at(-1);
    if (!turn || !item) return;
    item.text += delta;
    this.emit("notification", { method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: item.id, delta } });
  }
}
const bridge = new FixtureBridge(), app = Fastify();
const user = (request: { headers: Record<string, unknown> }) => auth.authenticatedUserFromHeaders(request.headers as any) ?? "anonymous";
registerSideChatRoutes(app, bridge as any, store, user);
const wss = attachSocketServer(app.server, bridge as any, store);
app.post("/api/auth/login", async (_request, reply) => { reply.header("Set-Cookie", auth.createSessionCookie("admin")); return { ok: true }; });
app.post<{ Body: { threadId: string } }>("/api/__test/complete", async request => { bridge.complete(request.body.threadId); return { ok: true }; });
app.post<{ Body: { threadId: string; delta: string } }>("/api/__test/append", async request => { bridge.append(request.body.threadId, request.body.delta); return { ok: true }; });
app.post<{ Body: { pause: boolean } }>("/api/__test/hold-create", async request => {
  if (request.body.pause) bridge.creationGate = new Promise(resolve => { bridge.releaseCreation = resolve; });
  else { bridge.releaseCreation?.(); bridge.creationGate = null; bridge.releaseCreation = null; }
  return { ok: true };
});
app.post("/api/__test/fail-next", async () => { bridge.failNextTurn = true; return { ok: true }; });
app.get("/api/__test/state", async () => ({ fixture: "bound-side-chats", projectId: project.id,
  calls: bridge.calls, sides: ["main-a", "main-b", "main-c"].map(id => store.sideChats.get(id, "admin", project.id)) }));
app.get("/api/projects", async () => ({ data: [project], projectRoot: root }));
app.get("/api/users", async () => ({ data: [{ id: "admin", name: "admin" }], defaultUserId: "admin" }));
app.get("/api/models", async () => ({ data: [{ id: "sol", label: "Sol", model: "gpt-6.1-sol", effort: "high" }] }));
app.get("/api/pets", async () => ({ pets: [], activePetId: null, visible: false, position: null }));
app.get("/api/codex/account-pool", async () => ({ data: { strategy: "single-account", accounts: [] } }));
app.get<{ Params: { id: string } }>("/api/projects/:id/threads", async () => ({ data: ["main-a", "main-b", "main-c"].map(id => threads.get(id)), hiddenThreadIds: [...store.sideChats.threadIds("admin", project.id)] }));
app.get<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
  if (!store.userCanAccessThread(request.params.threadId, user(request), project.id)) return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
  const thread = threads.get(request.params.threadId)!;
  return { thread, history: { totalItems: thread.turns.reduce((count, turn) => count + turn.items.length, 0), returnedItems: thread.turns.reduce((count, turn) => count + turn.items.length, 0), before: 0, hasOlder: false } };
});
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.includes("/execution-settings")) return { data: { sandbox: "read-only", approvalPolicy: "never" } };
  if (request.url.includes("/context")) return { data: null };
  if (request.url.includes("/subagents")) return { data: [], page: { total: 0, activeCount: 0, historyCount: 0, hasMore: false } };
  if (request.url.startsWith("/api/")) return { data: [] };
  return reply.code(404).send();
});
await app.listen({ host: "127.0.0.1", port: 0 });
console.log(JSON.stringify({ ready: true, origin: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, projectId: project.id }));
let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  for (const client of wss.clients) client.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await app.close(); await new Promise(resolve => setTimeout(resolve, 50)); store.close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
