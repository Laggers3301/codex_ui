export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface UserProfile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  rootPath: string;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  defaultSandbox: SandboxMode;
  defaultApprovalPolicy: ApprovalPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  createDirectory?: boolean;
  gitInit?: boolean;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultSandbox?: SandboxMode;
  defaultApprovalPolicy?: ApprovalPolicy;
}

export interface UpdateProjectInput {
  name?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultSandbox?: SandboxMode;
  defaultApprovalPolicy?: ApprovalPolicy;
}

export interface LocalSendSettings {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  destinationPath: string;
  identityFile: string;
  outputPath: string;
  updatedAt: string | null;
}

export interface UpdateLocalSendSettingsInput {
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  destinationPath?: string;
  identityFile?: string;
  outputPath?: string;
}

export interface RpcEnvelope {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export interface SocketClientMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface SocketServerMessage {
  type: string;
  requestId?: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
}
