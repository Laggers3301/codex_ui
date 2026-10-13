import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticatedUserFromHeaders } from "./auth.js";
import { serverConfig } from "./config.js";

// One generic release identifier, not a pet-specific UI message. Publishing a
// different version reuses the same dot; viewing it never alters chat records.
const initialVersion = "2026-10-03-shared-pets";
const validVersion = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
function root(): string { return path.resolve(process.env.CODEX_WEB_UI_UPDATE_DIR ?? path.join(serverConfig.dataDir, "ui-updates")); }
class UpdateError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
function userFor(request: FastifyRequest): string {
  const user = authenticatedUserFromHeaders(request.headers as any);
  if (!user || user === "auth-disabled") throw new UpdateError(401, "需要登录后查看更新状态。");
  return user;
}
function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new UpdateError(503, "更新状态暂时不可用。"); }
}
function release(): { version: string; targets?: string[]; notice?: string } {
  const release = readJson(path.join(root(), "release.json"));
  if (release === undefined) return { version: initialVersion };
  if (!validVersion(release?.version)) throw new UpdateError(503, "更新版本记录异常。");
  return release;
}
function seenFile(user: string): string { return path.join(root(), "seen", `${createHash("sha256").update(user).digest("hex")}.json`); }
function state(user: string, target = "account"): { version: string; hasUnseen: boolean; notice?: string } {
  const current = release(), version = current.version, seen = readJson(seenFile(user));
  if (seen !== undefined && !validVersion(seen?.version)) throw new UpdateError(503, "已读更新记录异常。");
  const active = (current.targets ?? ["account"]).includes(target);
  return { version, hasUnseen: active && (target === "account" ? seen?.version : seen?.targets?.[target]) !== version, ...(current.notice ? { notice: current.notice } : {}) };
}
function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.update-${randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Local administrator publication only; no client can publish a global update. */
export function publishUiUpdate(version: string, targets?: string[], notice?: string): void {
  if (!validVersion(version)) throw new UpdateError(400, "更新版本标识不合法。");
  if (targets?.some(t => !["account", "plugins", "feishu"].includes(t))) throw new UpdateError(400, "更新入口不合法。");
  atomicJson(path.join(root(), "release.json"), { version, ...(targets ? { targets } : {}), ...(notice ? { notice: notice.slice(0, 500) } : {}), publishedAt: new Date().toISOString() });
}

export function registerUiUpdateRoutes(app: FastifyInstance): void {
  const error = (reply: any, e: unknown) => reply.code(e instanceof UpdateError ? e.statusCode : 500).send({ error: e instanceof UpdateError ? e.message : "无法保存更新状态。" });
  app.get<{ Querystring: { target?: string } }>("/api/ui-updates", async (request, reply) => {
    try { reply.header("Cache-Control", "no-store"); return state(userFor(request), request.query.target); }
    catch (e) { return error(reply, e); }
  });
  app.post<{ Body: { version?: unknown; target?: string } }>("/api/ui-updates/seen", async (request, reply) => {
    try {
      const user = userFor(request), version = request.body?.version;
      if (!validVersion(version)) throw new UpdateError(400, "更新版本标识不合法。");
      const target = request.body.target ?? "account";
      if (!["account", "plugins", "feishu"].includes(target)) throw new UpdateError(400, "更新入口不合法。");
      const current = state(user, target);
      if (current.version !== version) return reply.header("Cache-Control", "no-store").send(current);
      if (current.hasUnseen) {
        const prior = readJson(seenFile(user)) ?? {};
        atomicJson(seenFile(user), { ...prior, version: target === "account" ? version : prior.version ?? initialVersion, targets: { ...prior.targets, [target]: version }, seenAt: new Date().toISOString() });
      }
      reply.header("Cache-Control", "no-store");
      return state(user, target);
    } catch (e) { return error(reply, e); }
  });
}
