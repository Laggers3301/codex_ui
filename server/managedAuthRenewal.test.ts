import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";

afterEach(() => vi.useRealTimers());
function credential(home: string, refresh: string, expires: number) {
  const file = path.join(home, "auth.json");
  fs.writeFileSync(file, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture." + Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000) })).toString("base64url") + ".fixture", refresh_token: refresh }, last_refresh: new Date().toISOString() }));
}
class Native extends EventEmitter {
  requests: { method: string; params: any }[] = [];
  renew: () => Promise<unknown> = async () => ({});
  starts = 0; stops = 0;
  async start() { this.starts++; }
  stop() { this.stops++; }
  async stopAndWait() { this.stops++; }
  getPendingServerRequests() { return []; }
  async request(method: string, params?: any) {
    this.requests.push({ method, params });
    if (method === "account/read" && params?.refreshToken) return this.renew();
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/loaded/list") return { data: [] };
    return {};
  }
}
function fixture(native = new Native()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "managed-auth-renewal-"));
  credential(home, "old-fixture", Date.now() + 3600_000);
  const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "a", codexHome: home }], stateFile: "state.json" }, home, () => native as unknown as CodexBridge);
  return { home, pool, native, clean() { pool.stop(); fs.rmSync(home, { recursive: true, force: true }); } };
}
it("single-flights renewal on the owning runtime, gates readers, and does not restart after its own rotation", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.native.renew = () => new Promise(resolve => { finish = resolve; });
  try {
    const first = f.pool.renewManagedCredentials();
    await Promise.all([f.pool.renewManagedCredentials(), f.pool.renewManagedCredentials()]);
    const read = f.pool.request("account/read", { refreshToken: true });
    await Promise.resolve();
    expect(f.native.requests.filter(r => r.params?.refreshToken === true)).toHaveLength(1);
    credential(f.home, "new-fixture", Date.now() + 10 * 86400_000);
    finish({ account: { type: "chatgpt" } }); await first; await read;
    expect(f.native.requests.filter(r => r.method === "account/read").map(r => r.params)).toEqual([{ refreshToken: true }, { refreshToken: false }]);
    await f.pool.refreshAccountData(true);
    expect(f.native.stops).toBe(0);
    await f.pool.renewManagedCredentials();
    expect(f.native.requests.filter(r => r.params?.refreshToken === true)).toHaveLength(1);
  } finally { f.clean(); }
});
it("backs off transport failures without invalidating or rewriting credentials", async () => {
  vi.useFakeTimers(); const f = fixture(); const original = fs.readFileSync(path.join(f.home, "auth.json"), "utf8");
  f.native.renew = async () => { throw new Error("HTTP 503 temporary transport timeout"); };
  try {
    await f.pool.renewManagedCredentials(); await f.pool.renewManagedCredentials();
    expect(f.native.requests.filter(r => r.params?.refreshToken === true)).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000); await f.pool.renewManagedCredentials();
    expect(f.native.requests.filter(r => r.params?.refreshToken === true)).toHaveLength(2);
    expect(fs.readFileSync(path.join(f.home, "auth.json"), "utf8")).toBe(original);
    expect(fs.existsSync(path.join(f.home, "state.json"))).toBe(false);
  } finally { f.clean(); }
});
it("latches a native relogin requirement, suppresses repeats, and clears it only for a new credential", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.native.renew = async () => { throw new Error("Your access token could not be refreshed. Please log out and sign in again."); };
  try {
    await f.pool.renewManagedCredentials();
    vi.setSystemTime(Date.now() + 3600_000); await f.pool.renewManagedCredentials();
    expect(f.native.requests.filter(r => r.params?.refreshToken === true)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(f.home, "state.json"), "utf8")).authFailures.a.code).toBe("refresh_token_unavailable");
    credential(f.home, "new-authorized-fixture", Date.now() + 10 * 86400_000);
    await f.pool.refreshAccountData(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.home, "state.json"), "utf8")).authFailures).toEqual({});
  } finally { f.clean(); }
});
it("recognizes the new error even across native stderr chunks", async () => {
  const f = fixture();
  try {
    f.native.emit("stderr", "ERROR codex_login::auth::manager: Your access token could not be ref");
    f.native.emit("stderr", "reshed. Please log out and sign in again.\n");
    expect(JSON.parse(fs.readFileSync(path.join(f.home, "state.json"), "utf8")).authFailures.a.code).toBe("refresh_token_unavailable");
  } finally { f.clean(); }
});
it("does not start another renewal or write a stale failure after pool shutdown", async () => {
  const f = fixture(); let reject!: (reason: Error) => void;
  f.native.renew = () => new Promise((_resolve, r) => { reject = r; });
  try {
    const pending = f.pool.renewManagedCredentials();
    f.pool.stop(); reject(new Error("Your access token could not be refreshed. Please log out and sign in again."));
    await pending; await f.pool.renewManagedCredentials();
    expect(f.native.requests.filter(r => r.params?.refreshToken === true)).toHaveLength(1);
    expect(fs.existsSync(path.join(f.home, "state.json"))).toBe(false);
  } finally { f.clean(); }
});
it("does not promote a logged-out high-quota account after an unrelated successful RPC", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "auth-routing-health-"));
  class MissingAuth extends Native {
    override async request(method: string, params?: any) {
      if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
      if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 0 } } };
      return super.request(method, params);
    }
  }
  const bad = new MissingAuth(), good = new Native();
  fs.mkdirSync(path.join(home,"bad")); fs.mkdirSync(path.join(home,"good"));
  let index = 0;
  const pool = new AccountPoolBridge({ accounts: [{ id: "bad", label: "bad", codexHome: path.join(home,"bad") }, { id: "good", label: "good", codexHome: path.join(home,"good") }], stateFile: "state.json" }, home, () => [bad,good][index++] as unknown as CodexBridge);
  try {
    await pool.refreshAccountData(true); pool.assignThreadsToAccount(["old-thread"], "bad");
    await pool.request("thread/read", { threadId: "old-thread", includeTurns: false });
    expect(pool.getBranchRoutingDecision("old-thread").targetAccount.id).toBe("good");
  } finally { pool.stop(); fs.rmSync(home,{recursive:true,force:true}); }
});
