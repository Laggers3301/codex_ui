import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticatedUserFromHeaders } from "./auth.js";
import { DEFAULT_USER_ID, type ProjectStore } from "./db.js";
import { serverConfig } from "./config.js";
import type { BrowserAction, BrowserService } from "./browserService.js";
import { browserActionSchema, browserMcpTools } from "./browserTools.js";

const MCP_PATH = "/api/browser/mcp";
const MAX_MCP_TEXT = 24_000;
type Binding = { userId: string; projectId: string; threadId: string | null };
type BindingDb = Record<string, Binding>;
let activeStore: ProjectStore | null = null;

export function browserMcpForThread(threadId: string): Record<string, unknown> {
  const owner = activeStore?.getThreadOwner(threadId);
  return owner ? mintBrowserMcpConfig(owner.userId, owner.projectId, threadId).config : {};
}

function privateDir(): string {
  const dir = path.join(serverConfig.dataDir, "browser-private");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* retain platform defaults */ }
  return dir;
}
function secret(): Buffer {
  const file = path.join(privateDir(), "mcp-secret");
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  return fs.readFileSync(file);
}
function dbPath(): string { return path.join(privateDir(), "mcp-bindings.json"); }
function loadBindings(): BindingDb {
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as BindingDb : {};
  } catch { return {}; }
}
function saveBindings(db: BindingDb): void {
  const file = dbPath(), temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(db)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}
function tokenFor(bindingId: string, binding: Binding): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, bindingId, ...binding })).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
function within(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function liveScope(binding: Binding): boolean {
  if (!activeStore) return false;
  const project = activeStore.getProject(binding.projectId, binding.userId);
  if (!project) return false;
  if (binding.threadId === null) return true;
  const owner = activeStore.getThreadOwner(binding.threadId);
  return Boolean(owner && owner.userId === binding.userId
    && activeStore.userCanAccessThread(binding.threadId, binding.userId)
    && within(project.rootPath, owner.rootPath));
}
function verifyToken(value: unknown): { bindingId: string; userId: string; projectId: string; threadId: string | null } | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const [payload, signature, ...extra] = value.split(".");
  if (!payload || !signature || extra.length) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed?.v !== 1 || typeof parsed.bindingId !== "string" || typeof parsed.userId !== "string" || typeof parsed.projectId !== "string" || !(parsed.threadId === null || typeof parsed.threadId === "string")) return null;
    const binding = loadBindings()[parsed.bindingId];
    // An initially unbound credential can be assigned exactly once by the
    // trusted thread-creation hook. A token minted for an existing thread is
    // permanently fixed to that exact thread.
    if (!binding || binding.userId !== parsed.userId || binding.projectId !== parsed.projectId
      || (parsed.threadId !== null && binding.threadId !== parsed.threadId) || !liveScope(binding)) return null;
    return { ...parsed, threadId: binding.threadId };
  } catch { return null; }
}

/** Mint a persisted, HMAC-protected MCP credential; it is never intended for the browser UI. */
export function mintBrowserMcpConfig(userId: string, projectId: string, threadId?: string): { config: Record<string, unknown>; bindingId?: string } {
  if (!userId || !projectId) throw new Error("Browser MCP scope requires a user and project.");
  const binding: Binding = { userId, projectId, threadId: threadId ?? null };
  const db = loadBindings();
  // Existing-thread credentials are stable across resume/restart, while each
  // not-yet-created conversation needs its own one-time binding capability.
  const existing = threadId
    ? Object.entries(db).find(([, value]) => value.userId === userId && value.projectId === projectId && value.threadId === threadId)
    : undefined;
  const bindingId = existing?.[0] ?? randomBytes(24).toString("base64url");
  if (!existing) { db[bindingId] = binding; saveBindings(db); }
  const token = tokenFor(bindingId, binding);
  return {
    ...(threadId ? {} : { bindingId }),
    config: { "mcp_servers.codex_browser": {
      url: `http://127.0.0.1:${serverConfig.port}${MCP_PATH}`,
      http_headers: { "x-codex-browser-token": token },
      startup_timeout_sec: 10, tool_timeout_sec: 180, enabled: true
    } }
  };
}

