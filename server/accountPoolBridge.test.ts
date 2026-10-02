import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { accountAppServerArgs, selectAccountCandidate, type AccountRoutingCandidate } from "./accountPoolBridge.js";
import { AccountPoolBridge } from "./accountPoolBridge.js";

class FakeCodexBridge extends EventEmitter {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly failingMethods = new Set<string>();
  stopped = false;

  async start(): Promise<void> {}
  stop(): void { this.stopped = true; }
  notify(): void {}
  getPendingServerRequests(): [] { return []; }
  respondToServerRequest(): void {}
  rejectServerRequest(): void {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.failingMethods.has(method)) throw new Error(`forced ${method} failure`);
    if (method === "thread/start") return { thread: { id: "new-thread" } };
    if (method === "thread/fork") return { thread: { id: "forked-thread" } };
    return method === "thread/unsubscribe" ? { status: "unsubscribed" } : {};
  }
}

class QuotaCodexBridge extends FakeCodexBridge {
  failLimits = false;

  override async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt", planType: "pro" } };
    if (method === "account/rateLimits/read") {
      if (this.failLimits) throw new Error("temporary usage endpoint failure");
      return { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 10_080 } } };
    }
    if (method === "account/usage/read") return { summary: { lifetimeTokens: 123 } };
    return super.request(method, params);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function candidate(
  id: string,
  remainingPercent: number,
  overrides: Partial<AccountRoutingCandidate> = {}
): AccountRoutingCandidate {
  return {
    id,
    health: "ready",
    remainingPercent,
    activeRequests: 0,
    assignedThreadCount: 0,
    ...overrides
  };
}

