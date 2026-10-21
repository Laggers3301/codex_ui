import fs from "node:fs";
import path from "node:path";

export const renewalLeadMs = 24 * 60 * 60_000;
export type AuthFailureCode = "refresh_token_reused" | "refresh_token_invalidated" | "refresh_token_expired" | "refresh_token_unavailable";
export const authFailureCodes = new Set<AuthFailureCode>(["refresh_token_reused", "refresh_token_invalidated", "refresh_token_expired", "refresh_token_unavailable"]);
export function permanentAuthCode(message: string): AuthFailureCode | null {
  const explicit = message.match(/\b(refresh_token_reused|refresh_token_invalidated|refresh_token_expired|refresh_token_unavailable)\b/)?.[1];
  if (explicit) return explicit as AuthFailureCode;
  // Do not equate a timeout/5xx or a bare "failed to refresh" with revocation.
  return /Your access token could not be refreshed\.\s*Please log out and sign in again\./i.test(message) ? "refresh_token_unavailable" : null;
}
export interface CredentialTiming { expiresAt: number | null; refreshedAt: number | null; }
export function credentialTiming(home: string): CredentialTiming | null {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
    if (auth.auth_mode && auth.auth_mode !== "chatgpt") return null;
    if (!auth.tokens?.refresh_token || !auth.tokens?.access_token) return null;
    let expiresAt: number | null = null;
    try {
      // An unverified claim is used ONLY as a wake-up hint, never authorization.
      const claims = JSON.parse(Buffer.from(auth.tokens.access_token.split(".")[1], "base64url").toString());
      if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) expiresAt = claims.exp * 1000;
    } catch { /* Opaque tokens use the last-refresh wake-up hint instead. */ }
    const refreshed = Date.parse(auth.last_refresh);
    return { expiresAt, refreshedAt: Number.isFinite(refreshed) ? refreshed : null };
  } catch { return null; }
}
export function renewalDue(timing: CredentialTiming | null, now = Date.now()): boolean {
  if (!timing) return false;
  return timing.expiresAt !== null ? timing.expiresAt - now <= renewalLeadMs
    : timing.refreshedAt !== null && now - timing.refreshedAt >= 6 * 24 * 60 * 60_000;
}
export function renewalRetryDelay(failures: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(Math.max(failures - 1, 0), 6));
}
