export type SideChatStatus = "ready" | "starting" | "running" | "complete" | "error" | "closing";

export interface SideChat {
  id: string;
  userId: string;
  projectId: string;
  parentThreadId: string;
  threadId: string | null;
  selectedText: string;
  draft: string;
  modelProfileId: string;
  requestId: string | null;
  lastPrompt: string;
  turnId: string | null;
  status: SideChatStatus;
  error: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SideChatChange {
  id: string;
  userId: string;
  projectId: string;
  parentThreadId: string;
  sideChat: SideChat | null;
}
