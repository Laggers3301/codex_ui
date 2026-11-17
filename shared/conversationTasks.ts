export type ConversationTaskStatus = "running" | "completed" | "failed" | "stopped" | "interrupted" | "unknown";

/** Public task metadata. Native output paths and control identifiers stay server-side. */
export interface ConversationTask {
  id: string;
  kind: "agent" | "shell" | "unknown";
  description: string;
  status: ConversationTaskStatus;
  background: boolean;
  parentTaskId?: string;
  subagentType?: string;
  summary?: string;
  lastToolName?: string;
  updatedAt?: number;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

export interface ConversationTasksResponse { data: ConversationTask[]; supported: boolean; }
