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
  constructor(private query: () => Promise<unknown>, private clock = Date.now, private cacheFile?: string) {
    if (cacheFile) try {
      if (statSync(cacheFile).size <= 16_384) {
        const cached = cachedProviderQuota(JSON.parse(readFileSync(cacheFile, "utf8")), this.clock());
        if (cached) this.ark = cached;
      }
    } catch { /* Missing or invalid cache never blocks provider health. */ }
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
      this.pending = queryResult.then(async raw => { this.ark = parseArkQuota(raw, new Date(this.clock()).toISOString()); await this.persist(); }).catch(() => {
        this.ark = { ...this.ark, status: "unavailable", stale: this.ark.periods.length > 0, message: "额度读取暂不可用，请检查官方 CLI 授权或稍后重试。" };
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
  }, Date.now, path.join(serverConfig.dataDir, "provider-quota-cache.json"));
  app.get("/api/codex/provider-quotas", async (request, reply) => {
    authorize(request);
    reply.header("Cache-Control", "no-store");
    return { data: quota.snapshot() };
  });
}
