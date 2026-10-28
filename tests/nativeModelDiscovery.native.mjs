// Run with CODEX_NATIVE_TEST_BIN=/path/to/codex node --import tsx/esm tests/nativeModelDiscovery.native.mjs.
// Every request, credential, configuration and database belongs to this fixture.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { CodexBridge } from "../server/codexBridge.ts";
import { accountAppServerArgs } from "../server/accountPoolBridge.ts";

const binary = process.env.CODEX_NATIVE_TEST_BIN;
assert.ok(binary, "Set CODEX_NATIVE_TEST_BIN to a compatible native Codex executable.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-model-discovery-wire-"));
const home = path.join(root, "runtime"), shapeHome = path.join(root, "shape"), parent = path.join(root, "parent"), cwd = path.join(parent, "workspace");
await Promise.all([home, shapeHome, cwd].map(directory => fs.mkdir(directory, { recursive: true })));
const baseEnvironment = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8" };
const shape = JSON.parse(execFileSync(binary, ["debug", "models", "-c", "project_root_markers=[]"], {
  cwd: root, env: { ...baseEnvironment, CODEX_HOME: shapeHome }, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024
}));
const model = structuredClone(shape.models.find(entry => entry.slug === "gpt-6.1-sol") ?? shape.models[0]);
Object.assign(model, { slug: "gpt-6.1-sol", display_name: "Native proxy cache fixture", visibility: "list", tool_mode: "code_mode_only", experimental_supported_tools: ["send_user_message_async", "clock"], use_responses_lite: true });
const staleCatalog = path.join(root, "old-models.json");
await fs.writeFile(staleCatalog, JSON.stringify({ models: [{ ...model, slug: "fixture-old-model", experimental_supported_tools: [] }] }));
execFileSync("git", ["init", "--quiet", parent]);
await fs.mkdir(path.join(parent, ".codex"));
const ancestorConfig = `model_catalog_json=${JSON.stringify(staleCatalog)}\n`;
await fs.writeFile(path.join(parent, ".codex/config.toml"), ancestorConfig);
const uiCatalog = path.join(home, "model-catalog-gpt-5.6-sol-long-context.json");
const uiCatalogText = JSON.stringify({ models: [{ ...model, slug: "provider-kept-by-ui" }] });
await fs.writeFile(uiCatalog, uiCatalogText);
const originalConfig = `model="gpt-6.1-sol"\nmodel_catalog_json=${JSON.stringify(staleCatalog)}\n[projects.${JSON.stringify(parent)}]\ntrust_level="trusted"\n`;
await fs.writeFile(path.join(home, "config.toml"), originalConfig);
const token = claims => Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url") + "." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".fixture";
const claims = { sub: "native-fixture-user", email: "fixture@example.invalid", exp: Math.floor(Date.now() / 1000) + 86400, "https://api.openai.com/auth": { chatgpt_account_id: "native-fixture-account", chatgpt_plan_type: "plus" } };
await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: token(claims), access_token: token(claims), refresh_token: "local-fixture-refresh", account_id: "native-fixture-account" }, last_refresh: new Date().toISOString() }), { mode: 0o600 });

