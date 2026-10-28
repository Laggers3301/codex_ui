import { claudePendingProfiles } from "../shared/agentRuntime.js";
import { ClaudeStreamAdapter } from "../server/claudeStreamAdapter.js";
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
process.env.CODEX_WEB_PORT = "0";
// The public repository is flat; the production host keeps frontend/backend
// separately. Both layouts must run this isolated fixture without live APIs.
const serverRoot = new URL(fs.existsSync(new URL('../server/db.ts', import.meta.url)) ? '../server/' : '../../backend/server/', import.meta.url);
const [{ ProjectStore }, { registerSideChatRoutes }, { attachSocketServer }, auth, { registerHostResourceRoutes }, { registerSessionCommunicationRoutes }, { registerBrowserRoutes }, { sanitizeMcpServerStatus }, { serverConfig }] = await Promise.all(
  ['db', 'sideChatRoutes', 'socket', 'auth', 'hostResources', 'sessionCommunicationRoutes', 'browserRoutes', 'routes', 'config'].map(name => import(new URL(name + '.js', serverRoot).href))
);
const store = new ProjectStore(path.join(root, "store.sqlite"));
const project = store.createProject({ name: "侧边绑定验收", rootPath: root, defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "high" });
type Thread = { id: string; name: string; cwd: string; status: string; historyMode: string; turns: any[]; createdAt: number; updatedAt: number };
const threads = new Map<string, Thread>();
for (const [id, name, quote] of [["main-a", "主会话 A", "第一段正文用于主会话 A 的侧边提问。"], ["main-b", "主会话 B", "第二段正文用于主会话 B 的侧边提问。"], ["main-c", "主会话 C", "这个主会话还没有侧边会话。"]]) {
  store.registerThreadOwner({ threadId: id, userId: "admin", projectId: project.id, rootPath: root });
  store.updateThreadDisplayName(id, "admin", name);
  threads.set(id, { id, name, cwd: root, status: "idle", historyMode: "paginated", createdAt: 1, updatedAt: 1, turns: [{ id: id + "-turn", status: "completed", items: [{ id: id + "-answer", type: "agentMessage", text: quote }] }] });
}

