import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { CodexBridge } from "./codexBridge.js";
import { serverConfig } from "./config.js";

type JsonRecord = Record<string, unknown>;

export interface AccountPoolEntryConfig {
  id: string;
  label: string;
  codexHome: string;
  enabled?: boolean;
}

interface AccountPoolFile {
  accounts: AccountPoolEntryConfig[];
  stateFile?: string;
  quotaCacheMs?: number;
}

interface PersistedPoolState {
  threadAccounts?: Record<string, string>;
}

export interface AccountPoolRawSnapshot {
  id: string;
  label: string;
  health: "ready" | "degraded" | "starting";
  selectedForNewThreads: boolean;
  assignedThreadCount: number;
  activeRequests: number;
  lastError: string | null;
  lastCheckedAt: string | null;
  account: unknown;
  limits: unknown;
  usage: unknown;
  errors: string[];
}

interface CachedAccountData {
  account: unknown;
  limits: unknown;
  usage: unknown;
  errors: string[];
  expiresAt: number;
}

interface AccountRuntime {
  id: string;
  label: string;
  codexHome: string;
  bridge: CodexBridge;
  health: "ready" | "degraded" | "starting";
  activeRequests: number;
  lastError: string | null;
  lastCheckedAt: string | null;
  cache: CachedAccountData | null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function safeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`Invalid account pool ${field}.`);
  }
  return value;
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Invalid account pool label.");
  }
  return value.trim();
}

