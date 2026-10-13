/** A failed HTTP response is not evidence of expired account credentials. */
export function isDisconnectedStreamError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return /ResponseStreamDisconnected|ResponseStreamConnectionFailed|stream disconnected|stream closed before response\.completed/i
    .test(`${String(value.message ?? "")} ${JSON.stringify(value.codexErrorInfo ?? value.codex_error_info ?? "")}`);
}

/** Validate a terminal failed actor before a new user turn. Never replay it. */
export async function prepareDisconnectedThreadRetry(
  bridge: { request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> },
  failedThreads: Set<string>,
  threadId: string
): Promise<void> {
  if (!failedThreads.has(threadId)) return;
  const result = await bridge.request("thread/read", { threadId, includeTurns: false }, 30_000) as { thread?: { status?: { type?: string } } };
  const status = result.thread?.status?.type;
  // Native 0.159.2 accepts a new user turn on an idle/systemError actor.
  // A disconnected response does not require unloading this actor first.
  if (!["idle", "systemError", "notLoaded"].includes(String(status))) {
    throw new Error("会话仍在运行或等待批准，不能重新载入；请先停止或完成审批。");
  }
  failedThreads.delete(threadId);
}