let catalogOffline = false, nextTool = null, serial = 0;
const catalogRequests = [], modelRequests = [], nativeQuestions = [], connects = [];
const fixtureErrors = [];
const proxy = http.createServer(async (request, response) => {
 try {
  const url = new URL(request.url, "http://fixture.invalid");
  if (request.method === "GET" && url.pathname.endsWith("/models")) {
    catalogRequests.push(request.url);
    response.writeHead(catalogOffline ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(catalogOffline ? { error: "fixture catalog offline" } : { models: [model] })); return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/responses") { response.writeHead(404); response.end(); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  let body = Buffer.concat(chunks);
  if (request.headers["content-encoding"] === "zstd") body = zlib.zstdDecompressSync(body);
  else if (request.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
  modelRequests.push(JSON.parse(body.toString("utf8")));
  const number = ++serial, name = nextTool; nextTool = null;
  const argumentsValue = name === "request_user_input_async"
    ? { questions: [{ title: "隔离测试：选择结果", options: ["甲", "乙"] }] }
    : { questions: [{ id: "choice", header: "测试", question: "隔离测试：选择结果", options: [{ label: "甲", description: "第一个结果" }, { label: "乙", description: "第二个结果" }] }] };
  const item = name
    ? { id: "fc_" + number, type: "function_call", call_id: "call_" + number, name, arguments: JSON.stringify(argumentsValue), status: "completed" }
    : { id: "msg_" + number, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "native-fixture-complete", annotations: [] }] };
  const result = { id: "resp_" + number, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: "gpt-6.1-sol", output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  response.writeHead(200, { "Content-Type": "text/event-stream" }); let sequence = 0;
  const emit = (type, fields) => response.write("event: " + type + "\ndata: " + JSON.stringify({ type, sequence_number: sequence++, ...fields }) + "\n\n");
  emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
  emit("response.output_item.added", { output_index: 0, item: name ? { ...item, status: "in_progress", arguments: "" } : { ...item, status: "in_progress", content: [] } });
  if (name) {
    emit("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments });
    emit("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments });
  } else {
    emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "native-fixture-complete" });
    emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "native-fixture-complete" });
    emit("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  }
  emit("response.output_item.done", { output_index: 0, item }); emit("response.completed", { response: result }); response.end();
 } catch (error) {
  fixtureErrors.push(String(error));
  if (!response.headersSent) response.writeHead(500);
  response.end();
 }
});
proxy.on("connect", (request, socket) => { connects.push(request.url); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const env = { ...baseEnvironment, CODEX_HOME: home, OPENAI_BASE_URL: "http://native-discovery.invalid/v1", http_proxy: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, HTTPS_PROXY: proxyUrl };
const args = () => [...accountAppServerArgs(home), "-c", 'openai_base_url="http://native-discovery.invalid/v1"'];
let bridge;
let nativeStderr = "";
const startBridge = async () => {
  bridge = new CodexBridge({ command: binary, args: args(), env, nativeModelDiscoveryHome: home });
  bridge.on("stderr", chunk => { nativeStderr = (nativeStderr + chunk).slice(-3000); });
  bridge.on("serverRequest", request => {
    if (request.method !== "item/tool/requestUserInput") return;
    nativeQuestions.push(request);
    bridge.respondToServerRequest(request.id, { answers: Object.fromEntries(request.params.questions.map(question => [question.id, { answers: ["甲"] }])) });
  });
  await bridge.start();
};
const runTurn = async (threadId, tool) => {
  nextTool = tool;
  let timer, accept;
  const done = new Promise((resolve, reject) => {
    accept = event => { if (event.method === "turn/completed" && event.params.threadId === threadId) resolve(event.params.turn); };
    bridge.on("notification", accept);
    timer = setTimeout(() => reject(new Error("native fixture turn timeout")), 20000);
  });
  try {
    await bridge.request("turn/start", { threadId, input: [{ type: "text", text: "隔离验证提问工具", text_elements: [] }], collaborationMode: { mode: "default", settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null } } });
    assert.equal((await done).status, "completed");
  } finally { clearTimeout(timer); bridge.off("notification", accept); }
};

try {
  await startBridge();
  const list = await bridge.request("model/list", { includeHidden: true, refresh: true });
  if (!JSON.stringify(list).includes(model.display_name)) console.log(JSON.stringify({ catalogRequests, connects }));
  assert.ok(JSON.stringify(list).includes(model.display_name), "native model/list uses the fetched catalog");
  assert.ok(catalogRequests.some(url => { const value = new URL(url); return value.hostname === "native-discovery.invalid" && value.pathname.endsWith("/models") && value.searchParams.has("client_version"); }), "the native model request traversed the configured proxy");
  const thread = await bridge.request("thread/start", { cwd, model: "gpt-6.1-sol", approvalPolicy: "never", sandbox: "read-only" });
  await runTurn(thread.thread.id, "request_user_input_async");
  const outputs = () => modelRequests.flatMap(request => (request.input ?? []).filter(item => item.type === "function_call_output").map(item => item.output));
  assert.ok(outputs().some(output => String(output).includes('"accepted":true')));
  await runTurn(thread.thread.id, "request_user_input");
  assert.equal(nativeQuestions.length, 1, "Default-mode synchronous input reaches the native client");
  assert.ok(outputs().some(output => String(output).includes('"甲"')));
  assert.ok(!JSON.stringify(modelRequests).includes("unavailable in Default mode"));
  const cacheFiles = (await fs.readdir(home)).filter(name => /^models_cache.*\.json$/.test(name));
  assert.ok(cacheFiles.length, "Codex writes its own model cache");
  const cacheBefore = await Promise.all(cacheFiles.map(async name => ({ name, data: JSON.parse(await fs.readFile(path.join(home, name), "utf8")) })));
  const cacheBytes = await Promise.all(cacheFiles.map(name => fs.readFile(path.join(home, name))));
  // The UI's independent static-catalog probe must not poison native caches.
  const picker = JSON.parse(execFileSync(binary, ["debug", "models", "-c", `model_catalog_json=${JSON.stringify(uiCatalog)}`], { cwd, env, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 }));
  assert.ok(picker.models.some(value => value.slug === "provider-kept-by-ui"));
  for (const [index, name] of cacheFiles.entries()) assert.deepEqual(await fs.readFile(path.join(home, name)), cacheBytes[index]);
  await bridge.stopAndWait();
  catalogOffline = true;
  await startBridge();
  const cached = await bridge.request("model/list", { includeHidden: true });
  if (!JSON.stringify(cached).includes(model.display_name)) console.log(JSON.stringify({ cacheDiagnostic: cacheBefore.map(({ name, data }) => ({ name, keys: Object.keys(data), fetched_at: data.fetched_at, client_version: data.client_version, models: data.models?.map(value => ({ slug: value.slug, display_name: value.display_name })) })), catalogRequests, cachedModels: cached.data?.map(value => ({ id: value.id, model: value.model, displayName: value.displayName })) }));
  assert.ok(JSON.stringify(cached).includes(model.display_name), "a restart retains the native cache while catalog networking is unavailable");
  await bridge.request("thread/resume", { threadId: thread.thread.id, cwd, model: "gpt-6.1-sol", approvalPolicy: "never", sandbox: "read-only" });
  await runTurn(thread.thread.id, "request_user_input_async");
  assert.equal(await fs.readFile(uiCatalog, "utf8"), uiCatalogText);
  assert.equal(await fs.readFile(path.join(parent, ".codex/config.toml"), "utf8"), ancestorConfig);
  const migrated = await fs.readFile(path.join(home, "config.toml"), "utf8");
  assert.ok(!migrated.includes("model_catalog_json"));
  const backups = (await fs.readdir(home)).filter(name => name.includes("before-native-model-discovery"));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(home, backups[0]), "utf8"), originalConfig);
  assert.deepEqual(fixtureErrors, []);
  console.log(JSON.stringify({ nativeVersion: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), isolatedHome: true, localModelOnly: true, nativeRemoteDiscoveryViaProxy: true, nativeCacheReusedOnRestart: true, persistedConversationResumedOffline: true, asyncQuestionAccepted: true, synchronousQuestionInDefault: true, enclosingGitConfigIsolated: true, uiAndProviderCatalogPreserved: true, uiProbeDoesNotPoisonNativeCache: true, privateMigrationBackedUp: true, modelRequests: modelRequests.length }));
} catch (error) {
  console.error(nativeStderr);
  throw error;
} finally {
  await bridge?.stopAndWait();
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
