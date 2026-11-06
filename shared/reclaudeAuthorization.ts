export type ReclaudeAuthorizationPhase = "starting" | "logging_out" | "waiting_authorization" | "verifying" | "completed" | "failed" | "cancelled" | "interrupted";
export interface ReclaudeAuthorizationOperation {
  id: string;
  orgId: string;
  phase: ReclaudeAuthorizationPhase;
  startedAt: number;
  expiresAt: number;
  owned: boolean;
  authorizationUrl?: string;
  message?: string;
}
export interface ReclaudeAuthorizationStatus {
  enabled: boolean;
  organizations: Array<{ orgId: string; label: string; connected: boolean }>;
  operation: ReclaudeAuthorizationOperation | null;
}
export const reclaudeAuthorizationPending = (phase: ReclaudeAuthorizationPhase) =>
  ["starting", "logging_out", "waiting_authorization", "verifying"].includes(phase);

export function newReclaudeAuthorizationRequestId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  // getRandomValues also works on the LAN HTTP origins supported by this app.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function reclaudeAuthorizationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["reclaude.ai", "www.recode.cat"].includes(url.hostname) || url.port || url.username || url.password
      || url.pathname !== "/cli/auth" || !url.searchParams.get("state")) return null;
    if ([...url.searchParams.keys()].some(key => /token|secret|device_code|api.?key/i.test(key))) return null;
    return url.toString();
  } catch { return null; }
}
