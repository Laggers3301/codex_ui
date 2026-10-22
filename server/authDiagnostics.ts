import fs from "node:fs";
import path from "node:path";

export type AuthPhase = "device_start" | "device_authorization" | "credential_install" | "runtime_reload" | "health_verify" | "native_refresh" | "managed_refresh";
const codes = new Set(["refresh_token_reused", "refresh_token_invalidated", "refresh_token_expired", "refresh_token_unavailable", "invalid_grant", "invalid_client", "invalid_refresh_token", "token_expired", "token_revoked", "account_missing", "timeout", "transport_error", "authorization_conflict", "account_mismatch", "invalid_credentials", "verification_incomplete", "runtime_reload_failed", "authorization_failed", "authorization_expired", "unknown"]);
const phases = new Set<AuthPhase>(["device_start","device_authorization","credential_install","runtime_reload","health_verify","native_refresh","managed_refresh"]);
export interface AuthDiagnostic {
  time: string; accountId: string; phase: AuthPhase; outcome: "success" | "failure" | "deferred";
  code: string; httpStatus: number | null; requestId: string | null; lastRefresh: string | null;
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const safeRequestId = (v: unknown) => typeof v === "string" && /^(?:[a-fA-F0-9-]{16,64}|req_[a-zA-Z0-9_-]{8,64})$/.test(v) ? v : null;
function safeDate(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
}
/** Whitelist projection: never spread an error, response, headers or raw log. */
export function authDiagnostic(accountId: string, phase: AuthPhase, outcome: AuthDiagnostic["outcome"], error?: unknown, lastRefresh?: string | null): AuthDiagnostic {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(accountId) || !phases.has(phase) || !["success","failure","deferred"].includes(outcome)) throw new Error("Invalid auth diagnostic context");
  const e = record(error), detail = record(e.data);
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : typeof e.message === "string" ? e.message : "";
  const exact = [e.authCode,e.code,detail.code,text].find(v => typeof v === "string" && codes.has(v) && v!=="unknown");
  const matched = text.match(/\b(refresh_token_reused|refresh_token_invalidated|refresh_token_expired|refresh_token_unavailable|invalid_grant|invalid_client|invalid_refresh_token|token_expired|token_revoked)\b/)?.[1];
  const status = e.httpStatus ?? detail.httpStatus ?? detail.http_status ?? e.status ?? text.match(/\b(?:HTTP(?:\s+status)?|status)\s*[=:]?\s*([45]\d\d)\b/i)?.[1];
  const numeric = Number(status);
  const requestId = safeRequestId(e.requestId ?? detail.requestId ?? detail.request_id) ?? safeRequestId(text.match(/\b(?:x-request-id|request_id|requestId)\s*[=:]\s*["']?([A-Za-z0-9_-]+)/)?.[1]);
  const code = exact ?? matched ?? (/timed?\s*out|timeout/i.test(text) ? "timeout" : /TLS|connection|socket|network|transport/i.test(text) ? "transport_error" : "unknown");
  return {time:new Date().toISOString(),accountId,phase,outcome,code:String(code),httpStatus:Number.isInteger(numeric)&&numeric>=400&&numeric<=599?numeric:null,requestId,lastRefresh:safeDate(lastRefresh)};
}
export class AuthDiagnosticLog {
  constructor(private readonly file: string) {}
  append(input: AuthDiagnostic): void {
    // Project again at the file boundary; ignore any excess runtime keys.
    const row=authDiagnostic(input.accountId,input.phase,input.outcome,{code:input.code,httpStatus:input.httpStatus,requestId:input.requestId},input.lastRefresh);
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    if(fs.existsSync(this.file) && fs.statSync(this.file).size>=1024*1024) {
      if(fs.existsSync(this.file+".1"))fs.unlinkSync(this.file+".1");
      fs.renameSync(this.file,this.file+".1");
    }
    const fd=fs.openSync(this.file,fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{fs.fchmodSync(fd,0o600);fs.writeSync(fd,JSON.stringify(row)+"\n");}finally{fs.closeSync(fd);}
  }
}
