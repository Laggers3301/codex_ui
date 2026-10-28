export type SessionTaskState = "queued" | "dispatching" | "running" | "succeeded" | "failed" | "interrupted" | "canceled" | "unknown";
export type TaskCallbackState = "none" | "queued" | "dispatching" | "delivered" | "failed" | "unknown";
export interface SessionTask {
  id: string; userId: string; sourceThreadId: string; targetThreadId: string;
  sourceThreadName: string; targetThreadName: string; message: string;
  sourceHref?: string; targetHref?: string;
  state: SessionTaskState; result: string | null; error: string | null;
  targetTurnId: string | null; sourceTurnId: string | null; callbackTurnId: string | null;
  callbackState: TaskCallbackState; callbackError: string | null; returnToSource: boolean;
  cancelRequested: boolean; parentTaskId: string | null; rootTurnId: string | null; depth: number;
  attempts: number; nextAttemptAt: number; createdAt: string; updatedAt: string;
}
export interface SessionTaskTarget { threadId: string; name: string; projectName: string; model: string }
export const sessionTaskLabels: Record<SessionTaskState, string> = {
  queued: "等待会话空闲", dispatching: "正在提交", running: "执行中", succeeded: "已完成", failed: "执行失败",
  interrupted: "已中断", canceled: "已取消", unknown: "执行状态待核对"
};
