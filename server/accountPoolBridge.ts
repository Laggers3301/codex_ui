import { assertCodexModelRequest } from "./agentRuntimeGuard.js";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBridge } from "./codexBridge.js";
import { serverConfig } from "./config.js";
import { ensureDefaultAgentLanguage } from "./agentLanguage.js";
import { installSubagentHistoryGuard } from "../scripts/install-subagent-history-guard.mjs";
import { withSubagentHistoryGuard } from "./subagentHistoryGuard.js";
import { responsesCompatibleModelCatalog } from "./modelCatalogCompatibility.js";
import { applyPoolContextDefaults } from "./modelContextDefaults.js";
import { prepareVerifiedProviderCatalog } from "./verifiedProviderCapabilities.js";
import { appendLegacyRollbackMarker, removeAppendedRollbackMarker, readLegacyTailMetadata, LegacyRollbackConflictError, type AppendedRollbackMarker } from "./legacyRollback.js";
import { installedRuntimeVersion, isNewerRuntime, runtimeIsIdle, runtimeSelectionPath, writeRuntimeSelection, RuntimeUpgradeFailure, nextRuntimeUpgradeRetry, type RuntimeBusyReason, type RuntimeUpgradeStage, type RuntimeUpgradeRetry } from "./runtimeUpgrade.js";
import {readableRolloutPath} from './rolloutStorage.js';
import { authFailureCodes as AUTH_FAILURE_CODES, permanentAuthCode, credentialTiming, renewalDue, renewalRetryDelay, type AuthFailureCode } from "./authRenewal.js";
import {authDiagnostic, type AuthDiagnostic, type AuthPhase} from "./authDiagnostics.js";
import { ProviderTurnProtocol } from "./providerProtocol.js";
import { validateModelRequest } from "./modelRequestValidation.js";
import { nativeModelDiscoveryEnabled } from "./nativeModelDiscovery.js";

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
  /** Deprecated compatibility field; pool quota reads never rotate OAuth tokens. */
  authRefreshIntervalMs?: number;
}

interface PersistedPoolState {
  threadAccounts?: Record<string, string>;
  quotaSnapshots?: Record<string, { limits: unknown; usage: unknown }>;
  authFailures?: Record<string, { code: AuthFailureCode; credentialVersion?: number; credentialFingerprint?: string | null }>;
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
  authFileStamp: number;
  credentialFingerprint: string | null;
  authFailureCode: AuthFailureCode | null;
  authFailureFingerprint: string | null;
}

export interface ModelCatalogTarget {
  id: string;
  codexHome: string;
  catalogPath: string;
}

export type ModelCatalogApplyResult = "reloaded" | "busy" | "unchanged";

const MODEL_CATALOG_FILENAME = "model-catalog-gpt-5.6-sol-long-context.json";

