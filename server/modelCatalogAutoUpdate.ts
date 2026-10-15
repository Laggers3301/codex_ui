import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AccountPoolBridge, ModelCatalogTarget } from "./accountPoolBridge.js";
import { defaults, serverConfig } from "./config.js";
import {applyPoolContextDefaults} from "./modelContextDefaults.js";

const execFileAsync = promisify(execFile);
const MAX_CATALOG_BYTES = 1024 * 1024;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";

type JsonRecord = Record<string, unknown>;

type CatalogFetchResult =
  | { status: "not-modified"; etag: string | null }
  | { status: "updated"; etag: string | null; catalogText: string };

export interface ModelCatalogUpdateLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function catalogModels(value: unknown): JsonRecord[] {
  const models = asRecord(value).models;
  if (!Array.isArray(models) || models.length < 3) throw new Error("上游模型目录为空或不完整。");
  const slugs = new Set<string>();
  const records = models.map((entry) => {
    const model = asRecord(entry);
    const slug = typeof model.slug === "string" ? model.slug.trim() : "";
    if (!slug || slugs.has(slug)) throw new Error("上游模型目录包含空或重复的模型标识。");
    slugs.add(slug);
    return model;
  });
  const visible = records.filter((model) => model.visibility === "list");
  if (!visible.some((model) => model.slug === defaults.model)) {
    throw new Error(`上游目录未列出服务默认模型 ${defaults.model}，已保留当前目录。`);
  }
  return records;
}

function jwtExpiryMilliseconds(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function codexClientVersion(versionOutput: string): string {
  const match = versionOutput.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/);
  if (!match) throw new Error("无法识别 Codex 客户端版本。");
  return match[1];
}

async function normalizeCatalog(rawCatalog: unknown): Promise<string> {
  catalogModels(rawCatalog);
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-"));
  const rawPath = path.join(temporaryHome, "remote.json");
  try {
    fs.writeFileSync(rawPath, JSON.stringify(rawCatalog), { mode: 0o600 });
    const { stdout } = await execFileAsync(serverConfig.codexBin, [
      "debug", "models", "-c", `model_catalog_json=${JSON.stringify(rawPath)}`
    ], {
      env: { ...process.env, CODEX_HOME: temporaryHome },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    });
    const normalized = JSON.parse(stdout);
    catalogModels(normalized);
    applyPoolContextDefaults(normalized);
    return `${JSON.stringify(normalized, null, 2)}\n`;
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
}

async function fetchCatalog(target: ModelCatalogTarget, clientVersion: string, etag: string | undefined): Promise<CatalogFetchResult> {
  const authPath = path.join(target.codexHome, "auth.json");
  const authStat = fs.statSync(authPath);
  if (!authStat.isFile() || authStat.size > 1024 * 1024) throw new Error("账号凭据文件不可用。");
  const auth = asRecord(JSON.parse(fs.readFileSync(authPath, "utf8")));
  const tokens = asRecord(auth.tokens);
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id.trim() : "";
  if (!accessToken || !accountId || /[\r\n]/.test(accountId)) throw new Error("账号缺少可用的模型目录访问凭据。");
  const expiry = jwtExpiryMilliseconds(accessToken);
  if (expiry !== null && expiry <= Date.now() + 60_000) {
    throw new Error("账号访问令牌已过期；等待原生运行时续期后重试。");
  }

  const url = new URL(MODELS_ENDPOINT);
  url.searchParams.set("client_version", clientVersion);
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "user-agent": `codex_cli_rs/${clientVersion}`,
    originator: "codex_cli_rs"
  };
  if (etag) headers["if-none-match"] = etag;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const nextEtag = response.headers.get("etag");
  if (response.status === 304) return { status: "not-modified", etag: nextEtag ?? etag ?? null };
  if (!response.ok) throw new Error(`上游模型目录请求失败（HTTP ${response.status}）。`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) throw new Error("上游模型目录超过 1 MiB 安全限制。");
  const rawCatalog = JSON.parse(text);
  return { status: "updated", etag: nextEtag, catalogText: await normalizeCatalog(rawCatalog) };
}

export class ModelCatalogAutoUpdater {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private nextRefreshAt = 0;
  private readonly etags = new Map<string, string>();
  private readonly pendingCatalogs = new Map<string, string>();
  private clientVersion: string | null = null;

  constructor(
    private readonly pool: AccountPoolBridge,
    private readonly intervalMs: number,
    private readonly logger: ModelCatalogUpdateLogger,
    private readonly onApplied: () => void
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, Math.min(60_000, this.intervalMs));
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async version(): Promise<string> {
    if (this.clientVersion) return this.clientVersion;
    const { stdout } = await execFileAsync(serverConfig.codexBin, ["--version"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024
    });
    this.clientVersion = codexClientVersion(stdout);
    return this.clientVersion;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runTick(): Promise<void> {
    let refreshFailed = false;
    if (Date.now() >= this.nextRefreshAt) {
      const version = await this.version();
      for (const target of this.pool.modelCatalogTargets()) {
        try {
          const result = await fetchCatalog(target, version, this.etags.get(target.id));
          if (result.etag) this.etags.set(target.id, result.etag);
          if (result.status === "updated") {
            const current = fs.existsSync(target.catalogPath) ? fs.readFileSync(target.catalogPath, "utf8") : "";
            if (current !== result.catalogText) this.pendingCatalogs.set(target.id, result.catalogText);
          }
        } catch (error) {
          refreshFailed = true;
          this.logger.warn({ accountId: target.id, error: error instanceof Error ? error.message : String(error) }, "自动更新模型目录失败；保留当前目录");
        }
      }
      this.nextRefreshAt = Date.now() + (refreshFailed ? Math.min(this.intervalMs, RETRY_INTERVAL_MS) : this.intervalMs);
    }

    for (const [accountId, catalogText] of this.pendingCatalogs) {
      try {
        const result = await this.pool.applyModelCatalogIfIdle(accountId, catalogText);
        if (result === "busy") continue;
        this.pendingCatalogs.delete(accountId);
        if (result === "reloaded") {
          this.onApplied();
          this.logger.info({ accountId }, "模型目录已自动更新并重载账号运行时");
        }
      } catch (error) {
        this.logger.warn({ accountId, error: error instanceof Error ? error.message : String(error) }, "模型目录重载失败；稍后重试");
      }
    }
  }
}
