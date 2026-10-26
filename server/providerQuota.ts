import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { serverConfig } from "./config.js";
import { cachedProviderQuota } from "../shared/providerQuotaCache.js";
import type { FastifyInstance } from "fastify";
import type { ProviderQuotaPeriod, ProviderQuotaView } from "../shared/providerQuota.js";
const exec = promisify(execFile);

/** Classify the native CLI's bounded error text; never expose its argv, raw
 * response, headers or credentials to a browser/log. */
export function providerQuotaFailure(error: unknown): { status: "auth_required" | "unavailable"; code: string; message: string } {
  const row = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const text = [row.stderr, row.stdout, error instanceof Error ? error.message : ""].filter(v => typeof v === "string").map(v => String(v).slice(0, 16_384)).join("\n");
  if (/invalid_grant|refresh[_ -]?token.{0,60}(?:expired|revoked|invalid)|SSO token expired|not logged in/i.test(text)) {
    return {status:"auth_required",code:/invalid_grant/i.test(text)?"sso_invalid_grant":"sso_reauthorization_required",message:"Ark 官方 CLI 的 SSO 授权已失效，原生自动续签未成功；需要重新授权。保留上次额度，模型 API Key 未被修改。"};
  }
  if (row.killed === true || /ETIMEDOUT|timed?\s*out|timeout/i.test(text)) return {status:"unavailable",code:"query_timeout",message:"Ark 官方额度查询超时，正在后台重试；暂时显示缓存。"};
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|TLS handshake|network is unreachable/i.test(text)) return {status:"unavailable",code:"query_network_error",message:"Ark 官方额度查询连接失败，正在后台重试；不代表账号授权失效。"};
  return {status:"unavailable",code:"query_failed",message:"Ark 官方额度查询暂不可用，正在后台重试；保留上次成功值。"};
}

export function parseArkQuota(raw: unknown, now = new Date().toISOString()): ProviderQuotaView {
  const rows = (raw as { items?: unknown[] })?.items;
  const row = rows?.find(value => (value as { product?: string }).product === "coding-plan") as { subscribed?: boolean; periods?: unknown[] } | undefined;
  if (!row?.subscribed || !Array.isArray(row.periods)) throw new Error("No Coding Plan subscription data");
  const periods: ProviderQuotaPeriod[] = row.periods.flatMap(value => {
    const p = value as { label?: string; percent?: unknown; reset_at?: unknown };
    if (!["session", "weekly", "monthly"].includes(p.label ?? "") || typeof p.percent !== "number" || !Number.isFinite(p.percent) || p.percent < 0) return [];
    return [{ label: p.label!, usedPercent: p.percent, resetsAt: typeof p.reset_at === "string" && Number.isFinite(Date.parse(p.reset_at)) ? p.reset_at : null }];
  });
  if (!periods.length) throw new Error("Missing quota periods");
  return { id: "ark", name: "Ark", status: "ready", periods, updatedAt: now, stale: false, message: null };
}

/** One bounded control-plane query per minute, regardless of viewer count.
 * The CLI owns its SSO state; no model requests or credential-file access. */
export class ProviderQuotaCache {
  private ark: ProviderQuotaView = { id: "ark", name: "Ark", status: "loading", periods: [], updatedAt: null, stale: false, message: null };
  private pending: Promise<void> | null = null;
  private nextAttempt = 0;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private lastFailureCode: string | null = null;
  constructor(private query: () => Promise<unknown>, private clock = Date.now, private cacheFile?: string,
    private report: (event: {provider:string;event:string;code?:string;at:string}) => void = () => {}) {
    if (cacheFile) try {
      if (statSync(cacheFile).size <= 16_384) {
        const cached = cachedProviderQuota(JSON.parse(readFileSync(cacheFile, "utf8")), this.clock());
        if (cached) this.ark = cached;
      }
    } catch { /* Missing or invalid cache never blocks provider health. */ }
  }
  /** Keep the native CLI active even when nobody opens the quota popover.
   * Native CLI alone owns OAuth, locking, rotation and invalid-grant cooldown.
   * Query dates prove quota retrieval, NOT that an OAuth renewal succeeded. */
  start() {
    if (this.maintenanceTimer) return;
    this.snapshot();
    this.maintenanceTimer = setInterval(() => { this.snapshot(); }, 60_000);
    this.maintenanceTimer.unref();
  }
  stop() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }
  private async persist() {
    if (!this.cacheFile) return;
    const temporary = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(cachedProviderQuota(this.ark, this.clock())), { mode: 0o600 });
      await rename(temporary, this.cacheFile);
    } catch { await unlink(temporary).catch(() => {}); }
  }
  snapshot(): { items: ProviderQuotaView[]; loading: boolean } {
    if (!this.pending && this.clock() >= this.nextAttempt) {
      this.nextAttempt = this.clock() + 60_000;
      let queryResult: Promise<unknown>;
      try { queryResult = Promise.resolve(this.query()); }
      catch (error) { queryResult = Promise.reject(error); }
      this.pending = queryResult.then(async raw => {
        this.ark = parseArkQuota(raw, new Date(this.clock()).toISOString());
        if (this.lastFailureCode) this.report({provider:"ark",event:"quota_query_recovered",at:new Date(this.clock()).toISOString()});
        this.lastFailureCode = null;
        await this.persist();
      }).catch(error => {
        const failure = providerQuotaFailure(error);
        this.ark = { ...this.ark, status: failure.status, stale: this.ark.periods.length > 0, message: failure.message };
        if (failure.code !== this.lastFailureCode) this.report({provider:"ark",event:"quota_query_failed",code:failure.code,at:new Date(this.clock()).toISOString()});
        this.lastFailureCode = failure.code;
      }).finally(() => { this.pending = null; });
    }
    return { items: [this.ark, { id: "mimo", name: "MiMo", status: "auth_required", periods: [], updatedAt: null, stale: false,
      message: "MiMo 用量查询需要独立的控制台登录授权；现有模型 API Key 不能替代此登录态。当前尚未接入该授权流程。" }], loading: Boolean(this.pending) };
  }
}

export function registerProviderQuotaRoutes(app: FastifyInstance, authorize: (request: { headers: Record<string, unknown> }) => unknown, cache?: ProviderQuotaCache) {
  const cli = process.env.CODEX_WEB_ARKCLI_BIN || "arkcli";
  const quota = cache ?? new ProviderQuotaCache(async () => {
    const { stdout } = await exec(cli, ["usage", "plan", "--product", "coding-plan", "--format", "json"], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout);
  }, Date.now, path.join(serverConfig.dataDir, "provider-quota-cache.json"), event => app.log.warn(event, "Provider quota maintenance"));
  if (!cache) {
    app.addHook("onReady", async () => { quota.start(); });
    app.addHook("onClose", async () => { quota.stop(); });
  }
  app.get("/api/codex/provider-quotas", async (request, reply) => {
    authorize(request);
    reply.header("Cache-Control", "no-store");
    return { data: quota.snapshot() };
  });
}
