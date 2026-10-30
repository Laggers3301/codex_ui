export type CommunicationKind = "topic" | "service" | "action";
export type CommunicationState = "published" | "pending" | "accepted" | "executing" | "cancel_requested" | "succeeded" | "failed" | "rejected" | "canceled" | "timed_out";
export type CommunicationOperation =
  | { operation: "task.send"; targetThreadId: string; message: string; returnToSource?: boolean }
  | { operation: "task.cancel"; id: string }
  | { operation: "topic.subscribe" | "topic.unsubscribe" | "service.advertise" | "service.unadvertise" | "action.advertise" | "action.unadvertise"; name: string }
  | { operation: "topic.publish"; name: string; message: string }
  | { operation: "service.call"; name: string; message: string; timeoutSeconds?: number }
  | { operation: "service.respond"; id: string; result: string; success: boolean }
  | { operation: "action.send"; name: string; message: string; timeoutSeconds?: number }
  | { operation: "action.update"; id: string; status: "accepted" | "executing" | "succeeded" | "failed" | "rejected" | "canceled"; message?: string; progress?: number }
  | { operation: "action.cancel" | "inbox.ack"; id: string };
export type CommunicationCommand = CommunicationOperation & { requestId: string };
export interface CommunicationBinding { kind: CommunicationKind; name: string; threadId: string; threadName: string }
export interface CommunicationMessage {
  id: string; kind: CommunicationKind; name: string; sourceThreadId: string; targetThreadId: string | null;
  sourceThreadName: string; targetThreadName: string | null; state: CommunicationState;
  message: string; result: string | null; progress: number | null;
  feedback: Array<{ at: string; message: string; progress: number | null }>;
  createdAt: string; updatedAt: string; deadlineAt: string | null; unread: boolean;
}
export interface CommunicationSnapshot {
  tasks: import("./sessionTasks").SessionTask[];
  threadId: string; sampledAt: string; directory: CommunicationBinding[]; bindings: CommunicationBinding[];
  inbox: CommunicationMessage[]; outbox: CommunicationMessage[]; unreadCount: number;
}
export const communicationStateLabels: Record<CommunicationState, string> = {
  published: "已发布", pending: "等待接收", accepted: "已接收", executing: "执行中", cancel_requested: "已请求取消，等待确认",
  succeeded: "已完成", failed: "失败", rejected: "已拒绝", canceled: "已确认取消", timed_out: "已超时"
};