/** Bind a pre-thread credential once a new conversation has been created. */
export function bindBrowserMcpThread(bindingId: string, threadId: string, store: ProjectStore | null = activeStore): void {
  const db = loadBindings(), binding = db[bindingId];
  if (!binding || binding.threadId !== null || !threadId) throw new Error("Invalid browser MCP thread binding.");
  const owner = store?.getThreadOwner(threadId);
  const project = store?.getProject(binding.projectId, binding.userId);
  if (!owner || owner.userId !== binding.userId || !store?.userCanAccessThread(threadId, binding.userId)
    || !project || !within(project.rootPath, owner.rootPath)) {
    throw new Error("Browser MCP thread is outside its authorized user and project scope.");
  }
  db[bindingId] = { ...binding, threadId };
  saveBindings(db);
}

/** Used by the server's global request hook to exempt only valid MCP credentials. */
export function browserMcpAuthorized(headers: Record<string, unknown>): boolean {
  const token = headers["x-codex-browser-token"];
  return verifyToken(Array.isArray(token) ? token[0] : token) !== null;
}

class BrowserRouteError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
function statusOf(error: unknown): number {
  const code = (error as { statusCode?: unknown })?.statusCode;
  return Number.isInteger(code) && Number(code) >= 400 && Number(code) <= 599 ? Number(code) : 500;
}
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : "Browser request failed.";
}
function sendError(reply: any, error: unknown): unknown {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid browser request." });
  return reply.code(statusOf(error)).send({ error: messageOf(error) });
}
function userFor(request: FastifyRequest): string {
  const user = authenticatedUserFromHeaders(request.headers as any);
  if (!user) throw new BrowserRouteError(401, "Authentication required.");
  return user === "auth-disabled" ? DEFAULT_USER_ID : user;
}

