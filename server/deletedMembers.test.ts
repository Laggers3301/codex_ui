import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { authenticatedUserFromHeaders, changeUserPassword, createSessionCookie, verifyCredentials, webUserDisplayNames } from "./auth.js";
import { serverConfig } from "./config.js";
import { assertTrackedUserQuotaAvailable, filterDeletedLeaderboardUsers, presentLeaderboard } from "./routes.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";
import type { CodexBridge } from "./codexBridge.js";

const originalConfig = { authUsersFile: serverConfig.authUsersFile, authMode: serverConfig.authMode, defaultAuthPassword: serverConfig.defaultAuthPassword };
let temporary: string;
let authPath: string;
function writeAuth(deleted = false) {
  const salt = "fixture-only";
  const stored = { salt, hash: scryptSync("ls", salt, 64).toString("hex"), createdAt: "", updatedAt: "" };
  fs.writeFileSync(authPath, JSON.stringify({ users: { kept: stored, ...(deleted ? {} : { removed: stored }) },
    ...(deleted ? { deletedUsers: { removed: { deletedAt: new Date().toISOString() } } } : {}) }));
}
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-member-auth-"));
  authPath = path.join(temporary, "members.json");
  serverConfig.authUsersFile = authPath;
  serverConfig.authMode = "member";
  serverConfig.defaultAuthPassword = "ls";
  vi.stubEnv("CODEX_WEB_SESSION_SECRET", "deleted-member-test-only");
  writeAuth();
});
afterEach(() => {
  Object.assign(serverConfig, originalConfig);
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe("deleted Web members", () => {
  it("rejects a deleted member's password and previously signed cookie, leaving other logins valid", () => {
    const removedCookie = createSessionCookie("removed").split(";", 1)[0];
    const keptCookie = createSessionCookie("kept").split(";", 1)[0];
    expect(authenticatedUserFromHeaders({ cookie: removedCookie })).toBe("removed");
    writeAuth(true);
    expect(verifyCredentials("removed", "ls")).toBe(false);
    expect(authenticatedUserFromHeaders({ cookie: removedCookie })).toBeNull();
    expect(verifyCredentials("kept", "ls")).toBe(true);
    expect(authenticatedUserFromHeaders({ cookie: keptCookie })).toBe("kept");
  });

  it("keeps deletion records when another member changes their password", () => {
    writeAuth(true);
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    auth.users.kept.displayName = "张三";
    fs.writeFileSync(authPath, JSON.stringify(auth));
    changeUserPassword("kept", "ls", "personal-password");
    expect(JSON.parse(fs.readFileSync(authPath, "utf8")).deletedUsers.removed).toBeDefined();
    expect(webUserDisplayNames().get("kept")).toBe("张三");
    expect(verifyCredentials("kept", "personal-password")).toBe(true);
  });

  it("reads saved names for both cached leaderboard periods and applies later edits immediately", () => {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    auth.users.bob = { ...auth.users.kept, displayName: "用户确认姓名" };
    fs.writeFileSync(authPath, JSON.stringify(auth));
    const scope = { totalTokens: 1, users: [{ userId: "bob", totalTokens: 1, quotaPercent: 10, models: [] }] };
    const board = { quotaAccountCount: 4, currentCycle: scope, lifetime: scope } as never;
    expect(presentLeaderboard(board).currentCycle.users[0].displayName).toBe("用户确认姓名");
    auth.users.bob.displayName = "新姓名";
    fs.writeFileSync(authPath, JSON.stringify(auth));
    const presented = presentLeaderboard(board);
    expect(presented.currentCycle.users[0].displayName).toBe("新姓名");
    expect(presented.lifetime.users[0].displayName).toBe("新姓名");
    expect(scope.users[0]).not.toHaveProperty("displayName");
  });

  it("filters both periods of an already cached leaderboard without erasing billing totals or mutating the cache", () => {
    const scope = { totalTokens: 100, resetAt: null, resetWindowMins: null, startAt: null, quotaUsedPercent: 40,
      users: [{ userId: "removed", totalTokens: 60, quotaPercent: 24 }, { userId: "kept", totalTokens: 40, quotaPercent: 16 }] };
    const board = { currentCycle: scope, lifetime: scope, updatedAt: "fixture", errors: [] };
    expect(filterDeletedLeaderboardUsers(board as never)).toBe(board);
    writeAuth(true);
    const filtered = filterDeletedLeaderboardUsers(board as never);
    expect(filtered.currentCycle.users.map(user => user.userId)).toEqual(["kept"]);
    expect(filtered.lifetime.users.map(user => user.userId)).toEqual(["kept"]);
    expect(filtered.currentCycle.totalTokens).toBe(100);
    expect(filtered.currentCycle.quotaUsedPercent).toBe(40);
    expect(filtered.currentCycle.users[0].quotaPercent).toBe(16);
    expect(board.currentCycle.users).toHaveLength(2);
  });

  it("blocks new and automatically continued turns for deleted members before quota probes", async () => {
    writeAuth(true);
    await expect(assertTrackedUserQuotaAvailable({} as never, {} as never, "removed"))
      .rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("revokes an already connected WebSocket before it can send another request", async () => {
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    class FakeBridge extends EventEmitter {
      requests: string[] = [];
      getPendingServerRequests() { return []; }
      async request(method: string) { this.requests.push(method); return {}; }
    }
    const bridge = new FakeBridge();
    const server = http.createServer();
    const wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind.");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { cookie: createSessionCookie("removed").split(";", 1)[0] }
    });
    try {
      await new Promise<void>((resolve, reject) => { ws.once("message", () => resolve()); ws.once("error", reject); });
      writeAuth(true);
      const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
      ws.send(JSON.stringify({ type: "thread.start", requestId: "revoked", prompt: "must not run" }));
      expect(await closed).toBe(1008);
      expect(bridge.requests).toEqual([]);
    } finally {
      ws.terminate();
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      store.close();
    }
  });
});
