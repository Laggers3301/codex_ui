import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";
import type { ProjectStore } from "./db.js";
import { registerRoutes } from "./routes.js";

class NativeFixture extends EventEmitter {
  requests: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly used: number, private readonly tokens: number) { super(); }
  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    // Keep the refresh in flight while the other HTTP readers join it.
    await new Promise(resolve => setTimeout(resolve, 10));
    if (method === "account/read") return { account: { type: "chatgpt", planType: "pro" } };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: this.used, windowDurationMins: 10080 } } };
    if (method === "account/usage/read") return { summary: { lifetimeTokens: this.tokens } };
    throw new Error(`Unexpected native method: ${method}`);
  }
  stop() {}
}

afterEach(() => vi.restoreAllMocks());

describe("legacy quota endpoint in an account pool", () => {
  it("shares one refresh with pool readers and keeps all metrics on the same account", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pool-quota-http-"));
    const homes = ["a", "b"].map(id => {
      const home = path.join(directory, id);
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: `fixture-only-${id}` } }));
      return home;
    });
    const natives = [new NativeFixture(10, 111), new NativeFixture(60, 222)];
    const pool = new AccountPoolBridge({ accounts: homes.map((codexHome, index) => ({ id: ["a", "b"][index], label: ["a", "b"][index], codexHome })), stateFile: "pool.json" }, directory,
      (_home, id) => natives[id === "a" ? 0 : 1] as unknown as CodexBridge);
    const app = Fastify();
    registerRoutes(app, pool as unknown as CodexBridge, {} as ProjectStore, { backgroundIndexing: false });
    try {
      const replies = await Promise.all(Array.from({ length: 20 }, (_, index) => app.inject({ method: "GET", url: index % 2 ? "/api/codex/account-pool?refresh=true" : "/api/codex/quota?refresh=true" })));
      for (const response of replies) expect(response.statusCode).toBe(200);
      const quota = replies[0].json().data;
      expect(quota.rateLimits.primary.usedPercent).toBe(10);
      expect(quota.usage.summary.lifetimeTokens).toBe(111);
      for (const native of natives) {
        expect(native.requests.filter(request => request.method === "account/read")).toEqual([{ method: "account/read", params: { refreshToken: false } }]);
        expect(native.requests.filter(request => request.method === "account/rateLimits/read")).toHaveLength(1);
        expect(native.requests.filter(request => request.method === "account/usage/read")).toHaveLength(1);
      }
      const currentTime = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(currentTime + 6000);
      await app.inject({ method: "GET", url: "/api/codex/quota?refresh=true" });
      for (const native of natives) {
        expect(native.requests.filter(request => request.method === "account/read").at(-1)?.params).toEqual({ refreshToken: false });
      }
    } finally {
      await app.close();
      pool.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