function safeAbsoluteDirectory(value: unknown, field: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`Invalid account pool ${field}.`);
  }
  const resolved = path.resolve(value);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Invalid account pool ${field}.`);
  }
  return resolved;
}

function rawRateWindow(limits: unknown): JsonRecord {
  const root = asRecord(limits);
  const snapshot = asRecord(root.rateLimits);
  const primary = asRecord(snapshot.primary);
  if (Object.keys(primary).length) {
    return primary;
  }
  return asRecord(root.primary);
}

function remainingPercent(limits: unknown): number {
  const used = rawRateWindow(limits).usedPercent;
  return typeof used === "number" && Number.isFinite(used)
    ? Math.max(0, Math.min(100, 100 - used))
    : -1;
}

export interface AccountRoutingCandidate {
  id: string;
  health: "ready" | "degraded" | "starting";
  remainingPercent: number;
  activeRequests: number;
  assignedThreadCount: number;
}

/**
 * Deterministic, side-effect-free account selection used by the live bridge and
 * by policy regression tests. Quota balance is the primary goal; concurrency
 * and existing assignment count only break equal-quota ties.
 */
export function selectAccountCandidate<T extends AccountRoutingCandidate>(accounts: readonly T[]): T {
  if (!accounts.length) throw new Error("The Codex account pool has no routing candidates.");
  const healthy = accounts.filter((account) => account.health !== "degraded");
  const candidates = healthy.length ? healthy : accounts;
  return [...candidates].sort((left, right) => {
    const remainingDifference = right.remainingPercent - left.remainingPercent;
    if (remainingDifference) return remainingDifference;
    if (left.activeRequests !== right.activeRequests) return left.activeRequests - right.activeRequests;
    return left.assignedThreadCount - right.assignedThreadCount;
  })[0];
}

function threadIdFromParams(params: unknown): string | null {
  const record = asRecord(params);
  return typeof record.threadId === "string" && record.threadId ? record.threadId : null;
}

function threadIdFromStartResult(value: unknown): string | null {
  const root = asRecord(value);
  const thread = asRecord(root.thread);
  return typeof thread.id === "string" && thread.id ? thread.id : null;
}

function processIdFromParams(params: unknown): string | null {
  const value = asRecord(params).processId;
  return typeof value === "string" && value ? value : null;
}

/**
 * One local app-server per CODEX_HOME. New conversations go to the healthiest
 * account with the most remaining quota; every existing thread stays pinned to
 * its original account so prompt-cache and server-side conversation state are
 * never lost by round-robin routing.
 */
export class AccountPoolBridge extends EventEmitter {
  private readonly accounts: AccountRuntime[];
  private readonly accountsById = new Map<string, AccountRuntime>();
  private readonly threadAccounts = new Map<string, string>();
  private readonly processAccounts = new Map<string, string>();
  private readonly serverRequestAccounts = new Map<number | string, { account: AccountRuntime; originalId: number | string }>();
  private readonly stateFile: string;
  private readonly quotaCacheMs: number;
  private accountRefreshInFlight: Promise<void> | null = null;
  private accountRefreshCompletedAt = 0;
  private nextServerRequestId = 1;

  static fromFile(filePath: string): AccountPoolBridge {
    const absolute = path.resolve(filePath);
    const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as AccountPoolFile;
    if (!parsed || !Array.isArray(parsed.accounts)) {
      throw new Error("Invalid account pool file.");
    }
    return new AccountPoolBridge(parsed, path.dirname(absolute));
  }

  constructor(config: AccountPoolFile, configDirectory = process.cwd()) {
    super();
    const enabled = config.accounts.filter((entry) => entry.enabled !== false);
    if (!enabled.length) {
      throw new Error("The Codex account pool has no enabled accounts.");
    }
    this.stateFile = path.resolve(configDirectory, config.stateFile ?? "account-pool-state.json");
    this.quotaCacheMs = Number.isInteger(config.quotaCacheMs) && Number(config.quotaCacheMs) >= 5_000
      ? Number(config.quotaCacheMs)
      : 30_000;

    this.accounts = enabled.map((entry) => {
      const id = safeIdentifier(entry.id, "account id");
      if (this.accountsById.has(id)) {
        throw new Error("Duplicate account pool account id.");
      }
      const codexHome = safeAbsoluteDirectory(entry.codexHome, "CODEX_HOME");
      const bridge = new CodexBridge({
        command: serverConfig.codexBin,
        args: ["app-server", "--listen", "stdio://"],
        env: { ...process.env, CODEX_HOME: codexHome }
      });
      const runtime: AccountRuntime = {
        id,
        label: safeLabel(entry.label),
        codexHome,
        bridge,
        health: "starting",
        activeRequests: 0,
        lastError: null,
        lastCheckedAt: null,
        cache: null
      };
      this.accountsById.set(id, runtime);
      this.forwardEvents(runtime);
      return runtime;
    });
    this.loadState();
  }

  private forwardEvents(account: AccountRuntime): void {
    account.bridge.on("notification", (message) => {
      this.emit("notification", { ...asRecord(message), accountId: account.id, accountLabel: account.label });
    });
    account.bridge.on("serverRequest", (request) => {
      const original = asRecord(request);
      const originalId = original.id as number | string;
      const id = `pool-${this.nextServerRequestId++}`;
      this.serverRequestAccounts.set(id, { account, originalId });
      this.emit("serverRequest", { ...original, id, accountId: account.id, accountLabel: account.label });
    });
    account.bridge.on("status", (status) => {
      const state = asRecord(status).state;
      account.health = state === "ready" ? "ready" : state === "exited" ? "degraded" : account.health;
      this.emit("status", { ...asRecord(status), accountId: account.id, accountLabel: account.label });
    });
    account.bridge.on("stderr", (message) => this.emit("stderr", `[${account.id}] ${String(message)}`));
    account.bridge.on("errorEvent", (message) => {
      account.health = "degraded";
      account.lastError = String(message);
      this.emit("errorEvent", `[${account.id}] ${String(message)}`);
    });
  }

  private loadState(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as PersistedPoolState;
      for (const [threadId, accountId] of Object.entries(parsed.threadAccounts ?? {})) {
        if (threadId && this.accountsById.has(accountId)) {
          this.threadAccounts.set(threadId, accountId);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Unable to read the Codex account-pool state.");
      }
    }
  }

  private persistState(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ threadAccounts: Object.fromEntries(this.threadAccounts) }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(this.accounts.map(async (account) => {
      await account.bridge.start();
      account.health = "ready";
    }));
    if (results.every((result) => result.status === "rejected")) {
      throw new Error("No Codex account in the pool could start.");
    }
    await this.refreshAccountData(false);
  }

  stop(): void {
    for (const account of this.accounts) {
      account.bridge.stop();
    }
  }

  getPendingServerRequests(): Array<{ id: number | string; method: string; params: unknown; receivedAt: string }> {
    return Array.from(this.serverRequestAccounts.entries()).map(([id, route]) => {
      const original = route.account.bridge.getPendingServerRequests().find((item) => item.id === route.originalId);
      return original ? { ...original, id } : null;
    }).filter((item): item is { id: number | string; method: string; params: unknown; receivedAt: string } => Boolean(item));
  }

  notify(method: string, params?: unknown): void {
    void this.accountForRequest(method, params).then((account) => account.bridge.notify(method, params));
  }

  respondToServerRequest(id: number | string, result: unknown): void {
    const route = this.serverRequestAccounts.get(id);
    if (!route) throw new Error(`Unknown Codex server request: ${id}`);
    this.serverRequestAccounts.delete(id);
    route.account.bridge.respondToServerRequest(route.originalId, result);
  }

  rejectServerRequest(id: number | string, message: string): void {
    const route = this.serverRequestAccounts.get(id);
    if (!route) throw new Error(`Unknown Codex server request: ${id}`);
    this.serverRequestAccounts.delete(id);
    route.account.bridge.rejectServerRequest(route.originalId, message);
  }

  async request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (method === "thread/list") {
      return this.listThreads(params, timeoutMs);
    }

    const account = await this.accountForRequest(method, params);
    account.activeRequests += 1;
    try {
      const result = await account.bridge.request(method, params, timeoutMs);
      account.health = "ready";
      account.lastError = null;
      if (method === "thread/start") {
        const threadId = threadIdFromStartResult(result);
        if (threadId) {
          this.threadAccounts.set(threadId, account.id);
          this.persistState();
        }
      }
      if (method === "command/exec") {
        const processId = processIdFromParams(params);
        if (processId) this.processAccounts.set(processId, account.id);
      }
      return result;
    } catch (error) {
      account.health = "degraded";
      account.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      account.activeRequests -= 1;
    }
  }

  private async accountForRequest(method: string, params: unknown): Promise<AccountRuntime> {
    const threadId = threadIdFromParams(params);
    if (threadId) {
      const known = this.accountsById.get(this.threadAccounts.get(threadId) ?? "");
      if (known) return known;
      return this.discoverThreadAccount(threadId);
    }
    const processId = processIdFromParams(params);
    const processAccount = processId ? this.accountsById.get(this.processAccounts.get(processId) ?? "") : undefined;
    if (processAccount) return processAccount;
    return this.chooseAccount();
  }

  private async discoverThreadAccount(threadId: string): Promise<AccountRuntime> {
    const attempts = await Promise.allSettled(this.accounts.map(async (account) => {
      await account.bridge.request("thread/read", { threadId, includeTurns: false }, 30_000);
      return account;
    }));
    const matches = attempts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!matches.length) throw new Error("Codex thread was not found in any configured account.");
    const account = matches[0];
    this.threadAccounts.set(threadId, account.id);
    this.persistState();
    return account;
  }

  private chooseAccount(): AccountRuntime {
    const selected = selectAccountCandidate(this.accounts.map((account) => ({
      id: account.id,
      health: account.health,
      remainingPercent: remainingPercent(account.cache?.limits),
      activeRequests: account.activeRequests,
      assignedThreadCount: this.assignedThreadCount(account.id)
    })));
    return this.accountsById.get(selected.id)!;
  }

  private assignedThreadCount(accountId: string): number {
    let count = 0;
    for (const value of this.threadAccounts.values()) if (value === accountId) count += 1;
    return count;
  }

  private async listThreads(params: unknown, timeoutMs: number): Promise<unknown> {
    const root = asRecord(params);
    const requestedLimit = typeof root.limit === "number" && root.limit > 0 ? Math.min(500, Math.floor(root.limit)) : 100;
    const pages = await Promise.allSettled(this.accounts.map(async (account) => {
      const data: unknown[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const value = asRecord(await account.bridge.request("thread/list", { ...root, cursor, limit: requestedLimit }, timeoutMs));
        const threads = Array.isArray(value.data) ? value.data : [];
        for (const thread of threads) {
          const threadId = asRecord(thread).id;
          if (typeof threadId === "string" && threadId) this.threadAccounts.set(threadId, account.id);
          data.push(thread);
        }
        cursor = typeof value.nextCursor === "string" && value.nextCursor ? value.nextCursor : null;
        if (cursor && seen.has(cursor)) throw new Error("Codex returned a repeated account-pool cursor.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return data;
    }));
    const fulfilled = pages.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!fulfilled.length && pages.every((result) => result.status === "rejected")) {
      throw new Error("No account could list Codex threads.");
    }
    this.persistState();
    fulfilled.sort((left, right) => {
      const leftRecord = asRecord(left);
      const rightRecord = asRecord(right);
      const leftTime = Date.parse(String(leftRecord.updatedAt ?? leftRecord.createdAt ?? 0));
      const rightTime = Date.parse(String(rightRecord.updatedAt ?? rightRecord.createdAt ?? 0));
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
    return { data: fulfilled, nextCursor: null, backwardsCursor: null };
  }

  async refreshAccountData(force = false): Promise<AccountPoolRawSnapshot[]> {
    const now = Date.now();
    // Treat rapid repeated force=true requests as one user-visible refresh.
    // This still permits an intentional refresh after a short cooldown while
    // preventing a second burst wave from starting another six RPCs.
    const forceRefresh = force && now - this.accountRefreshCompletedAt >= 5_000;
    const needsRefresh = this.accounts.some((account) => forceRefresh || !account.cache || account.cache.expiresAt <= now);
    if (this.accountRefreshInFlight) {
      // Many users can open or pin the quota popover at the same instant. One
      // shared refresh is enough; issuing six app-server requests per browser
      // would otherwise create multi-second tail latency under a small burst.
      await this.accountRefreshInFlight;
    } else if (needsRefresh) {
      this.accountRefreshInFlight = Promise.all(this.accounts.map(async (account) => {
        if (!forceRefresh && account.cache && account.cache.expiresAt > now) return;
        const results = await Promise.allSettled([
          account.bridge.request("account/read", { refreshToken: false }, 30_000),
          account.bridge.request("account/rateLimits/read", undefined, 30_000),
          account.bridge.request("account/usage/read", undefined, 30_000)
        ]);
        const errors = results.flatMap((result, index) => result.status === "rejected"
          ? [`${["account", "rateLimits", "usage"][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : []);
        account.cache = {
          account: results[0].status === "fulfilled" ? results[0].value : {},
          limits: results[1].status === "fulfilled" ? results[1].value : {},
          usage: results[2].status === "fulfilled" ? results[2].value : {},
          errors,
          expiresAt: Date.now() + this.quotaCacheMs
        };
        account.lastCheckedAt = new Date().toISOString();
        account.health = results[0].status === "rejected" && results[1].status === "rejected" ? "degraded" : "ready";
        account.lastError = errors[0] ?? null;
      })).then(() => {
        this.accountRefreshCompletedAt = Date.now();
      }).finally(() => {
        this.accountRefreshInFlight = null;
      });
      await this.accountRefreshInFlight;
    }
    const selected = this.chooseAccount().id;
    return this.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      health: account.health,
      selectedForNewThreads: account.id === selected,
      assignedThreadCount: this.assignedThreadCount(account.id),
      activeRequests: account.activeRequests,
      lastError: account.lastError,
      lastCheckedAt: account.lastCheckedAt,
      account: account.cache?.account ?? {},
      limits: account.cache?.limits ?? {},
      usage: account.cache?.usage ?? {},
      errors: account.cache?.errors ?? ["额度尚未读取"]
    }));
  }

  /** Return an existing mapping without probing accounts on a UI refresh. */
  getKnownThreadAccount(threadId: string | undefined): { id: string; label: string } | null {
    const account = threadId ? this.accountsById.get(this.threadAccounts.get(threadId) ?? "") : undefined;
    return account ? { id: account.id, label: account.label } : null;
  }
}

export function isAccountPoolBridge(value: unknown): value is AccountPoolBridge {
  return value instanceof AccountPoolBridge;
}