export function registerBrowserRoutes(app: FastifyInstance, store: ProjectStore, service: BrowserService): void {
  activeStore = store;
  const context = (request: FastifyRequest) => {
    const userId = userFor(request);
    const { id: projectId, threadId } = request.params as { id: string; threadId: string };
    const project = store.getProject(projectId, userId);
    const owner = store.getThreadOwner(threadId);
    if (!project || !owner || owner.userId !== userId || !store.userCanAccessThread(threadId, userId) || !within(project.rootPath, owner.rootPath)) {
      throw new BrowserRouteError(404, "Thread not found.");
    }
    return { userId, projectId, threadId, project };
  };
  const base = "/api/projects/:id/threads/:threadId/browser";
  app.get(base, async (req, reply) => { try { const c = context(req); reply.header("Cache-Control", "no-store"); return { data: service.get(c.userId, c.threadId) }; } catch (e) { return sendError(reply, e); } });
  app.post(`${base}/open`, async (req, reply) => { try {
    const c = context(req); const body = z.object({ url: z.string().max(4096).optional(), newTab: z.boolean().optional() }).strict().parse(req.body ?? {});
    const existed = service.get(c.userId, c.threadId);
    await service.open(c.userId, c.threadId);
    await service.control(c.userId, c.threadId, "human");
    if (body.newTab && existed && existed.status !== "closed" && existed.tabs?.length) await service.action(c.userId, c.threadId, { action: "new_tab", url: body.url }, "human");
    else if (body.url?.trim()) await service.action(c.userId, c.threadId, { action: "navigate", url: body.url }, "human");
    return { data: service.get(c.userId, c.threadId) };
  } catch (e) { return sendError(reply, e); } });
  app.post(`${base}/control`, async (req, reply) => { try { const c = context(req); const body = z.object({ mode: z.enum(["human", "agent"]) }).strict().parse(req.body); return { data: await service.control(c.userId, c.threadId, body.mode) }; } catch (e) { return sendError(reply, e); } });
  app.post(`${base}/action`, async (req, reply) => { try { const c = context(req); const body = browserActionSchema.parse(req.body) as BrowserAction; const result = await service.action(c.userId, c.threadId, body, "human"); return { data: result }; } catch (e) { return sendError(reply, e); } });
  app.post(`${base}/approval`, async (req, reply) => { try { const c = context(req); const body = z.object({ id: z.string().min(1).max(200), approved: z.boolean() }).strict().parse(req.body); service.approve(c.userId, c.threadId, body.id, body.approved); return { ok: true }; } catch (e) { return sendError(reply, e); } });
  app.delete(base, async (req, reply) => { try { const c = context(req); await service.close(c.userId, c.threadId); return { ok: true }; } catch (e) { return sendError(reply, e); } });
  app.get(`${base}/frame`, async (req, reply) => { try { const c = context(req); const query = z.object({ tabId: z.string().uuid().optional() }).passthrough().parse(req.query); const frame = service.frame(c.userId, c.threadId, query.tabId); if (!frame) throw new BrowserRouteError(404, "Browser frame is unavailable."); return reply.type("image/jpeg").header("Cache-Control", "private, no-store").header("X-Frame-Version", String(frame.version)).send(frame.data); } catch (e) { return sendError(reply, e); } });

  app.post(MCP_PATH, async (req, reply) => {
    const tokenHeader = req.headers["x-codex-browser-token"];
    const token = verifyToken(Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader);
    if (!token) return reply.code(401).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized." } });
    const rpc = req.body as any;
    const id = rpc && Object.prototype.hasOwnProperty.call(rpc, "id") ? rpc.id : null;
    const fail = (code: number, message: string) => reply.send({ jsonrpc: "2.0", id, error: { code, message } });
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return fail(-32600, "Invalid JSON-RPC request.");
    if (rpc.method === "notifications/initialized") return reply.code(202).send();
    if (rpc.method === "ping") return reply.send({ jsonrpc: "2.0", id, result: {} });
    if (rpc.method === "initialize") {
      const requestedVersion = rpc.params?.protocolVersion;
      const supported = ["2025-03-26", "2024-11-05"];
      if (requestedVersion !== undefined && typeof requestedVersion !== "string") return fail(-32602, "Invalid MCP protocol version.");
      return reply.send({ jsonrpc: "2.0", id, result: { protocolVersion: supported.includes(requestedVersion) ? requestedVersion : supported[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "codex-browser", version: "1.0.0" } } });
    }
    if (rpc.method === "tools/list") return reply.send({ jsonrpc: "2.0", id, result: { tools: browserMcpTools } });
    if (rpc.method !== "tools/call") return fail(-32601, "Method not found.");
    if (rpc.params?.name !== "browser_action") return fail(-32602, "Unknown tool.");
    if (!token.threadId) return reply.send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Browser is not yet bound to a conversation." }], isError: true } });
    const db = loadBindings()[token.bindingId];
    if (!db || db.userId !== token.userId || db.projectId !== token.projectId || db.threadId !== token.threadId) return reply.code(401).send({ jsonrpc: "2.0", id, error: { code: -32001, message: "Unauthorized." } });
    try {
      const args = browserActionSchema.parse(rpc.params.arguments ?? {}) as BrowserAction;
      const result = await service.action(token.userId, token.threadId, args, "agent");
      const content: any[] = [{ type: "text", text: result.text.slice(0, MAX_MCP_TEXT) }];
      if (result.image) {
        const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(result.image);
        if (match) content.push({ type: "image", data: match[2], mimeType: match[1] });
      }
      return reply.send({ jsonrpc: "2.0", id, result: { content, isError: false } });
    } catch (error) {
      const safe = error instanceof z.ZodError ? "Invalid browser action arguments." : messageOf(error);
      return reply.send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: safe }], isError: true } });
    }
  });
}