function writeFileAtomically(filePath: string, contents: string): void {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function authCredentialIdentity(auth: JsonRecord): string | null {
  const tokens = asRecord(auth.tokens);
  const mode = String(auth.auth_mode ?? auth.authMode ?? "").toLowerCase();
  const apiKey = [auth.OPENAI_API_KEY, auth.openai_api_key, auth.api_key, auth.apiKey, tokens.OPENAI_API_KEY, tokens.api_key, tokens.apiKey]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if ((mode.includes("api") || mode.includes("key")) && apiKey) {
    return createHash("sha256").update("api-key\0").update(apiKey).digest("hex");
  }
  const refreshToken = tokens.refresh_token;
  if (typeof refreshToken === "string" && refreshToken.length > 0) {
    return createHash("sha256").update("refresh-token\0").update(refreshToken).digest("hex");
  }
  if (apiKey) return createHash("sha256").update("api-key\0").update(apiKey).digest("hex");
  return null;
}

function authCredentialSnapshot(codexHome: string): { stamp: number; fingerprint: string | null } {
  const file = path.join(codexHome, "auth.json");
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(file, "r");
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > 1024 * 1024) return { stamp: before.mtimeMs, fingerprint: null };
    const contents = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) {
      return { stamp: after.mtimeMs, fingerprint: null };
    }
    const auth = JSON.parse(contents) as JsonRecord;
    return { stamp: after.mtimeMs, fingerprint: authCredentialIdentity(auth) };
  } catch {
    try { return { stamp: fs.statSync(file).mtimeMs, fingerprint: null }; }
    catch { return { stamp: 0, fingerprint: null }; }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function authFailureWarning(code: AuthFailureCode): string {
  return `account: 自动续期凭据不可用（${code}），需重新授权恢复续期；不代表现有访问令牌或最新额度读取已失效。`;
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

export function accountAppServerArgs(codexHome: string, kind: "codex-account" | "api-provider" = "codex-account"): string[] {
  ensureDefaultAgentLanguage(codexHome);
  installSubagentHistoryGuard(codexHome);
  const modelCatalogPath = path.join(codexHome, MODEL_CATALOG_FILENAME);
  const args = ["app-server", "--listen", "stdio://"];
  if (!nativeModelDiscoveryEnabled(codexHome, kind) && fs.existsSync(modelCatalogPath)) {
    args.push("-c", `model_catalog_json=${JSON.stringify(responsesCompatibleModelCatalog(modelCatalogPath))}`);
  }
  return args;
}

function accountSupportedModels(codexHome: string): Set<string> | null {
  const modelCatalogPath = path.join(codexHome, MODEL_CATALOG_FILENAME);
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

function createAccountBridge(codexHome: string, accountId: string, adoptCandidate = false, kind: "codex-account" | "api-provider" = "codex-account"): CodexBridge {
  prepareVerifiedProviderCatalog(codexHome, accountId);
  // Keep the pay-as-you-go credential out of other account runtimes. The
  // provider's shell policy also excludes it from agent tool environments.
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome, CODEX_WEB_RUNTIME_ADOPT_CANDIDATE: adoptCandidate ? "1" : "0" };
  delete env.ARK_PAY_API_KEY;
  if (accountId === "ark-pay") {
    const keyFile = process.env.CODEX_WEB_ARK_PAY_KEY_FILE ?? path.join(serverConfig.dataDir, "providers", "ark-pay", "credential.env");
    const stat = fs.statSync(keyFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Ark API credential file must be private");
    const key = fs.readFileSync(keyFile, "utf8").match(/^ARK_PAY_API_KEY=([^\r\n]+)$/m)?.[1];
    if (!key) throw new Error("Ark API credential unavailable");
    env.ARK_PAY_API_KEY = key;
  }
  const scope = process.env.CODEX_WEB_ISOLATE_AGENT_SCOPES === "1" ? {
    unitPrefix: `codex-agent-${accountId.replace(/[^A-Za-z0-9-]/g, "-")}`,
    slice: "codex-workers.slice",
    // A 3 GiB high watermark below the 4 GiB allocation cap caused sustained
    // direct reclaim during native history forks, then systemd-oomd killed the
    // account despite available host memory. Keep the hard cap, but do not
    // create a separate per-account reclaim stall below it. The worker slice
    // retains its aggregate pressure and allocation limits.
    memoryHigh: "4G",
    memoryMax: "4G",
    memorySwapMax: "256M"
  } : undefined;
  return new CodexBridge({
    // The kernel lease spans every app-server refresh, including automatic
    // native recovery during a turn. It is not just a browser-request mutex.
    command: "/usr/bin/flock",
    args: ["--exclusive", "--nonblock", "--no-fork", "--conflict-exit-code", "75",
      path.join(codexHome, ".web-runtime.lock"), process.execPath,
      fileURLToPath(new URL("../scripts/run-account-runtime.mjs", import.meta.url)),
      serverConfig.codexBin, ...accountAppServerArgs(codexHome, kind)],
    env,
    ...(nativeModelDiscoveryEnabled(codexHome, kind) ? { nativeModelDiscoveryHome: codexHome } : {}),
    scope
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
  private readonly serverRequestAccounts = new Map<number | string, { bridge: CodexBridge; originalId: number | string; accountId: string }>();
  private readonly stateFile: string;
  private readonly quotaCacheMs: number;
  private accountRefreshInFlight: Promise<void> | null = null;
  private accountRefreshCompletedAt = 0;
  private nextServerRequestId = 1;
  private readonly bridgeFactory: (codexHome: string, accountId: string) => CodexBridge;
  private readonly accountMaintenance = new Map<string, Promise<void>>();
  private runtimeUpgradeTimer: ReturnType<typeof setInterval> | undefined;
  private runtimeUpgradeChecking = false;
  private storageTimer: ReturnType<typeof setInterval> | undefined;
  private storageInitialTimer: ReturnType<typeof setTimeout> | undefined;
  private storageChecking = false;
  private readonly storageScheduledAt=new Map<string,number>();

  private async maintainCompressedStorage(): Promise<void> {
    if(this.storageChecking) return;
    const policyPath=path.join(serverConfig.dataDir,'native-storage-policy.json');
    try {
      const policy=JSON.parse(fs.readFileSync(policyPath,'utf8'));
      if(policy.enabled!==true||policy.adapterRevision!==1) return;
    } catch { return; }
    this.storageChecking=true;
    try {
      for(const account of this.accounts) {
        if(Date.now()-(this.storageScheduledAt.get(account.id)??0)<24*60*60*1000) continue;
        if(account.activeRequests||this.accountMaintenance.has(account.id)||account.bridge.getPendingServerRequests().length) continue;
        try {
          if(!await runtimeIsIdle(account.bridge)) continue;
          await this.invokeAccount(account,'rollout/compress',undefined,30_000);
          this.storageScheduledAt.set(account.id,Date.now());
          // This RPC acknowledges scheduling, not completion or savings.
          console.info('storage.native_compression_scheduled',{accountId:account.id});
        } catch { console.warn('storage.native_compression_deferred',{accountId:account.id}); }
      }
    } finally { this.storageChecking=false; }
  }
  private readonly runtimeUpgradeRetries = new Map<string, RuntimeUpgradeRetry>();
  private readonly runtimeUpgradeBusy = new Map<string, { signature: string; at: number }>();
  private readonly pendingCredentialReloads = new Set<string>();
  private authRenewalTimer: ReturnType<typeof setInterval> | undefined;
  private authRenewalInitialTimer: ReturnType<typeof setTimeout> | undefined;
  private authRenewalChecking = false;
  private authRenewalStopped = false;
  private authRenewalGeneration = 0;
  private readonly authRenewalRetries = new Map<string, { fingerprint: string | null; nextAt: number; failures: number }>();
  private readonly diagnosticLastAt = new Map<string,number>();

  private diagnose(account: AccountRuntime, phase: AuthPhase, outcome: AuthDiagnostic["outcome"], error?: unknown): void {
    const refreshedAt=credentialTiming(account.codexHome)?.refreshedAt;
    const row=authDiagnostic(account.id,phase,outcome,error,refreshedAt ? new Date(refreshedAt).toISOString() : null);
    const key=JSON.stringify({...row,time:null});
    if(Date.now()-(this.diagnosticLastAt.get(key)??0)<60_000)return;
    if(this.diagnosticLastAt.size>256)this.diagnosticLastAt.clear();
    this.diagnosticLastAt.set(key,Date.now());this.emit("accountAuthDiagnostic",row);
  }

  authorizationTarget(accountId: string) {
    const account=this.accountsById.get(accountId);
    if(!account || account.kind!=="codex-account")throw new Error("Unknown managed account");
    return {home:account.codexHome,expected:this.currentCredentialVersion(account),version:installedRuntimeVersion(account.codexHome,serverConfig.codexBin)};
  }

  createDeviceAuthorizationBridge(accountId: string, stageHome: string): CodexBridge {
    const target=this.authorizationTarget(accountId);
    writeRuntimeSelection(stageHome,target.version);
    return this.bridgeFactory(stageHome,`${accountId}-device-login`);
  }

  /** Single installation entry. The staging runtime MUST be stopped first.
   * No logout, no overwrite on conflict, and no restart of a busy account. */
  async installAuthorizedCredentials(accountId: string, stageHome: string, expected: {stamp:number;fingerprint:string|null}): Promise<"busy"|"installed"> {
    // Finish the current read batch before replacing its runtime or cache.
    if(this.accountRefreshInFlight)await this.accountRefreshInFlight;
    const account=this.accountsById.get(accountId);
    if(!account || account.kind!=="codex-account")throw new Error("Unknown managed account");
    if(this.authRenewalStopped || this.accountMaintenance.has(accountId))return "busy";
    let release!:()=>void;
    this.accountMaintenance.set(accountId,new Promise<void>(resolve=>{release=resolve;}));
    const readAuth=(home:string):JsonRecord=>{
      const fd=fs.openSync(path.join(home,"auth.json"),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>131072)throw new Error("invalid_credentials");return asRecord(JSON.parse(fs.readFileSync(fd,"utf8")));}
      finally{fs.closeSync(fd);}
    };
    let stopped=false,installedOnDisk=false;
    let phase:AuthPhase="credential_install";
    try {
      if(account.activeRequests || account.bridge.getPendingServerRequests().length || !await runtimeIsIdle(account.bridge))return "busy";
      const staged=readAuth(stageHome),tokens=asRecord(staged.tokens);
      if(staged.auth_mode!=="chatgpt" || !tokens.access_token || !tokens.refresh_token || !tokens.account_id || !credentialTiming(stageHome)?.expiresAt || credentialTiming(stageHome)!.expiresAt!<=Date.now())throw new Error("invalid_credentials");
      const old=fs.existsSync(path.join(account.codexHome,"auth.json"))?asRecord(readAuth(account.codexHome).tokens):{};
      if(old.account_id && old.account_id!==tokens.account_id)throw new Error("account_mismatch");
      const before=this.currentCredentialVersion(account);
      if(before.fingerprint!==expected.fingerprint || before.stamp!==expected.stamp)throw new Error("authorization_conflict");
      await account.bridge.stopAndWait();stopped=true;
      if(this.authRenewalStopped)throw new Error("authorization_conflict");
      const final=this.currentCredentialVersion(account);
      if(final.fingerprint!==expected.fingerprint || final.stamp!==expected.stamp)throw new Error("authorization_conflict");
      const file=path.join(stageHome,"auth.json");fs.chmodSync(file,0o600);fs.renameSync(file,path.join(account.codexHome,"auth.json"));
      installedOnDisk=true;
      const installed=this.currentCredentialVersion(account);
      account.authFileStamp=installed.stamp;account.credentialFingerprint=installed.fingerprint;
      account.authFailureCode=null;account.authFailureFingerprint=null;account.cache=null;
      this.pendingCredentialReloads.add(accountId);this.authRenewalRetries.delete(accountId);this.persistState();
      this.diagnose(account,"credential_install","success");
      phase="runtime_reload";
      const replacement=this.bridgeFactory(account.codexHome,account.id);
      account.bridge=replacement;this.forwardEvents(account,replacement);
      await replacement.start();stopped=false;this.pendingCredentialReloads.delete(accountId);
      this.diagnose(account,"runtime_reload","success");
      this.emit("accountRuntime",{accountId,event:"credentials_reloaded"});
      return "installed";
    } catch(error) {
      this.diagnose(account,phase,"failure",error);
      if(stopped && !this.authRenewalStopped) {
        // Restart using whichever credentials are authoritative on disk. Never
        // restore a stale refresh-token chain after a successful installation.
        const replacement=this.bridgeFactory(account.codexHome,account.id);
        account.bridge=replacement;this.forwardEvents(account,replacement);
        try{await replacement.start();}catch{account.health="degraded";}
      }
      if(installedOnDisk)return "installed";
      throw error;
    } finally {this.accountMaintenance.delete(accountId);release();}
  }

  async verifyAuthorizedAccount(accountId:string):Promise<boolean> {
    const account=this.accountsById.get(accountId);if(!account)throw new Error("Unknown managed account");
    try {
      const accountInfo=asRecord(await this.invokeAccount(account,"account/read",{refreshToken:false},12_000));
      if(!accountInfo.account)throw new Error("verification_incomplete");
      await this.invokeAccount(account,"account/rateLimits/read",undefined,30_000);
      this.diagnose(account,"health_verify","success");return true;
    } catch(error){this.diagnose(account,"health_verify","deferred",error);return false;}
  }

  /** One serialized renewal through the account's existing, lease-owning
   * native runtime. Never POST OAuth from Node or copy refresh credentials. */
  async renewManagedCredentials(): Promise<void> {
    if (this.authRenewalStopped || this.authRenewalChecking) return;
    const generation = this.authRenewalGeneration;
    this.authRenewalChecking = true;
    try {
      // Wait for a quota refresh rather than missing every check when its
      // interval happens to align with this timer. No maintenance gate is held.
      if (this.accountRefreshInFlight) await this.accountRefreshInFlight;
      for (const account of this.accounts) {
        if (this.authRenewalStopped || generation !== this.authRenewalGeneration) return;
        if (account.kind !== "codex-account" || account.activeRequests || this.accountMaintenance.has(account.id)) continue;
        const before = this.currentCredentialVersion(account);
        this.updateCredentialVersion(account, before);
        if (account.authFailureCode || this.pendingCredentialReloads.has(account.id)) continue;
        const retry = this.authRenewalRetries.get(account.id);
        if (retry?.fingerprint === before.fingerprint && Date.now() < retry.nextAt) continue;
        const timing = credentialTiming(account.codexHome);
        if (!renewalDue(timing)) continue;
        let release!: () => void;
        this.accountMaintenance.set(account.id, new Promise<void>(resolve => { release = resolve; }));
        try {
          // Deliberately bypass the public account/read clamp only here. All
          // quota/browser requests remain non-rotating and wait for this gate.
          const result = asRecord(await account.bridge.request("account/read", { refreshToken: true }, 30_000));
          if (this.authRenewalStopped || generation !== this.authRenewalGeneration) return;
          const after = this.currentCredentialVersion(account), updated = credentialTiming(account.codexHome);
          if (!result.account || !updated || !after.fingerprint ||
            (after.fingerprint === before.fingerprint && (updated.expiresAt ?? 0) <= (timing?.expiresAt ?? 0))) {
            throw new Error("Native renewal did not advance credential metadata");
          }
          // The same runtime performed this rotation; restarting it would be
          // unnecessary and could interrupt a running model turn.
          account.authFileStamp = after.stamp; account.credentialFingerprint = after.fingerprint;
          account.cache = null;
          this.authRenewalRetries.set(account.id, { fingerprint: after.fingerprint, nextAt: Date.now() + 3600_000, failures: 0 });
          this.emit("accountAuth", { accountId: account.id, code: "renewed", requiresLogin: false });
          this.diagnose(account,"managed_refresh","success");
        } catch (error) {
          if (this.authRenewalStopped || generation !== this.authRenewalGeneration) return;
          const code = permanentAuthCode(error instanceof Error ? error.message : String(error));
          const failures = retry?.fingerprint === before.fingerprint ? retry.failures + 1 : 1;
          this.authRenewalRetries.set(account.id, { fingerprint: before.fingerprint, nextAt: Date.now() + renewalRetryDelay(failures), failures });
          if (code) {
            account.authFailureCode = code; account.authFailureFingerprint = before.fingerprint;
            account.health = "degraded"; account.lastError = authFailureWarning(code);
            this.persistState();
          }
          this.emit("accountAuth", { accountId: account.id, code: code ?? "renewal_temporarily_failed", requiresLogin: Boolean(code) });
          this.diagnose(account,"managed_refresh","failure",error);
        } finally { this.accountMaintenance.delete(account.id); release(); }
      }
    } finally { this.authRenewalChecking = false; }
  }

  private markReadyUnlessAuthFailure(account: AccountRuntime): void {
    if (account.authFailureCode) {
      account.health = "degraded";
      account.lastError = authFailureWarning(account.authFailureCode);
      return;
    }
    const authState = asRecord(account.cache?.account);
    if (authState.account === null && authState.requiresOpenaiAuth !== false) {
      account.health = "degraded";
      account.lastError = "account: 当前账号未登录，不参与新会话的正常自动分配。";
      return;
    }
    account.health = "ready";
    account.lastError = null;
  }

  private updateCredentialVersion(account: AccountRuntime, next: { stamp: number; fingerprint: string | null }): void {
    if (next.fingerprint && next.fingerprint !== account.credentialFingerprint) this.pendingCredentialReloads.add(account.id);
    account.authFileStamp = next.stamp;
    account.credentialFingerprint = next.fingerprint;
    if (!account.authFailureCode || !account.authFailureFingerprint || !next.fingerprint) return;
    if (account.authFailureFingerprint === next.fingerprint) return;
    account.authFailureCode = null;
    account.authFailureFingerprint = null;
  }

  private currentCredentialVersion(account: AccountRuntime): { stamp: number; fingerprint: string | null } {
    return authCredentialSnapshot(account.codexHome);
  }

  /** New device authorization must replace native in-memory credentials too.
   * Wait for complete idleness; never interrupt a model turn or rotate tokens.
   */
  private async reloadChangedCredentialsIfIdle(account: AccountRuntime): Promise<void> {
    if (!this.pendingCredentialReloads.has(account.id) || this.accountMaintenance.has(account.id)) return;
    let release!: () => void;
    this.accountMaintenance.set(account.id, new Promise<void>(resolve => { release = resolve; }));
    try {
      if (account.activeRequests || account.bridge.getPendingServerRequests().length || !await runtimeIsIdle(account.bridge)) return;
      await account.bridge.stopAndWait();
      const replacement = this.bridgeFactory(account.codexHome, account.id);
      account.bridge = replacement; this.forwardEvents(account, replacement);
      await replacement.start();
      this.pendingCredentialReloads.delete(account.id);
      account.cache = null;
      this.emit("accountRuntime", { accountId: account.id, event: "credentials_reloaded" });
    } catch {
      // Keep the pending marker. A missing/unsupported idle check cannot justify
      // disrupting running work; later polling retries without changing auth.json.
    } finally { this.accountMaintenance.delete(account.id); release(); }
  }

  static fromFile(filePath: string): AccountPoolBridge {
    const absolute = path.resolve(filePath);
    const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as AccountPoolFile;
    if (!parsed || !Array.isArray(parsed.accounts)) {
      throw new Error("Invalid account pool file.");
    }
    const launchedHomes = new Set<string>();
    return new AccountPoolBridge(parsed, path.dirname(absolute), (home, id) => {
      const coldStart = !launchedHomes.has(home);
      launchedHomes.add(home);
      const kind = parsed.accounts.find(entry => entry.id === id)?.kind ?? "codex-account";
      return createAccountBridge(home, id, coldStart && process.env.CODEX_WEB_AUTO_RUNTIME_UPDATE === "1", kind);
    });
  }

  constructor(
    config: AccountPoolFile,
    configDirectory = process.cwd(),
    bridgeFactory?: (codexHome: string, accountId: string) => CodexBridge
  ) {
    super();
    this.bridgeFactory = bridgeFactory ?? ((home, id) => createAccountBridge(home, id, false,
      config.accounts.find(entry => entry.id === id)?.kind ?? "codex-account"));
    const enabled = config.accounts.filter((entry) => entry.enabled !== false);
    if (!enabled.length) {
      throw new Error("The Codex account pool has no enabled accounts.");
    }
    this.stateFile = path.resolve(configDirectory, config.stateFile ?? "account-pool-state.json");
    this.quotaCacheMs = Number.isInteger(config.quotaCacheMs) && Number(config.quotaCacheMs) >= 5_000
      ? Number(config.quotaCacheMs)
      : 30_000;

    const credentialHomes = new Set<string>();
    const credentialSessions = new Set<string>();
    this.accounts = enabled.map((entry) => {
      const id = safeIdentifier(entry.id, "account id");
      if (this.accountsById.has(id)) {
        throw new Error("Duplicate account pool account id.");
      }
      const codexHome = safeAbsoluteDirectory(entry.codexHome, "CODEX_HOME");
      const canonicalHome = fs.realpathSync(codexHome);
      if (credentialHomes.has(canonicalHome)) throw new Error("Multiple pool accounts cannot share one credential directory.");
      credentialHomes.add(canonicalHome);
      try {
        const auth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"));
        const refresh = auth.tokens?.refresh_token;
        if (typeof refresh === "string" && refresh) {
          if (credentialSessions.has(refresh)) throw new Error("Multiple pool accounts cannot share one OAuth refresh session.");
          credentialSessions.add(refresh);
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Multiple pool accounts cannot share one OAuth refresh session.") throw error;
        // Native auth handling reports a missing/malformed credential file.
      }
      // A backend cold start is already outside the old runtime's active work.
      // Reapply authorized defaults before constructing immutable launch args,
      // including when the upstream refresh returns 304. Do not touch providers
      // or thread-specific overrides, and retain the source on validation error.
      if (entry.kind !== "api-provider") {
        const catalogPath = path.join(codexHome, MODEL_CATALOG_FILENAME);
        if (fs.existsSync(catalogPath)) {
          try {
            const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
            const previous = JSON.stringify(catalog);
            applyPoolContextDefaults(catalog);
            if (JSON.stringify(catalog) !== previous) {
              writeFileAtomically(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
            }
          } catch {
            console.warn("Account context defaults unavailable; retaining catalog", { accountId: id });
          }
        }
      }
      // Install before *any* transport factory starts. Tests, remote adapters
      // and recovery bridges must not depend on the default argv builder to
      // discover this mandatory account-global guard.
      installSubagentHistoryGuard(codexHome);
      const bridge = this.bridgeFactory(codexHome, id);
      const credential = authCredentialSnapshot(codexHome);
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
        supportedModels: accountSupportedModels(codexHome),
        authFileStamp: credential.stamp,
        credentialFingerprint: credential.fingerprint,
        authFailureCode: null,
        authFailureFingerprint: null
      };
      this.accountsById.set(id, runtime);
      this.forwardEvents(runtime, bridge);
      return runtime;
    });
    this.loadState();
  }

  private forwardEvents(account: AccountRuntime, bridge: CodexBridge): void {
    let authErrorTail = "";
    const protocol = new ProviderTurnProtocol();
    bridge.on("notification", (message) => {
      if(account.bridge!==bridge)return;
      if (asRecord(message).method === "serverRequest/resolved") {
        const params = asRecord(asRecord(message).params);
        const routed = [...this.serverRequestAccounts].find(([, route]) => route.bridge === bridge && route.originalId === params.requestId);
        // Answers are resolved locally when written. The native notification
        // also clears questions cancelled by a completed/interrupted turn.
        if (!routed) return;
        this.serverRequestAccounts.delete(routed[0]);
        this.emit("notification", { ...asRecord(message), params: { ...params, requestId: routed[0] }, accountId: account.id, accountLabel: account.label });
        return;
      }
      for (const event of protocol.accept(message)) {
        this.emit("notification", { ...event, accountId: account.id, accountLabel: account.label });
      }
    });
    bridge.on("serverRequest", (request) => {
      if(account.bridge!==bridge)return;
      const original = asRecord(request);
      const originalId = original.id as number | string;
      const id = `pool-${this.nextServerRequestId++}`;
      this.serverRequestAccounts.set(id, { bridge, originalId, accountId: account.id });
      this.emit("serverRequest", { ...original, id, accountId: account.id, accountLabel: account.label });
    });
    bridge.on("status", (status) => {
      if(account.bridge!==bridge)return;
      const state = asRecord(status).state;
      if (state === "ready") this.markReadyUnlessAuthFailure(account);
      else if (state === "exited") account.health = "degraded";
      this.emit("status", { ...asRecord(status), accountId: account.id, accountLabel: account.label });
      if (state === "exited" && asRecord(status).code === 75) {
        account.lastError = "该账号已有运行时持有凭据锁，已阻止重复启动及并发刷新。";
        this.emit("accountRuntime", { accountId: account.id, event: "lease_conflict" });
      }
    });
    bridge.on("stderr", (message) => {
      if(account.bridge!==bridge)return;
      if(/Failed to refresh token|Encountered unknown response while refreshing token/.test(String(message))){
        this.diagnose(account,"native_refresh","failure",String(message));
      }
      for (const line of String(message).split("\n")) {
        if (!line.startsWith("[account-runtime] ")) continue;
        try {
          const runtime = asRecord(JSON.parse(line.slice("[account-runtime] ".length)));
          if (!["started", "exited", "credentials_changed", "watch_failed", "spawn_failed"].includes(String(runtime.event))) continue;
          this.emit("accountRuntime", {
            accountId: account.id, event: runtime.event,
            runtimePid: Number.isInteger(runtime.runtimePid) ? runtime.runtimePid : undefined,
            nativePid: Number.isInteger(runtime.nativePid) ? runtime.nativePid : undefined,
            authState: ["present", "missing", "invalid"].includes(String(runtime.authState)) ? runtime.authState : undefined,
            lastRefresh: typeof runtime.lastRefresh === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(runtime.lastRefresh) ? runtime.lastRefresh : undefined,
            previousRefresh: typeof runtime.previousRefresh === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(runtime.previousRefresh) ? runtime.previousRefresh : undefined,
            refreshTokenChanged: typeof runtime.refreshTokenChanged === "boolean" ? runtime.refreshTokenChanged : undefined,
            exitCode: Number.isInteger(runtime.code) ? runtime.code : undefined
          });
        } catch { /* An incomplete stderr chunk is not an auth failure. */ }
      }
      const combined = authErrorTail + String(message);
      const code = permanentAuthCode(combined);
      authErrorTail = code ? "" : combined.slice(combined.lastIndexOf("\n") + 1).slice(-4096);
      if (code && account.authFailureCode !== code) {
        account.authFailureCode = code;
        account.authFailureFingerprint = account.credentialFingerprint;
        account.health = "degraded";
        account.lastError = authFailureWarning(code);
        try {
          this.persistState();
        } catch {
          this.emit("errorEvent", "Unable to persist account-pool authentication state.");
        }
        // Log only the classification, never native stderr (which may contain
        // credentials, device codes or user content).
        this.emit("accountAuth", { accountId: account.id, code, requiresLogin: true });
      }
      this.emit("stderr", `[${account.id}] ${String(message)}`);
    });
    bridge.on("errorEvent", (message) => {
      if(account.bridge!==bridge)return;
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
      for (const [id, failure] of Object.entries(parsed.authFailures ?? {})) {
        const account = this.accountsById.get(id);
        if (!account || account.kind !== "codex-account" || !failure || typeof failure !== "object") continue;
        const code = (failure as { code?: unknown }).code;
        const credentialVersion = (failure as { credentialVersion?: unknown }).credentialVersion;
        const persistedFingerprint = (failure as { credentialFingerprint?: unknown }).credentialFingerprint;
        if (typeof code !== "string" || !AUTH_FAILURE_CODES.has(code as AuthFailureCode)) continue;
        if (typeof persistedFingerprint === "string" && /^[a-f\d]{64}$/i.test(persistedFingerprint)) {
          if (account.credentialFingerprint && persistedFingerprint !== account.credentialFingerprint) continue;
          account.authFailureFingerprint = persistedFingerprint.toLowerCase();
        } else if (persistedFingerprint !== undefined) {
          // Malformed identity cannot prove that credentials changed.
          account.authFailureFingerprint = null;
        } else if (typeof credentialVersion === "number" && Number.isFinite(credentialVersion) && credentialVersion > 0) {
          // Legacy state stored only mtime: migrate only on an exact match,
          // then bind the current private identity in memory.
          if (account.authFileStamp !== credentialVersion) continue;
          account.authFailureFingerprint = account.credentialFingerprint;
        } else {
          // Missing/unknown version metadata fails closed.
          account.authFailureFingerprint = null;
        }
        account.authFailureCode = code as AuthFailureCode;
        account.health = "degraded";
        account.lastError = authFailureWarning(code as AuthFailureCode);
      }
      for (const [id, snapshot] of Object.entries(parsed.quotaSnapshots ?? {})) {
        const account = this.accountsById.get(id);
        if (!account || account.kind === "api-provider") continue;
        account.cache = { account: {}, limits: snapshot.limits ?? {}, usage: snapshot.usage ?? {}, expiresAt: 0,
          errors: ["rateLimits: 上次读取的缓存值，正在重新验证", "usage: 上次读取的缓存值，正在重新验证"] };
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
    const quotaSnapshots = Object.fromEntries(this.accounts.filter(account => account.kind !== "api-provider" && account.cache)
      .map(account => [account.id, { limits: account.cache!.limits, usage: account.cache!.usage }]));
    const authFailures = Object.fromEntries(this.accounts.flatMap(account =>
      account.kind === "codex-account" && account.authFailureCode && Number.isFinite(account.authFileStamp) && account.authFileStamp > 0
        ? [[account.id, {
          code: account.authFailureCode,
          credentialVersion: account.authFileStamp,
          credentialFingerprint: account.authFailureFingerprint
        }]]
        : []
    ));
    fs.writeFileSync(temporary, JSON.stringify({ threadAccounts: Object.fromEntries(this.threadAccounts), quotaSnapshots, authFailures }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }

  async start(): Promise<void> {
    this.authRenewalStopped = false;
    const results = await Promise.allSettled(this.accounts.map(async (account) => {
      const file=runtimeSelectionPath(account.codexHome);
      const previous=fs.existsSync(file)?fs.readFileSync(file,"utf8"):null;
      const before=installedRuntimeVersion(account.codexHome,serverConfig.codexBin);
      try { await account.bridge.start(); }
      catch(error) {
        const selected=installedRuntimeVersion(account.codexHome,serverConfig.codexBin);
        if(process.env.CODEX_WEB_AUTO_RUNTIME_UPDATE!=="1"||!isNewerRuntime(selected,before))throw error;
        // Cold-start adoption is under the native lease. If that launch fails,
        // restore the previous pin and use a non-adopting recovery bridge.
        await account.bridge.stopAndWait();
        if(previous===null)fs.rmSync(file,{force:true});else writeFileAtomically(file,previous);
        const recovery=this.bridgeFactory(account.codexHome,account.id);
        account.bridge=recovery;this.forwardEvents(account,recovery);
        await recovery.start();
        this.runtimeUpgradeRetries.set(`${account.id}:${selected}`,nextRuntimeUpgradeRetry(undefined,"replacement"));
        console.warn("Codex cold-start upgrade restored previous runtime",{accountId:account.id,version:selected,restored:before});
      }
      this.markReadyUnlessAuthFailure(account);
    }));
    if (results.every((result) => result.status === "rejected")) {
      throw new Error("No Codex account in the pool could start.");
    }
    await this.refreshAccountData(false);
    if (!this.authRenewalTimer && process.env.CODEX_WEB_MANAGED_AUTH_RENEWAL !== "0") {
      const check = () => { void this.renewManagedCredentials().catch(() => this.emit("errorEvent", "Managed credential renewal deferred by a local error.")); };
      this.authRenewalTimer = setInterval(check, 60_000);
      this.authRenewalTimer.unref();
      this.authRenewalInitialTimer = setTimeout(check, 30_000);
      this.authRenewalInitialTimer.unref();
    }
    if (process.env.CODEX_WEB_AUTO_RUNTIME_UPDATE === "1" && !this.runtimeUpgradeTimer) {
      this.runtimeUpgradeTimer = setInterval(() => { void this.checkRuntimeUpgrade(); }, 60_000);
      this.runtimeUpgradeTimer.unref();
    }
    if(!this.storageTimer) {
      this.storageTimer=setInterval(()=>{void this.maintainCompressedStorage();},15*60*1000);
      this.storageTimer.unref();
      this.storageInitialTimer=setTimeout(()=>{void this.maintainCompressedStorage();},60_000); this.storageInitialTimer.unref();
    }
  }

  stop(): void {
    this.authRenewalStopped = true; this.authRenewalGeneration++;
    if (this.authRenewalTimer) clearInterval(this.authRenewalTimer);
    if (this.authRenewalInitialTimer) clearTimeout(this.authRenewalInitialTimer);
    this.authRenewalTimer = undefined; this.authRenewalInitialTimer = undefined;
    if(this.storageInitialTimer) clearTimeout(this.storageInitialTimer);
    this.storageInitialTimer=undefined;
    if(this.storageTimer) clearInterval(this.storageTimer);
    this.storageTimer=undefined;
    if (this.runtimeUpgradeTimer) clearInterval(this.runtimeUpgradeTimer);
    this.runtimeUpgradeTimer = undefined;
    for (const account of this.accounts) {
      account.bridge.stop();
    }
  }

  /** Rolling upgrade under the same request barrier as catalog maintenance. */
  async applyRuntimeVersionIfIdle(accountId: string, version: string): Promise<"busy" | "unchanged" | "reloaded"> {
    const account = this.accountsById.get(accountId);
    if (!account) throw new Error("Unknown account");
    const current = installedRuntimeVersion(account.codexHome, serverConfig.codexBin);
    if (!isNewerRuntime(version,current)) return "unchanged";
    const busy = (details: RuntimeBusyReason): "busy" => {
      const key = `${account.id}:${version}`, signature = JSON.stringify(details), previous = this.runtimeUpgradeBusy.get(key);
      if (!previous || previous.signature !== signature || Date.now() - previous.at >= 600_000) {
        this.runtimeUpgradeBusy.set(key, { signature, at: Date.now() });
        console.info("Codex runtime update waiting for idle", { accountId: account.id, version, ...details });
      }
      writeFileAtomically(path.join(account.codexHome, ".web-runtime-upgrade-status.json"), JSON.stringify({ version, current, checkedAt: new Date().toISOString(), ...details }));
      return "busy";
    };
    if (account.authFailureCode) return busy({ reason: "authorization_required" });
    if (this.accountMaintenance.has(account.id)) return busy({ reason: "account_maintenance" });
    let release!: () => void;
    this.accountMaintenance.set(account.id,new Promise<void>(resolve => {release=resolve;}));
    const file=runtimeSelectionPath(account.codexHome);
    const previous=fs.existsSync(file)?fs.readFileSync(file,"utf8"):null;
    let stopped=false;
    let stage: RuntimeUpgradeStage = "preflight";
    try {
      if (account.activeRequests) return busy({ reason: "active_requests", count: account.activeRequests });
      if (account.bridge.getPendingServerRequests().length) return busy({ reason: "pending_approval" });
      let reason: RuntimeBusyReason = { reason: "unknown" };
      if (!await runtimeIsIdle(account.bridge, value => { reason = value; })) return busy(reason);
      // Incoming requests are waiting at the barrier; goals/queues/terminals
      // were checked natively, so no model turn is interrupted here.
      stage = "replacement";
      await account.bridge.stopAndWait(); stopped=true;
      writeRuntimeSelection(account.codexHome,version);
      const replacement=this.bridgeFactory(account.codexHome,account.id);
      account.bridge=replacement;this.forwardEvents(account,replacement);
      await replacement.start(); stopped=false;
      this.markReadyUnlessAuthFailure(account);
      this.runtimeUpgradeBusy.delete(`${account.id}:${version}`);
      writeFileAtomically(path.join(account.codexHome, ".web-runtime-upgrade-status.json"), JSON.stringify({ version, checkedAt: new Date().toISOString(), reason: "upgraded" }));
      this.emit("accountRuntime",{accountId:account.id,event:"runtime_upgraded",version});
      return "reloaded";
    } catch(error) {
      if(stopped) {
        try {
          await account.bridge.stopAndWait();
          if(previous===null) fs.rmSync(file,{force:true});
          else writeFileAtomically(file,previous);
          const recovery=this.bridgeFactory(account.codexHome,account.id);
          account.bridge=recovery;this.forwardEvents(account,recovery);
          await recovery.start();
        } catch (rollbackError) {
          throw new RuntimeUpgradeFailure("rollback", rollbackError);
        }
      }
      throw new RuntimeUpgradeFailure(stage, error);
    } finally {this.accountMaintenance.delete(account.id);release();}
  }

  private async checkRuntimeUpgrade(): Promise<void> {
    if(this.runtimeUpgradeChecking) return;
    this.runtimeUpgradeChecking=true;
    try {
      const root=fileURLToPath(new URL("../../",import.meta.url));
      const file=path.join(root,"bin/runtime-candidate.json");
      if(!fs.existsSync(file)) return;
      const candidate=JSON.parse(fs.readFileSync(file,"utf8"));
      if(candidate.validated!==true || !/^\d+\.\d+\.\d+$/.test(candidate.version)) return;
      const binary=path.join(root,`bin/codex-${candidate.version}/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`);
      fs.accessSync(binary,fs.constants.X_OK);
      for(const account of this.accounts) {
        const key=`${account.id}:${candidate.version}`;
        const previousRetry = this.runtimeUpgradeRetries.get(key);
        if(previousRetry && previousRetry.retryAt > Date.now()) continue;
        try {
          const result=await this.applyRuntimeVersionIfIdle(account.id,candidate.version);
          if(result !== "busy") this.runtimeUpgradeRetries.delete(key);
          if(result==="reloaded") console.info("Codex runtime updated",{accountId:account.id,version:candidate.version});
        } catch(error) {
          const stage = error instanceof RuntimeUpgradeFailure ? error.stage : "preflight";
          const retry = nextRuntimeUpgradeRetry(previousRetry, stage);
          this.runtimeUpgradeRetries.set(key, retry);
          console.warn("Codex runtime update deferred after failure",{accountId:account.id,version:candidate.version,stage,attempts:retry.attempts,retryAt:new Date(retry.retryAt).toISOString(),error:error instanceof Error?error.message:"runtime failure"});
        }
      }
    } catch(error) { console.warn("Codex update candidate unavailable",{error:error instanceof Error?error.message:"runtime failure"}); }
    finally {this.runtimeUpgradeChecking=false;}
  }

  modelCatalogTargets(): ModelCatalogTarget[] {
    return this.accounts
      .filter((account) => account.kind === "codex-account")
      .map((account) => ({
        id: account.id,
        codexHome: account.codexHome,
        catalogPath: path.join(account.codexHome, MODEL_CATALOG_FILENAME)
      }));
  }

  /** Native Codex owns its remote discovery/cache; UI catalog sources stay
   * independent and are still returned by modelCatalogTargets(). */
  automaticModelCatalogTargets(): ModelCatalogTarget[] {
    return this.modelCatalogTargets().filter(target => !nativeModelDiscoveryEnabled(target.codexHome));
  }

  /**
   * Install a validated catalog and replace only this account's app-server.
   * New requests wait on the maintenance barrier, while running turns cause a
   * busy result so the caller can retry without interrupting user work.
   */
  async applyModelCatalogIfIdle(accountId: string, catalogText: string): Promise<ModelCatalogApplyResult> {
    const account = this.accountsById.get(accountId);
    if (!account || account.kind !== "codex-account") throw new Error(`Unknown Codex account: ${accountId}`);
    if (this.accountMaintenance.has(account.id)) return "busy";

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    this.accountMaintenance.set(account.id, barrier);
    const catalogPath = path.join(account.codexHome, MODEL_CATALOG_FILENAME);
    let previousCatalog: string | null = null;
    let catalogInstalled = false;
    let runtimeStopped = false;
    try {
      previousCatalog = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : null;
      if (previousCatalog === catalogText) return "unchanged";
      if (account.activeRequests || account.bridge.getPendingServerRequests().length) return "busy";

      const loaded = asRecord(await account.bridge.request("thread/loaded/list", {}, 15_000));
      if (!Array.isArray(loaded.data)) throw new Error("Codex did not return its loaded-thread list.");
      const loadedIds = loaded.data.filter((value): value is string => typeof value === "string" && Boolean(value));
      const statuses = await Promise.all(loadedIds.map(async (threadId) => {
        const response = asRecord(await account.bridge.request("thread/read", { threadId, includeTurns: false }, 15_000));
        return String(asRecord(asRecord(response.thread).status).type ?? "");
      }));
      if (statuses.some((status) => status !== "idle")) return "busy";

      if (previousCatalog !== null) writeFileAtomically(`${catalogPath}.auto-backup`, previousCatalog);
      writeFileAtomically(catalogPath, catalogText);
      catalogInstalled = true;
      // Generate the 0.159.2 Responses compatibility copy before constructing
      // the replacement bridge so its immutable launch arguments use it.
      responsesCompatibleModelCatalog(catalogPath);

      const previousBridge = account.bridge;
      await previousBridge.stopAndWait();
      runtimeStopped = true;
      const replacement = this.bridgeFactory(account.codexHome, account.id);
      account.bridge = replacement;
      this.forwardEvents(account, replacement);
      await replacement.start();
      runtimeStopped = false;
      account.supportedModels = accountSupportedModels(account.codexHome);
      this.markReadyUnlessAuthFailure(account);
      this.emit("accountRuntime", { accountId: account.id, event: "model_catalog_reloaded" });
      return "reloaded";
    } catch (error) {
      if (catalogInstalled) {
        try {
          // A failed start may still have spawned a child or armed its native
          // restart loop, so always stop the currently assigned bridge before
          // restoring the previous catalog.
          await account.bridge.stopAndWait();
          runtimeStopped = true;
          if (previousCatalog === null) fs.unlinkSync(catalogPath);
          else writeFileAtomically(catalogPath, previousCatalog);
          if (previousCatalog !== null) responsesCompatibleModelCatalog(catalogPath);
          const recovery = this.bridgeFactory(account.codexHome, account.id);
          account.bridge = recovery;
          this.forwardEvents(account, recovery);
          await recovery.start();
          runtimeStopped = false;
          account.supportedModels = accountSupportedModels(account.codexHome);
        } catch (recoveryError) {
          throw new Error(`模型目录更新失败，旧目录恢复也未完成：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
        }
      }
      throw error;
    } finally {
      this.accountMaintenance.delete(account.id);
      release();
    }
  }

  getPendingServerRequests(): Array<{ id: number | string; method: string; params: unknown; receivedAt: string; accountId: string }> {
    return Array.from(this.serverRequestAccounts.entries()).map(([id, route]) => {
      const original = route.bridge.getPendingServerRequests().find((item) => item.id === route.originalId);
      return original ? { ...original, id, accountId: route.accountId } : null;
    }).filter((item): item is { id: number | string; method: string; params: unknown; receivedAt: string; accountId: string } => Boolean(item));
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
    validateModelRequest(account.codexHome, method, params);
    account.activeRequests += 1;
    try {
      // Enforce native-owned renewal at the shared transport boundary, also
      // covering explicit thread-account readers and future host call sites.
      const requestParams = method === "account/read" ? { ...asRecord(params), refreshToken: false }
        : method === "thread/start" || method === "thread/resume" || method === "thread/fork"
          ? await withSubagentHistoryGuard(account.bridge, account.codexHome, params)
          : params;
      return await account.bridge.request(method, requestParams, timeoutMs);
    } catch(error) {
      if(["account/read","account/rateLimits/read","account/usage/read"].includes(method))this.diagnose(account,"health_verify","failure",error);
      throw error;
    } finally {
      account.activeRequests -= 1;
    }
  }

  respondToServerRequest(id: number | string, result: unknown): void {
    const route = this.serverRequestAccounts.get(id);
    if (!route) throw new Error(`Unknown Codex server request: ${id}`);
    route.bridge.respondToServerRequest(route.originalId, result);
    this.serverRequestAccounts.delete(id);
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

    // Pool callers may read account state, but only Codex itself owns OAuth
    // refresh. Clamp legacy/direct host account/read requests as well as quota
    // polling so a caller cannot bypass the native refresh lifecycle.
    const requestParams = method === "account/read" ? { ...asRecord(params), refreshToken: false } : params;
    const account = await this.accountForRequest(method, requestParams);
    const startingProcessId = method === "command/exec" ? processIdFromParams(requestParams) : null;
    // PTY requests stay pending until the shell exits. Follow-up write/resize
    // must resolve to this same account while the original request is running.
    if (startingProcessId) this.processAccounts.set(startingProcessId, account.id);
    try {
      const result = await this.invokeAccount(account, method, requestParams, timeoutMs);
      this.markReadyUnlessAuthFailure(account);
      if (method === "thread/start" || method === "thread/fork") {
        const threadId = threadIdFromStartResult(result);
        if (threadId) {
          this.threadAccounts.set(threadId, account.id);
          this.persistState();
        }
      }
      if (method === "command/exec/terminate") {
        const processId = processIdFromParams(requestParams);
        if (processId) this.processAccounts.delete(processId);
      }
      if (startingProcessId) this.processAccounts.delete(startingProcessId);
      return result;
    } catch (error) {
      if (startingProcessId) this.processAccounts.delete(startingProcessId);
      if (error instanceof Error && "code" in error && error.code === "unsupported_model_capability") throw error;
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

  getAccountMemoryHeadroom(accountId: string): number | null {
    return this.accountsById.get(accountId)?.bridge.getMemoryHeadroom() ?? null;
  }

  async resolveThreadAccount(threadId: string): Promise<{ id: string; label: string }> {
    const account = await this.accountForRequest("thread/read", { threadId });
    return { id: account.id, label: account.label };
  }

  async startThreadOnAccount(accountId: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    assertCodexModelRequest(params);
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
    assertCodexModelRequest(params);
    const account = this.accountsById.get(accountId);
    if (!account) throw new Error(`Unknown account-pool account: ${accountId}`);
    try {
      const result = await this.invokeAccount(account, "thread/fork", params, timeoutMs);
      this.markReadyUnlessAuthFailure(account);
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

  /** Serialize a native history mutation against all pool requests. Calls
   * inside the callback use the owning bridge to avoid waiting on our barrier. */
  async withThreadMaintenance<T>(threadId: string, work: (bridge: CodexBridge) => Promise<T>): Promise<T> {
    const account = await this.accountForRequest("thread/read", { threadId });
    if (this.accountMaintenance.has(account.id) || account.activeRequests || account.bridge.getPendingServerRequests().length) {
      throw new LegacyRollbackConflictError("该账号正在处理请求或审批，请稍后重试；草稿和附件仍保留。");
    }
    let release!: () => void;
    this.accountMaintenance.set(account.id, new Promise<void>(resolve => { release = resolve; }));
    try { return await work(account.bridge); }
    finally { this.accountMaintenance.delete(account.id); release(); }
  }

  /** Rewind a stopped legacy suffix without changing the thread id. Original
   * records stay in the log; Codex replays the rollback marker on reload. */
  async rollbackLegacyLatest(threadId: string, expectedTurnId: string, edit?: { expectedLatestTurnId: string; allowHistoryRewrite: boolean }): Promise<unknown> {
    const account = await this.accountForRequest("thread/read", { threadId });
    if (this.accountMaintenance.has(account.id)) throw new LegacyRollbackConflictError("该账号正在处理另一项会话维护，请稍后重试。");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    this.accountMaintenance.set(account.id, barrier);
    let marker: AppendedRollbackMarker | null = null;
    let stopped = false;
    try {
      if (account.activeRequests || account.bridge.getPendingServerRequests().length) {
        throw new LegacyRollbackConflictError("该账号还有正在处理的请求或审批，请稍后重试撤回。");
      }
      if (!await runtimeIsIdle(account.bridge)) throw new LegacyRollbackConflictError("该账号还有运行中会话、排队任务或后台终端，请稍后重试；草稿和附件仍保留。");
      // Never serialize a legacy rollout into Node: it may be larger than the
      // shared backend heap. Read only bounded structural metadata at its tail.
      const before = asRecord(asRecord(await account.bridge.request("thread/read", { threadId, includeTurns: false }, 30_000)).thread);
      if (typeof before.path !== "string" || !before.path) throw new Error("Codex 未提供该会话的日志路径。");
      let metadata = await readLegacyTailMetadata(await readableRolloutPath(before.path), edit?.allowHistoryRewrite ? expectedTurnId : undefined);
      const last = metadata.latest;
      if (before.historyMode !== "legacy" || !last || last.id !== (edit?.expectedLatestTurnId ?? expectedTurnId) || !metadata.target || metadata.target.id !== expectedTurnId) {
        throw new LegacyRollbackConflictError("会话已更新或待编辑的提问已撤回，请刷新后重试；原记录未改动。");
      }
      if (!["completed", "failed", "interrupted"].includes(String(last.status))) {
        throw new LegacyRollbackConflictError("最后一轮仍在运行，请等待完成或先终止回答。");
      }
      if (!metadata.target.hasUserMessage) {
        throw new LegacyRollbackConflictError("目标轮次不是用户提问，不能自动撤回。");
      }
      if(!fs.existsSync(before.path)) {
        // Only native Codex may recover a writable rollout and acquire its
        // writer locks. A read cache is never used as the edit target.
        await account.bridge.request('thread/resume',{threadId,excludeTurns:true},30_000);
        metadata=await readLegacyTailMetadata(before.path, edit?.allowHistoryRewrite ? expectedTurnId : undefined);
        if(metadata.latest?.id!==(edit?.expectedLatestTurnId ?? expectedTurnId) || metadata.target?.id!==expectedTurnId) throw new LegacyRollbackConflictError('恢复后的会话已变化，未执行撤回，请刷新后重试。');
      }
      await account.bridge.stopAndWait();
      stopped = true;
      marker = await appendLegacyRollbackMarker(account.codexHome, before.path, threadId, metadata, metadata.rollbackTurns);
      await account.bridge.start();
      stopped = false;
      const after = asRecord(asRecord(await account.bridge.request("thread/read", { threadId, includeTurns: false }, 30_000)).thread);
      const remaining = await readLegacyTailMetadata(before.path);
      if (after.id !== threadId || after.historyMode !== "legacy" || remaining.latest?.id !== metadata.retainedPrevious?.id || remaining.latest?.id === expectedTurnId) {
        throw new Error("撤回标记未被当前 Codex 正确重放，正在恢复原记录。");
      }
      marker = null;
      this.markReadyUnlessAuthFailure(account);
      return { thread: { id: threadId, path: before.path, historyMode: "legacy", turns: [] },
        rolledBackTurnId: expectedTurnId, rolledBackTurns: metadata.rollbackTurns, latestTurnId: remaining.latest?.id ?? null };
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
    assertCodexModelRequest(params);
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
      // A pay-as-you-go provider must only be chosen explicitly by model;
      // it must not become the implicit default when quota data is absent.
      : this.accounts.filter((account) => account.id !== "ark-pay");
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
        const credential = this.currentCredentialVersion(account);
        this.updateCredentialVersion(account, credential);
        await this.reloadChangedCredentialsIfIdle(account);
        // Host quota polling only reads account state. Native Codex owns token
        // staleness refresh and recovery during actual model requests.
        const [accountSettled] = await Promise.allSettled([
          this.invokeAccount(account, "account/read", { refreshToken: false }, 12_000)
        ]);
        this.updateCredentialVersion(account, this.currentCredentialVersion(account));
        const accountRead = accountSettled.status === "fulfilled" ? asRecord(accountSettled.value) : null;
        const missingAuth = accountRead?.account === null && accountRead.requiresOpenaiAuth !== false;
        // Native quota reads may await optional reset-credit details and then
        // fall back to the usage response. Do not time out before that bounded
        // fallback completes. Cached snapshots remain non-blocking to viewers.
        const [limitsSettled, usageSettled] = await Promise.allSettled([
          this.invokeAccount(account, "account/rateLimits/read", undefined, 30_000),
          this.invokeAccount(account, "account/usage/read", undefined, 30_000)
        ]);
        const results = [accountSettled, limitsSettled, usageSettled] as const;
        const errors = results.flatMap((result, index) => result.status === "rejected"
          ? [`${["account", "rateLimits", "usage"][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : []);
        if (missingAuth) {
          const error = `account: 登录失效${account.authFailureCode ? `（${account.authFailureCode}）` : ""}，请重新完成设备授权；反复刷新不能恢复已失效的凭据。`;
          errors.unshift(error);
          if (previous?.errors[0] !== error) {
            this.emit("accountAuth", { accountId: account.id, code: account.authFailureCode ?? "account_missing", requiresLogin: true });
          }
        } else if (account.authFailureCode) {
          errors.unshift(authFailureWarning(account.authFailureCode));
        }
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
        this.persistState();
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
