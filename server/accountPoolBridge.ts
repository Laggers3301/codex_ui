import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { CodexBridge } from "./codexBridge.js";
import { serverConfig } from "./config.js";
import { appendLegacyRollbackMarker, removeAppendedRollbackMarker, type AppendedRollbackMarker } from "./legacyRollback.js";

type JsonRecord = Record<string, unknown>;

export interface AccountPoolEntryConfig {
  id: string;
  label: string;
  codexHome: string;
  kind?: "codex-account" | "api-provider";
  enabled?: boolean;
}

interface AccountPoolFile {
  accounts: AccountPoolEntryConfig[];
  stateFile?: string;
  quotaCacheMs?: number;
  authRefreshIntervalMs?: number;
}

interface PersistedPoolState {
  threadAccounts?: Record<string, string>;
}

export interface AccountPoolRawSnapshot {
  id: string;
  label: string;
  kind: "codex-account" | "api-provider";
  codexHome: string;
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
  kind: "codex-account" | "api-provider";
  bridge: CodexBridge;
  health: "ready" | "degraded" | "starting";
  activeRequests: number;
  lastError: string | null;
  lastCheckedAt: string | null;
  cache: CachedAccountData | null;
  supportedModels: Set<string> | null;
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

export function accountAppServerArgs(codexHome: string): string[] {
  const modelCatalogPath = path.join(codexHome, "model-catalog-gpt-5.6-sol-long-context.json");
  const args = ["app-server", "--listen", "stdio://"];
  if (fs.existsSync(modelCatalogPath)) {
    args.push("-c", `model_catalog_json=${JSON.stringify(modelCatalogPath)}`);
  }
  return args;
}

function accountSupportedModels(codexHome: string): Set<string> | null {
  const modelCatalogPath = path.join(codexHome, "model-catalog-gpt-5.6-sol-long-context.json");
  try {
    const catalog = JSON.parse(fs.readFileSync(modelCatalogPath, "utf8")) as { models?: unknown[] };
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    return new Set(models.flatMap((entry) => {
      const model = asRecord(entry);
      return typeof model.slug === "string" && model.visibility === "list" ? [model.slug] : [];
    }));
  } catch {
    // A missing or temporarily unreadable catalog must preserve the legacy
    // routing behavior instead of disabling the account entirely.
    return null;
  }
}

function createAccountBridge(codexHome: string): CodexBridge {
  return new CodexBridge({
    command: serverConfig.codexBin,
    args: accountAppServerArgs(codexHome),
    env: { ...process.env, CODEX_HOME: codexHome }
  });
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
  private readonly serverRequestAccounts = new Map<number | string, { bridge: CodexBridge; originalId: number | string }>();
  private readonly stateFile: string;
  private readonly quotaCacheMs: number;
  private readonly authRefreshIntervalMs: number;
  private accountRefreshInFlight: Promise<void> | null = null;
  private accountRefreshCompletedAt = 0;
  private authRefreshTimer: NodeJS.Timeout | null = null;
  private nextServerRequestId = 1;
  private readonly bridgeFactory: (codexHome: string) => CodexBridge;
  private readonly accountMaintenance = new Map<string, Promise<void>>();

  static fromFile(filePath: string): AccountPoolBridge {
    const absolute = path.resolve(filePath);
    const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as AccountPoolFile;
    if (!parsed || !Array.isArray(parsed.accounts)) {
      throw new Error("Invalid account pool file.");
    }
    return new AccountPoolBridge(parsed, path.dirname(absolute));
  }

  constructor(
    config: AccountPoolFile,
    configDirectory = process.cwd(),
    bridgeFactory: (codexHome: string) => CodexBridge = createAccountBridge
  ) {
    super();
    this.bridgeFactory = bridgeFactory;
    const enabled = config.accounts.filter((entry) => entry.enabled !== false);
    if (!enabled.length) {
      throw new Error("The Codex account pool has no enabled accounts.");
    }
    this.stateFile = path.resolve(configDirectory, config.stateFile ?? "account-pool-state.json");
    this.quotaCacheMs = Number.isInteger(config.quotaCacheMs) && Number(config.quotaCacheMs) >= 5_000
      ? Number(config.quotaCacheMs)
      : 30_000;
    this.authRefreshIntervalMs = Number.isInteger(config.authRefreshIntervalMs)
      && Number(config.authRefreshIntervalMs) >= 60_000
      ? Number(config.authRefreshIntervalMs)
      : 15 * 60_000;

    this.accounts = enabled.map((entry) => {
      const id = safeIdentifier(entry.id, "account id");
      if (this.accountsById.has(id)) {
        throw new Error("Duplicate account pool account id.");
      }
      const codexHome = safeAbsoluteDirectory(entry.codexHome, "CODEX_HOME");
      const bridge = this.bridgeFactory(codexHome);
      const runtime: AccountRuntime = {
        id,
        label: safeLabel(entry.label),
        codexHome,
        kind: entry.kind === "api-provider" ? "api-provider" : "codex-account",
        bridge,
        health: "starting",
        activeRequests: 0,
        lastError: null,
        lastCheckedAt: null,
        cache: null,
        supportedModels: accountSupportedModels(codexHome)
      };
      this.accountsById.set(id, runtime);
      this.forwardEvents(runtime, bridge);
      return runtime;
    });
    this.loadState();
  }

  private forwardEvents(account: AccountRuntime, bridge: CodexBridge): void {
    bridge.on("notification", (message) => {
      this.emit("notification", { ...asRecord(message), accountId: account.id, accountLabel: account.label });
    });
    bridge.on("serverRequest", (request) => {
      const original = asRecord(request);
      const originalId = original.id as number | string;
      const id = `pool-${this.nextServerRequestId++}`;
      this.serverRequestAccounts.set(id, { bridge, originalId });
      this.emit("serverRequest", { ...original, id, accountId: account.id, accountLabel: account.label });
    });
    bridge.on("status", (status) => {
      const state = asRecord(status).state;
      account.health = state === "ready" ? "ready" : state === "exited" ? "degraded" : account.health;
      this.emit("status", { ...asRecord(status), accountId: account.id, accountLabel: account.label });
    });
    bridge.on("stderr", (message) => this.emit("stderr", `[${account.id}] ${String(message)}`));
    bridge.on("errorEvent", (message) => {
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
    this.startAuthRefreshTimer();
  }

  stop(): void {
    if (this.authRefreshTimer) {
      clearInterval(this.authRefreshTimer);
      this.authRefreshTimer = null;
    }
    for (const account of this.accounts) {
      account.bridge.stop();
    }
  }

  private startAuthRefreshTimer(): void {
    if (this.authRefreshTimer) return;
    // Credential upkeep must not depend on a browser tab being open. Since the
    // account list is built from account-pool.json, every enabled account added
    // through the pool installer is covered automatically after its restart.
    this.authRefreshTimer = setInterval(() => {
      void this.refreshAccountData(true).catch((error) => {
        this.emit("errorEvent", `Account credential refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.authRefreshIntervalMs);
    this.authRefreshTimer.unref();
  }

  getPendingServerRequests(): Array<{ id: number | string; method: string; params: unknown; receivedAt: string }> {
    return Array.from(this.serverRequestAccounts.entries()).map(([id, route]) => {
      const original = route.bridge.getPendingServerRequests().find((item) => item.id === route.originalId);
      return original ? { ...original, id } : null;
    }).filter((item): item is { id: number | string; method: string; params: unknown; receivedAt: string } => Boolean(item));
  }

  notify(method: string, params?: unknown): void {
    void this.accountForRequest(method, params).then(async (account) => {
      await this.waitForMaintenance(account);
      account.bridge.notify(method, params);
    });
  }

  private async waitForMaintenance(account: AccountRuntime): Promise<void> {
    while (this.accountMaintenance.has(account.id)) {
      await this.accountMaintenance.get(account.id);
    }
  }

  private async invokeAccount(account: AccountRuntime, method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    await this.waitForMaintenance(account);
    account.activeRequests += 1;
    try {
      return await account.bridge.request(method, params, timeoutMs);
    } finally {
      account.activeRequests -= 1;
    }
  }

  respondToServerRequest(id: number | string, result: unknown): void {
    const route = this.serverRequestAccounts.get(id);
    if (!route) throw new Error(`Unknown Codex server request: ${id}`);
    this.serverRequestAccounts.delete(id);
    route.bridge.respondToServerRequest(route.originalId, result);
  }

  rejectServerRequest(id: number | string, message: string): void {
    const route = this.serverRequestAccounts.get(id);
    if (!route) throw new Error(`Unknown Codex server request: ${id}`);
    this.serverRequestAccounts.delete(id);
    route.bridge.rejectServerRequest(route.originalId, message);
  }

  async request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (method === "thread/list") {
      return this.listThreads(params, timeoutMs);
    }

    const account = await this.accountForRequest(method, params);
    const startingProcessId = method === "command/exec" ? processIdFromParams(params) : null;
    // PTY requests stay pending until the shell exits. Follow-up write/resize
    // must resolve to this same account while the original request is running.
    if (startingProcessId) this.processAccounts.set(startingProcessId, account.id);
    try {
      const result = await this.invokeAccount(account, method, params, timeoutMs);
      account.health = "ready";
      account.lastError = null;
      if (method === "thread/start" || method === "thread/fork") {
        const threadId = threadIdFromStartResult(result);
        if (threadId) {
          this.threadAccounts.set(threadId, account.id);
          this.persistState();
        }
      }
      if (method === "command/exec/terminate") {
        const processId = processIdFromParams(params);
        if (processId) this.processAccounts.delete(processId);
      }
      if (startingProcessId) this.processAccounts.delete(startingProcessId);
      return result;
    } catch (error) {
      if (startingProcessId) this.processAccounts.delete(startingProcessId);
      account.health = "degraded";
      account.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  // skills/list has no threadId parameter in the app-server protocol. Resolve
  // the owner first, then query that exact runtime rather than another pool account.
  async requestOnThreadAccount(threadId: string, method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const account = await this.accountForRequest(method, { threadId });
    return this.invokeAccount(account, method, params, timeoutMs);
  }

  hasAccount(accountId: string): boolean {
    return this.accountsById.has(accountId);
  }

  async resolveThreadAccount(threadId: string): Promise<{ id: string; label: string }> {
    const account = await this.accountForRequest("thread/read", { threadId });
    return { id: account.id, label: account.label };
  }

  async startThreadOnAccount(accountId: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const account = this.accountsById.get(accountId);
    if (!account) throw new Error(`Unknown account-pool account: ${accountId}`);
    const model = asRecord(params).model;
    if (typeof model === "string" && account.supportedModels && !account.supportedModels.has(model)) {
      throw new Error(`Account ${accountId} does not support model ${model}.`);
    }
    const result = await this.invokeAccount(account, "thread/start", params, timeoutMs);
    const threadId = threadIdFromStartResult(result);
    if (threadId) {
      this.threadAccounts.set(threadId, account.id);
      this.persistState();
    }
    return result;
  }

  /** Execute an exact native fork on a specific account selected by branch routing. */
  async forkThreadOnAccount(accountId: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const account = this.accountsById.get(accountId);
    if (!account) throw new Error(`Unknown account-pool account: ${accountId}`);
    try {
      const result = await this.invokeAccount(account, "thread/fork", params, timeoutMs);
      account.health = "ready";
      account.lastError = null;
      const threadId = threadIdFromStartResult(result);
      if (threadId) {
        this.threadAccounts.set(threadId, account.id);
        this.persistState();
      }
      return result;
    } catch (error) {
      account.health = "degraded";
      account.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** Rewind one stopped legacy turn without changing the thread id. */
  async rollbackLegacyLatest(threadId: string, expectedTurnId: string): Promise<unknown> {
    const account = await this.accountForRequest("thread/read", { threadId });
    if (this.accountMaintenance.has(account.id)) throw new Error("该账号正在处理另一项会话维护，请稍后重试。");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    this.accountMaintenance.set(account.id, barrier);
    let marker: AppendedRollbackMarker | null = null;
    let stopped = false;
    try {
      if (account.activeRequests || account.bridge.getPendingServerRequests().length) {
        throw new Error("该账号还有正在处理的请求或审批，请稍后重试撤回。");
      }
      const loaded = asRecord(await account.bridge.request("thread/loaded/list", {}, 30_000));
      const loadedIds = Array.isArray(loaded.data) ? loaded.data.filter((id): id is string => typeof id === "string") : [];
      for (const loadedId of loadedIds) {
        const snapshot = asRecord(asRecord(await account.bridge.request("thread/read", { threadId: loadedId, includeTurns: false }, 30_000)).thread);
        if (asRecord(snapshot.status).type !== "idle") {
          throw new Error("该账号还有运行中的会话，不能为撤回而重启 Codex 子进程。");
        }
        const goal = asRecord(await account.bridge.request("thread/goal/get", { threadId: loadedId }, 30_000));
        if (asRecord(goal.goal).status === "active") {
          throw new Error("该账号还有持续目标在运行，请稍后重试撤回。");
        }
        const queue = asRecord(await account.bridge.request("thread/queue/list", { threadId: loadedId, limit: 1 }, 30_000));
        if (Array.isArray(queue.data) && queue.data.length) {
          throw new Error("该账号还有排队消息，请稍后重试撤回。");
        }
      }
      const before = asRecord(asRecord(await account.bridge.request("thread/read", { threadId, includeTurns: true }, 60_000)).thread);
      const turns = Array.isArray(before.turns) ? before.turns.map(asRecord) : [];
      const last = turns.at(-1);
      if (before.historyMode !== "legacy" || !last || last.id !== expectedTurnId) {
        throw new Error("只能撤回当前 legacy 会话的最后一轮；请刷新后重试。");
      }
      if (!["completed", "failed", "interrupted"].includes(String(last.status))) {
        throw new Error("最后一轮仍在运行，请等待完成或先终止回答。");
      }
      if (!Array.isArray(last.items) || !last.items.some((item) => asRecord(item).type === "userMessage")) {
        throw new Error("最后一轮不是用户提问，不能自动撤回。");
      }
      if (typeof before.path !== "string" || !before.path) throw new Error("Codex 未提供该会话的日志路径。");
      await account.bridge.stopAndWait();
      stopped = true;
      marker = await appendLegacyRollbackMarker(account.codexHome, before.path, threadId);
      await account.bridge.start();
      stopped = false;
      const after = asRecord(asRecord(await account.bridge.request("thread/read", { threadId, includeTurns: true }, 60_000)).thread);
      const remaining = Array.isArray(after.turns) ? after.turns.map(asRecord) : [];
      if (remaining.length !== turns.length - 1 || remaining.some((turn) => turn.id === expectedTurnId)) {
        throw new Error("撤回标记未被当前 Codex 正确重放，正在恢复原记录。");
      }
      marker = null;
      account.health = "ready";
      return { thread: after };
    } catch (error) {
      let recoveryError: unknown = null;
      if (marker) {
        try {
          if (!stopped) {
            await account.bridge.stopAndWait();
            stopped = true;
          }
          await removeAppendedRollbackMarker(marker);
        } catch (caught) {
          recoveryError = caught;
        }
      }
      if (stopped) {
        try {
          await account.bridge.start();
        } catch (caught) {
          recoveryError ??= caught;
        }
      }
      if (recoveryError) {
        throw new Error(`撤回失败，自动恢复也未完成；请检查该账号会话日志后再继续使用。${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
      }
      throw error;
    } finally {
      this.accountMaintenance.delete(account.id);
      release();
    }
  }

  private async accountForRequest(method: string, params: unknown): Promise<AccountRuntime> {
    const threadId = threadIdFromParams(params);
    if (threadId) {
      const known = this.accountsById.get(this.threadAccounts.get(threadId) ?? "");
      const account = known ?? await this.discoverThreadAccount(threadId);
      const requestedModel = asRecord(params).model;
      if (method === "turn/start" && typeof requestedModel === "string"
        && account.supportedModels && !account.supportedModels.has(requestedModel)) {
        throw new Error(`当前会话属于 ${account.label}，不能直接切换到 ${requestedModel}。请从上一轮回答创建分支，迁移到对应供应商后继续。`);
      }
      return account;
    }
    const processId = processIdFromParams(params);
    const processAccount = processId ? this.accountsById.get(this.processAccounts.get(processId) ?? "") : undefined;
    if (processAccount) return processAccount;
    const requestedModel = typeof asRecord(params).model === "string" ? String(asRecord(params).model) : undefined;
    return this.chooseAccount(requestedModel);
  }

  private async discoverThreadAccount(threadId: string): Promise<AccountRuntime> {
    const attempts = await Promise.allSettled(this.accounts.map(async (account) => {
      await this.invokeAccount(account, "thread/read", { threadId, includeTurns: false }, 30_000);
      return account;
    }));
    const matches = attempts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!matches.length) throw new Error("Codex thread was not found in any configured account.");
    const account = matches[0];
    this.threadAccounts.set(threadId, account.id);
    this.persistState();
    return account;
  }

  private chooseAccount(model?: string): AccountRuntime {
    const compatibleAccounts = model
      ? this.accounts.filter((account) => account.supportedModels === null || account.supportedModels.has(model))
      : this.accounts;
    if (!compatibleAccounts.length) {
      throw new Error(`No configured Codex account supports model ${model}.`);
    }
    const selected = selectAccountCandidate(compatibleAccounts.map((account) => ({
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
        const value = asRecord(await this.invokeAccount(account, "thread/list", { ...root, cursor, limit: requestedLimit }, timeoutMs));
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
    const hasCompleteCachedSnapshot = this.accounts.every((account) => account.cache !== null);
    // Treat rapid repeated force=true requests as one user-visible refresh.
    // This still permits an intentional refresh after a short cooldown while
    // preventing a second burst wave from starting another six RPCs.
    const forceRefresh = force && now - this.accountRefreshCompletedAt >= 5_000;
    const needsRefresh = this.accounts.some((account) => forceRefresh || !account.cache || account.cache.expiresAt <= now);
    if (this.accountRefreshInFlight) {
      // Many users can open or pin the quota popover at the same instant. One
      // shared refresh is enough; issuing six app-server requests per browser
      // would otherwise create multi-second tail latency under a small burst.
      // Normal page loads may immediately use the previous snapshot while the
      // shared refresh completes. An explicit refresh still waits for fresh
      // data, as does the first read after process start when no snapshot exists.
      if (force || !hasCompleteCachedSnapshot) await this.accountRefreshInFlight;
    } else if (needsRefresh) {
      this.accountRefreshInFlight = Promise.all(this.accounts.map(async (account) => {
        if (!forceRefresh && account.cache && account.cache.expiresAt > now) return;
        await this.waitForMaintenance(account);
        if (account.kind === "api-provider") {
          account.cache = { account: {}, limits: {}, usage: {}, errors: [], expiresAt: Date.now() + this.quotaCacheMs };
          account.lastCheckedAt = new Date().toISOString();
          account.lastError = null;
          return;
        }
        const previous = account.cache;
        // Refresh authentication first, then read quota. Running all three
        // calls in parallel races an expired access token against its refresh
        // and leaves the quota card blank until the next cache cycle.
        const [accountSettled] = await Promise.allSettled([
          this.invokeAccount(account, "account/read", { refreshToken: true }, 12_000)
        ]);
        const [limitsSettled, usageSettled] = await Promise.allSettled([
          this.invokeAccount(account, "account/rateLimits/read", undefined, 12_000),
          this.invokeAccount(account, "account/usage/read", undefined, 12_000)
        ]);
        const results = [accountSettled, limitsSettled, usageSettled] as const;
        const errors = results.flatMap((result, index) => result.status === "rejected"
          ? [`${["account", "rateLimits", "usage"][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : []);
        account.cache = {
          // A transient proxy/OpenAI failure must not erase the last known-good
          // values. The error/health fields still expose that this refresh was
          // degraded, while the quota card remains useful instead of becoming
          // "-- / 0%" until a later successful poll.
          account: results[0].status === "fulfilled" ? results[0].value : previous?.account ?? {},
          limits: results[1].status === "fulfilled" ? results[1].value : previous?.limits ?? {},
          usage: results[2].status === "fulfilled" ? results[2].value : previous?.usage ?? {},
          errors,
          expiresAt: Date.now() + this.quotaCacheMs
        };
        account.lastCheckedAt = new Date().toISOString();
        account.health = errors.length > 0 ? "degraded" : "ready";
        account.lastError = errors[0] ?? null;
      })).then(() => {
        this.accountRefreshCompletedAt = Date.now();
      }).finally(() => {
        this.accountRefreshInFlight = null;
      });
      if (force || !hasCompleteCachedSnapshot) await this.accountRefreshInFlight;
    }
    const selected = this.chooseAccount().id;
    return this.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      kind: account.kind,
      codexHome: account.codexHome,
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

  canThreadUseModel(threadId: string, model: string): boolean {
    const account = this.accountsById.get(this.threadAccounts.get(threadId) ?? "");
    return !account?.supportedModels || account.supportedModels.has(model);
  }

  /** Select the best current account for a branch, independently of its source. */
  getBranchRoutingDecision(threadId: string, model?: string, forcedTargetAccountId?: string): {
    mode: "native" | "cross-account-native";
    sourceAccount: { id: string; label: string; codexHome: string } | null;
    targetAccount: { id: string; label: string; codexHome: string };
  } {
    const source = this.accountsById.get(this.threadAccounts.get(threadId) ?? "") ?? null;
    const target = forcedTargetAccountId
      ? this.accountsById.get(forcedTargetAccountId)
      : this.chooseAccount(model);
    if (!target) throw new Error(`Unknown account-pool account: ${forcedTargetAccountId}`);
    if (model && target.supportedModels && !target.supportedModels.has(model)) {
      throw new Error(`Account ${target.id} does not support model ${model}.`);
    }
    const sourceAccount = source
      ? { id: source.id, label: source.label, codexHome: source.codexHome }
      : null;
    const targetAccount = { id: target.id, label: target.label, codexHome: target.codexHome };
    return {
      mode: source?.id === target.id ? "native" : "cross-account-native",
      sourceAccount,
      targetAccount
    };
  }

  /** Pin imported conversations to the account whose CODEX_HOME received them. */
  assignThreadsToAccount(threadIds: Iterable<string>, accountId: string): void {
    const account = this.accountsById.get(accountId);
    if (!account) throw new Error(`Unknown account-pool account: ${accountId}`);
    let changed = false;
    for (const value of threadIds) {
      const threadId = value.trim();
      if (!threadId || this.threadAccounts.get(threadId) === account.id) continue;
      this.threadAccounts.set(threadId, account.id);
      changed = true;
    }
    if (changed) this.persistState();
  }
}

export function isAccountPoolBridge(value: unknown): value is AccountPoolBridge {
  return value instanceof AccountPoolBridge;
}