describe("account-pool routing policy", () => {
  it("retries transient account-state read failures without rotating credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-retry-"));
    const authPath = path.join(temporary, "auth.json");
    const fixture = JSON.stringify({ tokens: { refresh_token: "fixture-only" } });
    fs.writeFileSync(authPath, fixture, { mode: 0o600 });
    class RetryBridge extends QuotaCodexBridge {
      fail = true;
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === "account/read" && this.fail) {
          this.requests.push({ method, params });
          throw new Error("temporary transport timeout");
        }
        return super.request(method, params);
      }
    }
    const fake = new RetryBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      expect((await pool.refreshAccountData(true))[0].health).toBe("degraded");
      expect(fs.readFileSync(authPath, "utf8")).toBe(fixture);
      fake.fail = false;
      vi.setSystemTime(Date.now() + 61_000);
      expect((await pool.refreshAccountData(true))[0].health).toBe("ready");
      expect(fake.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }, { refreshToken: false }]);
      expect(fs.readFileSync(authPath, "utf8")).toBe(fixture);
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("coalesces twenty concurrent quota readers into one account-state read", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-concurrent-"));
    const fake = new QuotaCodexBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      const authEvents: Array<{ code: string }> = [];
      pool.on("accountAuth", event => authEvents.push(event));
      const results = await Promise.all(Array.from({ length: 20 }, () => pool.refreshAccountData(true)));
      expect(results.every(r => r[0].health === "ready")).toBe(true);
      expect(fake.requests.filter(r => r.method === "account/read")).toHaveLength(1);
      expect(fake.requests.filter(r => r.method === "account/rateLimits/read")).toHaveLength(1);
      expect(authEvents).toEqual([]);
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("rejects duplicate credential directories and copied OAuth refresh sessions", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-duplicate-auth-"));
    const a = path.join(temporary, "a"), b = path.join(temporary, "b");
    fs.mkdirSync(a); fs.mkdirSync(b);
    const create = (homes: string[]) => new AccountPoolBridge({ accounts: homes.map((codexHome, index) => ({ id: `a${index}`, label: `a${index}`, codexHome })), stateFile: "state.json" }, temporary, () => new FakeCodexBridge() as unknown as CodexBridge);
    try {
      expect(() => create([a, a])).toThrow("share one credential directory");
      for (const home of [a, b]) fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "fixture-only" } }));
      expect(() => create([a, b])).toThrow("share one OAuth refresh session");
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  it("keeps account reads non-rotating across repeated forced quota refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-cadence-"));
    const fake = new QuotaCodexBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      await pool.refreshAccountData(true);
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(Date.now() + 6_000);
        await pool.refreshAccountData(true);
      }
      expect(fake.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([
        { refreshToken: false }, { refreshToken: false }, { refreshToken: false }, { refreshToken: false }
      ]);
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("keeps last known credits across restart and labels failed reads as cached", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-credit-restart-"));
    class CreditsBridge extends QuotaCodexBridge {
      override async request(method: string, params?: unknown): Promise<unknown> {
        const response = await super.request(method, params);
        if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 100 }, credits: { balance: "62500", hasCredits: true, unlimited: false } } };
        return response;
      }
    }
    const config = { accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" };
    const firstBridge = new CreditsBridge();
    const first = new AccountPoolBridge(config, temporary, () => firstBridge as unknown as CodexBridge);
    let second: AccountPoolBridge | undefined;
    try {
      await first.refreshAccountData(true);
      first.stop();
      const nextBridge = new CreditsBridge(); nextBridge.failLimits = true;
      second = new AccountPoolBridge(config, temporary, () => nextBridge as unknown as CodexBridge);
      const snapshot = await second.refreshAccountData(true);
      expect(snapshot[0].limits).toMatchObject({ rateLimits: { credits: { balance: "62500" } } });
      expect(snapshot[0].errors.some(error => error.startsWith("rateLimits:"))).toBe(true);
      expect(snapshot[0].health).toBe("degraded");
    } finally { first.stop(); second?.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("reports a missing account, preserves terminal auth state and detects new device credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-relogin-"));
    fs.writeFileSync(path.join(temporary, "auth.json"), JSON.stringify({ tokens: { refresh_token: "fixture-old" } }), { mode: 0o600 });
    class LoginBridge extends QuotaCodexBridge {
      signedIn = false;
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === "account/read" && !this.signedIn) {
          this.requests.push({ method, params });
          this.emit("stderr", 'Failed to refresh token: refresh_token_reused');
          return { account: null, requiresOpenaiAuth: true };
        }
        return super.request(method, params);
      }
    }
    const fake = new LoginBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      const first = await pool.refreshAccountData(true);
      expect(first[0].health).toBe("degraded");
      expect(first[0].lastError).toContain("refresh_token_reused");
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await pool.refreshAccountData(true);
      expect(fake.requests.filter(r => r.method === "account/read").at(-1)?.params).toEqual({ refreshToken: false });
      fake.signedIn = true;
      fs.writeFileSync(path.join(temporary, "auth.json"), JSON.stringify({ tokens: { refresh_token: "fixture-new" } }), { mode: 0o600 });
      vi.setSystemTime(Date.now() + 6_000);
      const recovered = await pool.refreshAccountData(true);
      expect(fake.requests.filter(r => r.method === "account/read").at(-1)?.params).toEqual({ refreshToken: false });
      expect(recovered[0].health).toBe("ready");
      expect(recovered[0].errors).toEqual([]);
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("persists a terminal refresh failure without exposing its credential fingerprint", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-failure-state-"));
    const authPath = path.join(temporary, "auth.json");
    const statePath = path.join(temporary, "state.json");
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-only" } }), { mode: 0o600 });
    class TerminalRefreshBridge extends QuotaCodexBridge {
      persistedAtFailure: unknown;
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === "account/read") {
          this.requests.push({ method, params });
          this.emit("stderr", "Failed to refresh token: refresh_token_reused");
          this.persistedAtFailure = JSON.parse(fs.readFileSync(statePath, "utf8"));
          return { account: { type: "chatgpt", planType: "pro" } };
        }
        return super.request(method, params);
      }
    }
    const config = { accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" };
    const firstBridge = new TerminalRefreshBridge();
    const first = new AccountPoolBridge(config, temporary, () => firstBridge as unknown as CodexBridge);
    let second: AccountPoolBridge | undefined;
    const publicAuthEvents: unknown[] = [];
    first.on("accountAuth", event => publicAuthEvents.push(event));
    try {
      const firstSnapshot = await first.refreshAccountData(true);
      expect(firstSnapshot[0].health).toBe("degraded");
      expect(firstSnapshot[0].errors[0]).toContain("refresh_token_reused");
      const persistedFailure = (firstBridge.persistedAtFailure as { authFailures: Record<string, { code: string; credentialVersion: number; credentialFingerprint?: string }> }).authFailures.a;
      expect(persistedFailure).toMatchObject({ code: "refresh_token_reused", credentialVersion: fs.statSync(authPath).mtimeMs });
      expect(persistedFailure.credentialFingerprint).toMatch(/^[a-f\d]{64}$/i);
      const stateText = fs.readFileSync(statePath, "utf8");
      expect(stateText).not.toContain("fixture-only");
      expect(stateText).not.toContain("\"tokens\"");
      expect(JSON.stringify({ snapshot: firstSnapshot, events: publicAuthEvents })).not.toContain(persistedFailure.credentialFingerprint);
      first.stop();

      const nextBridge = new QuotaCodexBridge();
      second = new AccountPoolBridge(config, temporary, () => nextBridge as unknown as CodexBridge);
      const nextSnapshot = await second.refreshAccountData(true);
      expect(nextBridge.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }]);
      expect(nextSnapshot[0].health).toBe("degraded");
      expect(nextSnapshot[0].errors[0]).toContain("refresh_token_reused");
    } finally { first.stop(); second?.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("clears a persisted terminal refresh failure when the refresh-session identity changes", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-failure-version-"));
    const authPath = path.join(temporary, "auth.json");
    const statePath = path.join(temporary, "state.json");
    const writeAuth = (marker: string) => fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: marker } }), { mode: 0o600 });
    writeAuth("fixture-old");
    class TerminalRefreshBridge extends QuotaCodexBridge {
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === "account/read") {
          this.requests.push({ method, params });
          this.emit("stderr", "Failed to refresh token: refresh_token_expired");
          return { account: { type: "chatgpt", planType: "pro" } };
        }
        return super.request(method, params);
      }
    }
    const config = { accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" };
    const first = new AccountPoolBridge(config, temporary, () => new TerminalRefreshBridge() as unknown as CodexBridge);
    let second: AccountPoolBridge | undefined;
    try {
      await first.refreshAccountData(true);
      first.stop();
      const oldMtime = fs.statSync(authPath).mtime;
      writeAuth("fixture-new");
      fs.utimesSync(authPath, oldMtime, oldMtime);
      expect(fs.statSync(authPath).mtime.getTime()).toBe(oldMtime.getTime());

      const nextBridge = new QuotaCodexBridge();
      second = new AccountPoolBridge(config, temporary, () => nextBridge as unknown as CodexBridge);
      const snapshot = await second.refreshAccountData(true);
      expect(nextBridge.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }]);
      expect(snapshot[0].health).toBe("ready");
      expect(snapshot[0].errors).toEqual([]);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).authFailures).toEqual({});
    } finally { first.stop(); second?.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("does not clear a terminal refresh failure when the auth file is touched or reformatted with the same token", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-failure-touch-"));
    const authPath = path.join(temporary, "auth.json");
    const statePath = path.join(temporary, "state.json");
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-same" } }), { mode: 0o600 });
    class TerminalRefreshBridge extends QuotaCodexBridge {
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === "account/read") {
          this.requests.push({ method, params });
          this.emit("stderr", "Failed to refresh token: refresh_token_reused");
          return { account: { type: "chatgpt", planType: "pro" } };
        }
        return super.request(method, params);
      }
    }
    const config = { accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" };
    const first = new AccountPoolBridge(config, temporary, () => new TerminalRefreshBridge() as unknown as CodexBridge);
    let second: AccountPoolBridge | undefined;
    try {
      await first.refreshAccountData(true);
      first.stop();
      const oldTime = fs.statSync(authPath).mtime;
      fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-same" } }, null, 2), { mode: 0o600 });
      const touchedTime = new Date(Math.max(Date.now(), oldTime.getTime() + 2_000));
      fs.utimesSync(authPath, touchedTime, touchedTime);

      const nextBridge = new QuotaCodexBridge();
      second = new AccountPoolBridge(config, temporary, () => nextBridge as unknown as CodexBridge);
      const snapshot = await second.refreshAccountData(true);
      expect(nextBridge.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }]);
      expect(snapshot[0].health).toBe("degraded");
      expect(snapshot[0].errors[0]).toContain("refresh_token_reused");
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).authFailures.a.credentialFingerprint).toMatch(/^[a-f\d]{64}$/i);
    } finally { first.stop(); second?.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("migrates legacy numeric failures only on an exact mtime match and binds current token identity", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-failure-legacy-version-"));
    const authPath = path.join(temporary, "auth.json");
    const statePath = path.join(temporary, "state.json");
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-legacy" } }), { mode: 0o600 });
    fs.writeFileSync(statePath, JSON.stringify({ authFailures: { a: {
      code: "refresh_token_reused", credentialVersion: fs.statSync(authPath).mtimeMs
    } } }));
    const fake = new QuotaCodexBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      const snapshot = await pool.refreshAccountData(true);
      expect(snapshot[0].health).toBe("degraded");
      const saved = JSON.parse(fs.readFileSync(statePath, "utf8")).authFailures.a;
      expect(saved.credentialFingerprint).toMatch(/^[a-f\d]{64}$/i);
      expect(fake.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }]);
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("fails closed for malformed credential identity metadata", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-failure-unknown-"));
    const authPath = path.join(temporary, "auth.json");
    const statePath = path.join(temporary, "state.json");
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-before" } }), { mode: 0o600 });
    fs.writeFileSync(statePath, JSON.stringify({ authFailures: { a: {
      code: "refresh_token_invalidated", credentialVersion: "unknown", credentialFingerprint: "malformed"
    } } }));
    const fake = new QuotaCodexBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    let next: AccountPoolBridge | undefined;
    try {
      const first = await pool.refreshAccountData(true);
      expect(first[0].health).toBe("degraded");
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).authFailures.a.credentialFingerprint).toBeNull();
      pool.stop();

      fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-after" } }), { mode: 0o600 });
      const touched = new Date(Date.now() + 2_000);
      fs.utimesSync(authPath, touched, touched);
      const nextBridge = new QuotaCodexBridge();
      next = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => nextBridge as unknown as CodexBridge);
      const second = await next.refreshAccountData(true);
      expect(second[0].health).toBe("degraded");
      expect(nextBridge.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }]);
    } finally { pool.stop(); next?.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("uses the active API-key identity instead of a stale OAuth token when auth mode is API key", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-failure-apikey-"));
    const authPath = path.join(temporary, "auth.json");
    const statePath = path.join(temporary, "state.json");
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: "api_key", OPENAI_API_KEY: "fixture-api-old", tokens: { refresh_token: "fixture-stale-refresh" } }), { mode: 0o600 });
    class TerminalRefreshBridge extends QuotaCodexBridge {
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === "account/read") {
          this.requests.push({ method, params });
          this.emit("stderr", "Failed to refresh token: refresh_token_reused");
          return { account: { type: "chatgpt", planType: "pro" } };
        }
        return super.request(method, params);
      }
    }
    const config = { accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" };
    const first = new AccountPoolBridge(config, temporary, () => new TerminalRefreshBridge() as unknown as CodexBridge);
    let second: AccountPoolBridge | undefined;
    try {
      await first.refreshAccountData(true);
      first.stop();
      const oldMtime = fs.statSync(authPath).mtime;
      fs.writeFileSync(authPath, JSON.stringify({ auth_mode: "api_key", OPENAI_API_KEY: "fixture-api-new", tokens: { refresh_token: "fixture-stale-refresh" } }), { mode: 0o600 });
      fs.utimesSync(authPath, oldMtime, oldMtime);
      const nextBridge = new QuotaCodexBridge();
      second = new AccountPoolBridge(config, temporary, () => nextBridge as unknown as CodexBridge);
      const snapshot = await second.refreshAccountData(true);
      expect(snapshot[0].health).toBe("ready");
      expect(snapshot[0].errors).toEqual([]);
      expect(nextBridge.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }]);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).authFailures).toEqual({});
    } finally { first.stop(); second?.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("does not bind an in-flight terminal error to credentials replaced during that request", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-failure-race-"));
    const authPath = path.join(temporary, "auth.json");
    const statePath = path.join(temporary, "state.json");
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-old" } }), { mode: 0o600 });
    class ReplaceDuringRefreshBridge extends QuotaCodexBridge {
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === "account/read") {
          this.requests.push({ method, params });
          this.emit("stderr", "Failed to refresh token: refresh_token_reused");
          const oldMtime = fs.statSync(authPath).mtime;
          fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-new" } }), { mode: 0o600 });
          fs.utimesSync(authPath, oldMtime, oldMtime);
          return { account: { type: "chatgpt", planType: "pro" } };
        }
        return super.request(method, params);
      }
    }
    const fake = new ReplaceDuringRefreshBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      const snapshot = await pool.refreshAccountData(true);
      expect(snapshot[0].health).toBe("ready");
      expect(snapshot[0].errors).toEqual([]);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).authFailures).toEqual({});
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("loads pre-auth-failure state files without requiring the new field", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-state-legacy-"));
    const statePath = path.join(temporary, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ threadAccounts: { "thread-1": "a" }, quotaSnapshots: { a: { limits: {}, usage: {} } } }));
    const fake = new QuotaCodexBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      const snapshot = await pool.refreshAccountData(true);
      expect(snapshot[0].health).toBe("ready");
      expect(fake.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }]);
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("ignores persisted auth failure labels outside the canonical terminal-code allowlist", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-state-code-"));
    const authPath = path.join(temporary, "auth.json");
    const statePath = path.join(temporary, "state.json");
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-only" } }), { mode: 0o600 });
    fs.writeFileSync(statePath, JSON.stringify({ authFailures: { a: { code: "unrecognized_error", credentialVersion: fs.statSync(authPath).mtimeMs } } }));
    const fake = new QuotaCodexBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      const snapshot = await pool.refreshAccountData(true);
      expect(snapshot[0].health).toBe("ready");
      expect(fake.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: false }]);
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("keeps terminal auth health degraded after a successful generic RPC and ready status event", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-health-latch-"));
    fs.writeFileSync(path.join(temporary, "auth.json"), JSON.stringify({ tokens: { refresh_token: "fixture-only" } }), { mode: 0o600 });
    const fake = new QuotaCodexBridge();
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: temporary }], stateFile: "state.json" }, temporary, () => fake as unknown as CodexBridge);
    try {
      fake.emit("stderr", "Failed to refresh token: refresh_token_invalidated");
      fake.emit("status", { state: "ready" });
      await expect(pool.request("thread/read", { threadId: "known-thread" })).resolves.toEqual({});
      await expect(pool.request("account/read", { refreshToken: true })).resolves.toMatchObject({ account: { type: "chatgpt" } });
      await expect(pool.requestOnThreadAccount("known-thread", "account/read", { refreshToken: true })).resolves.toMatchObject({ account: { type: "chatgpt" } });
      const snapshot = await pool.refreshAccountData(true);
      expect(fake.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([
        { refreshToken: false }, { refreshToken: false }, { refreshToken: false }
      ]);
      expect(snapshot[0].health).toBe("degraded");
      expect(snapshot[0].lastError).toContain("refresh_token_invalidated");
      expect(snapshot[0].errors[0]).toContain("refresh_token_invalidated");
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  it("routes PTY input to the starting account before command/exec finishes", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pty-routing-"));
    const accountA = path.join(temporary, "a");
    const accountB = path.join(temporary, "b");
    fs.mkdirSync(accountA); fs.mkdirSync(accountB);
    let finish: ((value: unknown) => void) | undefined;
    class PendingCommandBridge extends FakeCodexBridge {
      override async request(method: string, params?: unknown): Promise<unknown> {
        if (method === "command/exec") {
          this.requests.push({ method, params });
          return new Promise(resolve => { finish = resolve; });
        }
        return super.request(method, params);
      }
    }
    const bridges = [new PendingCommandBridge(), new PendingCommandBridge()];
    let next = 0;
    const pool = new AccountPoolBridge({ accounts: [
      { id: "a", label: "a", codexHome: accountA }, { id: "b", label: "b", codexHome: accountB }
    ], stateFile: "state.json" }, temporary, () => bridges[next++] as unknown as CodexBridge);
    try {
      const command = pool.request("command/exec", { processId: "test-process", command: ["bash"] });
      await vi.waitFor(() => expect(bridges.some(bridge => bridge.requests.some(item => item.method === "command/exec"))).toBe(true));
      const selected = bridges.find(bridge => bridge.requests.some(item => item.method === "command/exec"))!;
      await pool.request("command/exec/write", { processId: "test-process", deltaBase64: "YQ==" });
      expect(selected.requests.some(item => item.method === "command/exec/write")).toBe(true);
      finish?.({ exitCode: 0 });
      await command;
    } finally { pool.stop(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  it("starts a restricted user's thread on the specified account, not the pool default", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-forced-account-"));
    const accountA = path.join(temporary, "account-a");
    const accountB = path.join(temporary, "account-b");
    fs.mkdirSync(accountA);
    fs.mkdirSync(accountB);
    const bridges = [new FakeCodexBridge(), new FakeCodexBridge()];
    let nextBridge = 0;
    try {
      const pool = new AccountPoolBridge({
        accounts: [
          { id: "account-a", label: "account-a", codexHome: accountA },
          { id: "account-c", label: "account-c", codexHome: accountB }
        ],
        stateFile: "state.json"
      }, temporary, () => bridges[nextBridge++] as unknown as CodexBridge);
      await pool.startThreadOnAccount("account-c", { model: "gpt-6-sol" });
      expect(bridges[0].requests).toHaveLength(0);
      expect(bridges[1].requests).toContainEqual({ method: "thread/start", params: { model: "gpt-6-sol" } });
      expect(pool.getKnownThreadAccount("new-thread")?.id).toBe("account-c");
      pool.stop();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it("passes an account-local model catalog to that account's app-server", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-"));
    try {
      expect(accountAppServerArgs(temporary)).toEqual(["app-server", "--listen", "stdio://"]);

      const catalogPath = path.join(temporary, "model-catalog-gpt-5.6-sol-long-context.json");
      fs.writeFileSync(catalogPath, '{"models":[]}');
      expect(accountAppServerArgs(temporary)).toEqual([
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        `model_catalog_json=${JSON.stringify(catalogPath)}`
      ]);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("always gives a new thread to the healthy account with more remaining quota", () => {
    const selected = selectAccountCandidate([
      candidate("account-a", 65, { activeRequests: 8, assignedThreadCount: 100 }),
      candidate("account-legacy", 53)
    ]);
    expect(selected.id).toBe("account-a");
  });

  it("routes a new thread only to an account whose catalog lists the requested model", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-aware-route-"));
    const accountA = path.join(temporary, "account-a");
    const accountB = path.join(temporary, "account-b");
    fs.mkdirSync(accountA);
    fs.mkdirSync(accountB);
    fs.writeFileSync(path.join(accountA, "model-catalog-gpt-5.6-sol-long-context.json"), JSON.stringify({
      models: [{ slug: "gpt-6-astra", visibility: "list" }]
    }));
    fs.writeFileSync(path.join(accountB, "model-catalog-gpt-5.6-sol-long-context.json"), JSON.stringify({
      models: [{ slug: "gpt-6-sol", visibility: "list" }]
    }));
    const bridges: FakeCodexBridge[] = [];
    try {
      const pool = new AccountPoolBridge({
        accounts: [
          { id: "account-a", label: "Account A", codexHome: accountA },
          { id: "account-b", label: "Account B", codexHome: accountB }
        ],
        stateFile: "state.json"
      }, temporary, () => {
        const fake = new FakeCodexBridge();
        bridges.push(fake);
        return fake as unknown as CodexBridge;
      });

      await pool.request("thread/start", { model: "gpt-6-sol" });

      expect(bridges[0].requests).toHaveLength(0);
      expect(bridges[1].requests).toContainEqual({ method: "thread/start", params: { model: "gpt-6-sol" } });
      pool.stop();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("excludes a degraded account even when it has more quota", () => {
    const selected = selectAccountCandidate([
      candidate("degraded", 100, { health: "degraded" }),
      candidate("healthy", 20)
    ]);
    expect(selected.id).toBe("healthy");
  });

  it("uses active requests and then assigned threads only for equal-quota ties", () => {
    expect(selectAccountCandidate([
      candidate("busy", 80, { activeRequests: 2 }),
      candidate("idle", 80, { activeRequests: 0, assignedThreadCount: 10 })
    ]).id).toBe("idle");

    expect(selectAccountCandidate([
      candidate("many", 80, { assignedThreadCount: 11 }),
      candidate("few", 80, { assignedThreadCount: 3 })
    ]).id).toBe("few");
  });

  it("prefers a known zero-percent balance over an unknown balance", () => {
    expect(selectAccountCandidate([
      candidate("unknown", -1),
      candidate("known", 0)
    ]).id).toBe("known");
  });

  it("still chooses deterministically when every account is degraded", () => {
    expect(selectAccountCandidate([
      candidate("lower", 10, { health: "degraded" }),
      candidate("higher", 20, { health: "degraded" })
    ]).id).toBe("higher");
  });

  it("rejects an empty account pool", () => {
    expect(() => selectAccountCandidate([])).toThrow(/no routing candidates/i);
  });

  it("keeps the last known quota when a later rate-limit refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00Z"));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-fallback-"));
    const codexHome = path.join(temporary, "account-home");
    fs.mkdirSync(codexHome);
    const quotaBridge = new QuotaCodexBridge();
    try {
      const pool = new AccountPoolBridge({
        accounts: [{ id: "account-a", label: "Account A", codexHome }],
        stateFile: "state.json",
        quotaCacheMs: 5_000
      }, temporary, () => quotaBridge as unknown as CodexBridge);

      const first = await pool.refreshAccountData(true);
      expect(first[0].limits).toMatchObject({ rateLimits: { primary: { usedPercent: 25 } } });

      quotaBridge.failLimits = true;
      vi.setSystemTime(new Date("2026-08-31T00:00:06Z"));
      const second = await pool.refreshAccountData(true);
      expect(second[0].limits).toEqual(first[0].limits);
      expect(second[0].errors.join(" ")).toContain("temporary usage endpoint failure");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("keeps startup, timers, changed credentials, and twenty forced quota reads non-rotating", async () => {
    vi.useFakeTimers();
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-keeper-"));
    const accountA = path.join(temporary, "account-a");
    const accountB = path.join(temporary, "account-b");
    const disabled = path.join(temporary, "disabled");
    fs.mkdirSync(accountA);
    fs.mkdirSync(accountB);
    fs.mkdirSync(disabled);
    const bridges: FakeCodexBridge[] = [];
    try {
      const pool = new AccountPoolBridge({
        accounts: [
          { id: "account-a", label: "Account A", codexHome: accountA },
          { id: "account-b", label: "Account B", codexHome: accountB },
          { id: "disabled", label: "Disabled", codexHome: disabled, enabled: false }
        ],
        stateFile: "state.json",
        authRefreshIntervalMs: 60_000
      }, temporary, () => {
        const fake = new FakeCodexBridge();
        bridges.push(fake);
        return fake as unknown as CodexBridge;
      });

      await pool.start();
      expect(bridges).toHaveLength(2);
      for (const bridge of bridges) {
        expect(bridge.requests.filter((request) => request.method === "account/read")).toEqual([
          { method: "account/read", params: { refreshToken: false } }
        ]);
      }

      // The deprecated cadence setting is accepted but does not create a
      // host-side refresh timer. Advancing beyond several old intervals is inert.
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      for (const bridge of bridges) {
        expect(bridge.requests.filter((request) => request.method === "account/read")).toHaveLength(1);
      }

      for (const home of [accountA, accountB]) {
        const authPath = path.join(home, "auth.json");
        fs.writeFileSync(authPath, JSON.stringify({ tokens: { refresh_token: "fixture-only" } }), { mode: 0o600 });
        const stamp = Date.now();
        fs.utimesSync(authPath, new Date(stamp), new Date(stamp));
      }
      await Promise.all(Array.from({ length: 20 }, () => pool.refreshAccountData(true)));
      for (const bridge of bridges) {
        expect(bridge.requests.filter((request) => request.method === "account/read")).toEqual([
          { method: "account/read", params: { refreshToken: false } },
          { method: "account/read", params: { refreshToken: false } }
        ]);
      }

      pool.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      for (const bridge of bridges) {
        expect(bridge.requests.filter((request) => request.method === "account/read")).toHaveLength(2);
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("routes all threads assigned to one account through one app-server bridge", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-context-route-"));
    const codexHome = path.join(temporary, "account-home");
    fs.mkdirSync(codexHome);
    const bridges: FakeCodexBridge[] = [];
    try {
      const pool = new AccountPoolBridge({
        accounts: [{ id: "account-a", label: "Account A", codexHome }],
        stateFile: "state.json"
      }, temporary, () => {
        const bridge = new FakeCodexBridge();
        bridges.push(bridge);
        return bridge as unknown as CodexBridge;
      });
      pool.assignThreadsToAccount(["changed-thread", "other-thread"], "account-a");

      await pool.request("turn/start", { threadId: "changed-thread" });
      await pool.request("turn/start", { threadId: "other-thread" });

      expect(bridges).toHaveLength(1);
      expect(bridges[0].requests).toContainEqual({ method: "turn/start", params: { threadId: "changed-thread" } });
      expect(bridges[0].requests).toContainEqual({ method: "turn/start", params: { threadId: "other-thread" } });
      pool.stop();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("uses a native fork when the selected target is the source account", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-fork-route-"));
    const accountA = path.join(temporary, "account-a");
    fs.mkdirSync(accountA);
    const bridges: FakeCodexBridge[] = [];
    try {
      const pool = new AccountPoolBridge({
        accounts: [{ id: "account-a", label: "Account A", codexHome: accountA }],
        stateFile: "state.json"
      }, temporary, () => {
        const fake = new FakeCodexBridge();
        bridges.push(fake);
        return fake as unknown as CodexBridge;
      });
      pool.assignThreadsToAccount(["source-thread"], "account-a");

      expect(pool.getBranchRoutingDecision("source-thread").mode).toBe("native");
      await pool.request("thread/fork", { threadId: "source-thread", lastTurnId: "turn-1" });
      await pool.request("turn/start", { threadId: "forked-thread" });

      expect(bridges[0].requests).toContainEqual({
        method: "thread/fork",
        params: { threadId: "source-thread", lastTurnId: "turn-1" }
      });
      expect(bridges[0].requests).toContainEqual({ method: "turn/start", params: { threadId: "forked-thread" } });
      pool.stop();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("load-balances a branch onto another account and runs its native fork there", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cross-account-route-"));
    const accountA = path.join(temporary, "account-a");
    const accountB = path.join(temporary, "account-b");
    fs.mkdirSync(accountA);
    fs.mkdirSync(accountB);
    const bridges: FakeCodexBridge[] = [];
    try {
      const pool = new AccountPoolBridge({
        accounts: [
          { id: "account-a", label: "Account A", codexHome: accountA },
          { id: "account-b", label: "Account B", codexHome: accountB }
        ],
        stateFile: "state.json"
      }, temporary, () => {
        const fake = new FakeCodexBridge();
        bridges.push(fake);
        return fake as unknown as CodexBridge;
      });
      pool.assignThreadsToAccount(["source-thread"], "account-a");
      const decision = pool.getBranchRoutingDecision("source-thread");
      expect(decision.mode).toBe("cross-account-native");
      expect(decision.sourceAccount?.id).toBe("account-a");
      expect(decision.targetAccount.id).toBe("account-b");
      await pool.forkThreadOnAccount("account-b", {
        threadId: "source-thread",
        path: "/private/source-snapshot.jsonl",
        lastTurnId: "turn-1"
      });
      await pool.request("turn/start", { threadId: "forked-thread" });

      expect(bridges[0].requests).toHaveLength(0);
      expect(bridges[1].requests).toContainEqual({
        method: "thread/fork",
        params: {
          threadId: "source-thread",
          path: "/private/source-snapshot.jsonl",
          lastTurnId: "turn-1"
        }
      });
      expect(bridges[1].requests).toContainEqual({ method: "turn/start", params: { threadId: "forked-thread" } });
      pool.stop();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
