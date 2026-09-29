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
          { id: "260803", label: "260803", codexHome: accountA },
          { id: "260901", label: "260901", codexHome: accountB }
        ],
        stateFile: "state.json"
      }, temporary, () => bridges[nextBridge++] as unknown as CodexBridge);
      await pool.startThreadOnAccount("260901", { model: "gpt-6-sol" });
      expect(bridges[0].requests).toHaveLength(0);
      expect(bridges[1].requests).toContainEqual({ method: "thread/start", params: { model: "gpt-6-sol" } });
      expect(pool.getKnownThreadAccount("new-thread")?.id).toBe("260901");
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
      candidate("260803", 65, { activeRequests: 8, assignedThreadCount: 100 }),
      candidate("260707", 53)
    ]);
    expect(selected.id).toBe("260803");
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

  it("refreshes authentication for every enabled account without a browser poll", async () => {
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
          { method: "account/read", params: { refreshToken: true } }
        ]);
      }

      await vi.advanceTimersByTimeAsync(60_000);
      for (const bridge of bridges) {
        expect(bridge.requests.filter((request) => request.method === "account/read")).toHaveLength(2);
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