class FixtureBridge extends EventEmitter {
  calls: Array<{ method: string; threadId?: string }> = [];
  starts: Array<{ threadId: string; text: string }> = [];
  mcpConfigs = new Map<string, Record<string, any>>();
  taskToolOutputs: Array<{ threadId: string; value: any }> = [];
  creationGate: Promise<void> | null = null;
  releaseCreation: (() => void) | null = null;
  failNextTurn = false;
  failNextApproval = false;
  pending: Array<{ id: number; method: string; params: Record<string, unknown>; receivedAt: string }> = [];
  approvalResponses: Array<{ id: number | string; result: unknown }> = [];
  flags = new Map<string, string[]>();
  nextApprovalId = 1;
  getPendingServerRequests() { return this.pending; }
  respondToServerRequest(id: number | string, result: unknown) {
    if (this.failNextApproval) { this.failNextApproval = false; throw new Error("模拟批准提交失败，请重试"); }
    const request = this.pending.find(request => request.id === id)!;
    this.approvalResponses.push({ id, result }); this.pending = this.pending.filter(request => request.id !== id);
    const threadId = String(request.params.threadId);
    this.flags.set(threadId, this.pending.some(request => request.params.threadId === threadId) ? ["waitingOnApproval"] : []);
  }
  async request(method: string, params: any = {}) {
    this.calls.push({ method, threadId: params.threadId });
    if (method === "thread/start" || method === "thread/fork") {
      await this.creationGate;
      const inherited = method === "thread/fork" ? structuredClone(threads.get(params.threadId)!.turns) : [];
      const thread = { id: randomUUID(), name: "侧边聊天", cwd: root, status: "idle", historyMode: "paginated", createdAt: 1, updatedAt: 1, turns: inherited };
      this.mcpConfigs.set(thread.id, structuredClone(params.config ?? {}));
      threads.set(thread.id, thread); return { thread };
    }
    const thread = threads.get(params.threadId);
    if (method === "thread/loaded/list") return { data: [...this.mcpConfigs.keys()] };
    if (method === "thread/name/set" && thread) thread.name = params.name;
    if (method === "thread/read") return { thread: thread ? { ...thread, status: { type: thread.status, activeFlags: this.flags.get(thread.id) ?? [] }, turns: params.includeTurns === false ? [] : thread.turns } : thread };
    if (method === "thread/resume") {
      if (params.config) this.mcpConfigs.set(params.threadId, structuredClone(params.config));
      return { thread };
    }
    if (method === "mcpServerStatus/list") {
      const config = this.mcpConfigs.get(params.threadId)?.["mcp_servers.codex_communication"];
      if (!config) return { data: [] };
      const result = await callFixtureMcp(config, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      if (result.error) throw new Error("fixture MCP identity unavailable");
      return { data: [{ name: "codex_communication", runtimeStatus: "connected", tools: Object.fromEntries(result.result.tools.map((tool: any) => [tool.name, tool])) }] };
    }
    if (method === "thread/queue/list") return { data: [] };
    if (method === "thread/turns/list") return { data: thread?.turns.slice(-1).map(({id,status}) => ({id,status})) ?? [] };
    if (method === "thread/items/list") return { data: (thread?.turns.find(turn => turn.id === params.turnId)?.items ?? []).map((item: unknown) => ({ turnId: params.turnId, item })) };
    if (method === "turn/start" && thread) {
      if (this.failNextTurn) { this.failNextTurn = false; throw new Error("用于选中复制的完整错误详情"); }
      const callback = params.toolOutput ? JSON.parse(params.toolOutput.output) : null;
      if (callback) {
        this.taskToolOutputs.push({ threadId: thread.id, value: callback });
        if (thread.status === "active") return { turn: { id: thread.turns.at(-1)!.id } };
      }
      const id = randomUUID(), userText = params.input.map((item: any) => item.text ?? "").join("\n");
      this.starts.push({threadId:thread.id,text:userText});
      const sideTurnCount = thread.turns.filter(turn => turn.items.some((item: any) => item.type === "userMessage")).length;
      const answer = callback ? `已自动接收协作结果：${callback.result ?? callback.error}` : `侧边回答 ${sideTurnCount + 1}：${userText.split("用户问题：\n").at(-1)}`;
      const turn = { id, status: "running", items: [callback
        ? { id: id + "-tool-output", type: "functionCallOutput", name: "session_communication", output: params.toolOutput.output }
        : { id: id + "-user", type: "userMessage", text: userText }, { id: id + "-answer", type: "agentMessage", text: answer }] };
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
async function callFixtureMcp(config: Record<string, any>, payload: unknown) {
  const expected = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/communication/mcp`;
  if (config.url !== expected) throw new Error("MCP must use the isolated fixture server");
  const response = await fetch(config.url, { method: "POST", headers: { ...config.http_headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("fixture MCP transport failed: " + response.status);
  return response.json();
}
const browserService = Object.assign(new EventEmitter(), { get: () => null });
registerBrowserRoutes(app, store, browserService as any);
const user = (request: { headers: Record<string, unknown> }) => auth.authenticatedUserFromHeaders(request.headers as any) ?? "anonymous";
registerSideChatRoutes(app, bridge as any, store, user);
let resourceReads = 0, resourceFailure = false, networkProbes = 0, networkFailure = false, networkHold = false;
let releaseNetwork: (() => void) | null = null;
registerHostResourceRoutes(app, { read: async () => {
  resourceReads++; if (resourceFailure) throw new Error('fixture resource failure');
  return { sampledAt: new Date().toISOString(), intervalMs: 10_000, hostname: "fixture-host", platform: "linux",
    cpu: { cores: 8, model: "Fixture CPU", usagePercent: 12.5, loadAverage: [1, .8, .6] },
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 6 * 1024 ** 3, availableBytes: 2 * 1024 ** 3, usagePercent: 75, swapTotalBytes: 2 * 1024 ** 3, swapUsedBytes: 1024 ** 3 },
    volumes: [{ labels: ["系统", "数据目录", "工作目录"], paths: [{ label: "系统", path: "/" }, { label: "数据目录", path: "/fixture/data" }, { label: "工作目录", path: "/fixture/workspaces" }], mountPoints: ["/"], totalBytes: 100 * 1024 ** 3, usedBytes: 40 * 1024 ** 3, availableBytes: 60 * 1024 ** 3, usagePercent: 40 }],
    disks: [{ name: "vda", mountPoints: ["/", "/boot"], readBytesPerSecond: 2 * 1024 ** 2, writeBytesPerSecond: 1024 ** 2, busyPercent: 30 }], warnings: [] };
} } as any, { run: async () => {
  networkProbes++; if (networkHold) await new Promise<void>(resolve => { releaseNetwork = resolve; });
  return { target: "google.com", startedAt: new Date().toISOString(), durationMs: 2000, status: networkFailure ? "timeout" : "reachable",
    message: networkFailure ? "本次检测未收到 ICMP 应答。" : "已收到 google.com 的 ICMP 应答。", address: "142.250.1.1", packetsTransmitted: 3,
    packetsReceived: networkFailure ? 0 : 3, packetLossPercent: networkFailure ? 100 : 0, averageLatencyMs: networkFailure ? null : 20.5,
    output: `PING google.com (142.250.1.1) 56(84) bytes of data.\n3 packets transmitted, ${networkFailure ? 0 : 3} received, ${networkFailure ? 100 : 0}% packet loss` };
} } as any);
registerSessionCommunicationRoutes(app, store);
app.post<{ Body: { fail: boolean } }>("/api/__test/resource-mode", async request => { resourceFailure = request.body.fail; return { ok: true }; });
app.post<{ Body: { fail?: boolean; hold?: boolean } }>("/api/__test/network-mode", async request => {
  if (request.body.fail !== undefined) networkFailure = request.body.fail;
  if (request.body.hold !== undefined) networkHold = request.body.hold;
  if (!networkHold) { releaseNetwork?.(); releaseNetwork = null; } return { ok: true };
});
const wss = attachSocketServer(app.server, bridge as any, store, browserService as any);
app.get<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/mcp-status", async (request, reply) => {
  if (request.params.id !== project.id || !store.userCanAccessThread(request.params.threadId, user(request), project.id)) return reply.code(404).send({ error: "Thread not found." });
  return sanitizeMcpServerStatus(await bridge.request("mcpServerStatus/list", { threadId: request.params.threadId }));
});
// Exercise the actual credentials passed through socket start/resume/fork;
// this adapter never invokes a model or exposes its private MCP headers.
app.post<{ Body: { threadId: string; command: unknown } }>("/api/__test/model-communication", async (request, reply) => {
  const config = bridge.mcpConfigs.get(request.body.threadId)?.["mcp_servers.codex_communication"];
  if (!config) return reply.code(409).send({ error: "Thread tools are not loaded." });
  return callFixtureMcp(config, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_communication", arguments: request.body.command } });
});
app.post("/api/auth/login", async (_request, reply) => { reply.header("Set-Cookie", auth.createSessionCookie("admin")); return { ok: true }; });
app.post<{ Body: { threadId: string } }>("/api/__test/complete", async request => { bridge.complete(request.body.threadId); return { ok: true }; });
app.post<{ Body: { threadId: string; delta: string } }>("/api/__test/append", async request => { bridge.append(request.body.threadId, request.body.delta); return { ok: true }; });
app.post<{ Body: { threadId: string } }>("/api/__test/start-main", async request => bridge.request("turn/start", {
  threadId: request.body.threadId, input: [{ type: "text", text: "模拟主会话持续运行" }]
}));
app.post<{ Body: { threadId: string } }>("/api/__test/runtime-exit", async request => {
  const thread=threads.get(request.body.threadId)!;
  thread.turns.at(-1).status='interrupted';thread.status='idle';
  bridge.emit('status',{state:'exited',code:null,signal:'SIGABRT'});return {ok:true};
});
app.post<{ Body: { threadId: string } }>("/api/__test/interrupt-main", async request => { bridge.complete(request.body.threadId,'interrupted');return {ok:true}; });
app.post<{ Body: { threadId: string } }>("/api/__test/open-tool", async request => {
  const thread=threads.get(request.body.threadId)!,turn=thread.turns.at(-1);
  const item={id:'unfinished-operation',type:'commandExecution',command:'模拟已提交但结果未返回的操作',cwd:root,status:'inProgress'};
  turn.items.push(item);bridge.emit('notification',{method:'item/started',params:{threadId:thread.id,turnId:turn.id,item}});return {ok:true};
});
app.post<{ Body: { threadId: string } }>("/api/__test/main-tool", async request => {
  const threadId = request.body.threadId, turnId = threads.get(threadId)!.turns.at(-1)!.id;
  const item = { id: "main-scroll-tool", type: "commandExecution", command: "echo MAIN_TOOL_SCROLL_UPDATE", cwd: root, status: "inProgress" };
  bridge.emit("notification", { method: "item/started", params: { threadId, turnId, item } });
  bridge.emit("notification", { method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: item.id, delta: "MAIN_TOOL_SCROLL_UPDATE" } });
  bridge.emit("notification", { method: "item/completed", params: { threadId, turnId, item: { ...item, status: "completed", aggregatedOutput: "MAIN_TOOL_SCROLL_UPDATE", exitCode: 0 } } });
  return { ok: true };
});
app.post<{ Body: { pause: boolean } }>("/api/__test/hold-create", async request => {
  if (request.body.pause) bridge.creationGate = new Promise(resolve => { bridge.releaseCreation = resolve; });
  else { bridge.releaseCreation?.(); bridge.creationGate = null; bridge.releaseCreation = null; }
  return { ok: true };
});
app.post("/api/__test/fail-next", async () => { bridge.failNextTurn = true; return { ok: true }; });
app.post("/api/__test/fail-next-approval", async () => { bridge.failNextApproval = true; return { ok: true }; });
app.post<{ Body: { threadId: string; kind: string; emit?: boolean } }>("/api/__test/approval", async request => {
  const { threadId, kind, emit = true } = request.body, id = bridge.nextApprovalId++;
  const pending = { id, method: `item/${kind}/requestApproval`, receivedAt: new Date().toISOString(), params: {
    threadId, turnId: threads.get(threadId)!.turns.at(-1).id, itemId: `approval-${id}`,
    reason: "核对 lzc 分支的最新代码", cwd: root,
    ...(kind === "commandExecution" ? { command: "git fetch origin lzc" } : kind === "permissions"
      ? { permissions: { network: { enabled: true }, fileSystem: { read: ["/tmp/approval-fixture"], write: null } } }
      : kind === "fileChange" ? { grantRoot: "/tmp/approval-fixture" } : kind === "claudeTool" ? {toolName:"Bash",toolInput:{command:"git status --short"}} : {})
  } };
  bridge.pending.push(pending); bridge.flags.set(threadId, ["waitingOnApproval"]);
  if (emit) bridge.emit("serverRequest", pending);
  bridge.emit("notification", { method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
  return { id };
});
app.post<{ Body: { threadId: string; waiting: boolean; clearRequests?: boolean } }>("/api/__test/approval-state", async request => {
  const { threadId, waiting, clearRequests } = request.body;
  if (clearRequests) bridge.pending = bridge.pending.filter(request => request.params.threadId !== threadId);
  const activeFlags = waiting ? ["waitingOnApproval"] : []; bridge.flags.set(threadId, activeFlags);
  bridge.emit("notification", { method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags } } });
  return { ok: true };
});
app.get("/api/__test/state", async () => ({ fixture: "bound-side-chats", projectId: project.id,
  calls: bridge.calls, starts:bridge.starts, taskToolOutputs: bridge.taskToolOutputs, resourceReads, networkProbes, pendingApprovals: bridge.pending, approvalResponses: bridge.approvalResponses, recoveries:store.listTurnRecoveryStates('admin').map(({threadId,error,interruption,activeTurn}:{threadId:string;error:unknown;interruption?:unknown;activeTurn?:unknown})=>({threadId,error,interruption,activeTurn})), sides: ["main-a", "main-b", "main-c"].map(id => store.sideChats.get(id, "admin", project.id)) }));
app.get("/api/projects", async () => ({ data: [project], projectRoot: root }));
app.get("/api/users", async () => ({ data: [{ id: "admin", name: "admin" }], defaultUserId: "admin" }));
app.get("/api/models", async () => ({ data: [{ id: "sol", label: "Sol", model: "gpt-6.1-sol", effort: "high" }, ...(process.env.RECLAUDE_FIXTURE_TEST === "1" ? claudePendingProfiles() : [])] }));
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
// Opt-in native-message fixtures: never registered by the production server.
if (process.env.RECLAUDE_FIXTURE_TEST === "1") {
  let adapter: ClaudeStreamAdapter;
  app.post("/api/__test/claude-begin", async () => {
    const thread = threads.get("main-a")!;
    const turn = {id: randomUUID(), status: "inProgress", items: [{id:randomUUID(),type:"userMessage",content:[{type:"text",text:"请检查示例文件并说明结果。"}]}] as any[]};
    thread.turns.push(turn); thread.status="active";
    adapter=new ClaudeStreamAdapter(thread.id,turn.id,event=>{
      const params=event.params as any;
      if (event.method==="item/completed") {
        const index=turn.items.findIndex(item=>item.id===params.item.id);
        if(index<0)turn.items.push(params.item);else turn.items[index]=params.item;
      }
      if (event.method==="turn/completed") {turn.status=params.turn.status;thread.status="idle";}
      bridge.emit("notification",event);
    });
    adapter.start();return {turnId:turn.id};
  });
  app.post<{Body:Record<string,unknown>}>("/api/__test/claude-event",async request=>{adapter.accept(request.body);return {ok:true};});
}
await app.listen({ host: "127.0.0.1", port: 0 });
serverConfig.port = (app.server.address() as { port: number }).port;
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
