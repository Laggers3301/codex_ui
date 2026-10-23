import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import { createSessionCookie } from "./auth.js";
import { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";

const binary = process.env.CODEX_SIDE_CHAT_TEST_BIN ?? path.resolve(process.cwd(), "../bin/codex-0.163.0/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex");

it.skipIf(!fs.existsSync(binary))("sends inherited main context to the native model and keeps side turns, mode and goals independent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "side-chat-context-native-"));
  const requests: any[] = [], runtimes: CodexBridge[] = [], diagnostics: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
    requests.push(JSON.parse(body));
    const n = requests.length, item = { id: `msg_${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `Local answer ${n}`, annotations: [] }] };
    const result = { id: `resp_${n}`, object: "response", model: "gpt-6.1-sol", status: "in_progress", output: [] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: result },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: `Local answer ${n}` },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { ...result, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "dummy-local-only" }), { mode: 0o600 });
  const pool = new AccountPoolBridge({ accounts: [{ id: "isolated", label: "isolated", codexHome: root }], stateFile: "pool.json" }, root, home => {
    const runtime = new CodexBridge({ command: binary, args: ["app-server", "--listen", "stdio://", "-c", `openai_base_url="http://127.0.0.1:${port}/v1"`, "-c", 'model="gpt-6.1-sol"'], env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, NO_PROXY: "127.0.0.1,localhost" } });
    runtime.on("stderr", text => diagnostics.push(String(text)));
    runtimes.push(runtime); return runtime;
  });
  const store = new ProjectStore(path.join(root, "test.sqlite")), project = store.createProject({ name: "isolated context", rootPath: root, defaultModel: "gpt-6.1-sol" });
  const server = http.createServer(), wss = attachSocketServer(server, pool as unknown as CodexBridge, store);
  let socket: WebSocket | undefined;
  const messages: any[] = [];
  const completed = new Map<string, any>();
  pool.on("notification", (message: any) => {
    if (message.method === "turn/completed") completed.set(message.params.turn.id, message.params.turn);
  });
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 20_000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}; ${diagnostics.join("").slice(-4000)}`); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    const created = await pool.startThreadOnAccount("isolated", { cwd: root, model: "gpt-6.1-sol", approvalPolicy: "never", sandbox: "read-only", historyMode: "paginated" }) as { thread: { id: string } };
    const parent = created.thread.id;
    store.registerThreadOwner({ threadId: parent, userId: "admin", projectId: project.id, rootPath: root });
    const parentTurn = async (text: string) => {
      const result = await pool.request("turn/start", { threadId: parent, input: [{ type: "text", text }], collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null } } }) as { turn: { id: string } };
      await wait(() => completed.has(result.turn.id), "parent turn completion");
      expect(completed.get(result.turn.id).status, JSON.stringify(completed.get(result.turn.id))).toBe("completed");
    };
    await parentTurn("Keep this earlier main-thread fact: the project passphrase is ORCHID-8271. It is absent from the selected quotation.");
    await pool.request("thread/goal/set", { threadId: parent, objective: "Parent-only paused objective", status: "paused", origin: "user" });
    const side = store.sideChats.create(parent, "admin", project.id, "selected quotation without the passphrase", "sol");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`, { headers: { cookie: createSessionCookie("admin") } });
    socket.on("message", raw => messages.push(JSON.parse(String(raw))));
    await wait(() => messages.some(message => message.type === "hello"), "socket hello");
    const send = async (message: Record<string, unknown>) => {
      socket!.send(JSON.stringify({ projectId: project.id, sideChatId: side.id, ...message }));
      await wait(() => messages.some(result => result.requestId === message.requestId && result.type === "ack"), "side acknowledgement");
      const ack = messages.find(result => result.requestId === message.requestId && result.type === "ack");
      expect(ack.ok, JSON.stringify(ack)).toBe(true);
      const turnId = ack.data.turn.turn.id;
      await wait(() => completed.has(turnId), "side turn completion");
      expect(completed.get(turnId).status, JSON.stringify(completed.get(turnId))).toBe("completed");
    };
    await send({ type: "thread.start", requestId: "side-first", prompt: "What passphrase did I give earlier? Use it here.", model: "gpt-6.1-sol", sandbox: "read-only", approvalPolicy: "never" });
    const child = store.sideChats.byId(side.id, "admin")!.threadId!;
    expect(child).not.toBe(parent);
    expect(await pool.resolveThreadAccount(child)).toMatchObject({ id: "isolated" });
    expect(JSON.stringify(requests.at(-1).input).includes("ORCHID-8271")).toBe(true);
    expect(JSON.stringify(requests.at(-1).input).includes("What passphrase did I give earlier?")).toBe(true);
    const mode = requests.at(-1).input.filter((item: any) => item.role === "developer")
      .flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "")
      .filter((text: string) => text.startsWith("<collaboration_mode>")).at(-1);
    expect(mode?.includes("# Collaboration Mode: Default")).toBe(true);
    expect(await pool.request("thread/goal/get", { threadId: child })).toMatchObject({ goal: null });
    expect(await pool.request("thread/goal/get", { threadId: parent })).toMatchObject({ goal: { objective: "Parent-only paused objective", status: "paused" } });
    await parentTurn("This newer main-only fact MUST_NOT_REACH_EXISTING_SIDE arrived after the side fork.");
    await send({ type: "turn.start", requestId: "side-next", threadId: child, prompt: "SIDE_FOLLOWUP: recall my earlier side question." });
    const input = JSON.stringify(requests.at(-1).input);
    expect(input.includes("ORCHID-8271")).toBe(true);
    expect(input.includes("What passphrase did I give earlier?")).toBe(true);
    expect(input.includes("SIDE_FOLLOWUP")).toBe(true);
    expect(input.includes("MUST_NOT_REACH_EXISTING_SIDE")).toBe(false);
    const history = await pool.request("thread/turns/list", { threadId: parent, itemsView: "full", limit: 10 });
    expect(JSON.stringify(history).includes("What passphrase did I give earlier?")).toBe(false);
    expect(JSON.stringify(history).includes("SIDE_FOLLOWUP")).toBe(false);
    expect(requests).toHaveLength(4);
  } finally {
    socket?.terminate();
    await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
    await Promise.all(runtimes.map(runtime => runtime.stopAndWait())); pool.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await new Promise(resolve => setTimeout(resolve, 30)); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
