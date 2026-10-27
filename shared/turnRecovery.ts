export type ErrorSource = "user" | "runtime" | "backend" | "connection" | "provider" | "resource" | "unknown";

export function errorSource(code: string): ErrorSource {
  if (code === "runtime_terminated") return "runtime";
  if (code === "backend_restarted") return "backend";
  if (code === "memory_pressure") return "resource";
  if (code === "stream_disconnected") return "connection";
  if (["quota_exceeded", "authentication_failed", "rate_limited", "model_overloaded", "upstream_http_429", "quota_or_rate_limit", "context_exhausted"].includes(code)) return "provider";
  return "unknown";
}

export interface PublicAppError {
  code: string;
  message: string;
  originalMessage: string;
  retryable: boolean;
  at: string;
  source?: ErrorSource;
}

export interface RecoveryInspection {
  status: "checking" | "ready" | "needs_review" | "running" | "waiting" | "completed" | "changed" | "unknown";
  at: string;
  message: string;
}

export interface TurnInterruption {
  turnId: string;
  previousTurnId?: string;
  requiresReview?: boolean;
  source: ErrorSource;
  unresolvedTools: string[];
  inspection?: RecoveryInspection;
}

export interface TurnRecoveryView {
  threadId: string;
  error: PublicAppError | null;
  job: null | { status: "waiting" | "running" | "exhausted"; attempts: number; maxAttempts: number; nextRetryAt: number | null };
  interruption?: TurnInterruption;
  dismissedTurnId?: string;
}
