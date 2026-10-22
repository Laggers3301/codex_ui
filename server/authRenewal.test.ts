import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialTiming, permanentAuthCode, renewalDue, renewalRetryDelay } from "./authRenewal.js";

describe("native-managed auth renewal policy", () => {
  it("renews before expiry, not on every quota read", () => {
    expect(renewalDue({ expiresAt: 200_000_000, refreshedAt: 0 }, 0)).toBe(false);
    expect(renewalDue({ expiresAt: 200_000_000, refreshedAt: 0 }, 199_000_000)).toBe(true);
    expect(renewalDue({ expiresAt: -1, refreshedAt: 0 }, 0)).toBe(true);
    expect(renewalDue(null)).toBe(false);
    expect(renewalDue({ expiresAt: null, refreshedAt: 0 }, 7 * 86400_000)).toBe(true);
  });
  it("recognizes explicit native relogin errors but does not invent reused/invalidated", () => {
    expect(permanentAuthCode("Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.")).toBe("refresh_token_unavailable");
    expect(permanentAuthCode("refresh_token_reused")).toBe("refresh_token_reused");
    for (const text of ["Failed to refresh token: timeout", "HTTP 503", "token_expired", "socket closed"]) expect(permanentAuthCode(text)).toBeNull();
  });
  it("backs off transient failures with a bounded delay", () => {
    expect(renewalRetryDelay(1)).toBe(60_000);
    expect(renewalRetryDelay(3)).toBe(240_000);
    expect(renewalRetryDelay(100)).toBe(3600_000);
  });
  it("reads only scheduling metadata without changing credentials", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "auth-renewal-policy-"));
    const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x." + Buffer.from(JSON.stringify({ exp: 12345 })).toString("base64url") + ".x", refresh_token: "fixture" }, last_refresh: "2026-10-20T00:00:00Z" });
    try {
      fs.writeFileSync(path.join(root, "auth.json"), auth);
      expect(credentialTiming(root)?.expiresAt).toBe(12345000);
      expect(fs.readFileSync(path.join(root, "auth.json"), "utf8")).toBe(auth);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
