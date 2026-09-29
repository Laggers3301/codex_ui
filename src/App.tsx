import { Fragment, createContext, isValidElement, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ComponentPropsWithoutRef, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Application as IconParkApplication, Command as IconParkCommand } from "@icon-park/svg";
import { nodeInputRule } from "@tiptap/core";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { toggleComposerList } from "./composerList";
import { classifyProviderFailure, type ProviderFailureNotice } from "./providerFailure";
import { exhaustedAccountSuggestion, type ExhaustedAccountSuggestion } from "./accountExhaustion";
import "katex/dist/katex.min.css";
import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  GitBranch,
  Lightbulb,
  MessageSquare,
  Minus,
  MoreHorizontal,
  PencilLine,
  Pin,
  RefreshCcw,
  Search,
  Send,
  Settings2,
  Square,
  SquarePen,
  Sun,
  Moon,
  Trophy,
  Trash2,
  Upload,
  Plus,
  ChevronLeft,
  ChevronRight,
  X
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import { coalesceToolOutputs, collapseCodeModeWrappers, latestUserTimelineIndex, liveTimelineItems, mergeTimelineItems } from "./conversationTimeline";
import { ToolReveal } from "./ToolReveal";
import { parseQuestionTool, parseQuestionToolItem, questionHasLaterUserMessage, type ToolQuestion } from "./questionTool";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remend from "remend";
import type { PluggableList } from "unified";
import {
  createProject,
  branchThread,
  editLatestThreadTurn,
  deleteProject,
  deleteThread,
  exportThreadRecord,
  getApiUserId,
  getPushPublicKey,
  fetchProjectFileBlob,
  listDirectories,
  listModels,
  listCodexSkills,
  listProjects,
  listThreads,
  listArchivedThreads,
  listProjectHooks,
  createProjectHook,
  listProjectGitRepositories,
  setProjectHookTrust,
  setThreadArchived,
  createProjectWorktree,
  searchThreads,
  searchThreadHits,
  startThreadReview,
  listUsers,
  locateThreadItem,
  previewProjectFile,
  readCodexAccountPool,
  readCodexLeaderboard,
  readCodexQuota,
  readTrackedQuotaUsage,
  readLocalSendSettings,
  readThreadContext,
  readThread,
  readThreadItemOutput,
  removePushSubscription,
  savePushSubscription,
  selectDirectory,
  sendProjectFileToLocal,
  setApiUserId,
  testLocalSendSettings,
  THREAD_READ_MAX_LIMIT,
  updateLocalSendSettings,
  updateProject,
  updateThreadModelProfile,
  updateThreadContextConfig,
  updateThreadContextPin,
  updateThreadOrder,
  updateThreadPresentation,
  uploadProjectFiles
} from "./api";
import { codexSocket } from "./codexSocket";
import { TerminalPanel } from "./TerminalPanel";
import { normalizeGfmTableBoundaries, normalizeMathMarkdown, stripInterruptArtifacts } from "./markdown";
import { createRevealPass, emptyRevealSnapshot, StreamRevealSpan } from "./streamReveal";
import { exactSearchTurn, waitForSearchTarget } from "./searchNavigation";
import type {
  ApprovalPolicy,
  CodexAccountPool,
  CodexAccountPoolAccount,
  CodexNotification,
  CodexLeaderboard,
  CodexLeaderboardScope,
  CodexLeaderboardUserUsage,
  CodexQuota,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexSkill,
  DirectoryListResponse,
  LiveStateSnapshot,
  LiveAgentMessage,
  LiveToolItem,
  LocalSendSettings,
  ModelProfile,
  ThreadExportFormat,
  Project,
  ProjectFile,
  ProjectFilePreview,
  ReasoningEffort,
  SandboxMode,
  SocketMessage,
  ThreadItem,
  ThreadContextStatus,
  ThreadContextConfig,
  ThreadContextProfile,
  ThreadHistoryPage,
  ThreadSummary,
  TrackedQuotaUsage,
  Turn,
  UserProfile
} from "./types";
import { VirtualConversation, type VirtualConversationHandle } from "./VirtualConversation";

function DeferredConversationTurn({ render }: { render: () => ReactNode; "data-turn-id": string }) {
  return <>{render()}</>;
}

function IconParkSmallArrow({ direction }: { direction: "left" | "right" }) {
  return (
    <svg className="sidebarArrowIcon" aria-hidden="true" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
      <path d={direction === "left" ? "M12 23.992h24M24 36L12 24l12-12" : "M36 24.008H12M24 12l12 12l-12 12"} />
    </svg>
  );
}

interface LocalMessage {
  id: string;
  meta: string;
  text: string;
  kind?: "system" | "tool";
  placement?: "tail" | "conversation";
  threadId?: string | null;
  afterTurnId?: string | null;
}

const contextProfileOptions: Array<{
  id: ThreadContextProfile;
  title: string;
  detail: string;
  risk?: boolean;
}> = [
  { id: "default", title: "默认最佳", detail: "272K / 244.8K compact" },
  { id: "balanced", title: "均衡 225K", detail: "默认窗口，225K compact" },
  { id: "long", title: "长上下文 372K", detail: "320K compact，较耗额度" },
  { id: "maximum", title: "极限 1M", detail: "900K compact，高额度消耗", risk: true },
  { id: "custom", title: "自定义", detail: "手动设置两个参数" }
];

function emptyThreadContextConfig(threadId = ""): ThreadContextConfig {
  return {
    threadId,
    profile: "default",
    contextWindow: null,
    compactTokenLimit: null,
    scope: "total",
    updatedAt: null
  };
}

function contextConfigForProfile(current: ThreadContextConfig, profile: ThreadContextProfile): ThreadContextConfig {
  if (profile === "default") return { ...current, profile, contextWindow: 272_000, compactTokenLimit: 244_800, scope: "total" };
  if (profile === "balanced") return { ...current, profile, contextWindow: null, compactTokenLimit: 225_000, scope: "total" };
  if (profile === "long") return { ...current, profile, contextWindow: 372_000, compactTokenLimit: 320_000, scope: "total" };
  if (profile === "maximum") return { ...current, profile, contextWindow: 1_000_000, compactTokenLimit: 900_000, scope: "total" };
  return {
    ...current,
    profile,
    contextWindow: current.contextWindow ?? 372_000,
    compactTokenLimit: current.compactTokenLimit ?? 320_000,
    scope: current.scope ?? "total"
  };
}

function contextConfigRequest(config: ThreadContextConfig) {
  return {
    profile: config.profile,
    contextWindow: config.contextWindow,
    compactTokenLimit: config.compactTokenLimit,
    scope: config.scope
  };
}

function hasContextConfigOverride(config: ThreadContextConfig): boolean {
  return config.profile !== "default" || config.contextWindow !== null || config.compactTokenLimit !== null;
}

function contextConfigValidationError(config: ThreadContextConfig): string | null {
  if (config.profile !== "custom") return null;
  if (!Number.isInteger(config.contextWindow) || config.contextWindow! < 64_000 || config.contextWindow! > 1_000_000) {
    return "自定义上下文窗口必须在 64,000 到 1,000,000 token 之间。";
  }
  if (!Number.isInteger(config.compactTokenLimit) || config.compactTokenLimit! < 32_000) {
    return "自定义 compact 阈值不能低于 32,000 token。";
  }
  if (config.compactTokenLimit! > Math.floor(config.contextWindow! * 0.9)) {
    return "compact 阈值最多为上下文窗口的 90%。";
  }
  return null;
}

function contextConfigShortLabel(config: ThreadContextConfig): string {
  if (config.profile === "maximum") return "1M";
  if (config.profile === "long") return "372K";
  if (config.profile === "balanced") return "225K";
  if (config.profile === "custom") return config.contextWindow ? `${Math.round(config.contextWindow / 1_000)}K` : "自定义";
  return config.contextWindow ? "272K" : "默认";
}

interface TemporaryAsk {
  requestId: string;
  projectId: string;
  threadId: string | null;
  selectedText: string;
  prompt: string;
  prompts: Array<{
    requestId: string;
    turnId: string | null;
    text: string;
    createdAt: number;
  }>;
  turnId: string | null;
  status: "ready" | "starting" | "running" | "complete" | "error";
}

function isTemporaryAskThread(thread: ThreadSummary): boolean {
  const text = `${thread.name ?? ""} ${thread.preview ?? ""}`;
  return text.includes("请基于下面选中的文字回答") || text.includes("选中文字：");
}

function temporaryQuestionText(text: string): string {
  const normalized = visibleUserHistoryText(text);
  const marker = "\n用户问题：\n";
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length).trim() : normalized;
}

type GlobalSearchResult = {
  project: Project;
  thread: ThreadSummary;
  match?: {
    projectId: string;
    threadId: string;
    turnId?: string;
    itemId?: string;
    query: string;
    snippet: string;
    cursor?: string;
    ordinal?: number;
  };
};
type GlobalSearchMatch = NonNullable<GlobalSearchResult["match"]>;

type ThreadSearchPanel = {
  threadId: string;
  projectId: string;
  query: string;
  hits: GlobalSearchMatch[];
  total: number;
  index: number;
  loading: boolean;
  selectedItemId?: string;
  error?: string;
  refreshKey: number;
};

interface PolishedSelectOption<T extends string> {
  value: T;
  label: string;
  detail?: string;
}

// Keep floating UI mounted long enough for its exit motion to finish.
function useExitPresence(open: boolean, duration = 200) {
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setPresent(true);
      setClosing(false);
      return;
    }
    if (!present) return;
    setClosing(true);
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
    const timer = window.setTimeout(() => {
      setPresent(false);
      setClosing(false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [open, present, duration]);
  return { present, closing };
}

function PolishedSelect<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  title
}: {
  value: T;
  options: PolishedSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuPresence = useExitPresence(open);
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <div
      className={`polishedSelect ${className} ${open ? "open" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        className="polishedSelectTrigger"
        type="button"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label ?? value}</span>
        <span className="polishedSelectChevron" aria-hidden="true" />
      </button>
      {menuPresence.present ? (
        <div className={`polishedSelectMenu${menuPresence.closing ? " uiClosing" : ""}`} role="listbox" aria-hidden={menuPresence.closing} inert={menuPresence.closing}>
          {options.map((option) => (
            <button
              className={`polishedSelectOption ${option.value === value ? "selected" : ""}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span><strong>{option.label}</strong>{option.detail ? <small>{option.detail}</small> : null}</span>
              <span className="polishedSelectCheck" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type ModelPickerSection = "root" | "gpt" | "domestic" | "doubao" | "deepseek" | "kimi" | "mimo" | "glm" | "minimax";
const domesticModelGroups: Array<{ key: ModelPickerSection; label: string }> = [
  { key: "doubao", label: "Doubao" },
  { key: "deepseek", label: "DeepSeek" },
  { key: "kimi", label: "Kimi" },
  { key: "mimo", label: "MiMo" },
  { key: "glm", label: "GLM" },
  { key: "minimax", label: "MiniMax" }
];

function modelPickerGroup(model: string): ModelPickerSection {
  if (model.startsWith("gpt-")) return "gpt";
  if (model.startsWith("doubao-") || model === "ark-code-latest") return "doubao";
  if (model.startsWith("deepseek-")) return "deepseek";
  if (model.startsWith("kimi-")) return "kimi";
  if (model.startsWith("mimo-")) return "mimo";
  if (model.startsWith("glm-")) return "glm";
  if (model.startsWith("minimax-")) return "minimax";
  return "domestic";
}

function ModelGroupedSelect({
  value, profiles, onChange, disabled = false, title
}: {
  value: string;
  profiles: ModelProfile[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState<"gpt" | "domestic" | null>(null);
  const [lastBranch, setLastBranch] = useState<"gpt" | "domestic">("domestic");
  const [provider, setProvider] = useState<ModelPickerSection | null>(null);
  const [lastProvider, setLastProvider] = useState<ModelPickerSection>("doubao");
  const menuPresence = useExitPresence(open);
  const visibleProfiles = profiles.filter((profile) => !isUltraModelProfile(profile));
  const selected = visibleProfiles.find((profile) => profile.id === value) ?? visibleProfiles[0];
  const modelNames = [...new Set(visibleProfiles.map((profile) => profile.model))];
  const groupCount = (group: ModelPickerSection) => modelNames.filter((model) => modelPickerGroup(model) === group).length;
  const selectBranch = (next: "gpt" | "domestic") => {
    setLastBranch(next);
    setBranch(next);
    setProvider(null);
  };
  const selectProvider = (next: ModelPickerSection) => {
    setLastProvider(next);
    setProvider(next);
  };
  const profileOptions = (group: ModelPickerSection) => visibleProfiles.filter((profile) => modelPickerGroup(profile.model) === group).map((profile) => (
    <button className={`polishedSelectOption groupedModelProfile${profile.id === value ? " selected" : ""}`}
      type="button" role="option" aria-selected={profile.id === value} key={profile.id}
      onClick={() => { onChange(profile.id); setOpen(false); }}>
      <span><strong>{profile.label}</strong></span>
      <span className="polishedSelectCheck" aria-hidden="true">{profile.id === value ? "✓" : ""}</span>
    </button>
  ));
  return (
    <div className={`polishedSelect v2ModelPicker groupedModelPicker ${open ? "open" : ""}`}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <button className="polishedSelectTrigger" type="button" disabled={disabled} title={title}
        aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { if (!open) { setBranch(null); setProvider(null); } setOpen((current) => !current); }}>
        <span>{selected?.label ?? "选择模型"}</span>
        <span className="polishedSelectChevron" aria-hidden="true" />
      </button>
      {menuPresence.present ? (
        <div className={`polishedSelectMenu groupedModelMenu${menuPresence.closing ? " uiClosing" : ""}`}
          role="dialog" aria-label="选择模型和推理档位" aria-hidden={menuPresence.closing} inert={menuPresence.closing}
          onMouseDown={(event) => event.preventDefault()}>
          <div className="groupedModelHeading">选择模型</div>
          <div className="groupedModelRows">
            <button className={`groupedModelRow${branch === "gpt" ? " active" : ""}`} type="button" aria-expanded={branch === "gpt"} onClick={() => selectBranch("gpt")}><span>GPT</span><ChevronRight size={15} /></button>
            <button className={`groupedModelRow${branch === "domestic" ? " active" : ""}`} type="button" aria-expanded={branch === "domestic"} onClick={() => selectBranch("domestic")}><span>国产模型</span><ChevronRight size={15} /></button>
          </div>
          <div className="groupedModelCascade groupedModelSecond" data-branch={lastBranch} data-visible={Boolean(branch)} aria-hidden={!branch} inert={!branch}>
            <button className="groupedModelBack" type="button" onClick={() => { setProvider(null); setBranch(null); }} aria-label="收起子目录">
              <ChevronLeft size={16} /><span>{lastBranch === "gpt" ? "GPT" : "国产模型"}</span>
            </button>
            <div className="groupedModelRows" role={lastBranch === "gpt" ? "listbox" : undefined}>
              {lastBranch === "gpt" ? profileOptions("gpt") : domesticModelGroups.filter((group) => groupCount(group.key) > 0).map((group) => (
                <button className={`groupedModelRow${provider === group.key ? " active" : ""}`} type="button" key={group.key}
                  aria-expanded={provider === group.key} onClick={() => selectProvider(group.key)}>
                  <span>{group.label}</span><ChevronRight size={15} />
                </button>
              ))}
            </div>
            <div className="groupedModelCascade groupedModelThird" data-visible={Boolean(provider) && branch === "domestic"} aria-hidden={!provider || branch !== "domestic"} inert={!provider || branch !== "domestic"}>
              <button className="groupedModelBack" type="button" onClick={() => setProvider(null)} aria-label="收起模型列表">
                <ChevronLeft size={16} /><span>{domesticModelGroups.find((group) => group.key === lastProvider)?.label ?? "模型"}</span>
              </button>
              <div className="groupedModelRows" role="listbox">{profileOptions(lastProvider)}</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type LocalMessageOptions = Pick<LocalMessage, "placement" | "threadId" | "afterTurnId">;

interface LiveDeltaEntry {
  threadId: string | null;
  turnId: string | null;
  text: string;
  startedAt: string;
  sequence?: number;
  sourceItemId?: string;
}

interface LiveToolEntry extends LiveToolItem {}

type LiveTimelineEntry =
  | { id: string; kind: "agent"; threadId: string | null; turnId: string | null; startedAt: string; sequence: number; text: string; sourceItemId?: string }
  | { id: string; kind: "tool"; threadId: string | null; turnId: string | null; startedAt: string; sequence: number; tool: string; input: string; output: string; completed: boolean; sourceItemId?: string };

interface PendingUserMessage {
  id: string;
  requestId: string;
  threadId: string | null;
  turnId?: string | null;
  viewToken: number;
  text: string;
  keepAtBottomUntil: number;
  attachments?: ComposerUpload[];
}

interface ComposerUpload extends ProjectFile {
  sourceFile: File | null;
  isImage: boolean;
  uploading?: boolean;
}

interface EditingPromptDraft {
  threadId: string;
  turnId: string;
}

interface PromptRequestContext {
  viewToken: number;
  projectId: string;
  threadId: string | null;
  model: string;
  reasoningEffort: ReasoningEffort;
  sentPromptText: string;
  visibleText: string;
}

interface QueuedSubmission {
  id: string;
  input: Array<{ type: string; text?: string; name?: string }>;
  clientUserMessageId: string;
}

interface TurnInterruptContext {
  threadId: string;
  turnId: string;
  projectId: string;
}

interface ThreadRenameRequestContext {
  threadId: string;
  projectId: string;
  name: string;
}

interface ThreadContextMenu {
  thread: ThreadSummary;
  x: number;
  y: number;
}

interface ThreadLoadOptions {
  before?: number;
  cursor?: string;
  appendOlder?: boolean;
  skipCache?: boolean;
  requireFresh?: boolean;
}

interface ContinuationPrompt {
  projectId: string;
  sourceThreadId: string;
  sentPromptText: string;
  visibleText: string;
}

interface PromptNavigationItem {
  key: string;
  text: string;
  title: string;
  preview: string;
}

type QuotaRefreshResult = {
  quota: CodexQuota | null;
  pool: CodexAccountPool | null;
  error: string | null;
};

type QuotaRefreshOptions = {
  background?: boolean;
  force?: boolean;
};

type LeaderboardRefreshResult = {
  leaderboard: CodexLeaderboard | null;
  error: string | null;
};

type TrackedQuotaRefreshResult = {
  usage: TrackedQuotaUsage | null;
  error: string | null;
};

const quotaAutoRefreshMs = 180_000;
const quotaRetryRefreshMs = 15_000;
const leaderboardAutoRefreshMs = 60_000;
const trackedQuotaAutoRefreshMs = 30_000;
const sentPromptBottomHoldMs = 5_000;
const accountPoolSnapshotStorageKey = "codex.v2.accountPool.lastKnownGood";
const trackedQuotaSnapshotStorageKey = "codex.v2.trackedQuota.lastKnownGood";
// A leading slash is common in filesystem paths. Only reserve the commands
// that this UI actually implements; everything else must reach Codex verbatim.
const localSlashCommands = new Set(["help", "?", "quota", "usage", "skills", "skill", "new", "send", "stop", "interrupt", "goal", "goal-stop", "goalstop", "compact", "status", "review", "rename", "shell", "cmd", "plan", "fast"]);
const composerSlashCommands = [
  { command: "/plan", label: "计划模式", detail: "先审方案，再决定是否执行", insert: "/plan" },
  { command: "/goal", label: "持续目标", detail: "为当前会话设定长期目标", insert: "/goal " },
  { command: "/goal-stop", label: "结束目标", detail: "停止并清除当前持续目标", insert: "/goal-stop" },
  { command: "/status", label: "会话状态", detail: "查看模型与上下文", insert: "/status" },
  { command: "/skills", label: "技能", detail: "打开可用技能选择器", insert: "/skills" },
  { command: "/skill", label: "选用技能", detail: "输入技能名称与任务", insert: "/skill " },
  { command: "/review", label: "代码审查", detail: "审查当前工作区或指定分支", insert: "/review" },
  { command: "/compact", label: "压缩上下文", detail: "压缩过长的会话上下文", insert: "/compact" },
  { command: "/quota", label: "剩余用量", detail: "查看额度与重置时间", insert: "/quota" },
  { command: "/fast", label: "Fast 模式", detail: "切换下次请求的速度档位", insert: "/fast" },
  { command: "/send", label: "发送文件", detail: "经 SSH 发送工作区文件", insert: "/send " },
  { command: "/shell", label: "会话命令", detail: "在当前 Codex 会话执行命令", insert: "/shell " },
  { command: "/cmd", label: "项目命令", detail: "在当前项目目录运行命令", insert: "/cmd " },
  { command: "/rename", label: "重命名", detail: "重命名当前会话", insert: "/rename " },
  { command: "/new", label: "新建会话", detail: "在当前工作区新建会话", insert: "/new" },
  { command: "/stop", label: "停止生成", detail: "终止当前轮次", insert: "/stop" },
  { command: "/help", label: "全部命令", detail: "查看网页已支持的命令", insert: "/help" }
] as const;

function pushKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function quotaHasUsableRateLimits(quota: CodexQuota | null | undefined): boolean {
  const windows = [quota?.rateLimits?.primary, quota?.rateLimits?.secondary];
  if (windows.some((window) => typeof window?.usedPercent === "number")) return true;
  return Object.values(quota?.rateLimitsByLimitId ?? {}).some((snapshot) => (
    typeof snapshot.primary?.usedPercent === "number" || typeof snapshot.secondary?.usedPercent === "number"
  ));
}

function mergeAccountPoolWithLastKnownGood(previous: CodexAccountPool | null, incoming: CodexAccountPool): CodexAccountPool {
  if (!previous?.accounts.length) return incoming;
  const previousById = new Map(previous.accounts.map((account) => [account.id, account]));
  return {
    ...incoming,
    accounts: incoming.accounts.map((account) => {
      const prior = previousById.get(account.id);
      if (quotaHasUsableRateLimits(account.quota) || !quotaHasUsableRateLimits(prior?.quota)) return account;
      return {
        ...account,
        quota: {
          ...prior!.quota,
          errors: account.quota.errors,
          updatedAt: account.quota.updatedAt
        }
      };
    })
  };
}

function selectedQuotaFromPool(pool: CodexAccountPool | null): CodexQuota | null {
  const accounts = pool?.accounts.filter((account) => account.kind !== "api-provider") ?? [];
  return accounts.find((account) => account.selectedForNewThreads)?.quota ?? accounts[0]?.quota ?? null;
}

function safeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some browsers deny Clipboard API access on an HTTP ZeroTier address.
      // Keep a selection-based fallback so the user can still copy a session ID.
    }
  }

  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  fallback.style.pointerEvents = "none";
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) {
    throw new Error("浏览器未允许访问剪贴板，请手动复制会话 ID。");
  }
}

type MarkdownBlockCopyState = "idle" | "copied" | "failed";

const MarkdownBlockCopyButton = memo(function MarkdownBlockCopyButton({ getText }: { getText: () => string }) {
  const [copyState, setCopyState] = useState<MarkdownBlockCopyState>("idle");
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copyBlock = useCallback(async () => {
    const text = getText();
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      resetTimerRef.current = null;
    }, 1_600);
  }, [getText]);

  const label = copyState === "copied" ? "已复制框内全部内容" : copyState === "failed" ? "复制失败，请重试" : "复制框内全部内容";
  return (
    <button
      className="markdownBlockCopyButton"
      type="button"
      data-copy-state={copyState}
      aria-label={label}
      title={label}
      onClick={() => void copyBlock()}
    >
      {copyState === "copied" ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={1.8} />}
    </button>
  );
});

type RunnablePreview = { kind: "html" | "mermaid"; title: string; source: string };
const RunnablePreviewContext = createContext<((preview: RunnablePreview) => void) | null>(null);

function runnableCodeLanguage(children: ReactNode): RunnablePreview["kind"] | null {
  const code = Array.isArray(children) ? children.find(isValidElement) : children;
  if (!isValidElement(code)) return null;
  const className = (code.props as { className?: string }).className ?? "";
  return /(?:^|\s)language-(?:html|htm)(?:\s|$)/i.test(className) ? "html"
    : /(?:^|\s)language-mermaid(?:\s|$)/i.test(className) ? "mermaid" : null;
}

const CopyableMarkdownPre = memo(function CopyableMarkdownPre({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const contentRef = useRef<HTMLPreElement>(null);
  const readText = useCallback(() => contentRef.current?.textContent ?? "", []);
  const runPreview = useContext(RunnablePreviewContext);
  const language = runnableCodeLanguage(children);
  return (
    <div className="markdownCopyFrame markdownCodeCopyFrame">
      <MarkdownBlockCopyButton getText={readText} />
      {language && runPreview ? <button className="markdownBlockRunButton" type="button" onClick={() => runPreview({ kind: language, title: language === "html" ? "HTML 预览" : "Mermaid 图", source: readText() })}>运行</button> : null}
      <pre {...props} ref={contentRef}>{children}</pre>
    </div>
  );
});

const previewCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

function RunnablePreviewFrame({ preview }: { preview: RunnablePreview }) {
  const [diagram, setDiagram] = useState("");
  const [renderError, setRenderError] = useState("");
  useEffect(() => {
    if (preview.kind !== "mermaid") return;
    let cancelled = false;
    setDiagram("");
    setRenderError("");
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      const id = `codex-viz-${crypto.randomUUID().replace(/-/g, "")}`;
      const result = await mermaid.render(id, preview.source);
      if (!cancelled) setDiagram(result.svg);
    }).catch((error: unknown) => {
      if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [preview]);

  const body = preview.kind === "html" ? preview.source : diagram;
  if (renderError) return <div className="filePreviewError">图表渲染失败：{renderError}</div>;
  if (!body) return <div className="emptyState">正在渲染图表…</div>;
  return <iframe
    className="runnablePreviewFrame"
    title={preview.title}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    srcDoc={`<meta http-equiv="Content-Security-Policy" content="${previewCsp}"><meta name="viewport" content="width=device-width,initial-scale=1">${body}`}
  />;
}

function displayOutputText(value: unknown, maxLength = 60000): string {
  const text = safeText(value);
  if (text.length <= maxLength) {
    return text;
  }
  const headLength = Math.floor(maxLength * 0.62);
  const tailLength = maxLength - headLength;
  return `${text.slice(0, headLength)}

... [Codex Web 为避免浏览器空白遮挡，已折叠 ${text.length - maxLength} 个字符；完整内容可用“导出记录”查看] ...

${text.slice(-tailLength)}`;
}

function statusText(status: unknown): string {
  if (!status) {
    return "ready";
  }
  if (typeof status === "string") {
    return status;
  }
  if (typeof status === "object" && "type" in status) {
    return safeText((status as { type?: unknown }).type);
  }
  return safeText(status);
}

function isTurnAbortMarker(text: unknown): boolean {
  const normalized = safeText(text).trim().toLowerCase();
  return (
    normalized === "<turn_aborted>" ||
    normalized === "<turn_aborted/>" ||
    normalized === "<turn_aborted />" ||
    normalized === "the user interrupted the previous turn on purpose."
  );
}

function visibleTextFromRawValue(value: unknown): string {
  const raw = textFromStructuredValue(value);
  return stripInterruptArtifacts(raw);
}

function textFromStructuredValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textFromStructuredValue).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["text", "message", "prompt", "input", "value", "content", "markdown", "body"]) {
      const text = textFromStructuredValue(object[key]);
      if (text.trim()) {
        return text;
      }
    }
    if (typeof object.path === "string") {
      return object.path;
    }
    if (typeof object.url === "string") {
      return object.url;
    }
  }
  return "";
}

function itemText(item: ThreadItem): string {
  const text = visibleTextFromRawValue(item.text ?? item.message ?? item.content ?? item.input ?? item.prompt ?? item.value ?? item.output);
  if (text.trim()) {
    return text;
  }
  if (item.command) {
    return safeText(item.command);
  }
  if (item.summary?.length) {
    return item.summary.map(safeText).join("\n");
  }
  return "";
}

type MessageKind = "user" | "agent" | "tool" | "reasoning" | "system";

type DeferredToolOutputElement = HTMLPreElement & {
  fullToolOutput?: string;
  previewToolOutput?: string;
};

const DeferredToolOutput = memo(function DeferredToolOutput({
  text,
  deferred = false,
  threadId,
  itemId,
  projectId
}: {
  text: string;
  deferred?: boolean;
  threadId?: string;
  itemId?: string;
  projectId?: string;
}) {
  const [loadedOutput, setLoadedOutput] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const loadingRef = useRef(false);
  const output = useMemo(() => displayOutputText(loadedOutput ?? text), [loadedOutput, text]);
  const preview = useMemo(() => {
    const lines = output.split(/\r?\n/).filter((line) => line.trim()).slice(0, 2).join("\n");
    return lines.length > 420 ? `${lines.slice(0, 420)}...` : lines;
  }, [output]);
  const outputRef = useRef<DeferredToolOutputElement>(null);

  useEffect(() => {
    setLoadedOutput(null);
    setLoadError("");
    loadingRef.current = false;
  }, [deferred, itemId, projectId, text, threadId]);

  const loadFullOutput = useCallback(async () => {
    if (!deferred || !threadId || !itemId || loadingRef.current || loadedOutput !== null) return;
    loadingRef.current = true;
    setLoadError("");
    try {
      const response = await readThreadItemOutput(threadId, itemId, projectId);
      setLoadedOutput(response.data.output);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      loadingRef.current = false;
    }
  }, [deferred, itemId, loadedOutput, projectId, threadId]);

  useEffect(() => {
    const element = outputRef.current;
    const toolCard = element?.closest<HTMLElement>(".messageItem.kind-tool");
    if (!toolCard) return;
    const handleExpanded = () => {
      if (toolCard.classList.contains("toolExpanded")) void loadFullOutput();
    };
    toolCard.addEventListener("codex:tool-expanded", handleExpanded);
    if (toolCard.classList.contains("toolExpanded")) void loadFullOutput();
    return () => toolCard.removeEventListener("codex:tool-expanded", handleExpanded);
  }, [loadFullOutput]);

  useEffect(() => {
    const element = outputRef.current;
    if (!element) {
      return;
    }
    element.fullToolOutput = `${output}${loadError ? `\n\n完整输出加载失败：${loadError}` : ""}`;
    element.previewToolOutput = preview;
    element.textContent = element.closest(".toolExpanded") ? output : preview;
  }, [loadError, output, preview]);

  return <pre ref={outputRef} className="outputBlock" data-deferred-tool-output>{preview}</pre>;
});

function normalizedToken(value: unknown): string {
  return safeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function itemKind(item: ThreadItem): MessageKind {
  const token = `${normalizedToken(item.role)} ${normalizedToken(item.type)} ${normalizedToken(item.tool)}`;
  // A tool named request_user_input is still a tool, not a user message.
  const role = normalizedToken(item.role);
  const type = normalizedToken(item.type);
  if (role === "user" || type === "user" || type === "usermessage") {
    return "user";
  }
  if (token.includes("reasoning") || token.includes("thinking")) {
    return "reasoning";
  }
  if (token.includes("assistant") || token.includes("agent")) {
    return "agent";
  }
  if (token.includes("tool") || token.includes("command") || token.includes("functioncall") || token.includes("filechange") || token.includes("mcp") || token.includes("websearch") || item.command || item.aggregatedOutput || Array.isArray(item.changes)) {
    return "tool";
  }
  return "system";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isThreadItem(value: unknown): value is ThreadItem {
  return isRecord(value) && typeof (value as { id?: unknown }).id === "string";
}

function isInternalRuntimeUserText(value: string): boolean {
  const text = value.trimStart();
  return text.startsWith("<environment_context>")
    || text.startsWith("<codex_internal_context_recovery>")
    || text.startsWith("<recommended_plugins>")
    || text.startsWith("<permissions instructions>")
    || text.startsWith("<app-context>")
    || /^# AGENTS\.md instructions(?:\r?\n|$)/.test(text)
    || /^<skill>\s*<name>[^<]+<\/name>\s*<path>[^<]+SKILL\.md<\/path>/.test(text);
}

function isInternalRuntimeUserMessage(item: ThreadItem): boolean {
  return itemKind(item) === "user" && isInternalRuntimeUserText(itemText(item));
}

function sanitizeTurnItems(items: unknown[]): ThreadItem[] {
  return items
    .filter(isThreadItem)
    .filter((item) => !isInternalRuntimeUserMessage(item))
    .map((item) => ({
      ...item,
      changes: Array.isArray(item.changes) ? item.changes.filter((change) => change !== null && change !== undefined) : []
    }));
}

function sanitizeThreadForRender(thread: ThreadSummary): ThreadSummary {
  if (!Array.isArray(thread.turns)) {
    return {
      ...thread,
      turns: []
    };
  }

  return {
    ...thread,
    turns: thread.turns
      .filter((turn): turn is Turn => isRecord(turn) && typeof (turn as { id?: unknown }).id === "string")
      .map((turn) => ({
        ...turn,
        items: Array.isArray((turn as Turn).items) ? sanitizeTurnItems((turn as Turn).items) : []
      }))
  };
}

function toolItemDetails(item: ThreadItem): string {
  if (!Array.isArray(item.changes) || item.changes.length === 0) {
    return "";
  }
  const changes = item.changes.map((change) => {
    if (change && typeof change === "object") {
      const record = change as Record<string, unknown>;
      const path = safeText(record.path ?? record.filePath ?? record.filename ?? record.name);
      const kind = safeText(record.kind ?? record.type ?? record.status);
      if (path || kind) {
        return `- ${kind ? `[${kind}] ` : ""}${path || safeText(change)}`;
      }
    }
    return `- ${safeText(change)}`;
  });
  return changes.join("\n");
}

function FileChangeReview({ changes, onComment }: {
  changes: unknown[];
  onComment: (path: string, line: number, side: "new" | "old", source: string, comment: string) => void;
}) {
  const [activeLine, setActiveLine] = useState("");
  const [comment, setComment] = useState("");
  const [addedComments, setAddedComments] = useState<Record<string, string>>({});
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [showAllFiles, setShowAllFiles] = useState<Record<string, true>>({});
  const files = changes.filter(isRecord).map((change) => ({
    path: safeText(change.path ?? change.filePath ?? change.filename),
    kind: safeText(change.kind ?? change.type),
    diff: safeText(change.diff)
  })).filter((change) => change.path || change.diff);
  if (!files.length) return null;
  return <div className="fileChangeReview" onClick={(event) => event.stopPropagation()}>
    {files.map((file, fileIndex) => {
      const fileKey = `${file.path}-${fileIndex}`;
      const expanded = expandedFiles[fileKey] ?? files.length === 1;
      const lines = file.diff.split("\n");
      let oldLine = 0;
      let newLine = 0;
      return <section className={`fileChangeReviewFile${expanded ? " expanded" : ""}`} key={fileKey}>
        <header><button type="button" className="fileChangeReviewToggle" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"} ${file.path || "未命名文件"} 的变更`} title={file.path} onClick={() => setExpandedFiles((current) => ({ ...current, [fileKey]: !expanded }))}><FileText size={14} /><span className="fileChangeReviewPath"><strong>{compactFileLabel(file.path) || "未命名文件"}</strong><span>{file.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/")}</span></span><small>{file.kind}</small><ChevronDown className="fileChangeReviewChevron" size={15} /></button></header>
        <div className="fileChangeReviewContent"><div className="fileChangeReviewContentInner">{file.diff ? <div className="fileChangeReviewLines">
          {(showAllFiles[fileKey] ? lines : lines.slice(0, 500)).map((line, index) => {
            const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
            if (hunk) {
              oldLine = Number(hunk[1]);
              newLine = Number(hunk[2]);
            }
            const isMeta = /^(diff --git |index |--- |\+\+\+ |\\ No newline)/.test(line);
            const side = !isMeta && line.startsWith("+") ? "new" : !isMeta && line.startsWith("-") ? "old" : null;
            const lineNumber = side === "new" ? newLine : side === "old" ? oldLine : newLine;
            const shownOldLine = !hunk && !isMeta && side !== "new" ? oldLine : null;
            const shownNewLine = !hunk && !isMeta && side !== "old" ? newLine : null;
            if (!hunk && !isMeta) {
              if (side !== "new") oldLine++;
              if (side !== "old") newLine++;
            }
            const lineKey = `${fileIndex}:${index}`;
            return <div className={`fileChangeReviewLine${hunk ? " hunk" : side ? ` ${side}` : ""}`} key={lineKey}>
              <span className="diffLineNumber">{shownOldLine ?? ""}</span><span className="diffLineNumber">{shownNewLine ?? ""}</span>
              <code>{line || " "}</code>
              {side && lineNumber > 0 ? <button type="button" className="diffCommentButton" title={`给第 ${lineNumber} 行添加审查意见`} aria-label={`给第 ${lineNumber} 行添加审查意见`} onClick={() => { setActiveLine(lineKey); setComment(""); }}>＋</button> : null}
              {addedComments[lineKey] ? <div className="diffAddedComment">已加入审查意见 · {addedComments[lineKey]}</div> : null}
              {activeLine === lineKey && side && lineNumber > 0 ? <div className="diffInlineComment">
                <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={`审查 ${file.path}:${lineNumber}`} autoFocus />
                <div><button type="button" onClick={() => setActiveLine("")}>取消</button><button type="button" disabled={!comment.trim()} onClick={() => {
                  onComment(file.path, lineNumber, side, line.slice(1), comment.trim());
                  setAddedComments((current) => ({ ...current, [lineKey]: comment.trim() }));
                  setActiveLine("");
                  setComment("");
                }}>加入输入框</button></div>
              </div> : null}
            </div>;
          })}
          {!showAllFiles[fileKey] && lines.length > 500 ? <button type="button" className="diffShowAll" onClick={() => setShowAllFiles((current) => ({ ...current, [fileKey]: true }))}>显示剩余 {lines.length - 500} 行</button> : null}
        </div> : <p className="fileChangeNoDiff">此文件没有可显示的文本 diff。</p>}</div></div>
      </section>;
    })}
  </div>;
}

function changesFromUnifiedDiff(diff: string): Array<{ path: string; kind: string; diff: string }> {
  const blocks = diff.split(/(?=^diff --git )/m).filter((block) => block.trim());
  return blocks.map((block) => {
    const path = block.match(/^diff --git a\/.*? b\/(.+)$/m)?.[1]
      ?? block.match(/^\+\+\+ b\/(.+)$/m)?.[1]
      ?? "本轮变更";
    return { path, kind: "", diff: block };
  });
}

function fileChangePath(change: unknown): string {
  if (!isRecord(change)) return "";
  return safeText(change.path ?? change.filePath ?? change.filename ?? change.name);
}

function turnFileChanges(turn: Turn, liveDiff?: string): unknown[] {
  const persisted = new Map<string, unknown>();
  for (const item of turn.items ?? []) {
    for (const change of item.changes ?? []) {
      const path = fileChangePath(change);
      if (path) persisted.set(path, change);
    }
  }
  const live = liveDiff ? changesFromUnifiedDiff(liveDiff) : [];
  if (!live.length) return [...persisted.values()];
  for (const change of live) {
    const saved = persisted.get(change.path);
    if (!isRecord(saved) || !safeText(saved.diff)) persisted.set(change.path, change);
  }
  return [...persisted.values()];
}

function TurnFileChangesCard({ changes, onReview, onFile }: {
  changes: unknown[];
  onReview: () => void;
  onFile: (path: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const files = changes.filter(isRecord).map((change) => {
    const path = fileChangePath(change);
    const lines = safeText(change.diff).split("\n");
    return {
      path,
      added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length,
      removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length,
      hasDiff: typeof change.diff === "string" && Boolean(change.diff)
    };
  }).filter((file) => file.path);
  if (!files.length) return null;
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  const renderFile = (file: typeof files[number]) => (
    <button className="turnFileChangesFile" type="button" key={file.path} onClick={() => onFile(file.path)} title={`查看 ${file.path} 的变更`}>
      <span className="turnFileChangesPath"><strong>{compactFileLabel(file.path)}</strong><span>{file.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/")}</span></span>
      {file.hasDiff ? <span className="turnFileChangesStats"><span>+{file.added}</span><span>-{file.removed}</span></span> : null}
    </button>
  );
  return <div className="uiGlassSurface turnFileChangesCard" aria-label="本轮文件变更">
    <div className="turnFileChangesHeader">
      <span className="turnFileChangesIcon"><FileText size={18} /></span>
      <div className="turnFileChangesTitle"><strong>已编辑 {files.length} 个文件</strong>{files.some((file) => file.hasDiff) ? <small><span>+{added}</span><span>-{removed}</span></small> : null}</div>
      <button className="turnFileChangesReview" type="button" onClick={onReview}>审核</button>
    </div>
    <div className="turnFileChangesList">
      {files.slice(0, 3).map(renderFile)}
      {files.length > 3 ? <div className={`turnFileChangesExtra${showAll ? " expanded" : ""}`} inert={!showAll}><div>{files.slice(3).map(renderFile)}</div></div> : null}
    </div>
    {files.length > 3 ? <button className="turnFileChangesMore" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>{showAll ? "收起" : `再显示 ${files.length - 3} 个文件`} <ChevronDown size={14} /></button> : null}
  </div>;
}

function ToolQuestionCard({ questions, onChoose }: { questions: ToolQuestion[]; onChoose: (answer: string) => Promise<boolean> }) {
  const [answers, setAnswers] = useState<(string | null)[]>(() => questions.map(() => null));
  const [customAnswers, setCustomAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const selectOption = async (questionIndex: number, option: string) => {
    if (submitting) return;
    const next = [...answers];
    next[questionIndex] = option;
    setAnswers(next);
    if (next.some((answer) => answer === null)) return;
    setSubmitting(true);
    const reply = questions.length === 1 ? option : questions.map((question, index) => `${question.title}：${next[index]}`).join("\n");
    if (!await onChoose(reply)) setSubmitting(false);
  };
  return <div className={`toolQuestionCard${submitting ? " submitting" : ""}`} aria-label="向用户提出的选择题">
    {questions.map((question, index) => <section className="toolQuestionBlock" key={`${index}:${question.title}`}>
      <div className="toolQuestionHeading"><span className="toolQuestionTag">选择题 {questions.length > 1 ? index + 1 : ""}</span><span>{question.title}</span></div>
      <div className="toolQuestionOptions">
        {question.options.map((option, optionIndex) => <button type="button" className={`toolQuestionOption${answers[index] === option ? " selected" : ""}`} key={`${optionIndex}:${option}`} disabled={submitting} aria-pressed={answers[index] === option} onClick={(event) => { event.stopPropagation(); void selectOption(index, option); }} title="选择并发送答案">
          <span className="toolQuestionOptionNumber">{optionIndex + 1}</span><span>{option}</span>
        </button>)}
        <div className="toolQuestionOther">
          <input
            type="text"
            value={customAnswers[index] ?? ""}
            onChange={(event) => setCustomAnswers((current) => current.map((value, position) => position === index ? event.target.value : value))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                const answer = customAnswers[index]?.trim();
                if (answer) void selectOption(index, answer);
              }
            }}
            disabled={submitting}
            aria-label={`自行输入答案：${question.title}`}
            placeholder="其他想法，自行输入…"
          />
          <button type="button" disabled={submitting || !customAnswers[index]?.trim()} onClick={(event) => { event.stopPropagation(); void selectOption(index, customAnswers[index].trim()); }} aria-label="发送自定义答案" title="发送自定义答案"><Send size={15} /></button>
        </div>
      </div>
    </section>)}
    <p className="toolQuestionHint">{submitting ? "正在发送答案…" : questions.length > 1 ? "选完所有问题后会自动发送；也可以在输入框输入自己的回答。" : "点击选项后自动发送；也可以在输入框输入自己的回答。"}</p>
  </div>;
}

function itemLabel(item: ThreadItem): string {
  const type = safeText(item.type);
  if (itemKind(item) === "user") {
    return type ? `用户 · ${type}` : "用户";
  }
  if (itemKind(item) === "agent") {
    return type ? `Codex · ${type}` : "Codex";
  }
  if (itemKind(item) === "reasoning") {
    return "Thinking · Codex 思考摘要";
  }
  if (itemKind(item) === "tool") {
    if (type === "toolCall") {
      return `调用工具 · ${item.tool || "tool"}`;
    }
    if (type === "toolCallOutput") {
      return "工具输出";
    }
    if (type.toLowerCase() === "filechange") {
      return "文件变更";
    }
    if (type.toLowerCase() === "commandexecution") {
      return `调用工具 · ${item.tool || "shell"}`;
    }
    return item.tool ? `工具 · ${item.tool}` : type || "工具";
  }
  return type || "系统";
}

function messageClassName(item: ThreadItem, extraClass = ""): string {
  const typeClass = `type-${safeText(item.type || "message").replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  return ["messageItem", `kind-${itemKind(item)}`, typeClass, extraClass].filter(Boolean).join(" ");
}

function turnUserText(turn: Turn): string {
  for (const value of [turn.userMessage, turn.prompt, turn.input, turn.message, turn.request, turn.submission]) {
    const text = textFromStructuredValue(value);
    if (text.trim() && !isInternalRuntimeUserText(text)) {
      const visible = stripInterruptArtifacts(text);
      if (visible) {
        return visible;
      }
    }
  }
  return "";
}

function turnHasUserItem(turn: Turn): boolean {
  return (turn.items ?? []).some((item) => itemKind(item) === "user" && itemText(item).trim());
}

function promptNavigationKey(turnId: string, itemId: string): string {
  return `turn:${turnId}:item:${itemId}`;
}

function pendingPromptNavigationKey(itemId: string): string {
  return `pending:${itemId}`;
}

function compactPromptNavigationText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "未命名提示词";
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength).trimEnd()}…` : compact;
}

function createPromptNavigationItem(key: string, text: string): PromptNavigationItem | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  return {
    key,
    text: normalized,
    title: compactPromptNavigationText(normalized, 30),
    preview: compactPromptNavigationText(normalized, 150)
  };
}

function promptNavigationItemsForThread(thread: ThreadSummary | null): PromptNavigationItem[] {
  if (!thread) {
    return [];
  }

  const items: PromptNavigationItem[] = [];
  for (const turn of thread.turns ?? []) {
    const userItems = (turn.items ?? []).filter((item) => itemKind(item) === "user" && itemText(item).trim());
    if (userItems.length > 0) {
      for (const item of userItems) {
        const navigationItem = createPromptNavigationItem(promptNavigationKey(turn.id, item.id), itemText(item));
        if (navigationItem) {
          items.push(navigationItem);
        }
      }
      continue;
    }

    const syntheticUserText = turnUserText(turn);
    const navigationItem = createPromptNavigationItem(
      promptNavigationKey(turn.id, `${turn.id}-user-input`),
      syntheticUserText
    );
    if (navigationItem) {
      items.push(navigationItem);
    }
  }
  return items;
}

function searchResultSnippet(sourceText: string, query: string, pad = 72): string {
  const text = safeText(sourceText);
  const normalizedQuery = safeText(query).toLocaleLowerCase();
  const haystack = text.toLocaleLowerCase();
  if (!normalizedQuery) {
    return text.slice(0, pad).trim();
  }
  const index = haystack.indexOf(normalizedQuery);
  if (index === -1) {
    return text.slice(0, 120).trim();
  }
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + normalizedQuery.length + pad);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function normalizeSearchQuery(value: string): string {
  return safeText(value).toLocaleLowerCase().trim();
}

function textContainsQuery(sourceText: string, query: string): boolean {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return false;
  }
  const haystack = safeText(sourceText).toLocaleLowerCase();
  if (!haystack) {
    return false;
  }
  if (haystack.includes(normalizedQuery)) {
    return true;
  }
  const compactNeedle = normalizedQuery.replace(/\s+/g, "");
  const compactHaystack = haystack.replace(/\s+/g, "");
  if (compactNeedle.length > 1 && compactHaystack.includes(compactNeedle)) {
    return true;
  }
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  return terms.length > 1 && terms.every((term) => haystack.includes(term));
}

function createGlobalSearchMatch(
  projectId: string,
  threadId: string,
  query: string,
  sourceText: string,
  turnId?: string,
  itemId?: string
): GlobalSearchMatch {
  return {
    projectId,
    threadId,
    turnId,
    itemId,
    query: normalizeSearchQuery(query),
    snippet: searchResultSnippet(sourceText, normalizeSearchQuery(query))
  };
}

function findSearchMatchInThread(thread: ThreadSummary, query: string, projectId: string): GlobalSearchMatch | null {
  const normalizedQuery = safeText(query).toLocaleLowerCase().trim();
  if (!normalizedQuery) {
    return null;
  }
  for (const turn of thread.turns ?? []) {
    if (!turn?.id) {
      continue;
    }
    const syntheticText = turnHasUserItem(turn) ? "" : visibleUserHistoryText(turnUserText(turn));
    if (textContainsQuery(safeText(syntheticText), normalizedQuery)) {
      return createGlobalSearchMatch(projectId, thread.id, normalizedQuery, safeText(syntheticText), turn.id, `${turn.id}-user-input`);
    }
    for (const item of turn.items ?? []) {
      const itemTextValue = itemKind(item) === "user" ? visibleUserHistoryText(itemText(item)) : stripInterruptArtifacts(itemText(item));
      if (!textContainsQuery(safeText(itemTextValue), normalizedQuery)) {
        continue;
      }
      return createGlobalSearchMatch(projectId, thread.id, normalizedQuery, safeText(itemTextValue), turn.id, item.id);
    }
  }
  return null;
}

function blocksGlobalEnterSend(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest(
    "textarea, input, select, button, a[href], [contenteditable], [role='textbox'], [role='button'], [role='menuitem'], [role='dialog'], [aria-modal='true']"
  ));
}

function normalizeUserText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function userTextsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeUserText(left);
  const normalizedRight = normalizeUserText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(normalizedRight + "\n") || normalizedRight.startsWith(normalizedLeft + "\n");
}

function threadHasUserText(thread: ThreadSummary, text: string): boolean {
  if (!normalizeUserText(text)) {
    return true;
  }
  return (thread.turns ?? []).some((turn) => {
    const matchesUserItem = (turn.items ?? []).some((item) => {
      if (itemKind(item) !== "user") {
        return false;
      }
      return userTextsMatch(itemText(item), text);
    });
    return matchesUserItem || (!turnHasUserItem(turn) && userTextsMatch(turnUserText(turn), text));
  });
}

function threadItemKey(item: ThreadItem, fallbackIndex: number): string {
  const id = safeText(item.id);
  return id ? `id:${id}` : `fallback:${safeText(item.type)}:${itemText(item).slice(0, 160)}:${fallbackIndex}`;
}

function liveAgentTextAfterPersisted(persistedValue: string, liveValue: string): string {
  const persisted = stripInterruptArtifacts(persistedValue);
  const live = stripInterruptArtifacts(liveValue);
  if (!persisted) return live;
  if (!live || persisted.includes(live)) return "";
  if (live.startsWith(persisted)) return live.slice(persisted.length);

  const maxOverlap = Math.min(persisted.length, live.length, 4096);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (persisted.endsWith(live.slice(0, overlap))) {
      return live.slice(overlap);
    }
  }
  return live;
}

function dedupeThreadListById(threads: ThreadSummary[]): ThreadSummary[] {
  const result: ThreadSummary[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    if (!thread.id || seen.has(thread.id)) {
      continue;
    }
    seen.add(thread.id);
    result.push(thread);
  }
  return result;
}

function mergeThreadHistoryPages(older: ThreadSummary, newer: ThreadSummary): ThreadSummary {
  const mergedTurns = new Map<string, Turn>();
  const contentKeys = ["text", "content", "command", "input", "output", "aggregatedOutput", "summary", "changes"] as const;
  const mergeThreadItem = (existing: ThreadItem, incoming: ThreadItem): ThreadItem => {
    const merged = { ...existing, ...incoming } as ThreadItem;
    for (const key of contentKeys) {
      const previousValue = existing[key as keyof ThreadItem];
      const incomingValue = incoming[key as keyof ThreadItem];
      const previousHasContent = Array.isArray(previousValue)
        ? previousValue.length > 0
        : Boolean(safeText(previousValue).trim());
      const incomingHasContent = Array.isArray(incomingValue)
        ? incomingValue.length > 0
        : Boolean(safeText(incomingValue).trim());
      if (previousHasContent && !incomingHasContent) {
        (merged as Record<string, unknown>)[key] = previousValue;
      }
    }
    return merged;
  };
  const appendTurns = (turns: Turn[]) => {
    for (const turn of turns ?? []) {
      const existing = mergedTurns.get(turn.id);
      if (!existing) {
        mergedTurns.set(turn.id, { ...turn, items: [...(turn.items ?? [])] });
        continue;
      }
      const mergedItems = [...(existing.items ?? [])];
      const known = new Map(mergedItems.map((item, index) => [threadItemKey(item, index), index]));
      for (const [itemIndex, item] of (turn.items ?? []).entries()) {
        const key = threadItemKey(item, itemIndex);
        const existingIndex = known.get(key);
        if (existingIndex !== undefined) {
          mergedItems[existingIndex] = mergeThreadItem(mergedItems[existingIndex], item);
          continue;
        }
        known.set(key, mergedItems.length);
        mergedItems.push(item);
      }
      mergedTurns.set(turn.id, { ...existing, ...turn, items: mergeTimelineItems([], mergedItems) });
    }
  };

  appendTurns(older.turns);
  appendTurns(newer.turns);
  return { ...newer, turns: Array.from(mergedTurns.values()) };
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

function projectNameFromPath(rootPath: string): string {
  return rootPath.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? "Project";
}

const fallbackModelProfiles: ModelProfile[] = [
  { id: "gpt-6-astra:max", label: "GPT-6-Astra max", model: "gpt-6-astra", effort: "max" },
  { id: "gpt-6-astra:xhigh", label: "GPT-6-Astra xhigh", model: "gpt-6-astra", effort: "xhigh" },
  { id: "gpt-6-astra:high", label: "GPT-6-Astra high", model: "gpt-6-astra", effort: "high" },
  { id: "gpt-6-astra:medium", label: "GPT-6-Astra medium", model: "gpt-6-astra", effort: "medium" },
  { id: "gpt-6-astra:low", label: "GPT-6-Astra low", model: "gpt-6-astra", effort: "low" },
  { id: "gpt-6-sol:max", label: "GPT-6-Sol max", model: "gpt-6-sol", effort: "max" },
  { id: "gpt-6-sol:xhigh", label: "GPT-6-Sol xhigh", model: "gpt-6-sol", effort: "xhigh" },
  { id: "gpt-6-sol:high", label: "GPT-6-Sol high", model: "gpt-6-sol", effort: "high" },
  { id: "gpt-6-sol:medium", label: "GPT-6-Sol medium", model: "gpt-6-sol", effort: "medium" },
  { id: "gpt-6-sol:low", label: "GPT-6-Sol low", model: "gpt-6-sol", effort: "low" },
  { id: "gpt-6-luna:max", label: "GPT-6-Luna max", model: "gpt-6-luna", effort: "max" },
  { id: "gpt-6-luna:xhigh", label: "GPT-6-Luna xhigh", model: "gpt-6-luna", effort: "xhigh" },
  { id: "gpt-6-luna:high", label: "GPT-6-Luna high", model: "gpt-6-luna", effort: "high" },
  { id: "gpt-6-luna:medium", label: "GPT-6-Luna medium", model: "gpt-6-luna", effort: "medium" },
  { id: "gpt-6-luna:low", label: "GPT-6-Luna low", model: "gpt-6-luna", effort: "low" },
  { id: "gpt-5.6-sol:max", label: "GPT-5.6-Sol max", model: "gpt-5.6-sol", effort: "max" },
  { id: "gpt-5.6-sol:xhigh", label: "GPT-5.6-Sol xhigh", model: "gpt-5.6-sol", effort: "xhigh" },
  { id: "gpt-5.6-sol:high", label: "GPT-5.6-Sol high", model: "gpt-5.6-sol", effort: "high" },
  { id: "gpt-5.6-sol:medium", label: "GPT-5.6-Sol medium", model: "gpt-5.6-sol", effort: "medium" },
  { id: "gpt-5.6-sol:low", label: "GPT-5.6-Sol low", model: "gpt-5.6-sol", effort: "low" },
  { id: "gpt-5.6-terra:max", label: "GPT-5.6-Terra max", model: "gpt-5.6-terra", effort: "max" },
  { id: "gpt-5.6-terra:xhigh", label: "GPT-5.6-Terra xhigh", model: "gpt-5.6-terra", effort: "xhigh" },
  { id: "gpt-5.6-terra:high", label: "GPT-5.6-Terra high", model: "gpt-5.6-terra", effort: "high" },
  { id: "gpt-5.6-terra:medium", label: "GPT-5.6-Terra medium", model: "gpt-5.6-terra", effort: "medium" },
  { id: "gpt-5.6-terra:low", label: "GPT-5.6-Terra low", model: "gpt-5.6-terra", effort: "low" },
  { id: "gpt-5.6-luna:max", label: "GPT-5.6-Luna max", model: "gpt-5.6-luna", effort: "max" },
  { id: "gpt-5.6-luna:xhigh", label: "GPT-5.6-Luna xhigh", model: "gpt-5.6-luna", effort: "xhigh" },
  { id: "gpt-5.6-luna:high", label: "GPT-5.6-Luna high", model: "gpt-5.6-luna", effort: "high" },
  { id: "gpt-5.6-luna:medium", label: "GPT-5.6-Luna medium", model: "gpt-5.6-luna", effort: "medium" },
  { id: "gpt-5.6-luna:low", label: "GPT-5.6-Luna low", model: "gpt-5.6-luna", effort: "low" },
  { id: "gpt-5.5:xhigh", label: "GPT-5.5 xhigh", model: "gpt-5.5", effort: "xhigh" },
  { id: "gpt-5.5:high", label: "GPT-5.5 high", model: "gpt-5.5", effort: "high" },
  { id: "gpt-5.5:medium", label: "GPT-5.5 medium", model: "gpt-5.5", effort: "medium" },
  { id: "gpt-5.5:low", label: "GPT-5.5 low", model: "gpt-5.5", effort: "low" }
];

const defaultModelProfileId = "gpt-5.5:xhigh";
const hiddenModelIds = new Set([
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini"
]);
const adminUserId = "admin";
const defaultLocalSendSettings: LocalSendSettings = {
  sshHost: "",
  sshPort: 22,
  sshUser: "",
  // A relative path is resolved by SSH in the signed-in remote user's home.
  // This keeps the default correct for both macOS and Linux clients.
  destinationPath: "Downloads",
  identityFile: "",
  outputPath: "/tmp/codex_remote_exports",
  updatedAt: null
};
const markdownRemarkPlugins: PluggableList = [remarkGfm, remarkBreaks];
const mathMarkdownRemarkPlugins: PluggableList = [remarkGfm, remarkBreaks, [remarkMath, { singleDollarTextMath: true }]];
const markdownRehypePlugins: PluggableList = [[rehypeKatex, { throwOnError: false, trust: false }]];

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileTargetFromHref(href?: string): string | null {
  if (!href || href.startsWith("#")) {
    return null;
  }

  if (/^file:\/\//i.test(href)) {
    return href;
  }

  if (/^https?:\/\//i.test(href)) {
    if (typeof window === "undefined") {
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(href, window.location.href);
    } catch {
      // Terminal output and JSON can leave quotes/braces attached to a URL.
      // Markdown may turn that fragment into a malformed link; one bad link
      // must never be allowed to crash the whole conversation renderer.
      return null;
    }
    if (parsed.origin !== window.location.origin || parsed.pathname.startsWith("/api/")) {
      return null;
    }
    return `${safeDecodeURIComponent(parsed.pathname)}${parsed.hash}`;
  }

  if (href.startsWith("/")) {
    if (href.startsWith("/api/")) {
      return null;
    }
    return safeDecodeURIComponent(href);
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return null;
  }

  return href;
}

const inlineImageExtensionPattern = /\.(png|jpe?g|gif|webp|svg)(?:[#?].*)?$/i;
const autoSendImageExtensionPattern = /\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[#?].*)?$/i;
const autoSendFileExtensionPattern = /\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp|pdf|docx?|pptx?|xlsx?|csv)(?:[#?].*)?$/i;
const autoSendFilePathPattern = /(?:file:\/\/\S+|\/\S+?\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp|pdf|docx?|pptx?|xlsx?|csv)(?:[?#]\S+)?|(?:\.{1,2}\/)?[\w][\w .()\-\/]*\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp|pdf|docx?|pptx?|xlsx?|csv))/gi;

interface GeneratedFileCandidate {
  target: string;
  allowOutsideProject: boolean;
  turnId: string | null;
}

function autoSendPreferenceStorageKey(userId: string): string {
  return `codex-web-auto-send-generated-files:v2:${encodeURIComponent(userId || "default")}`;
}

function storedBooleanWithDefault(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  return value === null ? fallback : value === "true";
}

function suggestLocalSendSettings(settings: LocalSendSettings, detectedClientHost: string, defaultSshUser = ""): LocalSendSettings {
  return {
    ...settings,
    sshHost: settings.sshHost.trim() || detectedClientHost.trim(),
    sshUser: settings.sshUser.trim() || defaultSshUser.trim(),
    destinationPath: settings.destinationPath.trim() || "Downloads"
  };
}

function normalizedGeneratedFileTarget(value: string): string | null {
  const trimmed = value.trim().replace(/^[<(\["'`]+|[>)\],;"'`]+$/g, "");
  if (!trimmed || /^https?:\/\//i.test(trimmed)) {
    return null;
  }
  const target = fileTargetFromHref(trimmed) ?? trimmed;
  return autoSendFileExtensionPattern.test(target) ? target : null;
}

function projectPathForComparison(target: string): string {
  const withoutSuffix = target.split(/[?#]/, 1)[0] ?? target;
  if (/^file:\/\//i.test(withoutSuffix)) {
    return safeDecodeURIComponent(withoutSuffix.replace(/^file:\/\/(?:localhost)?/i, "")).replace(/\\/g, "/");
  }
  return safeDecodeURIComponent(withoutSuffix).replace(/\\/g, "/");
}

function isSafeGeneratedFileTarget(target: string, projectRoot: string, allowOutsideProject: boolean): boolean {
  const pathValue = projectPathForComparison(target);
  if (!pathValue || /^https?:\/\//i.test(pathValue)) {
    return false;
  }
  if (pathValue.startsWith("/")) {
    if (allowOutsideProject && autoSendImageExtensionPattern.test(pathValue)) {
      return true;
    }
    const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    return pathValue === root || pathValue.startsWith(`${root}/`);
  }
  return !pathValue.startsWith("~") && !pathValue.split("/").includes("..");
}

function addGeneratedFileCandidate(
  candidates: GeneratedFileCandidate[],
  seen: Set<string>,
  rawValue: string,
  projectRoot: string,
  allowOutsideProject: boolean,
  turnId: string | null
): void {
  if (candidates.length >= 12) {
    return;
  }
  const target = normalizedGeneratedFileTarget(rawValue);
  if (!target || !isSafeGeneratedFileTarget(target, projectRoot, allowOutsideProject)) {
    return;
  }
  const key = `${allowOutsideProject ? "external" : "project"}:${target}`;
  if (!seen.has(key)) {
    seen.add(key);
    candidates.push({ target, allowOutsideProject, turnId });
  }
}

function collectGeneratedFileCandidates(
  value: unknown,
  projectRoot: string,
  candidates: GeneratedFileCandidate[],
  seen: Set<string>,
  turnId: string | null,
  fieldName = "",
  depth = 0
): void {
  if (depth > 5 || candidates.length >= 12 || value === null || value === undefined) {
    return;
  }
  const explicitFileField = /(?:^|[_-])(?:file|filepath|filename|path|outputpath|savedpath|imagepath|artifactpath)(?:$|[_-])/i.test(fieldName);
  const allowOutsideProject = /(?:saved|image)[_-]?(?:path|file)?/i.test(fieldName);
  if (typeof value === "string") {
    if (explicitFileField) {
      addGeneratedFileCandidate(candidates, seen, value, projectRoot, allowOutsideProject, turnId);
    } else {
      // Do not interpret arbitrary assistant/tool prose such as
      // "document.doc" as a generated artifact. Only accept path-shaped
      // references from non-file fields, never bare filenames in sentences.
      for (const match of value.matchAll(autoSendFilePathPattern)) {
        const candidate = match[0];
        if (/^(?:file:\/\/|\/|\.\.?(?:\/|\\))/.test(candidate)) {
          addGeneratedFileCandidate(candidates, seen, candidate, projectRoot, allowOutsideProject, turnId);
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 80)) {
      collectGeneratedFileCandidates(entry, projectRoot, candidates, seen, turnId, fieldName, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (/(?:token|secret|authorization|cookie|api[_-]?key)/i.test(key)) {
      continue;
    }
    collectGeneratedFileCandidates(entry, projectRoot, candidates, seen, turnId, key, depth + 1);
  }
}

function generatedFileCandidatesFromThread(thread: ThreadSummary, projectRoot: string): GeneratedFileCandidate[] {
  const candidates: GeneratedFileCandidate[] = [];
  const seen = new Set<string>();
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      // A prompt may mention an existing file. Only Codex and tool output can
      // describe a newly generated artifact eligible for automatic delivery.
      if (itemKind(item) === "user") {
        continue;
      }
      collectGeneratedFileCandidates(item, projectRoot, candidates, seen, turn.id);
      if (candidates.length >= 12) {
        return candidates;
      }
    }
  }
  return candidates;
}

function rawFileUrlForProject(projectId: string, fileTarget: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files/raw?path=${encodeURIComponent(fileTarget)}`;
}

function compactFileLabel(value: string): string {
  const withoutQuery = value.split("?")[0]?.split("#")[0] ?? value;
  const normalized = withoutQuery.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) || value;
}

function isInlineImageTarget(value: string): boolean {
  if (/^data:image\//i.test(value)) {
    return true;
  }
  const withoutQuery = value.split("?")[0]?.split("#")[0] ?? value;
  return inlineImageExtensionPattern.test(withoutQuery);
}

function imageTargetsFromText(text: string): string[] {
  const found = new Set<string>();
  const plainPathPattern = /(?:file:\/\/[^\s)\]"'<>]+|\/[^\s)\]"'<>]+\.(?:png|jpe?g|gif|webp|svg)(?:[#?][^\s)\]"'<>]*)?)/gi;

  for (const match of text.matchAll(plainPathPattern)) {
    const target = fileTargetFromHref(match[0]);
    if (target && isInlineImageTarget(target)) {
      found.add(target);
    }
  }

  return Array.from(found).slice(0, 12);
}
const MarkdownMessage = memo(function MarkdownMessage({
  text,
  projectId,
  onOpenFileLink,
  renderMath = false,
  suppressImageGrid = false,
  animateStreamingText = false
}: {
  text: string;
  projectId?: string;
  onOpenFileLink?: (target: string, gallery?: string[]) => void;
  renderMath?: boolean;
  suppressImageGrid?: boolean;
  animateStreamingText?: boolean;
}) {
  const inlineImageTargets = useMemo(() => (projectId ? imageTargetsFromText(text) : []), [projectId, text]);
  const sourceMarkdownText = useMemo(() => (renderMath ? normalizeMathMarkdown(text || " ") : text || " "), [renderMath, text]);
  const markdownText = useMemo(
    () => normalizeGfmTableBoundaries(
      animateStreamingText ? remend(sourceMarkdownText, { linkMode: "text-only" }) : sourceMarkdownText
    ),
    [animateStreamingText, sourceMarkdownText]
  );
  const revealRef = useRef(emptyRevealSnapshot());
  const revealPass = useMemo(() => createRevealPass(
    revealRef.current, sourceMarkdownText, performance.now(), markdownText
  ), [sourceMarkdownText, markdownText]);
  useLayoutEffect(() => {
    revealRef.current = animateStreamingText ? revealPass.snapshot : emptyRevealSnapshot();
  }, [animateStreamingText, revealPass]);
  const rehypePlugins = useMemo<PluggableList>(() => [
    ...(animateStreamingText ? [revealPass.plugin] : []),
    ...(renderMath ? markdownRehypePlugins : [])
  ], [animateStreamingText, revealPass, renderMath]);

  const markdownComponents = useMemo<Components>(
    () => ({
      span: StreamRevealSpan,
      p({ children, ...props }) {
        return <p {...props}>{children}</p>;
      },
      li({ children, ...props }) {
        return <li {...props}>{children}</li>;
      },
      h1({ children, ...props }) {
        return <h1 {...props}>{children}</h1>;
      },
      h2({ children, ...props }) {
        return <h2 {...props}>{children}</h2>;
      },
      h3({ children, ...props }) {
        return <h3 {...props}>{children}</h3>;
      },
      h4({ children, ...props }) {
        return <h4 {...props}>{children}</h4>;
      },
      blockquote({ children, ...props }) {
        return <blockquote {...props}>{children}</blockquote>;
      },
      a({ children, href, ...props }) {
        const fileTarget = fileTargetFromHref(href);
        return (
          <a
            href={href}
            rel="noreferrer"
            target={fileTarget ? undefined : "_blank"}
            onClick={(event) => {
              if (!fileTarget || !onOpenFileLink) {
                return;
              }
              event.preventDefault();
              onOpenFileLink(fileTarget);
            }}
            {...props}
          >
            {children}
          </a>
        );
      },
      input({ type, checked, ...props }) {
        if (type === "checkbox") {
          return (
            <input
              {...props}
              type="checkbox"
              checked={checked}
              readOnly
              className={`messageTodoCheckbox${props.className ? ` ${props.className}` : ""}`}
              onChange={() => {}}
            />
          );
        }
        return <input type={type} {...props} />;
      },
      pre({ children, node: _node, ...props }) {
        return <CopyableMarkdownPre {...props}>{children}</CopyableMarkdownPre>;
      },
      table({ children, node: _node, ...props }) {
        return (
          <div className="markdownTableWrap">
            <table className="markdownTable" {...props}>{children}</table>
          </div>
        );
      },
      th({ children, align, ...props }) {
        const aligned = align === "center" || align === "right" || align === "left" || align === "justify" ? align : undefined;
        return (
          <th
            className="markdownTableCell markdownTableHeaderCell"
            style={aligned ? { textAlign: aligned } : undefined}
            {...props}
          >
            {children}
          </th>
        );
      },
      td({ children, align, ...props }) {
        const aligned = align === "center" || align === "right" || align === "left" || align === "justify" ? align : undefined;
        return (
          <td
            className="markdownTableCell markdownTableBodyCell"
            style={aligned ? { textAlign: aligned } : undefined}
            {...props}
          >
            {children}
          </td>
        );
      },
      img({ src, alt }) {
        const srcText = typeof src === "string" ? src : "";
        const fileTarget = fileTargetFromHref(srcText);
        if (fileTarget && projectId && isInlineImageTarget(fileTarget)) {
          return (
            <button
              className="inlineImageButton"
              type="button"
              onClick={() => onOpenFileLink?.(fileTarget, inlineImageTargets)}
              title="打开图片预览"
            >
              <img className="inlineMessageImage" src={rawFileUrlForProject(projectId, fileTarget)} alt={alt ?? fileTarget} />
            </button>
          );
        }

        return <img className="inlineMessageImage" src={srcText} alt={alt ?? ""} loading="lazy" decoding="async" />;
      }
    }),
    [onOpenFileLink, projectId, inlineImageTargets]
  );

  return (
    <div className="messageMarkdown">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={renderMath ? mathMarkdownRemarkPlugins : markdownRemarkPlugins}
        rehypePlugins={rehypePlugins}
      >
        {markdownText}
      </ReactMarkdown>
      {projectId && inlineImageTargets.length > 0 && !suppressImageGrid ? (
        <div className="inlineImagePreviewGrid" aria-label="图片预览">
          {inlineImageTargets.map((target) => (
            <button
              className="inlineImageButton"
              type="button"
              key={target}
              onClick={() => onOpenFileLink?.(target, inlineImageTargets)}
              title="打开图片预览"
            >
              <img className="inlineMessageImage" src={rawFileUrlForProject(projectId, target)} alt={target} loading="lazy" decoding="async" />
              <span>{compactFileLabel(target)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

const ComposerInlineMath = InlineMath.extend({
  addInputRules() {
    return [nodeInputRule({
      find: /((?<!\$)\$([^$\n]+)\$(?!\$))$/,
      type: this.type,
      getAttributes: (match) => ({ latex: match[2] }),
    })];
  },
});

const ComposerBlockMath = BlockMath.extend({
  addInputRules() {
    return [nodeInputRule({
      find: /^(\$\$([^$\n]+)\$\$)$/,
      type: this.type,
      getAttributes: (match) => ({ latex: match[2] }),
    })];
  },
});

const composerExtensions = [
  StarterKit.configure({ link: { markdownLinks: true } }),
  Markdown,
  ComposerInlineMath.configure({ katexOptions: { throwOnError: false } }),
  ComposerBlockMath.configure({ katexOptions: { throwOnError: false } }),
];

const MarkdownComposerEditor = memo(function MarkdownComposerEditor({
  value,
  onChange,
  onPaste,
  onSubmit,
  skills = [],
  onChooseSkill,
  placeholder,
  disabled,
  height,
}: {
  value: string;
  onChange: (value: string) => void;
  onPaste?: (event: ReactClipboardEvent<HTMLDivElement>) => void;
  onSubmit: () => void;
  skills?: CodexSkill[];
  onChooseSkill?: (name: string) => void;
  placeholder: string;
  disabled?: boolean;
  height?: number;
}) {
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onChooseSkillRef = useRef(onChooseSkill);
  const valueRef = useRef(value);
  const shellRef = useRef<HTMLDivElement>(null);
  const [animatedHeight, setAnimatedHeight] = useState<number | undefined>(height);
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [slashFocused, setSlashFocused] = useState(false);
  const [slashDismissedValue, setSlashDismissedValue] = useState<string | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashAnchor, setSlashAnchor] = useState({ left: 12, bottom: 80, width: 360, maxHeight: 320 });
  const slashQuery = /^\/[^\s]*$/u.test(value) ? value.slice(1).toLocaleLowerCase() : null;
  const commandSuggestions = composerSlashCommands.filter((item) => slashQuery !== null && `${item.command} ${item.label} ${item.detail}`.toLocaleLowerCase().includes(slashQuery)).map((item) => ({ ...item, kind: "command" as const }));
  const skillSuggestions = skills.filter((skill) => skill.enabled).map((skill) => {
    const copy = localizedSkill(skill);
    return { kind: "skill" as const, command: `$${skill.name}`, label: copy.name, detail: copy.description, insert: "", skillName: skill.name };
  }).filter((item) => slashQuery !== null && `${item.command} ${item.label} ${item.detail} ${item.skillName === "build-web-data-visualization:data-visualization" ? "visualize" : ""}`.toLocaleLowerCase().includes(slashQuery));
  const featuredSkillNames = new Set(["pdf", "build-web-data-visualization:data-visualization", "product-design:design-qa", "imagegen"]);
  const slashMatches = slashQuery === ""
    ? [...skillSuggestions.filter((item) => featuredSkillNames.has(item.skillName)), ...commandSuggestions, ...skillSuggestions.filter((item) => !featuredSkillNames.has(item.skillName))]
    : [...commandSuggestions, ...skillSuggestions];
  const slashMatchesRef = useRef(slashMatches);
  const slashRenderedMatchesRef = useRef(slashMatches);
  const chooseSlashMatchRef = useRef<(index: number) => void>(() => {});
  const slashActiveIndexRef = useRef(slashActiveIndex);
  const slashOpenRef = useRef(false);
  slashMatchesRef.current = slashMatches;
  slashActiveIndexRef.current = slashActiveIndex;
  const slashMenuOpen = slashFocused && slashDismissedValue !== value && slashMatches.length > 0;
  const slashPresence = useExitPresence(slashMenuOpen);
  if (slashMenuOpen) slashRenderedMatchesRef.current = slashMatches;
  slashOpenRef.current = slashMenuOpen;
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onChooseSkillRef.current = onChooseSkill;
  valueRef.current = value;
  chooseSlashMatchRef.current = (index) => {
    const item = slashMatchesRef.current[index];
    if (!item) return;
    if (item.kind === "skill") {
      setSlashDismissedValue("");
      onChangeRef.current("");
      onChooseSkillRef.current?.(item.skillName);
      return;
    }
    setSlashDismissedValue(item.insert);
    onChangeRef.current(item.insert);
  };
  const editor = useEditor({
    extensions: [...composerExtensions, Placeholder.configure({ placeholder })],
    content: value,
    contentType: "markdown",
    editable: !disabled,
    editorProps: {
      attributes: { class: "composerRichInput", "data-placeholder": placeholder, "aria-label": placeholder, spellcheck: "false" },
      handleTextInput: (view, from, to, text) => {
        if (from !== to || !view.state.selection.empty) return false;
        const $from = view.state.doc.resolve(from);
        const activeMarks = view.state.storedMarks ?? $from.marks();
        if (!activeMarks.length) return false;
        const nextMarks = $from.nodeAfter?.marks ?? [];
        const continuingMarks = activeMarks.filter((mark) => nextMarks.some((next) => mark.eq(next)));
        if (continuingMarks.length === activeMarks.length) return false;
        const previousIsSpace = $from.parentOffset > 0 && /\s$/u.test($from.parent.textBetween($from.parentOffset - 1, $from.parentOffset));
        if (!/^\s/u.test(text) && !previousIsSpace) return false;
        // At the end of a link/format span, a space starts ordinary text.
        // Keep marks only when they continue into the text after the cursor.
        view.dispatch(view.state.tr.setStoredMarks(continuingMarks).insertText(text, from, to).setStoredMarks(continuingMarks));
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (slashOpenRef.current && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key) && !event.isComposing) {
          event.preventDefault();
          if (event.key === "Escape") setSlashDismissedValue(valueRef.current);
          else if (event.key === "ArrowDown") setSlashActiveIndex((index) => (index + 1) % slashMatchesRef.current.length);
          else if (event.key === "ArrowUp") setSlashActiveIndex((index) => (index - 1 + slashMatchesRef.current.length) % slashMatchesRef.current.length);
          else chooseSlashMatchRef.current(slashActiveIndexRef.current);
          return true;
        }
        if (event.key === "Enter" && event.shiftKey && !event.isComposing && editor?.isActive("listItem")) {
          if (editor.commands.splitListItem("listItem")) {
            event.preventDefault();
            return true;
          }
        }
        if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return false;
        event.preventDefault();
        onSubmitRef.current();
        return true;
      },
    },
    onFocus: () => setSlashFocused(true),
    onBlur: () => setSlashFocused(false),
    onUpdate: ({ editor: current }) => onChangeRef.current(current.getMarkdown()),
  });

  useEffect(() => {
    setSlashActiveIndex(0);
  }, [slashQuery]);

  useLayoutEffect(() => {
    if (!slashFocused || slashQuery === null || !slashMatches.length) return;
    const update = () => {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(510, window.innerWidth - 24);
      setSlashAnchor({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        bottom: window.innerHeight - rect.top + 9,
        width,
        maxHeight: Math.max(100, Math.min(440, rect.top - 20))
      });
    };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [slashFocused, slashQuery, slashMatches.length]);

  useEffect(() => {
    if (!editor) return;
    if (editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dom.setAttribute("data-placeholder", placeholder);
    editor.view.dom.setAttribute("aria-label", placeholder);
    editor.view.dom.querySelectorAll<HTMLElement>(".is-empty[data-placeholder]").forEach((node) => node.setAttribute("data-placeholder", placeholder));
  }, [editor, placeholder, value]);

  useEffect(() => {
    if (slashFocused) document.querySelector(".composerSlashMenu button.active")?.scrollIntoView({ block: "nearest" });
  }, [slashActiveIndex, slashFocused]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  useLayoutEffect(() => {
    if (!editor || height === undefined) return;
    const shell = shellRef.current;
    if (!shell) return;
    const input = editor.view.dom;
    const updateHeight = () => {
      const maxHeight = Number.parseFloat(window.getComputedStyle(shell).maxHeight) || 300;
      const nextHeight = Math.min(maxHeight, Math.max(height, input.scrollHeight));
      setAnimatedHeight((current) => current === nextHeight ? current : nextHeight);
    };
    const observer = new ResizeObserver(updateHeight);
    observer.observe(input);
    window.addEventListener("resize", updateHeight);
    updateHeight();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [editor, height]);

  return <div
    ref={shellRef}
    className="composerRichEditor"
    style={height === undefined ? undefined : { minHeight: height, height: animatedHeight }}
    onPasteCapture={(event) => {
      if (!onPaste) return;
      const hasFiles = Array.from(event.clipboardData.items).some((item) => item.kind === "file");
      if (hasFiles) {
        // Intercept before ProseMirror inserts the full-resolution clipboard
        // image into the document for a frame. The attachment owns the image.
        event.preventDefault();
        const pastedText = event.clipboardData.getData("text/plain");
        if (pastedText) editor?.commands.insertContent(pastedText, { contentType: "markdown" });
      }
      onPaste(event);
    }}
  >
    <EditorContent editor={editor} />
    {slashPresence.present ? createPortal(
      <div className={`uiGlassSurface composerSlashMenu${slashPresence.closing ? " uiClosing" : ""}`} role="listbox" aria-label="命令建议" aria-hidden={slashPresence.closing} inert={slashPresence.closing} style={{ left: slashAnchor.left, bottom: slashAnchor.bottom, width: slashAnchor.width, maxHeight: slashAnchor.maxHeight }} onMouseDown={(event) => event.preventDefault()}>
        {(slashMenuOpen ? slashMatches : slashRenderedMatchesRef.current).map((item, index, items) => <Fragment key={item.command}>
          {index === 0 || items[index - 1].kind !== item.kind ? <span className="composerSlashHeading">{item.kind === "skill" ? slashQuery === "" ? index === 0 ? "常用技能" : "更多技能" : "技能" : "命令"}</span> : null}
          <button type="button" role="option" aria-selected={index === slashActiveIndex} className={`${index === slashActiveIndex ? "active " : ""}${item.kind === "skill" ? "skillSuggestion" : ""}`} onMouseEnter={() => setSlashActiveIndex(index)} onClick={() => chooseSlashMatchRef.current(index)}>
            <span className="composerSlashGlyph" aria-hidden="true" dangerouslySetInnerHTML={{ __html: (item.kind === "skill" ? IconParkApplication : IconParkCommand)({ theme: "outline", size: 15, fill: "currentColor", strokeWidth: 4 }).replace(/^<\?xml[^>]*>/, "") }} />
            {item.kind === "skill" ? null : <code>{item.command}</code>}
            <span><strong>{item.label}</strong><small>{item.detail}</small></span>
            {item.kind === "skill" ? <em>{item.command}</em> : null}
          </button>
        </Fragment>)}
      </div>, document.body
    ) : null}
    {editor ? <BubbleMenu
      editor={editor}
      className="composerFormatToolbar"
      updateDelay={80}
      appendTo={() => document.body}
      options={{ placement: "top-start", offset: 8, shift: true, flip: true, onHide: () => setFormatMenuOpen(false) }}
      shouldShow={({ editor: current, state }) => !state.selection.empty && current.isFocused}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => { if (event.key === "Escape") setFormatMenuOpen(false); }}
    >
      <button type="button" className={editor.isActive("bold") ? "active" : ""} aria-label="粗体" title="粗体" onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></button>
      <button type="button" className={editor.isActive("italic") ? "active" : ""} aria-label="斜体" title="斜体" onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></button>
      <div className="composerFormatType">
        <button type="button" className="composerFormatTypeTrigger" aria-label="文本格式" aria-expanded={formatMenuOpen} onClick={() => setFormatMenuOpen((open) => !open)}>
          {editor.isActive("heading", { level: 1 }) ? "标题 1" : editor.isActive("heading", { level: 2 }) ? "标题 2" : editor.isActive("heading", { level: 3 }) ? "标题 3" : editor.isActive("orderedList") ? "编号列表" : editor.isActive("bulletList") ? "项目列表" : "正文"}
          <ChevronDown size={13} />
        </button>
        {formatMenuOpen ? <div className="composerFormatTypeMenu" role="menu">
          {([
            ["正文", "paragraph"], ["标题 1", "heading1"], ["标题 2", "heading2"], ["标题 3", "heading3"],
            ["编号列表", "orderedList"], ["项目列表", "bulletList"]
          ] as const).map(([label, format]) => <button type="button" role="menuitemradio" aria-checked={format === "paragraph" ? editor.isActive("paragraph") : format.startsWith("heading") ? editor.isActive("heading", { level: Number(format.slice(-1)) }) : editor.isActive(format)} key={format} onClick={() => {
            if (format === "paragraph") editor.chain().focus().setParagraph().run();
            else if (format === "heading1") editor.chain().focus().toggleHeading({ level: 1 }).run();
            else if (format === "heading2") editor.chain().focus().toggleHeading({ level: 2 }).run();
            else if (format === "heading3") editor.chain().focus().toggleHeading({ level: 3 }).run();
            else if (format === "orderedList" || format === "bulletList") toggleComposerList(editor, format);
            setFormatMenuOpen(false);
          }}>{label}</button>)}
        </div> : null}
      </div>
    </BubbleMenu> : null}
  </div>;
});

function reasoningDisplayText(value: string): string {
  const source = value.trim();
  if (!source) return "";
  const jsonSource = source
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!jsonSource.startsWith("{") && !jsonSource.startsWith("[")) return source;

  const extractText = (candidate: unknown, depth = 0): string => {
    if (depth > 5 || candidate === null || candidate === undefined) return "";
    if (typeof candidate === "string") return candidate;
    if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);
    if (Array.isArray(candidate)) {
      return candidate.map((entry) => extractText(entry, depth + 1)).filter(Boolean).join("\n");
    }
    if (typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      for (const key of ["text", "summary_text", "summaryText", "reasoning_summary", "summary", "content", "message", "value"]) {
        const extracted = extractText(record[key], depth + 1).trim();
        if (extracted) return extracted;
      }
    }
    return "";
  };

  try {
    return extractText(JSON.parse(jsonSource)).trim();
  } catch {
    // GPT-6 can stream several summary_text envelopes into one item without
    // wrapping them in a JSON array. Extract each JSON string value instead of
    // exposing the transport envelopes in the conversation.
    const streamedTexts = Array.from(jsonSource.matchAll(/"(?:text|summary_text|summaryText|reasoning_summary)"\s*:\s*("(?:\\.|[^"\\])*")/g))
      .flatMap((match) => {
        try {
          const decoded = JSON.parse(match[1]);
          return typeof decoded === "string" && decoded.trim() ? [decoded.trim()] : [];
        } catch {
          return [];
        }
      });
    return streamedTexts.length ? streamedTexts.join(" · ") : "";
  }
}

function reasoningItemDisplayText(item: ThreadItem): string {
  for (const candidate of [item.summary_text, item.summaryText, item.reasoning_summary, item.summary]) {
    const structuredText = textFromStructuredValue(candidate).trim();
    if (structuredText) return structuredText;
  }
  return reasoningDisplayText(stripInterruptArtifacts(itemText(item)));
}

function reasoningPreviewText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// IconPark official `thinking-problem` icon, kept inline so the 17px activity
// grid does not require another runtime icon package.
const ReasoningGlyph = memo(function ReasoningGlyph() {
  return (
    <svg className="reasoningGlyph" viewBox="4 4 40 40" fill="none" aria-hidden="true">
      <path d="M38 21L43 30L38 31V37H35L29 36L28 43H13L11 32.619C7.92077 29.7028 6 25.5757 6 21C6 12.1634 13.1634 5 22 5C30.8366 5 38 12.1634 38 21Z" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 19C17 16.2386 19.2386 14 22 14C24.7614 14 27 16.2386 27 19C27 21.7614 24.7614 24 22 24V27M22 33V34" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});

const ReasoningMessage = memo(function ReasoningMessage({
  text,
  projectId,
  onOpenFileLink
}: {
  text: string;
  projectId?: string;
  onOpenFileLink?: (target: string, gallery?: string[]) => void;
}) {
  const displayText = useMemo(() => reasoningDisplayText(text), [text]);
  const preview = useMemo(() => reasoningPreviewText(displayText), [displayText]);
  const [expanded, setExpanded] = useState(false);
  const expandable = Boolean(displayText);
  const summary = (
    <>
      <ReasoningGlyph />
      <span className="reasoningLabel">思考</span>
      <span className="reasoningSummaryPreview" title={preview}>{preview || "正在思考"}</span>
    </>
  );

  if (!expandable) {
    return <div className="reasoningSummaryRow">{summary}</div>;
  }
  return (
    <div className={`reasoningDisclosure${expanded ? " expanded" : ""}`}>
      <button className="reasoningDisclosureTrigger" type="button" aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>{summary}</button>
      <div className="reasoningExpandedShell" aria-hidden={!expanded} inert={!expanded}>
        <div className="reasoningExpandedClip">
          <div className="reasoningExpandedBody">
            <MarkdownMessage text={displayText} projectId={projectId} onOpenFileLink={onOpenFileLink} />
          </div>
        </div>
      </div>
    </div>
  );
});

export const LiveAgentStreamMessage = memo(function LiveAgentStreamMessage({
  text,
  projectId,
  onOpenFileLink
}: {
  text: string;
  projectId?: string;
  onOpenFileLink?: (target: string) => void;
}) {
  const latestTextRef = useRef(text);
  const renderTimerRef = useRef<number | null>(null);
  const [displayText, setDisplayText] = useState(text);
  latestTextRef.current = text;

  useEffect(() => {
    if (renderTimerRef.current !== null) return;
    // Keep short answers responsive, then reduce parse frequency as the live
    // document grows. The opacity animation bridges these small intervals, so
    // long Markdown answers stay smooth without monopolising the main thread.
    const renderIntervalMs = latestTextRef.current.length > 6_000
      ? 110
      : latestTextRef.current.length > 2_000
        ? 70
        : 40;
    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = null;
      setDisplayText(latestTextRef.current);
    }, renderIntervalMs);
  }, [text]);

  useEffect(() => () => {
    if (renderTimerRef.current !== null) {
      window.clearTimeout(renderTimerRef.current);
      renderTimerRef.current = null;
    }
  }, []);

  return (
    <div className="liveAgentStreamMessage">
      {displayText ? (
        <div className="liveAgentStreamTail" aria-live="polite">
          <MarkdownMessage text={displayText} projectId={projectId} onOpenFileLink={onOpenFileLink} renderMath animateStreamingText />
        </div>
      ) : null}
    </div>
  );
});

const userMessageCollapseMaxLines = 12;
const userMessageCollapseMaxCharacters = 900;
const userMessagePlainTextThreshold = 4_000;
const userMessageLongLineThreshold = 800;
const userMessageCollapsedPreviewCharacters = 6_000;

function isLongUserMessage(text: string): boolean {
  return text.length > userMessageCollapseMaxCharacters || text.split(/\r?\n/).length > userMessageCollapseMaxLines;
}

function shouldRenderUserMessageAsPlainText(text: string): boolean {
  return text.length > userMessagePlainTextThreshold || text.split(/\r?\n/).some((line) => line.length > userMessageLongLineThreshold);
}

function collapsedUserMessagePreview(text: string): string {
  if (text.length <= userMessageCollapsedPreviewCharacters) {
    return text;
  }
  const headLength = Math.floor(userMessageCollapsedPreviewCharacters * 0.72);
  const tailLength = userMessageCollapsedPreviewCharacters - headLength;
  return `${text.slice(0, headLength)}\n\n… 已折叠 ${text.length - userMessageCollapsedPreviewCharacters} 个字符，点击“展开更多”查看完整内容 …\n\n${text.slice(-tailLength)}`;
}

function visibleUserHistoryText(text: string): string {
  const withoutUploads = skillReferencesInPrompt(text).body.replace(/(?:\r?\n){0,2}上传文件：\s*(?:\r?\n-\s+[^\r\n]+)+\s*$/, "").trim();
  // App-server review actions include machine-readable context and action tags.
  // The transcript should show the actual findings, not that transport wrapper.
  const reviewAction = withoutUploads.match(/^<user_action>\s*[\s\S]*?<action>review<\/action>\s*<results>([\s\S]*?)<\/results>\s*<\/user_action>$/);
  if (reviewAction) return stripInterruptArtifacts(reviewAction[1].trim());
  return stripInterruptArtifacts(withoutUploads);
}

function skillReferencesInPrompt(text: string): { names: string[]; body: string } {
  const match = text.match(/^((?:\$[a-z][a-z0-9:_-]*(?:[ \t]+|\r?\n)?)+)/);
  if (!match) return { names: [], body: text };
  const names = [...match[1].matchAll(/\$([a-z][a-z0-9:_-]*)/g)].map((entry) => entry[1]);
  return { names, body: text.slice(match[0].length).trimStart() };
}

async function copyPlainText(text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

const CollapsibleUserMessage = memo(function CollapsibleUserMessage({
  text,
  skillNames = [],
  projectId,
  onOpenFileLink
}: {
  text: string;
  skillNames?: string[];
  projectId?: string;
  onOpenFileLink?: (target: string) => void;
  suppressImageGrid?: boolean;
}) {
  const collapsible = isLongUserMessage(text);
  const [expanded, setExpanded] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [animatedHeight, setAnimatedHeight] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const animationTimerRef = useRef<number | null>(null);
  const plainText = shouldRenderUserMessageAsPlainText(text);
  const visibleText = collapsible && !showFullText ? collapsedUserMessagePreview(text) : text;

  useEffect(() => {
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current);
    setExpanded(false);
    setShowFullText(false);
    setAnimating(false);
    setAnimatedHeight(null);
  }, [text]);

  useEffect(() => () => {
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current);
  }, []);

  function finishAnimation(isExpanded: boolean) {
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current);
    animationTimerRef.current = null;
    setAnimatedHeight(null);
    setAnimating(false);
    setShowFullText(isExpanded);
  }

  function toggleExpanded() {
    const element = contentRef.current;
    if (!element) {
      setExpanded((current) => !current);
      setShowFullText((current) => !current);
      return;
    }
    const opening = !expanded;
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current);
    setAnimatedHeight(element.getBoundingClientRect().height);
    setAnimating(true);
    setExpanded(opening);
    if (opening) setShowFullText(true);
    window.requestAnimationFrame(() => {
      const target = opening ? element.scrollHeight : Math.min(280, element.scrollHeight);
      setAnimatedHeight(target);
      animationTimerRef.current = window.setTimeout(() => finishAnimation(opening), 520);
    });
  }

  return (
    <>
      <div
        ref={contentRef}
        className={`userMessageContent ${collapsible && !expanded ? "collapsed" : ""} ${animating ? "animating" : ""}`}
        style={animatedHeight === null ? undefined : { height: animatedHeight }}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget || event.propertyName !== "height") return;
          finishAnimation(expanded);
        }}
      >
        {skillNames.length ? <div className="userSkillReferences">{skillNames.map((name) => <span className="userSkillReference" key={name}>{name.split(":").at(-1)}</span>)}</div> : null}
        {plainText ? (
          <pre className="userMessagePreformatted">{visibleText}</pre>
        ) : (
          <MarkdownMessage text={visibleText} projectId={projectId} onOpenFileLink={onOpenFileLink} suppressImageGrid />
        )}
      </div>
      {collapsible ? (
        <button
          className={`userMessageToggle ${expanded ? "expanded" : ""}`}
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <span>{expanded ? "收起内容" : "展开更多"}</span>
        </button>
      ) : null}
    </>
  );
});

interface MessageImagePreview {
  key: string;
  src: string;
  label: string;
  target?: string;
}

function imageTargetFromToolValue(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const source = value.trim();
    if (!source) return null;
    if ((source.startsWith("{") || source.startsWith("["))) {
      try {
        const parsed = imageTargetFromToolValue(JSON.parse(source), depth + 1);
        if (parsed) return parsed;
      } catch {
        // Some history formats already flatten the arguments to a plain path.
      }
    }
    const direct = fileTargetFromHref(source);
    if (direct && isInlineImageTarget(direct)) return direct;
    return imageTargetsFromText(source)[0] ?? null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = imageTargetFromToolValue(entry, depth + 1);
      if (target) return target;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["path", "image_path", "imagePath", "file", "file_path", "filePath", "input", "arguments", "command"]) {
      const target = imageTargetFromToolValue(record[key], depth + 1);
      if (target) return target;
    }
  }
  return null;
}

function viewImageTargetFromToolItem(item: ThreadItem): string | null {
  const tool = safeText(item.tool ?? item.name ?? item.type).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!tool.includes("viewimage") && !tool.includes("imageview")) return null;
  return imageTargetFromToolValue(item);
}

function looksLikeBase64Image(value: string): boolean {
  if (value.length < 256) {
    return false;
  }
  const compact = value.slice(0, 256).replace(/\s+/g, "");
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && (compact.startsWith("iVBOR") || compact.startsWith("/9j/") || compact.startsWith("R0lGOD") || compact.startsWith("UklGR"));
}

function addImagePreview(
  previews: MessageImagePreview[],
  seen: Set<string>,
  source: string,
  projectId: string | undefined,
  label: string,
  options: { allowBase64?: boolean } = {}
): void {
  const trimmed = source.trim();
  if (!trimmed || previews.length >= 12) {
    return;
  }

  if (/^data:image\//i.test(trimmed)) {
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      previews.push({ key: `data-${previews.length}`, src: trimmed, label });
    }
    return;
  }

  if (options.allowBase64 && looksLikeBase64Image(trimmed)) {
    const src = `data:image/png;base64,${trimmed.replace(/\s+/g, "")}`;
    if (!seen.has(src)) {
      seen.add(src);
      previews.push({ key: `base64-${previews.length}`, src, label });
    }
    return;
  }

  const fileTarget = fileTargetFromHref(trimmed);
  if (fileTarget && projectId && isInlineImageTarget(fileTarget)) {
    const key = `file-${fileTarget}`;
    if (!seen.has(key)) {
      seen.add(key);
      previews.push({ key, src: rawFileUrlForProject(projectId, fileTarget), label: fileTarget, target: fileTarget });
    }
    return;
  }

  if (/^https?:\/\//i.test(trimmed) && isInlineImageTarget(trimmed)) {
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      previews.push({ key: trimmed, src: trimmed, label });
    }
  }
}

function collectImagePreviewsFromValue(
  value: unknown,
  projectId: string | undefined,
  previews: MessageImagePreview[],
  seen: Set<string>,
  depth = 0
): void {
  if (depth > 5 || previews.length >= 12 || value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    if (/^data:image\//i.test(value) || isInlineImageTarget(value)) {
      addImagePreview(previews, seen, value, projectId, "图片");
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectImagePreviewsFromValue(entry, projectId, previews, seen, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const object = value as Record<string, unknown>;
  const fileImageKeys = ["saved_path", "savedPath", "image_path", "imagePath", "path"];
  let hasFileImagePath = false;
  for (const key of fileImageKeys) {
    const candidate = object[key];
    if (typeof candidate === "string") {
      const before = previews.length;
      addImagePreview(previews, seen, candidate, projectId, key);
      hasFileImagePath ||= previews.length > before;
    }
  }
  for (const key of ["image_url", "imageUrl", "url", "src"]) {
    const candidate = object[key];
    if (typeof candidate === "string") {
      addImagePreview(previews, seen, candidate, projectId, key);
    }
  }

  if (typeof object.result === "string" && !hasFileImagePath) {
    const typeText = safeText(object.type);
    addImagePreview(previews, seen, object.result, projectId, "生成图片", {
      allowBase64: /image/i.test(typeText) || looksLikeBase64Image(object.result)
    });
  }

  for (const key of ["output", "content", "value", "message", "data", "items", "attachments"]) {
    collectImagePreviewsFromValue(object[key], projectId, previews, seen, depth + 1);
  }
}

function imagePreviewsFromItem(item: ThreadItem, projectId?: string): MessageImagePreview[] {
  const previews: MessageImagePreview[] = [];
  const seen = new Set<string>();
  const viewedImage = viewImageTargetFromToolItem(item);
  if (viewedImage) addImagePreview(previews, seen, viewedImage, projectId, "查看的图片");
  collectImagePreviewsFromValue(item, projectId, previews, seen);
  const uploadPathPattern = /(\/tmp\/codex_remote_uploads\/[^\s)\]]+\.(?:png|jpe?g|gif|webp|bmp))/gi;
  for (const match of itemText(item).matchAll(uploadPathPattern)) {
    const uploadPath = match[0];
    addImagePreview(previews, seen, uploadPath, projectId, "图片");
  }
  return previews;
}

const MessageImagePreviewTile = memo(function MessageImagePreviewTile({
  preview,
  compact,
  galleryTargets,
  onOpenFileLink
}: {
  preview: MessageImagePreview;
  compact: boolean;
  galleryTargets: string[];
  onOpenFileLink?: (target: string, gallery?: string[]) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [preview.src]);
  const displayLabel = compactFileLabel(preview.label);
  const image = failed
    ? <span className="inlineImageUnavailable"><FileText size={20} />图片暂不可用</span>
    : <img className="inlineMessageImage" src={preview.src} alt={displayLabel} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  if (preview.target && onOpenFileLink) {
    return (
      <button
        className="inlineImageButton"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpenFileLink(preview.target!, galleryTargets);
        }}
        title={failed ? "重新打开图片预览" : "打开图片预览"}
        aria-label={`打开图片：${displayLabel}`}
      >
        {image}
        {compact ? <span>{displayLabel}</span> : null}
      </button>
    );
  }
  return (
    <div className="inlineImageButton inlineImageStatic">
      {image}
      {compact ? <span>{displayLabel}</span> : null}
    </div>
  );
});

const MessageImagePreviews = memo(function MessageImagePreviews({
  item,
  projectId,
  onOpenFileLink
}: {
  item: ThreadItem;
  projectId?: string;
  onOpenFileLink?: (target: string, gallery?: string[]) => void;
}) {
  const previews = useMemo(() => imagePreviewsFromItem(item, projectId), [item, projectId]);
  const galleryTargets = useMemo(() => previews.flatMap((preview) => preview.target ? [preview.target] : []), [previews]);
  const compactToolPreview = useMemo(() => Boolean(viewImageTargetFromToolItem(item)), [item]);
  if (!previews.length) {
    return null;
  }

  return (
    <div className={`inlineImagePreviewGrid${compactToolPreview ? " toolImagePreviewGrid" : ""}`} aria-label={compactToolPreview ? "工具查看的图片" : "图片预览"}>
      {compactToolPreview ? <span className="toolImagePreviewLabel">图片输出</span> : null}
      {previews.map((preview) => (
        <MessageImagePreviewTile key={preview.key} preview={preview} compact={compactToolPreview} galleryTargets={galleryTargets} onOpenFileLink={onOpenFileLink} />
      ))}
    </div>
  );
});

function uploadedFileMarkdown(files: ProjectFile[]): string {
  return files.map((file) => `- ${file.name}: ${file.relativePath}`).join("\n");
}

function promptWithUploadedFiles(promptText: string, files: ProjectFile[]): string {
  if (!files.length) {
    return promptText;
  }
  const uploadContext = `上传文件：\n${uploadedFileMarkdown(files)}`;
  return promptText ? `${promptText}\n\n${uploadContext}` : uploadContext;
}

function visiblePromptText(promptText: string, files: ProjectFile[]): string {
  if (promptText) {
    return promptText;
  }
  if (!files.length) {
    return "";
  }
  const names = files.map((file) => file.name).join("、");
  return `上传了 ${files.length} 个文件：${names}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImageComposerUpload(file: ProjectFile, sourceFile: File | null): boolean {
  return Boolean(
    sourceFile?.type.startsWith("image/") ||
    file.mime.toLowerCase().startsWith("image/") ||
    isInlineImageTarget(file.name) ||
    isInlineImageTarget(file.relativePath)
  );
}

const ComposerImageThumbnail = memo(function ComposerImageThumbnail({ upload }: { upload: ComposerUpload }) {
  const [source, setSource] = useState("");

  useEffect(() => {
    if (!upload.sourceFile) {
      setSource(upload.rawUrl);
      return;
    }
    const objectUrl = URL.createObjectURL(upload.sourceFile);
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [upload.sourceFile, upload.rawUrl]);

  if (!source) {
    return <span className="uploadedImageThumbnail uploadedImageThumbnailFallback"><FileText size={16} /></span>;
  }
  return <img className="uploadedImageThumbnail" src={source} alt={`${upload.name} 预览`} />;
});

const PendingUserImagePreviews = memo(function PendingUserImagePreviews({
  uploads,
  onOpenFileLink
}: {
  uploads?: ComposerUpload[];
  onOpenFileLink: (target: string, gallery?: string[]) => void;
}) {
  const images = uploads?.filter((upload) => upload.isImage) ?? [];
  if (!images.length) {
    return null;
  }
  return (
    <div className="inlineImagePreviewGrid pendingUserImagePreviews" aria-label="本条消息附带的图片">
      {images.map((upload) => (
        <button
          className="inlineImageButton pendingUserImagePreview"
          type="button"
          key={upload.relativePath}
          onClick={() => onOpenFileLink(upload.relativePath, images.map((image) => image.relativePath))}
          title="打开图片预览"
        >
          <ComposerImageThumbnail upload={upload} />
        </button>
      ))}
    </div>
  );
});

interface PersistedUserAttachment {
  name: string;
  target: string;
  isImage: boolean;
}

function persistedUserAttachmentsFromText(text: string): PersistedUserAttachment[] {
  const marker = text.lastIndexOf("上传文件：");
  if (marker < 0) {
    return [];
  }
  const attachments: PersistedUserAttachment[] = [];
  const seen = new Set<string>();
  const lines = text.slice(marker).split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s+(.+?):\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const name = match[1].trim();
    const target = match[2].trim();
    if (!name || !target || seen.has(target)) {
      continue;
    }
    seen.add(target);
    attachments.push({ name, target, isImage: isInlineImageTarget(target) });
  }
  return attachments;
}

const PersistedUserAttachmentPreviews = memo(function PersistedUserAttachmentPreviews({
  text,
  projectId,
  onOpenFileLink
}: {
  text: string;
  projectId?: string;
  onOpenFileLink: (target: string, gallery?: string[]) => void;
}) {
  const attachments = useMemo(() => persistedUserAttachmentsFromText(text), [text]);
  if (!attachments.length) {
    return null;
  }
  return (
    <div className="persistedUserAttachmentList" aria-label="本条消息的文件附件">
      {attachments.map((attachment) => {
        const content = attachment.isImage && projectId ? (
          <img className="persistedUserAttachmentThumbnail" src={rawFileUrlForProject(projectId, attachment.target)} alt={attachment.name} loading="lazy" decoding="async" />
        ) : (
          <span className={`persistedUserAttachmentIcon${/\.pdf$/i.test(attachment.name) ? " pdf" : ""}`}><FileText size={16} /></span>
        );
        return (
          <button
            className={`persistedUserAttachment${attachment.isImage ? " image" : ""}`}
            type="button"
            key={attachment.target}
            onClick={() => onOpenFileLink(attachment.target, attachment.isImage ? attachments.filter((entry) => entry.isImage).map((entry) => entry.target) : undefined)}
            title={`打开 ${attachment.name}`}
          >
            {content}
            {!attachment.isImage ? <span>{attachment.name}</span> : null}
          </button>
        );
      })}
    </div>
  );
});

function modelProfileById(id: string, profiles: ModelProfile[]): ModelProfile {
  return profiles.find((profile) => profile.id === id) ?? profiles[0] ?? fallbackModelProfiles[0];
}

function isUltraModelProfile(profile: ModelProfile): boolean {
  return String(profile.effort).toLowerCase() === "ultra"
    || profile.id.toLowerCase().includes("ultra")
    || profile.label.toLowerCase().includes("ultra");
}

function modelProfileIdFor(model: string, effort: ReasoningEffort, profiles: ModelProfile[]): string {
  return profiles.find((profile) => profile.model === model && profile.effort === effort)?.id ?? profiles[0]?.id ?? defaultModelProfileId;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return new Intl.NumberFormat("en-US").format(value);
}

function contextApplicationNote(status: ThreadContextStatus | null): { text: string; capped: boolean } | null {
  if (!status || (status.config.profile === "default" && status.config.contextWindow === null)) return null;
  const requestedWindow = status.config.contextWindow;
  const configAt = status.config.updatedAt ? Date.parse(status.config.updatedAt) : 0;
  const measuredAt = status.lastTokenCountAt ? Date.parse(status.lastTokenCountAt) : 0;
  if (configAt && configAt > measuredAt) {
    return { text: "设置已保存，等待下一次发送后读取 Codex 实际生效窗口。", capped: false };
  }
  if (requestedWindow && status.contextWindow) {
    const capped = status.contextWindow < requestedWindow * 0.94;
    const safeguard = status.effectiveCompactTokenLimit !== status.compactTokenLimit
      ? `；为防止撞满，当前 compact 安全降至 ${formatNumber(status.effectiveCompactTokenLimit)}`
      : "";
    return {
      text: `请求 ${formatNumber(requestedWindow)}，Codex 最近实际有效窗口 ${formatNumber(status.contextWindow)}${safeguard}。`,
      capped
    };
  }
  return { text: "会话参数已保存，将由对应账号的 Codex app-server 在续接时应用。", capped: false };
}

function formatResetTime(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) {
    return "-";
  }
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
}

function remainingQuotaPercent(usedPercent: number | null | undefined): number | null {
  if (usedPercent === null || usedPercent === undefined || Number.isNaN(usedPercent)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((100 - usedPercent) * 10) / 10));
}

function percentText(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return Number.isInteger(value) ? `${value}` : `${value.toFixed(1)}`;
}

function rateWindowLabel(window: CodexRateLimitWindow): string {
  const minutes = window.windowDurationMins;
  if (!minutes) {
    return "窗口";
  }
  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}天`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}小时`;
  }
  return `${minutes}分钟`;
}

function rateWindowSafePercentAtTonight(window: CodexRateLimitWindow | null | undefined): number | null {
  if (!window) {
    return null;
  }
  const durationMins = window.windowDurationMins;
  const resetsAt = window.resetsAt;
  if (durationMins === null || !resetsAt || durationMins <= 0) {
    return null;
  }
  const durationMs = durationMins * 60 * 1000;
  const windowEndMs = resetsAt * 1000;
  const windowStartMs = windowEndMs - durationMs;
  if (!Number.isFinite(windowEndMs) || !Number.isFinite(windowStartMs) || windowStartMs >= windowEndMs) {
    return null;
  }
  const todayEnd = new Date();
  todayEnd.setHours(24, 0, 0, 0);
  const cutoffMs = todayEnd.getTime();
  if (cutoffMs <= windowStartMs) {
    return 0;
  }
  const elapsedPercent = ((cutoffMs - windowStartMs) / durationMs) * 100;
  const safeRemainingPercent = 100 - elapsedPercent;
  return Math.max(0, Math.min(100, Number(safeRemainingPercent.toFixed(1))));
}

function formatTodayCutoffLabel(): string {
  return "今天 24:00";
}

function rateWindowDailyLimitLabel(window: CodexRateLimitWindow | null | undefined): string {
  const percent = rateWindowSafePercentAtTonight(window);
  if (percent === null) {
    return "-";
  }
  return `${percentText(percent)}%（截止 ${formatTodayCutoffLabel()}）`;
}

function weeklyRateWindow(
  primary: CodexRateLimitWindow | null | undefined,
  secondary: CodexRateLimitWindow | null | undefined
): CodexRateLimitWindow | null {
  const windows = [primary, secondary].filter((window): window is CodexRateLimitWindow => Boolean(window));
  return windows.sort((left, right) => (right.windowDurationMins ?? 0) - (left.windowDurationMins ?? 0))[0] ?? null;
}

function cleanLimitName(raw: string | null | undefined): string {
  const next = (raw ?? "")
    .replace(/gpt-5\.3-codex(?:-spark)?/gi, "Spark")
    .replace(/\s+/g, " ")
    .trim();
  return next || "模型额度";
}

function rateWindowText(window: CodexRateLimitWindow | null | undefined): string {
  if (!window) {
    return "-";
  }
  const windowLabel = rateWindowLabel(window);
  const remaining = remainingQuotaPercent(window.usedPercent);
  const used = window.usedPercent ?? null;
  return `剩余 ${percentText(remaining)}% / ${windowLabel}，已用 ${percentText(used)}%，重置 ${formatResetTime(window.resetsAt)}`;
}

function rateLimitSnapshotText(snapshot: CodexRateLimitSnapshot | null | undefined): string {
  if (!snapshot) {
    return "-";
  }
  const parts = [snapshot.primary, snapshot.secondary]
    .filter((window): window is CodexRateLimitWindow => Boolean(window))
    .map(rateWindowText);
  const individual = snapshot.individualLimit;
  if (individual?.resetsAt && individual.resetsAt !== snapshot.primary?.resetsAt) {
    const remaining = individual.remainingPercent === null ? "" : `剩余 ${percentText(individual.remainingPercent)}%`;
    parts.push([remaining, `重置 ${formatResetTime(individual.resetsAt)}`].filter(Boolean).join("，"));
  }
  return parts.join("；") || "-";
}

function quotaSummaryLabel(quota: CodexQuota | null, pool: CodexAccountPool | null): string {
  if (pool?.accounts.length) {
    const codexAccounts = pool.accounts.filter((account) => account.kind !== "api-provider");
    if (!codexAccounts.length) return "外部模型";
    const totalRemaining = codexAccounts.reduce((sum, account) => {
      return sum + (remainingQuotaPercent(account.quota.rateLimits?.primary?.usedPercent) ?? 0);
    }, 0);
    return `总额度 ${percentText(totalRemaining)}%`;
  }
  const primary = remainingQuotaPercent(quota?.rateLimits?.primary?.usedPercent);
  const secondary = remainingQuotaPercent(quota?.rateLimits?.secondary?.usedPercent);
  if (primary === null) {
    return "额度";
  }
  return `额度 ${percentText(primary)}%${secondary === null ? "" : ` / ${percentText(secondary)}%`}`;
}

function quotaMarkdown(quota: CodexQuota): string {
  const lines = [
    `**Codex 额度**`,
    `- 账号类型：${quota.account?.type ?? "-"} / ${quota.account?.planType ?? quota.rateLimits?.planType ?? "-"}`,
    `- 主额度：${rateWindowText(quota.rateLimits?.primary ?? null)}`,
    `- 次额度：${rateWindowText(quota.rateLimits?.secondary ?? null)}`,
    `- reset credits：${quota.resetCredits?.availableCount ?? "-"}`,
    `- lifetime tokens：${formatNumber(quota.usage?.summary?.lifetimeTokens)}`,
    `- peak daily tokens：${formatNumber(quota.usage?.summary?.peakDailyTokens)}`
  ];
  const otherLimits = Object.entries(quota.rateLimitsByLimitId ?? {}).filter(([key]) => key !== "codex");
  if (otherLimits.length) {
    lines.push("", "**其它模型额度**");
    for (const [key, value] of otherLimits) {
      const name = cleanLimitName(value.limitName ?? key);
      const windows = [value.primary, value.secondary].filter((window): window is CodexRateLimitWindow => Boolean(window));
      if (windows.length) {
        for (const window of windows) {
          lines.push(`- ${name} ${rateWindowLabel(window)}：${rateWindowText(window)}`);
        }
      } else {
        lines.push(`- ${name}：${rateLimitSnapshotText(value)}`);
      }
    }
  }
  if (quota.errors.length) {
    lines.push("", `读取警告：${quota.errors.join("；")}`);
  }
  return lines.join("\n");
}

function AccountQuotaDetails({ quota }: { quota: CodexQuota }) {
  const primary = quota?.rateLimits?.primary ?? null;
  const secondary = quota?.rateLimits?.secondary ?? null;
  const weekly = weeklyRateWindow(primary, secondary);
  const otherLimits = Object.entries(quota?.rateLimitsByLimitId ?? {}).filter(([key]) => key !== "codex");
  const otherLimitRows = otherLimits.flatMap(([key, limit]) => {
    const name = cleanLimitName(limit.limitName ?? key);
    const windows = ([
      ["primary", limit.primary],
      ["secondary", limit.secondary]
    ] as const).flatMap(([kind, window]) => window ? [{
      key: `${key}:${kind}`,
      label: `${name} ${rateWindowLabel(window)}`,
      text: rateWindowText(window)
    }] : []);
    return windows.length ? windows : [{ key, label: name, text: rateLimitSnapshotText(limit) }];
  });
  return (
    <div className="quotaPopoverRows">
          <div><span>主额度</span><strong>{rateWindowText(primary)}</strong></div>
          <div><span>次额度</span><strong>{rateWindowText(secondary)}</strong></div>
          <div><span>每日建议上限</span><strong>{rateWindowDailyLimitLabel(weekly)}</strong></div>
          {otherLimitRows.map((row) => (
            <div key={row.key}><span>{row.label}</span><strong>{row.text}</strong></div>
          ))}
          <div><span>总token</span><strong>{formatNumber(quota.usage?.summary?.lifetimeTokens)}</strong></div>
          <div><span>重置额度</span><strong>{formatNumber(quota.resetCredits?.availableCount)}</strong></div>
    </div>
  );
}

function accountRemainingLabel(account: CodexAccountPoolAccount): string {
  if (account.kind === "api-provider") return account.health === "ready" ? "运行时就绪" : "待检查";
  const remaining = remainingQuotaPercent(account.quota.rateLimits?.primary?.usedPercent);
  return remaining === null ? "--" : `${percentText(remaining)}%`;
}

function QuotaPopover({ quota, pool, loading, closing }: { quota: CodexQuota | null; pool: CodexAccountPool | null; loading: boolean; closing: boolean }) {
  const quotaAccounts = pool?.accounts.filter((entry) => entry.kind !== "api-provider") ?? [];
  const defaultAccount = quotaAccounts.find((entry) => entry.selectedForNewThreads) ?? quotaAccounts[0] ?? null;
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(defaultAccount?.id ?? null);
  const selectedAccount = quotaAccounts.find((entry) => entry.id === selectedAccountId) ?? defaultAccount;
  const currentThreadAccount = quotaAccounts.find((entry) => entry.id === pool?.currentThreadAccountId) ?? null;
  const selectedQuota = selectedAccount?.quota ?? quota;
  return (
    <section className={`quotaPopover accountPoolPopover ${closing ? "closing" : ""}`} role="status" aria-label="Codex 多账号额度详情" aria-hidden={closing} inert={closing}>
      {pool && quotaAccounts.length ? (
        <>
          <div className="accountPoolTabs" role="tablist" aria-label="Codex 账号额度">
            {quotaAccounts.map((account) => (
              <button
                className={`accountPoolTab ${account.id === selectedAccount?.id ? "active" : ""} ${account.health !== "ready" ? "degraded" : ""} ${account.id === currentThreadAccount?.id ? "current" : ""} ${(remainingQuotaPercent(account.quota.rateLimits?.primary?.usedPercent) ?? 100) <= 10 ? "lowQuota" : ""}`}
                data-account-id={account.id}
                type="button"
                role="tab"
                aria-selected={account.id === selectedAccount?.id}
                title={account.selectedForNewThreads ? `${account.label} 将承接下一个新会话` : `${account.label} 已有会话保持粘性`}
                key={account.id}
                onClick={() => setSelectedAccountId(account.id)}
              >
                <span>{account.label}</span>
                <strong>{accountRemainingLabel(account)}</strong>
              </button>
            ))}
          </div>
          {selectedQuota ? <AccountQuotaDetails quota={selectedQuota} /> : <p>暂未读取到额度</p>}
          {selectedAccount ? (
            <div className="accountPoolSelectedMeta">
              {currentThreadAccount ? (
                <>
                  <span className={`accountHealthDot ${currentThreadAccount.health}`} />
                  <span>当前会话 · {pool?.currentThreadAccountLabel ?? currentThreadAccount.label}</span>
                  <span>该账号已分配 {currentThreadAccount.assignedThreadCount} 个会话</span>
                </>
              ) : (
                <>
                  <span className={`accountHealthDot ${defaultAccount?.health ?? "starting"}`} />
                  <span>新会话将分配至 · {defaultAccount?.label ?? "--"}</span>
                  <span>按剩余额度自动均衡</span>
                </>
              )}
            </div>
          ) : null}
        </>
      ) : selectedQuota ? <AccountQuotaDetails quota={selectedQuota} /> : <p>{loading ? "正在读取额度…" : "暂未读取到额度"}</p>}
    </section>
  );
}

function userDisplayName(userId: string, users: UserProfile[]): string {
  return users.find((user) => user.id === userId)?.name ?? userId;
}

function leaderboardScopeLabel(scope: CodexLeaderboardScope): string {
  const windowText = scope.startAt && scope.resetAt
    ? `，窗口 ${formatResetTime(scope.startAt)} ~ ${formatResetTime(scope.resetAt)}`
    : scope.resetAt
      ? `，重置 ${formatResetTime(scope.resetAt)}`
      : scope.startAt
        ? `，统计自 ${formatResetTime(scope.startAt)}`
      : "";
  const quotaText = scope.quotaUsedPercent === null ? "" : `，当前额度已用 ${percentText(scope.quotaUsedPercent)}%`;
  return `${formatNumber(scope.totalTokens)} token${quotaText}${windowText}`;
}

function leaderboardMarkdown(leaderboard: CodexLeaderboard, users: UserProfile[]): string {
  const section = (title: string, scope: CodexLeaderboardScope) => {
    const lines = [`**${title}**`, `- 总计：${leaderboardScopeLabel(scope)}`];
    if (!scope.users.length) {
      lines.push("- 暂无本地 token_count 记录。");
      return lines;
    }
    for (const user of scope.users) {
      const name = userDisplayName(user.userId, users);
      const quotaPart = user.quotaPercent === null ? "" : `，约吃掉总额度 ${percentText(user.quotaPercent)}%`;
      lines.push(`- ${name}：${formatNumber(user.totalTokens)} token，占本榜 ${percentText(user.sharePercent)}%${quotaPart}`);
      lines.push(`  输入 ${formatNumber(user.inputTokens)} / 输出 ${formatNumber(user.outputTokens)} / reasoning ${formatNumber(user.reasoningOutputTokens)} / 会话 ${user.sessionCount}`);
      if (user.models.length) {
        lines.push(`  模型：${user.models.map((model) => `${model.model}${model.effort ? ` ${model.effort}` : ""} ${formatNumber(model.totalTokens)}`).join("；")}`);
      }
    }
    return lines;
  };
  const lines = [
    "**模型 Token 排行榜**",
    ...section("当前周期", leaderboard.currentCycle),
    "",
    ...section("历史累计", leaderboard.lifetime)
  ];
  if (leaderboard.errors.length) {
    lines.push("", `读取警告：${leaderboard.errors.join("；")}`);
  }
  return lines.join("\n");
}

function LeaderboardScopeView({ title, scope, users }: { title: string; scope: CodexLeaderboardScope; users: UserProfile[] }) {
  const rankedUsers = scope.users;
  return (
    <section className="leaderboardScope">
      <div className="leaderboardScopeHeader">
        <div>
          <h3>{title}</h3>
          <p>{leaderboardScopeLabel(scope)} · {rankedUsers.length} 人</p>
        </div>
      </div>
      {rankedUsers.length ? (
        <div className="leaderboardRows" role="region" tabIndex={0} aria-label={`${title}排行榜，共 ${rankedUsers.length} 人，可滚动浏览`}>
          {rankedUsers.map((user, index) => (
            <article className="leaderboardRow" key={`${title}-${user.userId}`}>
              <div className="leaderboardRank">{index + 1}</div>
              <div className="leaderboardMain">
                <div className="leaderboardNameLine">
                  <strong>{userDisplayName(user.userId, users)}</strong>
                  <span>{formatNumber(user.totalTokens)} token</span>
                </div>
                <div className="leaderboardMeter" aria-hidden="true">
                  <span style={{ width: `${Math.max(2, Math.min(100, user.sharePercent))}%` }} />
                </div>
                <div className="leaderboardMeta">
                  <span>占本榜 {percentText(user.sharePercent)}%</span>
                  {user.quotaPercent !== null ? <span>总额度 {percentText(user.quotaPercent)}%</span> : null}
                  <span>会话 {user.sessionCount}</span>
                </div>
                <div className="leaderboardBreakdown">
                  <span>输入 {formatNumber(user.inputTokens)}</span>
                  <span>输出 {formatNumber(user.outputTokens)}</span>
                  <span>reasoning {formatNumber(user.reasoningOutputTokens)}</span>
                </div>
                {user.models.length ? (
                  <div className="leaderboardModels">
                    {user.models.map((model) => (
                      <span key={`${model.model}-${model.effort ?? "default"}`}>
                        {model.model}{model.effort ? ` ${model.effort}` : ""} · {formatNumber(model.totalTokens)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="emptyState">暂无本地 token_count 记录。</div>
      )}
    </section>
  );
}

function TrackedQuotaDetails({ usage }: { usage: TrackedQuotaUsage }) {
  return (
    <div className="trackedQuotaBody">
      <section className={`trackedQuotaSummary ${usage.todayQuotaPercent > 50 ? "warning" : usage.blocked ? "blocked" : "healthy"}`}>
        <div>
          <span>{usage.today} · {usage.timeZone}</span>
          <strong>今日估算占用 {percentText(usage.todayQuotaPercent)}%</strong>
        </div>
        <em>{usage.unlimitedAccountId ? `仅可使用 ${usage.unlimitedAccountId}` : usage.blocked ? "已停止发起回答" : `距离上限还剩 ${percentText(Math.max(0, usage.dailyLimitPercent - usage.todayQuotaPercent))}%`}</em>
      </section>

      <div className="trackedQuotaAccounts">
        {usage.accounts.map((account) => (
          <article className="trackedQuotaAccount" key={account.accountId}>
            <header>
              <strong>{account.accountLabel}</strong>
              <span>账号剩余 {account.accountRemainingPercent === null ? "--" : `${percentText(account.accountRemainingPercent)}%`}</span>
            </header>
            <div className="trackedQuotaMetrics">
              <div><span>lzc 今日</span><strong>{percentText(account.todayQuotaPercent)}%</strong><small>{formatNumber(account.todayTokens)} token</small></div>
              <div><span>本周期累计</span><strong>{percentText(account.userCycleQuotaPercent)}%</strong><small>{formatNumber(account.userCycleTokens)} token</small></div>
            </div>
            <p>{account.cycleStartAt && account.resetAt
              ? `额度周期 ${formatResetTime(account.cycleStartAt)} 至 ${formatResetTime(account.resetAt)}`
              : "尚未读取到额度重置周期"}</p>
          </article>
        ))}
      </div>

      <section className="trackedQuotaDays">
        <header><strong>自然日统计</strong><span>当前额度周期内</span></header>
        {usage.days.length ? usage.days.map((day) => (
          <article key={day.date}>
            <div><strong>{day.date}</strong><span>{formatNumber(day.userTokens)} token</span></div>
            <em>{percentText(day.quotaPercent)}%</em>
            <small>{day.accounts.map((account) => `${account.accountLabel} ${percentText(account.quotaPercent)}%`).join(" · ")}</small>
          </article>
        )) : <div className="emptyState">当前额度周期暂无 lzc token 记录。</div>}
      </section>

      <p className="trackedQuotaFootnote">个人百分比为估算值，并非 OpenAI 提供的个人扣额；多人共用账号时无法精确拆分。{usage.unlimitedAccountId ? `lzc 仅可使用 ${usage.unlimitedAccountId}；其他账号的旧会话只可查看。` : `每日合计达到 ${percentText(usage.dailyLimitPercent)}% 后，后端禁止 lzc 继续发起回答，但仍可登录和查看历史。`}</p>
      {usage.errors.length ? <p className="leaderboardWarning">读取警告：{usage.errors.join("；")}</p> : null}
    </div>
  );
}

function skillsMarkdown(skills: CodexSkill[]): string {
  if (!skills.length) {
    return "当前项目没有发现可用 skill。";
  }
  return [`**可用 Codex Skills（${skills.length}）**`, ...skills.slice(0, 80).map((skill) => `- $${skill.name} · ${skill.displayName}${skill.shortDescription ? `：${skill.shortDescription}` : ""}`)].join("\n");
}

const localizedSkillCopy: Record<string, { name: string; description: string }> = {
  pdf: { name: "PDF 文档", description: "读取、制作与检查 PDF 的排版" },
  "build-web-data-visualization:data-visualization": { name: "数据可视化", description: "把数据制作成清晰的交互图表" },
  "build-web-data-visualization:dashboards-and-real-time-visualization": { name: "实时仪表盘", description: "设计实时更新的指标看板" },
  "build-web-data-visualization:d3-data-visualization": { name: "D3 图表", description: "用 D3 构建定制交互图表" },
  "build-web-data-visualization:canvas2d-data-visualization": { name: "Canvas 图表", description: "绘制高密度二维可视化" },
  "build-web-data-visualization:threejs-data-visualization": { name: "三维可视化", description: "用 Three.js 呈现三维数据" },
  "build-web-data-visualization:geospatial-and-cartographic-visualization": { name: "地图可视化", description: "制作地理空间数据地图" },
  "build-web-data-visualization:gantt-chart-visualization": { name: "甘特图", description: "展示任务、依赖与时间进度" },
  "build-web-data-visualization:node-link-and-diagram-layout": { name: "关系网络图", description: "排列节点、连线与复杂关系" },
  "build-web-data-visualization:uml-and-software-architecture-visualization": { name: "架构图", description: "绘制 UML 与软件架构关系" },
  "build-web-data-visualization:reports-pdfs-and-slide-automation": { name: "报告与演示", description: "将可视化导出为报告、PDF 与幻灯片" },
  "build-web-data-visualization:statistical-and-uncertainty-visualization": { name: "统计图", description: "准确呈现分布与不确定性" },
  "build-web-data-visualization:grammar-of-graphics-and-declarative-visualization": { name: "声明式图表", description: "使用图形语法构建可复用图表" },
  "build-web-data-visualization:react-and-nextjs-data-visualization": { name: "React 图表", description: "把交互可视化接入 React 页面" },
  "build-web-data-visualization:typescript-data-visualization-engineering": { name: "图表工程", description: "构建可靠的 TypeScript 可视化代码" },
  "build-web-data-visualization:scrollytelling-and-parallax-data-visualization": { name: "滚动叙事", description: "制作随页面滚动展开的数据故事" },
  "build-web-data-visualization:accessibility-and-inclusive-visualization": { name: "无障碍图表", description: "优化图表对比度、文字与可访问性" },
  "build-web-data-visualization:testing-data-visualizations": { name: "图表测试", description: "验证图表数据与视觉表现" },
  "build-web-data-visualization:visualization-strategy-and-critique": { name: "可视化方案", description: "选择图表形式并审查视觉表达" },
  "product-design:audit": { name: "设计审查", description: "检查界面体验与设计问题" },
  "product-design:design-qa": { name: "设计验收", description: "对照设计目标检查实现质量" },
  "product-design:get-context": { name: "收集设计背景", description: "整理设计任务所需的上下文" },
  "product-design:ideate": { name: "创意方案", description: "探索多个产品设计方向" },
  "product-design:image-to-code": { name: "截图转代码", description: "依据截图制作可用界面" },
  "product-design:index": { name: "产品设计导航", description: "选择合适的产品设计流程" },
  "product-design:research": { name: "设计调研", description: "研究体验问题与参考方案" },
  "product-design:share": { name: "分享设计", description: "整理可供团队审阅的设计成果" },
  "product-design:url-to-code": { name: "网页转代码", description: "参考现有网页制作界面" },
  "product-design:user-context": { name: "用户体验背景", description: "梳理目标用户与使用情境" },
  imagegen: { name: "图像生成", description: "生成或编辑网站、游戏和内容所需的图片" },
  "openai-docs": { name: "OpenAI 文档", description: "查询 OpenAI 官方文档、Codex 用法与模型迁移指南" },
  "openai-templates:artifact-template-analytics-dashboard": { name: "数据分析仪表盘", description: "创建包含关键指标与图表的数据分析表格" },
  "openai-templates:artifact-template-business-review": { name: "经营复盘", description: "创建业务表现、关键指标与后续计划演示文稿" },
  "openai-templates:artifact-template-design-report": { name: "设计报告", description: "创建包含发现、影响与建议的设计报告" },
  "openai-templates:artifact-template-experiment-analysis": { name: "实验分析", description: "整理实验假设、方法、结果、局限与下一步" },
  "openai-templates:artifact-template-financial-budget": { name: "财务预算", description: "创建预算、实际支出、预测与现金周期表格" },
  "openai-templates:artifact-template-investment-committee-memo": { name: "投委会备忘录", description: "创建投资逻辑、财务分析、风险与建议备忘录" },
  "openai-templates:artifact-template-legal-memorandum": { name: "法律备忘录", description: "创建问题、事实、分析与结论结构的法律文档" },
  "openai-templates:artifact-template-market-trends-report": { name: "市场趋势报告", description: "创建市场趋势、证据、影响与应对建议演示文稿" },
  "openai-templates:artifact-template-minimal-letterhead": { name: "简约商务信函", description: "使用简约抬头版式创建专业商务信函" },
  "openai-templates:artifact-template-operating-calendar": { name: "运营日历", description: "规划年度与月度里程碑、活动、发布和截止日期" },
  "openai-templates:artifact-template-operating-review": { name: "运营复盘", description: "创建周度运营计分卡、风险、决策与行动项演示" },
  "openai-templates:artifact-template-project-kickoff": { name: "项目启动会", description: "对齐项目目标、范围、角色、里程碑和风险" },
  "openai-templates:artifact-template-project-tracker": { name: "项目跟踪表", description: "跟踪任务、负责人、状态、优先级与甘特计划" },
  "openai-templates:artifact-template-sales-pipeline": { name: "销售管线", description: "跟踪商机、阶段、金额、概率、预测和下一步" },
  "openai-templates:artifact-template-simple-dark-mode": { name: "简约深色演示", description: "创建排版清晰的深色主题演示文稿" },
  "openai-templates:artifact-template-simple-light-mode": { name: "简约浅色演示", description: "创建留白舒展的浅色主题演示文稿" },
  "openai-templates:artifact-template-strategy-memorandum": { name: "战略备忘录", description: "整理战略背景、选择、风险、里程碑与建议" },
  "openai-templates:artifact-template-system-design": { name: "系统设计", description: "记录架构、需求、组件、数据流、接口与权衡" },
  "openai-templates:artifact-template-team-alignment": { name: "团队共识", description: "创建团队目标、优先级、决策与行动项演示" },
  "openai-templates:artifact-template-three-statement-forecast": { name: "三表预测", description: "创建利润表、资产负债表与现金流联动预测" },
  "plugin-creator": { name: "插件创建器", description: "创建 Codex 插件结构和市场条目" },
  "review-agent": { name: "代码审查", description: "检查代码变更并发现可执行的缺陷" },
  "skill-creator": { name: "技能创建器", description: "创建或更新可复用的 Codex 技能" },
  "skill-installer": { name: "技能安装器", description: "从官方列表或 GitHub 仓库安装技能" },
};

function localizedSkill(skill: CodexSkill) {
  return localizedSkillCopy[skill.name] ?? {
    name: skill.displayName || skill.name,
    description: skill.shortDescription || skill.description || "Codex 扩展技能",
  };
}

function skillSection(name: string): string {
  if (name.startsWith("build-web-data-visualization:")) return "数据可视化";
  if (name.startsWith("product-design:")) return "产品设计";
  return "基础技能";
}

function commandHelpMarkdown(): string {
  return [
    "**Codex Web 命令**",
    "- `/quota` 或 `/usage`：查看 Codex 额度/用量",
    "- `/skills`：打开中文技能选择器",
    "- `/plan`：开启原生计划模式，先审方案再允许改动",
    "- `/fast`：切换下次请求的 Fast 档位",
    "- `/skill 名称`：显式选择一个技能，发送时使用 `$技能名` 调用",
    "- `/stop`：终止当前轮次；存在 active Goal 时同时暂停 Goal，防止自动续跑",
    "- `/goal 目标`：在当前会话设置并启动 Codex 原生 Goal，完成后会自动续跑",
    "- `/goal-stop`：彻底结束并清除当前会话的 Goal",
    "- `/compact`：压缩当前会话上下文",
    "- `/status`：查看当前会话、模型和上下文使用情况",
    "- `/review`：原生审查未提交改动；`/review 分支名`：与指定分支比较",
    "- `/rename 新名称`：重命名当前会话",
    "- `/shell 命令`：把 shell 命令作为 Codex thread 命令执行（需要当前会话）",
    "- `/cmd 命令`：在当前项目目录直接运行一次 shell 命令",
    "- `/new`：回到新建会话"
  ].join("\n");
}

function isThreadVisibilityError(message: string | undefined): boolean {
  return Boolean(message && message.includes("Thread is not visible for this logged-in user"));
}

function safeLiveSnapshotItems<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => Boolean(item && typeof item === "object"))
    : [];
}

const LIVE_RECONNECT_AGENT_LIMIT = 32;
const LIVE_RECONNECT_TOOL_LIMIT = 48;
const LIVE_RECONNECT_TEXT_LIMIT = 6_000;

function recentLiveSnapshotItems<T>(value: T[] | null | undefined, limit: number): T[] {
  return safeLiveSnapshotItems(value).slice(-limit);
}

function reconnectPreview(text: string, maxChars = LIVE_RECONNECT_TEXT_LIMIT): string {
  if (text.length <= maxChars) return text;
  const notice = "\n…[实时预览已截断，完整内容保留在会话历史中]…\n";
  const available = Math.max(0, maxChars - notice.length);
  const headLength = Math.ceil(available * 0.65);
  return `${text.slice(0, headLength)}${notice}${text.slice(text.length - (available - headLength))}`;
}

function liveDeltasFromSnapshot(
  snapshot: LiveStateSnapshot,
  activeTurns = activeTurnsFromSnapshot(snapshot)
): Record<string, LiveDeltaEntry> {
  return Object.fromEntries(
    recentLiveSnapshotItems(snapshot.agentMessages, LIVE_RECONNECT_AGENT_LIMIT)
      .filter((message) => message.itemId && message.text && !message.completed)
      .map((message) => [
        message.itemId,
        {
          threadId: message.threadId,
          // A recovered live snapshot can retain an old item turnId after a
          // queued prompt has moved on. The active turn is authoritative while
          // it is running; completed history will retain the final order.
          turnId: message.turnId ?? (message.threadId ? activeTurns[message.threadId] ?? null : null),
          text: reconnectPreview(message.text, 32_000),
          startedAt: message.startedAt ?? message.updatedAt,
          sequence: message.sequence,
          sourceItemId: message.sourceItemId
        }
      ])
  );
}

function liveToolsFromSnapshot(snapshot: LiveStateSnapshot): Record<string, LiveToolEntry> {
  return Object.fromEntries(
    recentLiveSnapshotItems(snapshot.toolItems, LIVE_RECONNECT_TOOL_LIMIT)
      .filter((item) => item.itemId)
      .map((item) => [item.itemId, {
        ...item,
        input: reconnectPreview(item.input ?? ""),
        output: reconnectPreview(item.output ?? "")
      }])
  );
}

function activeTurnsFromSnapshot(snapshot: LiveStateSnapshot): Record<string, string> {
  return Object.fromEntries(
    safeLiveSnapshotItems(snapshot.activeTurns)
      .filter((turn) => turn.status === "running" && turn.threadId && turn.turnId)
      .map((turn) => [turn.threadId as string, turn.turnId as string])
  );
}

function notificationThreadId(params: Record<string, unknown>): string | null {
  const thread = params.thread && typeof params.thread === "object" ? params.thread as Record<string, unknown> : {};
  const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : {};
  for (const candidate of [params.threadId, thread.id, turn.threadId]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

function notificationTurnId(params: Record<string, unknown>): string | null {
  const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : {};
  for (const candidate of [params.turnId, turn.id]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

function isRunningStatus(status: unknown): boolean {
  const token = normalizedToken(status);
  return token.includes("running") || token.includes("inprogress") || token.includes("active");
}

function hasPersistedCompletedTurn(thread: ThreadSummary | null, turnId: string | null): boolean {
  if (!thread || !turnId) {
    return false;
  }
  const turn = thread.turns.find((entry) => entry.id === turnId);
  return Boolean(turn && !isRunningStatus(turn.status) && Array.isArray(turn.items) && turn.items.length > 0);
}

function requestToken(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }
  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function userInitials(name: string): string {
  const value = name.trim();
  if (!value) return "?";
  const parts = value.split(/[._\-\s]+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return Array.from(value).slice(0, 2).join("").toUpperCase();
}

const sidebarWidthStorageKey = "codex-web-sidebar-width";
const threadListWidthStorageKey = "codex-web-thread-list-width";
const composerHeightStorageKey = "codex-web-composer-height";
const sidebarCollapsedStorageKey = "codex-web-sidebar-collapsed";
const threadListCollapsedStorageKey = "codex-web-thread-list-collapsed";
const sidebarProjectsCacheKey = (userId: string) => `codex-v2-projects-${userId}`;
const sidebarProjectOrderKey = (userId: string) => `codex-v2-project-order-${userId}`;
const sidebarProjectSelectionKey = (userId: string) => `codex-v2-project-${userId}`;
const sidebarThreadsCacheKey = (userId: string, projectId: string) => `codex-v2-threads-${userId}-${projectId}`;
const sidebarExpandedProjectsKey = (userId: string) => `codex-v2-expanded-projects-${userId}`;
const modelPreferenceStorageKey = (userId: string, projectId: string) => `codex-v2-model-${encodeURIComponent(userId)}-${encodeURIComponent(projectId)}`;
const threadModelPreferenceStorageKey = (userId: string, threadId: string) => `codex-v2-thread-model-${encodeURIComponent(userId)}-${encodeURIComponent(threadId)}`;
const codexFastModeStorageKey = (userId: string) => `codex-v2-codex-fast-mode-${encodeURIComponent(userId)}`;

function resolveServiceTier(enabled: boolean): "fast" | null {
  return enabled ? "fast" : null;
}

function lookupThreadModelProfileId(userId: string, threadId: string, profiles: ModelProfile[]): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const profileId = window.localStorage.getItem(threadModelPreferenceStorageKey(userId, threadId));
  return profiles.some((profile) => profile.id === profileId) ? profileId : null;
}

function applyStoredThreadModelProfile(
  userId: string,
  thread: ThreadSummary,
  profiles: ModelProfile[]
): ThreadSummary {
  const profileId = lookupThreadModelProfileId(userId, thread.id, profiles);
  if (!profileId) {
    return thread;
  }
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) {
    return thread;
  }
  if (thread.configuredModel === profile.model && thread.configuredReasoningEffort === profile.effort) {
    return thread;
  }
  return {
    ...thread,
    configuredModel: profile.model,
    configuredReasoningEffort: profile.effort
  };
}

function storedJson<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function storedSessionJson<T>(key: string, fallback: T): T {
  try {
    const value = window.sessionStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

type ResizeSetter = (value: number) => void;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") {
    return fallback;
  }
  const stored = window.localStorage.getItem(key);
  if (stored === null || stored.trim() === "") return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? clampNumber(value, min, max) : fallback;
}

function storedBoolean(key: string): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(key) === "true";
}

function persistNumber(key: string, value: number): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(key, String(Math.round(value)));
  }
}

function beginHorizontalResize(
  event: ReactMouseEvent<HTMLElement>,
  currentWidth: number,
  setWidth: ResizeSetter,
  storageKey: string,
  minWidth: number,
  maxWidth: number
): void {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = currentWidth;
  const safeMaxWidth = Math.max(minWidth, maxWidth);
  const originalCursor = document.body.style.cursor;
  const originalUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const handleMove = (moveEvent: MouseEvent) => {
    const nextWidth = clampNumber(startWidth + moveEvent.clientX - startX, minWidth, safeMaxWidth);
    setWidth(nextWidth);
    persistNumber(storageKey, nextWidth);
  };
  const handleUp = () => {
    document.body.style.cursor = originalCursor;
    document.body.style.userSelect = originalUserSelect;
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
  };

  window.addEventListener("mousemove", handleMove);
  window.addEventListener("mouseup", handleUp);
}

function beginRightPanelResize(
  event: ReactMouseEvent<HTMLElement>,
  currentWidth: number,
  setWidth: ResizeSetter,
  storageKey: string,
  minWidth: number,
  maxWidth: number
): void {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = currentWidth;
  const originalCursor = document.body.style.cursor;
  const originalUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  const handleMove = (moveEvent: MouseEvent) => {
    const nextWidth = clampNumber(startWidth - (moveEvent.clientX - startX), minWidth, Math.max(minWidth, maxWidth));
    setWidth(nextWidth);
    persistNumber(storageKey, nextWidth);
  };
  const handleUp = () => {
    document.body.style.cursor = originalCursor;
    document.body.style.userSelect = originalUserSelect;
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
  };
  window.addEventListener("mousemove", handleMove);
  window.addEventListener("mouseup", handleUp);
}

function beginVerticalResize(
  event: ReactMouseEvent<HTMLElement>,
  currentHeight: number,
  setHeight: ResizeSetter,
  storageKey: string,
  minHeight: number,
  maxHeight: number
): void {
  event.preventDefault();
  const startY = event.clientY;
  const startHeight = currentHeight;
  const safeMaxHeight = Math.max(minHeight, maxHeight);
  const originalCursor = document.body.style.cursor;
  const originalUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";

  const handleMove = (moveEvent: MouseEvent) => {
    const nextHeight = clampNumber(startHeight - (moveEvent.clientY - startY), minHeight, safeMaxHeight);
    setHeight(nextHeight);
    persistNumber(storageKey, nextHeight);
  };
  const handleUp = () => {
    document.body.style.cursor = originalCursor;
    document.body.style.userSelect = originalUserSelect;
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
  };

  window.addEventListener("mousemove", handleMove);
  window.addEventListener("mouseup", handleUp);
}

export function App() {
  const [colorTheme, setColorTheme] = useState<"dark" | "light">(() => window.localStorage.getItem("codex-web-color-theme") === "light" ? "light" : "dark");
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    document.documentElement.style.colorScheme = colorTheme;
    window.localStorage.setItem("codex-web-color-theme", colorTheme);
  }, [colorTheme]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const conversationVirtualRef = useRef<VirtualConversationHandle | null>(null);
  const toolRevealCleanupRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const temporaryMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const promptNavigationFrameRef = useRef<number | null>(null);
  const promptPreviewSwitchTimerRef = useRef<number | null>(null);
  const lastPromptPreviewRef = useRef<{ item: PromptNavigationItem; index: number; threadId: string | null; userId: string } | null>(null);
  const threadCopyNoticeTimerRef = useRef<number | null>(null);
  const promptMessageElementsRef = useRef(new Map<string, HTMLElement>());
  const messageElementsRef = useRef(new Map<string, HTMLElement>());
  const threadViewCacheRef = useRef(new Map<string, { thread: ThreadSummary; history: ThreadHistoryPage | null }>());
  const threadHistoryRef = useRef<ThreadHistoryPage | null>(null);
  const olderHistoryLoadingRef = useRef(false);
  const olderHistoryNextEligibleAtRef = useRef(0);
  const olderHistoryRearmTopRef = useRef<number | null>(null);
  const olderHistoryRearmPendingRef = useRef(false);
  const autoFollowMessagesRef = useRef(true);
  const manualMessageScrollLockRef = useRef(false);
  const messageScrollDirectionRef = useRef<"up" | "down" | null>(null);
  const messageTouchYRef = useRef<number | null>(null);
  const lastMessageScrollTopRef = useRef(0);
  const searchNavigationLockUntilRef = useRef(0);
  const threadViewTokenRef = useRef(0);
  const initializedProjectIdRef = useRef("");
  const searchProjectNavigationRef = useRef<{ projectId: string; viewToken: number } | null>(null);
  const threadPageCacheRef = useRef(new Map<string, { thread: ThreadSummary; history: ThreadHistoryPage; cachedAt: number }>());
  const activeThreadReconcileRef = useRef(new Set<string>());
  const threadPrefetchesRef = useRef(new Set<string>());
  const promptRequestContextsRef = useRef(new Map<string, PromptRequestContext>());
  const pendingQueuedPromptsRef = useRef(new Map<string, { threadId: string; text: string; uploads: ComposerUpload[] }>());
  const pendingQueueSteersRef = useRef(new Map<string, { threadId: string; entry: QueuedSubmission }>());
  const interruptRequestContextsRef = useRef(new Map<string, TurnInterruptContext>());
  const threadRenameRequestContextsRef = useRef(new Map<string, ThreadRenameRequestContext>());
  const interruptRequestedTurnIdsRef = useRef(new Set<string>());
  const queuedInterruptPromptRequestIdsRef = useRef(new Set<string>());
  const turnThreadIdsRef = useRef(new Map<string, string>());
  const threadProjectIdsRef = useRef(new Map<string, string>());
  const autoSendEnabledRef = useRef(true);
  const autoSentGeneratedFileKeysRef = useRef(new Set<string>());
  const autoSendInFlightFileKeysRef = useRef(new Set<string>());
  const interruptTimeoutsRef = useRef(new Map<string, number>());
  const newThreadDraftModeRef = useRef(true);
  const quotaRefreshInFlightRef = useRef<Promise<QuotaRefreshResult> | null>(null);
  const leaderboardRefreshInFlightRef = useRef<Promise<LeaderboardRefreshResult> | null>(null);
  const trackedQuotaRefreshInFlightRef = useRef<Promise<TrackedQuotaRefreshResult> | null>(null);
  const threadSearchRequestRef = useRef(0);
  const globalSearchRequestRef = useRef(0);
  const threadSearchPanelRequestRef = useRef(0);
  const pendingLiveDeltasRef = useRef(new Map<string, LiveDeltaEntry>());
  const liveDeltaFlushTimerRef = useRef<number | null>(null);
  const liveTimelineSequenceRef = useRef(0);
  const liveTimelineOrderRef = useRef(new Map<string, number>());
  const lastLiveEventAtRef = useRef<Record<string, number>>({});
  const [projects, setProjects] = useState<Project[]>(() => storedJson<Project[]>(sidebarProjectsCacheKey(getApiUserId()), []));
  const [projectOrder, setProjectOrder] = useState<string[]>(() => storedJson<string[]>(sidebarProjectOrderKey(getApiUserId()), []));
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const projectDropTargetRef = useRef<{ id: string; after: boolean } | null>(null);
  const [projectGhostPosition, setProjectGhostPosition] = useState<{ x: number; y: number } | null>(null);
  const projectGhostRef = useRef<HTMLDivElement>(null);
  const projectPointerDragRef = useRef<{ id: string; pointerId: number; x: number; y: number; active: boolean } | null>(null);
  const projectLongPressTimerRef = useRef<number | null>(null);
  const suppressProjectClickRef = useRef(false);
  const projectGroupRectsRef = useRef(new Map<string, DOMRect>());
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState(getApiUserId());
  const orderedProjects = useMemo(() => {
    if (!projectOrder.length) return projects;
    const ranks = new Map(projectOrder.map((id, index) => [id, index]));
    return [...projects].sort((a, b) => (ranks.get(a.id) ?? -1) - (ranks.get(b.id) ?? -1));
  }, [projects, projectOrder]);
  useLayoutEffect(() => {
    const groups = document.querySelectorAll<HTMLElement>(".v2WorkspaceGroup[data-project-id]");
    const next = new Map<string, DOMRect>();
    for (const group of groups) {
      const id = group.dataset.projectId;
      if (!id) continue;
      const rect = group.getBoundingClientRect();
      next.set(id, rect);
      const previous = projectGroupRectsRef.current.get(id);
      const delta = previous ? previous.top - rect.top : 0;
      if (Math.abs(delta) > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        group.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
          duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        });
      }
    }
    projectGroupRectsRef.current = next;
  }, [orderedProjects]);
  const userEffectInitializedRef = useRef(false);
  const [projectRoot, setProjectRoot] = useState("/Volumes/DevDrive/program");
  const [threadContextFeatureEnabled, setThreadContextFeatureEnabled] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => storedNumber(sidebarWidthStorageKey, 280, 220, 640));
  const [threadListWidth, setThreadListWidth] = useState(() => storedNumber(threadListWidthStorageKey, 260, 180, 620));
  const [composerHeight, setComposerHeight] = useState(() => storedNumber(composerHeightStorageKey, 54, 38, 520));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => storedBoolean(sidebarCollapsedStorageKey));
  const [threadListCollapsed, setThreadListCollapsed] = useState(() => storedBoolean(threadListCollapsedStorageKey));
  const [systemDirectoryPickerAvailable, setSystemDirectoryPickerAvailable] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => window.localStorage.getItem(sidebarProjectSelectionKey(getApiUserId())) ?? "");
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>(() => {
    const userId = getApiUserId();
    const stored = window.localStorage.getItem(sidebarExpandedProjectsKey(userId));
    if (stored !== null) return storedJson<string[]>(sidebarExpandedProjectsKey(userId), []);
    const selectedId = window.localStorage.getItem(sidebarProjectSelectionKey(userId)) ?? "";
    return selectedId ? [selectedId] : [];
  });
  const [codexFastModeEnabled, setCodexFastModeEnabled] = useState(() => storedBoolean(codexFastModeStorageKey(getApiUserId())));
  const [threadSearch, setThreadSearch] = useState("");
  const [threadSearchLoading, setThreadSearchLoading] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchResult[]>([]);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchIndexing, setGlobalSearchIndexing] = useState(false);
  const [globalSearchPendingThreads, setGlobalSearchPendingThreads] = useState(0);
  const [globalSearchNextOffset, setGlobalSearchNextOffset] = useState<number | null>(null);
  const [globalSearchPage, setGlobalSearchPage] = useState(0);
  const [globalSearchExpandedThread, setGlobalSearchExpandedThread] = useState<string | null>(null);
  const [globalSearchJumpNotice, setGlobalSearchJumpNotice] = useState<string | null>(null);
  const [threadSearchPanel, setThreadSearchPanel] = useState<ThreadSearchPanel | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>(() => {
    const userId = getApiUserId();
    const projectId = window.localStorage.getItem(sidebarProjectSelectionKey(userId)) ?? "";
    return projectId ? storedJson<ThreadSummary[]>(sidebarThreadsCacheKey(userId, projectId), []).filter((thread) => !isTemporaryAskThread(thread)) : [];
  });
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null);
  const [dragOverThreadId, setDragOverThreadId] = useState<string | null>(null);
  const [dragOverThreadAfter, setDragOverThreadAfter] = useState(false);
  const [threadGhostPosition, setThreadGhostPosition] = useState<{ x: number; y: number } | null>(null);
  const threadGhostRef = useRef<HTMLDivElement>(null);
  const threadPointerDragRef = useRef<{ id: string; pointerId: number; x: number; y: number; active: boolean } | null>(null);
  const threadPointerListenersRef = useRef<{ move: (event: PointerEvent) => void; up: (event: PointerEvent) => void; cancel: (event: PointerEvent) => void; touchMove: (event: TouchEvent) => void; selectStart: (event: Event) => void } | null>(null);
  const threadLongPressTimerRef = useRef<number | null>(null);
  const threadDropTargetRef = useRef<{ id: string; after: boolean } | null>(null);
  const suppressThreadClickRef = useRef(false);
  const threadRowRectsRef = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const rows = document.querySelectorAll<HTMLElement>(".v2WorkspaceGroup.selected .threadRow[data-thread-id]");
    const next = new Map<string, DOMRect>();
    for (const row of rows) {
      const id = row.dataset.threadId;
      if (!id) continue;
      const rect = row.getBoundingClientRect();
      next.set(id, rect);
      const previous = threadRowRectsRef.current.get(id);
      const delta = previous ? previous.top - rect.top : 0;
      if (Math.abs(delta) > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        row.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
          duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        });
      }
    }
    threadRowRectsRef.current = next;
  }, [threads, selectedProjectId]);
  const [savingThreadOrder, setSavingThreadOrder] = useState(false);
  const [selectedThread, setSelectedThread] = useState<ThreadSummary | null>(null);
  const [openingThreadId, setOpeningThreadId] = useState<string | null>(null);
  const [threadHistory, setThreadHistory] = useState<ThreadHistoryPage | null>(null);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [olderHistoryLoadFailed, setOlderHistoryLoadFailed] = useState(false);
  useEffect(() => {
    olderHistoryNextEligibleAtRef.current = 0;
    olderHistoryRearmTopRef.current = null;
    olderHistoryRearmPendingRef.current = false;
    setOlderHistoryLoadFailed(false);
  }, [selectedThread?.id]);
  const [continuationPrompt, setContinuationPrompt] = useState<ContinuationPrompt | null>(null);
  const [prompt, setPrompt] = useState("");
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [directoryBrowser, setDirectoryBrowser] = useState<DirectoryListResponse | null>(null);
  const [directoryBrowserLoading, setDirectoryBrowserLoading] = useState(false);
  const [pendingDeleteProjectId, setPendingDeleteProjectId] = useState<string | null>(null);
  const [renamingProject, setRenamingProject] = useState<Project | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<string | null>(null);
  const [threadContextMenu, setThreadContextMenu] = useState<ThreadContextMenu | null>(null);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [worktreeRepositories, setWorktreeRepositories] = useState<Array<{ rootPath: string; name: string }>>([]);
  const [worktreeRepositoryPath, setWorktreeRepositoryPath] = useState("");
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[] | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [hooksStatus, setHooksStatus] = useState<{ hooks: Array<{ key: string; currentHash: string | null; eventName: string; handlerType: string; source: string; pluginId: string | null; enabled: boolean; isManaged: boolean; trustStatus: string; matcher: string | null; trustable: boolean; command: string | null; userTrusted: boolean }>; warnings: string[]; errors: string[] } | null>(null);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [pendingHookTrustKey, setPendingHookTrustKey] = useState<string | null>(null);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hookEditorOpen, setHookEditorOpen] = useState(false);
  const [hookEventName, setHookEventName] = useState<"SessionStart" | "Stop" | "PreToolUse" | "PostToolUse">("Stop");
  const [hookCommand, setHookCommand] = useState("");
  const [hookMatcher, setHookMatcher] = useState("");
  const [hookSaving, setHookSaving] = useState(false);
  const [terminalProjectId, setTerminalProjectId] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const terminalCloseTimerRef = useRef<number | null>(null);
  const [threadCopyNotice, setThreadCopyNotice] = useState<string | null>(null);
  const [renamingThread, setRenamingThread] = useState<ThreadSummary | null>(null);
  const [threadRenameDraft, setThreadRenameDraft] = useState("");
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [branchingThread, setBranchingThread] = useState(false);
  const branchingThreadRef = useRef(false);
  const [editingLastPrompt, setEditingLastPrompt] = useState(false);
  const editingCommitRef = useRef(false);
  const [editingPromptDraft, setEditingPromptDraft] = useState<EditingPromptDraft | null>(null);
  const [departingTurnId, setDepartingTurnId] = useState<string | null>(null);
  const [lastStoppedTurnForEdit, setLastStoppedTurnForEdit] = useState<{ threadId: string; turnId: string } | null>(null);
  useEffect(() => {
    if (!editingPromptDraft || editingPromptDraft.threadId === selectedThread?.id) return;
    setEditingPromptDraft(null);
    setPrompt("");
    setUploadedFiles([]);
  }, [editingPromptDraft, selectedThread?.id]);
  const [startingNativeReview, setStartingNativeReview] = useState(false);
  const [threadContextStatus, setThreadContextStatus] = useState<ThreadContextStatus | null>(null);
  const [threadContextLoading, setThreadContextLoading] = useState(false);
  const [contextPinDialogOpen, setContextPinDialogOpen] = useState(false);
  const [contextDialogLoading, setContextDialogLoading] = useState(false);
  const contextDialogLoadIdRef = useRef(0);
  const [contextPinDraft, setContextPinDraft] = useState("");
  const [contextConfigDraft, setContextConfigDraft] = useState<ThreadContextConfig>(() => emptyThreadContextConfig());
  const [newThreadContextPin, setNewThreadContextPin] = useState("");
  const [newThreadContextConfig, setNewThreadContextConfig] = useState<ThreadContextConfig>(() => emptyThreadContextConfig());
  const [contextPinSaving, setContextPinSaving] = useState(false);
  const [modelProfiles, setModelProfiles] = useState<ModelProfile[]>(fallbackModelProfiles);
  const [newThreadModelProfileId, setNewThreadModelProfileId] = useState(defaultModelProfileId);
  const [savingThreadModel, setSavingThreadModel] = useState(false);
  const [sandbox, setSandbox] = useState<SandboxMode>("danger-full-access");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>("never");
  const [socketStatus, setSocketStatus] = useState<"connecting" | "open" | "closed">("closed");
  const [liveDeltas, setLiveDeltas] = useState<Record<string, LiveDeltaEntry>>({});
  const [liveTools, setLiveTools] = useState<Record<string, LiveToolEntry>>({});
  const [answeredQuestionItems, setAnsweredQuestionItems] = useState<Record<string, true>>({});
  const submittingQuestionItemsRef = useRef(new Set<string>());
  const [expandedToolBundles, setExpandedToolBundles] = useState<Record<string, true>>({});
  const [expandedToolEntries, setExpandedToolEntries] = useState<Record<string, true>>({});
  const [pendingUserMessages, setPendingUserMessages] = useState<PendingUserMessage[]>([]);
  const [topAnchoredPrompt, setTopAnchoredPrompt] = useState<{ requestId: string; threadId: string | null; turnId: string | null; viewToken: number } | null>(null);
  const [promptBottomHoldNow, setPromptBottomHoldNow] = useState(() => Date.now());
  const [uploadedFiles, setUploadedFiles] = useState<ComposerUpload[]>([]);
  const [exitingUploads, setExitingUploads] = useState<ComposerUpload[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [draggingUpload, setDraggingUpload] = useState(false);
  const [filePreview, setFilePreview] = useState<ProjectFilePreview | null>(null);
  const [runnablePreview, setRunnablePreview] = useState<RunnablePreview | null>(null);
  const [filePreviewObjectUrl, setFilePreviewObjectUrl] = useState<string>("");
  const [imagePreviewMode, setImagePreviewMode] = useState<"fit" | "width" | "actual">("fit");
  const [imageGallery, setImageGallery] = useState<{ projectId: string; targets: string[]; index: number } | null>(null);
  const [imageViewerClosing, setImageViewerClosing] = useState(false);
  const [imageViewerActionsOpen, setImageViewerActionsOpen] = useState(false);
  const [imageViewerReady, setImageViewerReady] = useState(false);
  const [imageViewerError, setImageViewerError] = useState(false);
  const [imageViewerRetry, setImageViewerRetry] = useState(0);
  const [imageViewerZoom, setImageViewerZoom] = useState(1);
  const [imageViewerNaturalSize, setImageViewerNaturalSize] = useState({ width: 0, height: 0 });
  const [imageViewerStageSize, setImageViewerStageSize] = useState({ width: 0, height: 0 });
  const [imageViewerPrevious, setImageViewerPrevious] = useState<{ src: string; width: number; height: number } | null>(null);
  const imageViewerStageRef = useRef<HTMLDivElement>(null);
  const imageViewerCloseTimerRef = useRef<number | null>(null);
  const imageViewerPreviousTimerRef = useRef<number | null>(null);
  const imageViewerPreloadsRef = useRef(new Map<string, HTMLImageElement>());
  const filePreviewRequestIdRef = useRef(0);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [filePreviewError, setFilePreviewError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(() => storedBooleanWithDefault(`codex-web-push:${getApiUserId()}`, false));
  const [pushSaving, setPushSaving] = useState(false);
  const [nativeFeaturesReady, setNativeFeaturesReady] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, { id: string | number; method: string; params: Record<string, unknown> }>>({});
  const approvalResponseRequestsRef = useRef(new Map<string, { id: string | number; method: string; params: Record<string, unknown> }>());
  const [localSendSettings, setLocalSendSettings] = useState<LocalSendSettings>(defaultLocalSendSettings);
  const localSendSettingsRef = useRef<LocalSendSettings>(defaultLocalSendSettings);
  const [detectedClientHost, setDetectedClientHost] = useState("");
  const [autoSendGeneratedFiles, setAutoSendGeneratedFiles] = useState(() =>
    storedBooleanWithDefault(autoSendPreferenceStorageKey(getApiUserId()), false)
  );
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsTesting, setSettingsTesting] = useState(false);
  const [settingsTestStatus, setSettingsTestStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [exportFormat, setExportFormat] = useState<ThreadExportFormat>("markdown");
  const [exportSendLocal, setExportSendLocal] = useState(false);
  const [exportingThread, setExportingThread] = useState(false);
  const [sendingLocalFile, setSendingLocalFile] = useState(false);
  const [sharingBrowserFile, setSharingBrowserFile] = useState(false);
  const [accountPool, setAccountPool] = useState<CodexAccountPool | null>(() => (
    storedJson<CodexAccountPool | null>(accountPoolSnapshotStorageKey, null)
  ));
  const [quota, setQuota] = useState<CodexQuota | null>(() => selectedQuotaFromPool(
    storedJson<CodexAccountPool | null>(accountPoolSnapshotStorageKey, null)
  ));
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [exhaustedAccountNotice, setExhaustedAccountNotice] = useState<ExhaustedAccountSuggestion | null>(null);
  const [dismissedExhaustedThreadId, setDismissedExhaustedThreadId] = useState<string | null>(null);
  const [quotaPopoverOpen, setQuotaPopoverOpen] = useState(false);
  const [quotaPopoverPinned, setQuotaPopoverPinned] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [leaderboard, setLeaderboard] = useState<CodexLeaderboard | null>(() => storedJson<CodexLeaderboard | null>(`codex.v2.leaderboard.${getApiUserId()}`, null));
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [trackedQuotaUsage, setTrackedQuotaUsage] = useState<TrackedQuotaUsage | null>(() => (
    storedJson<TrackedQuotaUsage | null>(trackedQuotaSnapshotStorageKey, null)
  ));
  const [trackedQuotaOpen, setTrackedQuotaOpen] = useState(false);
  const [trackedQuotaLoading, setTrackedQuotaLoading] = useState(false);
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsPickerOpen, setSkillsPickerOpen] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [selectedSkillNames, setSelectedSkillNames] = useState<string[]>([]);
  useEffect(() => {
    const composeGoal = () => setPrompt((current) => current.startsWith("/goal ") ? current : `/goal ${current.trim()}`);
    window.addEventListener("codex:compose-goal", composeGoal);
    return () => window.removeEventListener("codex:compose-goal", composeGoal);
  }, []);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
  const [statusPopoverThreadId, setStatusPopoverThreadId] = useState<string | null>(null);
  const [statusPopoverVisible, setStatusPopoverVisible] = useState(false);
  const [statusPopoverLeft, setStatusPopoverLeft] = useState(0);
  const statusPopoverCloseTimerRef = useRef<number | null>(null);
  const [handledLocationFileTarget, setHandledLocationFileTarget] = useState(false);
  const [activeTurnsByThread, setActiveTurnsByThread] = useState<Record<string, string>>({});
  const activeTurnsByThreadRef = useRef<Record<string, string>>({});
  const [interruptingTurns, setInterruptingTurns] = useState<Record<string, true>>({});
  const [queuedInterruptPrompts, setQueuedInterruptPrompts] = useState<Record<string, true>>({});
  const [queuedSubmissions, setQueuedSubmissions] = useState<QueuedSubmission[]>([]);
  const lastQueuedSubmissionRef = useRef<{ threadId: string; entry: QueuedSubmission } | null>(null);
  const [queuedMenuOpen, setQueuedMenuOpen] = useState(false);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [queuedEditText, setQueuedEditText] = useState("");
  const [liveTurnDiffs, setLiveTurnDiffs] = useState<Record<string, string>>({});
  const [diffReview, setDiffReview] = useState<{ title: string; changes: unknown[]; focusPath?: string; reviewTurnId?: string } | null>(null);
  const [diffPanelVisible, setDiffPanelVisible] = useState(false);
  const [diffPanelResizing, setDiffPanelResizing] = useState(false);
  const [diffPanelWidth, setDiffPanelWidth] = useState(() => storedNumber("codex-web-diff-panel-width", 560, 350, 900));
  const diffPanelCloseTimerRef = useRef<number | null>(null);
  const diffInitialRestoreRef = useRef(new Set<string>());
  const [unreadResultThreads, setUnreadResultThreads] = useState<Record<string, true>>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [activePromptNavigationKey, setActivePromptNavigationKey] = useState<string | null>(null);
  const [hoveredPromptNavigationKey, setHoveredPromptNavigationKey] = useState<string | null>(null);
  const [departingPromptPreview, setDepartingPromptPreview] = useState<{ item: PromptNavigationItem; index: number; threadId: string | null; userId: string } | null>(null);
  const [error, setError] = useState<string>("");
  const [providerFailure, setProviderFailure] = useState<ProviderFailureNotice | null>(null);
  const [providerFailureOpen, setProviderFailureOpen] = useState(false);
  const providerFailurePresence = useExitPresence(providerFailureOpen, 260);
  const [newThreadProjectPickerOpen, setNewThreadProjectPickerOpen] = useState(false);
  const [temporaryAsk, setTemporaryAsk] = useState<TemporaryAsk | null>(null);
  const [temporaryThread, setTemporaryThread] = useState<ThreadSummary | null>(null);
  const [temporaryPrompt, setTemporaryPrompt] = useState("");
  const [temporaryModelProfileId, setTemporaryModelProfileId] = useState(defaultModelProfileId);
  const [temporaryAskWidth, setTemporaryAskWidth] = useState(() => storedNumber("codex-web-temporary-ask-width", 390, 300, 760));
  const [selectionAction, setSelectionAction] = useState<{ text: string; left: number; top: number } | null>(null);
  const [temporaryCloseConfirm, setTemporaryCloseConfirm] = useState(false);
  const [temporaryCloseDontAsk, setTemporaryCloseDontAsk] = useState(() => storedBoolean("codex-web-temporary-close-dont-ask"));
  const accountMenuPresence = useExitPresence(accountMenuOpen);
  const newThreadProjectPickerPresence = useExitPresence(newThreadProjectPickerOpen, 260);
  const archivedPresence = useExitPresence(archivedOpen, 260);
  const worktreePresence = useExitPresence(worktreeOpen, 260);
  const hooksPresence = useExitPresence(hooksOpen, 260);
  const hookEditorPresence = useExitPresence(hookEditorOpen, 260);
  const quotaPopoverPresence = useExitPresence(quotaPopoverOpen);
  const exhaustedAccountNoticeOpen = Boolean(
    selectedThread?.id
    && exhaustedAccountNotice?.threadId === selectedThread.id
    && dismissedExhaustedThreadId !== selectedThread.id
  );
  const exhaustedAccountNoticePresence = useExitPresence(exhaustedAccountNoticeOpen, 440);
  const openingThreadPresence = useExitPresence(Boolean(openingThreadId), 240);
  const queuedSubmissionPresence = useExitPresence(Boolean(selectedThread && queuedSubmissions.length), 260);
  const leaderboardPresence = useExitPresence(leaderboardOpen);
  const trackedQuotaPresence = useExitPresence(trackedQuotaOpen);
  const skillsPickerPresence = useExitPresence(skillsPickerOpen);
  const temporaryClosePresence = useExitPresence(temporaryCloseConfirm);
  const settingsPresence = useExitPresence(settingsOpen);
  const globalSearchPresence = useExitPresence(globalSearchOpen);
  const directoryBrowserPresence = useExitPresence(directoryBrowserOpen);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const draftModelProfile = useMemo(
    () => modelProfileById(newThreadModelProfileId, modelProfiles),
    [newThreadModelProfileId, modelProfiles]
  );
  const activeModelProfileId = useMemo(() => {
    if (!selectedThread) {
      return draftModelProfile.id;
    }
    return modelProfileIdFor(
      selectedThread.configuredModel ?? selectedProject?.defaultModel ?? "gpt-5.5",
      selectedThread.configuredReasoningEffort ?? selectedProject?.defaultReasoningEffort ?? "xhigh",
      modelProfiles
    );
  }, [draftModelProfile.id, modelProfiles, selectedProject, selectedThread]);
  const selectedModelProfile = useMemo(
    () => modelProfileById(activeModelProfileId, modelProfiles),
    [activeModelProfileId, modelProfiles]
  );
  const temporaryModelProfile = useMemo(
    () => modelProfileById(temporaryModelProfileId, modelProfiles),
    [temporaryModelProfileId, modelProfiles]
  );
  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) ?? users[0] ?? null,
    [users, selectedUserId]
  );
  const selectedSkills = useMemo(
    () => selectedSkillNames
      .map((name) => skills.find((skill) => skill.name === name))
      .filter((skill): skill is CodexSkill => Boolean(skill)),
    [selectedSkillNames, skills],
  );
  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    return skills.filter((skill) => {
      const copy = localizedSkill(skill);
      const alias = skill.name === "build-web-data-visualization:data-visualization" ? "Visualize" : "";
      return skill.enabled && `${copy.name} ${copy.description} ${skill.name} ${alias}`.toLowerCase().includes(query);
    }).sort((left, right) => skillSection(left.name).localeCompare(skillSection(right.name), "zh-CN") || localizedSkill(left).name.localeCompare(localizedSkill(right).name, "zh-CN"));
  }, [skillSearch, skills]);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedThreadRef = useRef<ThreadSummary | null>(selectedThread);
  const threadsRef = useRef<ThreadSummary[]>(threads);
  const projectsRef = useRef<Project[]>(projects);
  const notificationLinkHandledRef = useRef(false);
  const temporaryAskRef = useRef<TemporaryAsk | null>(null);
  const temporaryThreadIdsRef = useRef(new Set<string>());
  const pendingUserMessagesRef = useRef<PendingUserMessage[]>(pendingUserMessages);
  const threadLiveRecoveryAtRef = useRef<Record<string, number>>({});

  function markLiveEvent(threadId: string | null | undefined): void {
    if (threadId) {
      lastLiveEventAtRef.current[threadId] = Date.now();
    }
  }

  function liveTimelineSequence(kind: "agent" | "tool", itemId: string, moveToTail = false): number {
    const key = `${kind}:${itemId}`;
    const existing = liveTimelineOrderRef.current.get(key);
    if (existing !== undefined && (!moveToTail || existing === liveTimelineSequenceRef.current)) {
      return existing;
    }
    const sequence = ++liveTimelineSequenceRef.current;
    liveTimelineOrderRef.current.set(key, sequence);
    if (liveTimelineOrderRef.current.size > 4096) {
      const oldestKey = liveTimelineOrderRef.current.keys().next().value;
      if (oldestKey) liveTimelineOrderRef.current.delete(oldestKey);
    }
    return sequence;
  }

  function flushPendingLiveDeltas(): void {
    if (liveDeltaFlushTimerRef.current !== null) {
      window.clearTimeout(liveDeltaFlushTimerRef.current);
      liveDeltaFlushTimerRef.current = null;
    }
    if (pendingLiveDeltasRef.current.size === 0) {
      return;
    }
    const pending = pendingLiveDeltasRef.current;
    pendingLiveDeltasRef.current = new Map();
    setLiveDeltas((current) => {
      const next = { ...current };
      for (const [itemId, entry] of pending) {
        const existing = next[itemId];
        next[itemId] = {
          threadId: entry.threadId ?? existing?.threadId ?? null,
          turnId: entry.turnId ?? existing?.turnId ?? null,
          text: `${existing?.text ?? ""}${entry.text}`,
          startedAt: existing?.startedAt ?? entry.startedAt
        };
      }
      return next;
    });
  }

  function enqueueLiveDelta(itemId: string, entry: LiveDeltaEntry): void {
    // Codex may resume the same agent item after one or more tool calls. Its
    // next delta is a new timeline segment and must follow those tools instead
    // of retaining the item's original position near the start of the turn.
    liveTimelineSequence("agent", itemId, true);
    const existing = pendingLiveDeltasRef.current.get(itemId);
    pendingLiveDeltasRef.current.set(itemId, {
      threadId: entry.threadId ?? existing?.threadId ?? null,
      turnId: entry.turnId ?? existing?.turnId ?? null,
      text: `${existing?.text ?? ""}${entry.text}`,
      startedAt: existing?.startedAt ?? entry.startedAt
    });
    if (liveDeltaFlushTimerRef.current === null) {
      liveDeltaFlushTimerRef.current = window.setTimeout(flushPendingLiveDeltas, 24);
    }
  }

  function performCloseTemporaryAsk() {
    const current = temporaryAskRef.current;
    temporaryAskRef.current = null;
    setTemporaryAsk(null);
    setTemporaryThread(null);
    setTemporaryPrompt("");
    setSelectionAction(null);
    if (!current?.threadId) return;
    setLiveDeltas((items) => Object.fromEntries(Object.entries(items).filter(([, item]) => item.threadId !== current.threadId)));
    setLiveTools((items) => Object.fromEntries(Object.entries(items).filter(([, item]) => item.threadId !== current.threadId)));
    setActiveTurnsByThread((items) => {
      const next = { ...items };
      delete next[current.threadId!];
      return next;
    });
    void deleteThread(current.projectId, current.threadId)
      .then(() => {
        temporaryThreadIdsRef.current.delete(current.threadId!);
        return refreshThreads(current.projectId);
      })
      .catch((caught) => setError(`删除临时对话失败：${caught instanceof Error ? caught.message : String(caught)}`));
  }

  function closeTemporaryAsk() {
    if (temporaryCloseDontAsk) {
      performCloseTemporaryAsk();
      return;
    }
    setTemporaryCloseConfirm(true);
  }

  function confirmCloseTemporaryAsk() {
    if (temporaryCloseDontAsk) {
      window.localStorage.setItem("codex-web-temporary-close-dont-ask", "true");
    }
    setTemporaryCloseConfirm(false);
    performCloseTemporaryAsk();
  }

  function openTemporaryAsk(text: string, left: number, top: number) {
    if (!selectedProject || !text.trim()) return;
    if (temporaryAskRef.current) {
      setSelectionAction(null);
      return;
    }
    const requestId = `temp-${requestToken()}`;
    const next: TemporaryAsk = {
      requestId,
      projectId: selectedProject.id,
      threadId: null,
      selectedText: text.trim(),
      prompt: "",
      prompts: [],
      turnId: null,
      status: "ready",
    };
    temporaryAskRef.current = next;
    setTemporaryAsk(next);
    setTemporaryThread(null);
    setTemporaryPrompt("");
    setTemporaryModelProfileId(activeModelProfileId);
    setSelectionAction(null);
  }

  function sendTemporaryPrompt() {
    const current = temporaryAskRef.current;
    const text = temporaryPrompt.trim();
    if (!current || !text || current.status === "starting" || current.status === "running") return;
    const requestId = `temp-${requestToken()}`;
    const next = {
      ...current,
      requestId,
      prompt: text,
      prompts: [...current.prompts, { requestId, turnId: null, text, createdAt: Date.now() }],
      status: "starting" as const
    };
    temporaryAskRef.current = next;
    setTemporaryAsk(next);
    setTemporaryPrompt("");
    try {
      codexSocket.send(current.threadId ? {
        type: "turn.start",
        requestId,
        userId: selectedUserId,
        projectId: current.projectId,
        threadId: current.threadId,
        prompt: text,
        model: temporaryModelProfile.model,
        reasoningEffort: temporaryModelProfile.effort,
        serviceTier: resolveServiceTier(codexFastModeEnabled),
        sandbox,
        approvalPolicy,
      } : {
        type: "thread.start",
        requestId,
        userId: selectedUserId,
        projectId: current.projectId,
        prompt: `请基于下面选中的文字回答问题。\n\n选中文字：\n${current.selectedText}\n\n用户问题：\n${text}`,
        model: temporaryModelProfile.model,
        reasoningEffort: temporaryModelProfile.effort,
        serviceTier: resolveServiceTier(codexFastModeEnabled),
        sandbox,
        approvalPolicy,
      });
    } catch (caught) {
      const failed = { ...next, status: "error" as const };
      temporaryAskRef.current = failed;
      setTemporaryAsk(failed);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function promoteTemporaryTurn(threadId: string, projectId: string, turnId: string | null): Promise<void> {
    const retryDelays = [0, 160, 320, 640, 1_000, 1_600, 2_400];
    for (const delay of retryDelays) {
      if (delay > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      }
      const current = temporaryAskRef.current;
      if (!current || current.threadId !== threadId) return;
      try {
        const response = await readThread(threadId, projectId, { before: 0, limit: 128, fresh: true });
        if (temporaryAskRef.current?.threadId !== threadId) return;
        const persistedThread = sanitizeThreadForRender(response.thread);
        setTemporaryThread((currentThread) => (
          currentThread?.id === persistedThread.id
            ? sanitizeThreadForRender(mergeThreadHistoryPages(currentThread, persistedThread))
            : persistedThread
        ));
        if (!turnId || hasPersistedCompletedTurn(persistedThread, turnId)) {
          setLiveDeltas((items) => Object.fromEntries(Object.entries(items).filter(([, item]) => (
            item.threadId !== threadId || (turnId !== null && item.turnId !== turnId)
          ))));
          setLiveTools((items) => Object.fromEntries(Object.entries(items).filter(([, item]) => (
            item.threadId !== threadId || (turnId !== null && item.turnId !== turnId)
          ))));
          return;
        }
      } catch {
        // Persistence can trail the completion notification briefly. Keep the
        // live copy visible and retry instead of flashing an empty answer.
      }
    }
  }

  useEffect(() => {
    const updateSelectionAction = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const commonAncestor = range?.commonAncestorContainer;
      const ancestorElement = commonAncestor instanceof Element ? commonAncestor : commonAncestor?.parentElement;
      if (ancestorElement?.closest(".composer, .temporaryAskPanel, .globalSearchDialog") || !text || text.length > 6000 || selection?.isCollapsed) {
        setSelectionAction(null);
        return;
      }
      const rect = range?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      setSelectionAction({
        text,
        left: Math.min(Math.max(rect.left + rect.width / 2 - 78, 12), window.innerWidth - 190),
        top: Math.min(rect.bottom + 8, window.innerHeight - 54),
      });
    };
    const handleSelectionChange = () => window.requestAnimationFrame(updateSelectionAction);
    const handleMouseUp = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest(".selectionAskButton")) return;
      window.setTimeout(updateSelectionAction, 0);
    };
    document.addEventListener("selectionchange", handleSelectionChange, true);
    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("pointerup", handleMouseUp, true);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange, true);
      document.removeEventListener("mouseup", handleMouseUp, true);
      document.removeEventListener("pointerup", handleMouseUp, true);
    };
  }, []);

  function updateMessageScrollState() {
    const element = messagesRef.current;
    if (!element) {
      return;
    }
    const currentScrollTop = element.scrollTop;
    lastMessageScrollTopRef.current = currentScrollTop;
    // The conversation is vertical-only. Some WebKit/Safari trackpad gestures can
    // leave a scrollable message container with a non-zero horizontal offset when
    // a long path/image exists; visually this looks like a huge blank white block.
    // Force it back so history content never slides out of view horizontally.
    if (element.scrollLeft !== 0) {
      element.scrollLeft = 0;
    }
    // Safari/WebKit can occasionally leave a composited scroll layer blank while
    if (Date.now() < searchNavigationLockUntilRef.current) {
      manualMessageScrollLockRef.current = true;
      autoFollowMessagesRef.current = false;
      setShowScrollToBottom(true);
      schedulePromptNavigationActiveUpdate();
      return;
    }
    const bottomGap = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = bottomGap < 96;
    // A resize/prepend can also increase scrollTop. Resume following only on
    // an actual downward gesture or the bottom button, never from this event.
    if (bottomGap < 2 && messageScrollDirectionRef.current === "down"
      && !olderHistoryLoadingRef.current && !olderHistoryRearmPendingRef.current) {
      manualMessageScrollLockRef.current = false;
    }
    // Content growth (including the composer's live bottom clearance) can make
    // the measured gap temporarily large without the reader scrolling up.
    // Resize/virtualization can move scrollTop upward without user input. Only
    // explicit upward gestures may pause following a streaming answer.
    const shouldFollow = !manualMessageScrollLockRef.current && (nearBottom || autoFollowMessagesRef.current);
    autoFollowMessagesRef.current = shouldFollow;
    setShowScrollToBottom(!shouldFollow);
    schedulePromptNavigationActiveUpdate();
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
    stopToolReveal();
    stopSearchScroll();
    messageScrollDirectionRef.current = null;
    searchNavigationLockUntilRef.current = 0;
    manualMessageScrollLockRef.current = false;
    autoFollowMessagesRef.current = true;
    setShowScrollToBottom(false);
    if (conversationVirtualRef.current) {
      conversationVirtualRef.current.scrollToEnd(behavior === "smooth" ? "smooth" : "auto");
      return;
    }
    const element = messagesRef.current;
    if (element) {
      if (element.scrollLeft !== 0) {
        element.scrollLeft = 0;
      }
      element.scrollTo({ top: element.scrollHeight, left: 0, behavior });
      window.requestAnimationFrame(() => {
        if (element.scrollLeft !== 0) {
          element.scrollLeft = 0;
        }
      });
    } else {
      messagesEndRef.current?.scrollIntoView({ block: "end", inline: "nearest", behavior });
    }
    schedulePromptNavigationActiveUpdate();
  }

  function stopToolReveal() {
    toolRevealCleanupRef.current?.();
    toolRevealCleanupRef.current = null;
  }

  function revealExpandedTool(element: HTMLElement) {
    stopToolReveal();
    stopSearchScroll();
    conversationVirtualRef.current?.cancelScroll();
    messageScrollDirectionRef.current = null;
    const container = messagesRef.current;
    if (!container) return;
    const align = () => {
      if (!element.isConnected) return;
      const viewport = container.getBoundingClientRect();
      const top = viewport.top + 10;
      const bottom = Math.min(viewport.bottom, composerRef.current?.getBoundingClientRect().top ?? viewport.bottom) - 56;
      const bounds = element.getBoundingClientRect();
      const visibleHeight = Math.max(40, bottom - top);
      // While it fits, normal bottom-following already reveals the tool. Once
      // taller than the viewport, tool-top alignment takes exclusive ownership.
      if (bounds.height <= visibleHeight && autoFollowMessagesRef.current) return;
      const delta = bounds.height > visibleHeight
        ? bounds.top - top
        : Math.max(0, bounds.bottom - bottom);
      if (Math.abs(delta) > 1) {
        manualMessageScrollLockRef.current = true;
        autoFollowMessagesRef.current = false;
        setShowScrollToBottom(true);
        container.scrollTop += delta;
      }
    };
    const observer = new ResizeObserver(align);
    observer.observe(element);
    const frame = window.requestAnimationFrame(align);
    const timer = window.setTimeout(() => {
      align();
      stopToolReveal();
    }, 440);
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    inputs.forEach(type => container.addEventListener(type, stopToolReveal, true));
    toolRevealCleanupRef.current = () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      inputs.forEach(type => container.removeEventListener(type, stopToolReveal, true));
    };
  }

  useLayoutEffect(() => {
    const composer = composerRef.current;
    const conversation = composer?.parentElement;
    if (!composer || !conversation) return;
    const messages = messagesRef.current;
    let previousHeight = 0;
    const updateHeight = () => {
      const height = composer.getBoundingClientRect().height;
      conversation.style.setProperty("--composer-height", `${height}px`);
      if (Math.abs(height - previousHeight) < 1) return;
      previousHeight = height;
      if (autoFollowMessagesRef.current && !manualMessageScrollLockRef.current) {
        conversationVirtualRef.current?.scrollToEnd("auto");
      }
    };
    const observer = new ResizeObserver(updateHeight);
    observer.observe(composer);
    const updateMessagesHeight = () => {
      if (messages) conversation.style.setProperty("--messages-viewport-height", `${messages.clientHeight}px`);
    };
    const messagesObserver = messages ? new ResizeObserver(updateMessagesHeight) : null;
    if (messages) messagesObserver?.observe(messages);
    updateHeight();
    updateMessagesHeight();
    return () => {
      observer.disconnect();
      messagesObserver?.disconnect();
      conversation.style.removeProperty("--composer-height");
      conversation.style.removeProperty("--messages-viewport-height");
    };
  }, []);

  useLayoutEffect(() => {
    const sidebar = document.querySelector<HTMLElement>(".threadList");
    const tree = sidebar?.querySelector<HTMLElement>(".v2WorkspaceTree");
    if (!sidebar || !tree) return;
    // scrollbar-gutter: stable reserves a different width in each browser.
    const alignActions = () => {
      sidebar.style.setProperty("--workspace-action-gutter", `${Math.max(0, tree.offsetWidth - tree.clientWidth)}px`);
      if (!window.matchMedia("(max-width: 720px)").matches) return;
      const alignIcon = (variable: string, targetSelector: string, controlSelector: string) => {
        const target = tree.querySelector<SVGElement>(targetSelector)?.getBoundingClientRect();
        const control = sidebar.querySelector<SVGElement>(controlSelector)?.getBoundingClientRect();
        if (!target || !control) return;
        const delta = target.left + target.width / 2 - control.left - control.width / 2;
        if (Math.abs(delta) < 0.25) return;
        const current = Number.parseFloat(sidebar.style.getPropertyValue(variable)) || 0;
        sidebar.style.setProperty(variable, `${current + delta}px`);
      };
      alignIcon("--workspace-mobile-theme-shift", ".projectRenameButton svg", ".v2ThemeToggle svg");
      alignIcon("--workspace-mobile-toggle-shift", ".projectDeleteButton svg", ".v2SidebarToggle svg");
      alignIcon("--workspace-mobile-header-shift", ".projectRenameButton svg", ".v2SidebarSearchButton svg");
    };
    const observer = new ResizeObserver(alignActions);
    observer.observe(tree);
    alignActions();
    return () => {
      observer.disconnect();
      sidebar.style.removeProperty("--workspace-action-gutter");
      sidebar.style.removeProperty("--workspace-mobile-theme-shift");
      sidebar.style.removeProperty("--workspace-mobile-toggle-shift");
      sidebar.style.removeProperty("--workspace-mobile-header-shift");
    };
  }, [projects.length]);

  useLayoutEffect(() => {
    const content = messagesRef.current?.querySelector<HTMLElement>(".virtualConversationFlow, .virtualConversationSizer");
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (!autoFollowMessagesRef.current || manualMessageScrollLockRef.current) return;
      conversationVirtualRef.current?.scrollToEnd("auto");
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [selectedThread?.id]);

  const setPromptMessageElement = useCallback((key: string, element: HTMLElement | null) => {
    if (element) {
      promptMessageElementsRef.current.set(key, element);
    } else {
      promptMessageElementsRef.current.delete(key);
    }
  }, []);

  const messageElementKey = useCallback((threadId: string, turnId: string, itemId: string) => `${threadId}:${turnId}:${itemId}`, []);

  const setMessageElement = useCallback((key: string, element: HTMLElement | null) => {
    if (element) {
      messageElementsRef.current.set(key, element);
    } else {
      messageElementsRef.current.delete(key);
    }
  }, []);

  const globalSearchJumpNoticeTimerRef = useRef<number | null>(null);
  const searchScrollFrameRef = useRef<number | null>(null);

  function stopSearchScroll() {
    if (searchScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(searchScrollFrameRef.current);
      searchScrollFrameRef.current = null;
    }
  }

  function animateSearchScroll(container: HTMLElement, target: HTMLElement) {
    stopToolReveal();
    conversationVirtualRef.current?.cancelScroll();
    stopSearchScroll();
    const targetTop = () => container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 28;
    const startTop = container.scrollTop;
    const distance = Math.abs(targetTop() - startTop);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || distance < 3) {
      container.scrollTop = Math.max(0, targetTop());
      return;
    }
    const duration = Math.min(560, Math.max(280, 250 + distance * .16));
    const startedAt = performance.now();
    const step = (now: number) => {
      if (!target.isConnected || !container.isConnected) { stopSearchScroll(); return; }
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      const destination = targetTop();
      container.scrollTop = Math.max(0, startTop + (destination - startTop) * eased);
      if (progress < 1) searchScrollFrameRef.current = window.requestAnimationFrame(step);
      else { container.scrollTop = Math.max(0, targetTop()); searchScrollFrameRef.current = null; }
    };
    searchScrollFrameRef.current = window.requestAnimationFrame(step);
  }

  function searchWindowCursor(threadId: string, ordinal: number): string {
    return btoa(JSON.stringify({ v: 1, t: threadId, o: ordinal + 72 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function clearSearchHighlights() {
    (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete("thread-search-match");
  }

  function highlightSearchText(element: HTMLElement, query: string) {
    clearSearchHighlights();
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!registry || !HighlightConstructor || !query) return;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const content = node.textContent ?? "";
      const folded = content.toLocaleLowerCase();
      let offset = 0;
      while (ranges.length < 100) {
        const at = folded.indexOf(query.toLocaleLowerCase(), offset);
        if (at < 0) break;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, Math.min(content.length, at + query.length));
        ranges.push(range);
        offset = at + Math.max(1, query.length);
      }
    }
    if (ranges.length) registry.set("thread-search-match", new HighlightConstructor(...ranges));
  }

  function setGlobalSearchJumpNoticeWithFade(message: string | null) {
    setGlobalSearchJumpNotice(message);
    if (globalSearchJumpNoticeTimerRef.current !== null) {
      window.clearTimeout(globalSearchJumpNoticeTimerRef.current);
      globalSearchJumpNoticeTimerRef.current = null;
    }
    if (message) {
      globalSearchJumpNoticeTimerRef.current = window.setTimeout(() => {
        setGlobalSearchJumpNotice(null);
      }, 1600);
    }
  }

  async function revealGlobalSearchMatch(match: GlobalSearchMatch | null) {
    if (!match) return false;
    const viewToken = threadViewTokenRef.current;
    const isCurrent = () => viewToken === threadViewTokenRef.current && selectedThreadRef.current?.id === match.threadId;
    let selected = selectedThreadRef.current;
    if (!selected || !isCurrent()) return false;
    const resolved = match.itemId ? match : findSearchMatchInThread(selected, match.query, match.projectId);
    if (!resolved?.itemId) return false;
    let turnId = exactSearchTurn(selected, resolved.itemId);
    if (!turnId) {
      try {
        const position = await locateThreadItem(match.threadId, resolved.itemId, match.projectId);
        if (!isCurrent()) return false;
        await openThread(match.threadId, match.projectId, viewToken, { cursor: searchWindowCursor(match.threadId, position.data.ordinal), skipCache: true });
        if (!isCurrent()) return false;
        selected = selectedThreadRef.current!;
        turnId = exactSearchTurn(selected, resolved.itemId);
      } catch { return false; }
    }
    if (!turnId) return false;
    const key = messageElementKey(match.threadId, turnId, resolved.itemId);
    const targetTurnId = turnId;
    searchNavigationLockUntilRef.current = Date.now() + 5_000;
    manualMessageScrollLockRef.current = true;
    autoFollowMessagesRef.current = false;
    setShowScrollToBottom(true);
    const target = await waitForSearchTarget({
      getTarget: () => messageElementsRef.current.get(key),
      scrollToTurn: () => { conversationVirtualRef.current?.scrollToKey(`turn:${targetTurnId}`, "start"); },
      isCurrent,
      nextFrame: () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
    });
    const container = messagesRef.current;
    if (!target || !container || !isCurrent()) return false;
    window.requestAnimationFrame(() => {
      if (isCurrent() && target.isConnected) animateSearchScroll(container, target);
    });
    highlightSearchText(container, resolved.query);
    return true;
  }

  async function navigateThreadSearchHit(hit: GlobalSearchMatch, index: number) {
    if (selectedThreadRef.current?.id !== hit.threadId) return;
    const viewToken = threadViewTokenRef.current;
    setThreadSearchPanel(current => current?.threadId === hit.threadId ? { ...current, index, selectedItemId: hit.itemId } : current);
    if (typeof hit.ordinal === "number" && !exactSearchTurn(selectedThreadRef.current, hit.itemId ?? "")) {
      await openThread(hit.threadId, hit.projectId, viewToken, { cursor: searchWindowCursor(hit.threadId, hit.ordinal), skipCache: true });
    }
    if (viewToken !== threadViewTokenRef.current) return;
    const found = await revealGlobalSearchMatch(hit);
    if (!found) setGlobalSearchJumpNoticeWithFade("暂时无法定位这条消息，请重试搜索。");
  }

  async function closeThreadSearchPanel() {
    const panel = threadSearchPanel;
    stopSearchScroll();
    setThreadSearchPanel(null);
    clearSearchHighlights();
    if (panel && selectedThreadRef.current?.id === panel.threadId) {
      // A search window is not a continuous history page. Never merge its
      // partial turns into the normal latest-page view on exit.
      selectedThreadRef.current = null;
      threadHistoryRef.current = null;
      await openThread(panel.threadId, panel.projectId, threadViewTokenRef.current, { skipCache: true, requireFresh: true });
      manualMessageScrollLockRef.current = false;
      autoFollowMessagesRef.current = true;
      setShowScrollToBottom(false);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => conversationVirtualRef.current?.scrollToEnd("auto")));
    }
  }

  function updatePromptNavigationActive() {
    const container = messagesRef.current;
    if (!container || promptNavigationItems.length === 0) {
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    let nextKey = promptNavigationItems[0]?.key ?? null;
    for (const navigationItem of promptNavigationItems) {
      const target = promptMessageElementsRef.current.get(navigationItem.key);
      if (!target) {
        continue;
      }
      if (target.getBoundingClientRect().top - containerTop <= 72) {
        nextKey = navigationItem.key;
      } else {
        break;
      }
    }
    if (nextKey) {
      setActivePromptNavigationKey((current) => current === nextKey ? current : nextKey);
    }
  }

  function schedulePromptNavigationActiveUpdate() {
    if (promptNavigationFrameRef.current !== null) {
      return;
    }
    promptNavigationFrameRef.current = window.requestAnimationFrame(() => {
      promptNavigationFrameRef.current = null;
      updatePromptNavigationActive();
    });
  }

  function scrollToPromptNavigationItem(key: string) {
    const container = messagesRef.current;
    const target = promptMessageElementsRef.current.get(key);
    if (!container || !target) {
      return;
    }
    stopToolReveal();
    stopSearchScroll();
    conversationVirtualRef.current?.cancelScroll();
    searchNavigationLockUntilRef.current = Date.now() + 5_000;
    manualMessageScrollLockRef.current = true;
    autoFollowMessagesRef.current = false;
    setShowScrollToBottom(true);
    const targetTop = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, targetTop - 18), left: 0, behavior: "auto" });
    setActivePromptNavigationKey(key);
  }

  function resetToNewThread(clearPrompt = false) {
    try { window.sessionStorage.removeItem(`codex-web-active-diff:${selectedUserId}`); } catch { /* Storage can be disabled. */ }
    threadViewTokenRef.current += 1;
    newThreadDraftModeRef.current = true;
    selectedThreadRef.current = null;
    autoFollowMessagesRef.current = true;
    messageElementsRef.current.clear();
    stopSearchScroll();
    setSelectedThread(null);
    setThreadSearchPanel(null);
    clearSearchHighlights();
    setOpeningThreadId(null);
    setDiffReview(null);
    setDiffPanelVisible(false);
    setTopAnchoredPrompt(null);
    setThreadHistory(null);
    setLoadingOlderHistory(false);
    setContinuationPrompt(null);
    setLocalMessages([]);
    setUploadedFiles([]);
    setDraggingUpload(false);
    setError("");
    if (clearPrompt) {
      setPrompt("");
    }
    window.setTimeout(() => scrollMessagesToBottom("auto"), 0);
  }

  function startNewThreadInProject(projectId: string) {
    if (!projects.some((project) => project.id === projectId)) return;
    setNewThreadProjectPickerOpen(false);
    activateWorkspaceProject(projectId);
    resetToNewThread(true);
  }

  function clearThreadResult(threadId: string) {
    setUnreadResultThreads((current) => {
      if (!current[threadId]) {
        return current;
      }
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }

  function applyThreadListName(thread: ThreadSummary): ThreadSummary {
    const listedThread = threadsRef.current.find((entry) => entry.id === thread.id);
    return listedThread?.name && listedThread.name !== thread.name
      ? { ...thread, name: listedThread.name }
      : thread;
  }

  function activateWorkspaceProject(projectId: string) {
    if (selectedProjectIdRef.current === projectId) return;
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
  }

  function toggleWorkspaceProject(projectId: string) {
    setPendingDeleteProjectId(null);
    setExpandedProjectIds((current) => {
      const next = current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId];
      window.localStorage.setItem(sidebarExpandedProjectsKey(selectedUserId), JSON.stringify(next));
      return next;
    });
  }

  function finishProjectDrag() {
    if (projectLongPressTimerRef.current !== null) {
      window.clearTimeout(projectLongPressTimerRef.current);
      projectLongPressTimerRef.current = null;
    }
    const drag = projectPointerDragRef.current;
    const drop = projectDropTargetRef.current;
    projectPointerDragRef.current = null;
    projectDropTargetRef.current = null;
    setDraggingProjectId(null);
    setProjectDropTarget(null);
    setProjectGhostPosition(null);
    if (!drag?.active || !drop || drag.id === drop.id) return;
    const ids = orderedProjects.map((project) => project.id);
    const from = ids.indexOf(drag.id);
    if (from < 0) return;
    ids.splice(from, 1);
    const target = ids.indexOf(drop.id);
    if (target < 0) return;
    ids.splice(target + Number(drop.after), 0, drag.id);
    if (ids.every((id, index) => id === orderedProjects[index]?.id)) return;
    setProjectOrder(ids);
    window.localStorage.setItem(sidebarProjectOrderKey(selectedUserId), JSON.stringify(ids));
  }

  function moveProjectDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = projectPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 8) {
        if (projectLongPressTimerRef.current !== null) window.clearTimeout(projectLongPressTimerRef.current);
        projectLongPressTimerRef.current = null;
        projectPointerDragRef.current = null;
        suppressProjectClickRef.current = true;
      }
      return;
    }
    if (projectGhostRef.current) {
      projectGhostRef.current.style.transform = `translate3d(${event.clientX + 12}px, ${event.clientY + 12}px, 0)`;
    }
    const group = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".v2WorkspaceGroup[data-project-id]");
    const id = group?.dataset.projectId;
    if (!id || id === drag.id) {
      projectDropTargetRef.current = null;
      setProjectDropTarget(null);
      return;
    }
    const row = group.querySelector(".v2WorkspaceFolderButton");
    if (!row) return;
    const bounds = row.getBoundingClientRect();
    const after = event.clientY > bounds.top + bounds.height / 2;
    projectDropTargetRef.current = { id, after };
    setProjectDropTarget((current) => current?.id === id && current.after === after ? current : { id, after });
  }

  function selectThread(threadId: string, projectId = selectedProjectIdRef.current) {
    olderHistoryLoadingRef.current = false;
    olderHistoryRearmPendingRef.current = false;
    olderHistoryRearmTopRef.current = null;
    olderHistoryNextEligibleAtRef.current = 0;
    if (window.matchMedia("(max-width: 720px)").matches) {
      setThreadListCollapsed(true);
      window.localStorage.setItem(threadListCollapsedStorageKey, "true");
    }
    setDismissedExhaustedThreadId(null);
    try {
      const active = storedSessionJson<{ threadId: string } | null>(`codex-web-active-diff:${selectedUserId}`, null);
      if (active?.threadId !== threadId) window.sessionStorage.removeItem(`codex-web-active-diff:${selectedUserId}`);
    } catch { /* Storage can be disabled. */ }
    const viewToken = ++threadViewTokenRef.current;
    if (projectId) {
      if (initializedProjectIdRef.current !== projectId) {
        searchProjectNavigationRef.current = { projectId, viewToken };
      }
      activateWorkspaceProject(projectId);
    }
    try {
      codexSocket.send({ type: "live.state", requestId: `live-${requestToken()}` });
    } catch {
      // Reconnection requests the authoritative live snapshot again.
    }
    newThreadDraftModeRef.current = false;
    if (projectId) {
      threadProjectIdsRef.current.set(threadId, projectId);
    }
    setThreadContextMenu(null);
    setDiffReview(null);
    setDiffPanelVisible(false);
    setError("");
    const cachedView = projectId ? threadViewCacheRef.current.get(`${projectId}:${threadId}`) : undefined;
    const cachedHistory = cachedView?.history;
    const cachedViewIsUsable = Boolean(
      cachedView
      && cachedHistory
      && cachedHistory.totalItems > 0
      && (!cachedHistory.hasOlder || Boolean(cachedHistory.nextCursor || cachedHistory.nextBefore > 0))
    );
    if (cachedView && !cachedViewIsUsable) {
      threadViewCacheRef.current.delete(`${projectId}:${threadId}`);
    }
    if (cachedView && cachedHistory && cachedViewIsUsable) {
      setOpeningThreadId(null);
      const nextThread = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, applyThreadListName(cachedView.thread), modelProfiles));
      selectedThreadRef.current = nextThread;
      setSelectedThread(nextThread);
      threadHistoryRef.current = cachedHistory;
      setThreadHistory(cachedHistory);
    } else {
      setOpeningThreadId(threadId);
      selectedThreadRef.current = null;
      setSelectedThread(null);
      threadHistoryRef.current = null;
      setThreadHistory(null);
    }
    setLoadingOlderHistory(false);
    setContinuationPrompt(null);
    clearThreadResult(threadId);
    void openThread(threadId, projectId, viewToken);
  }

  useEffect(() => {
    if (notificationLinkHandledRef.current || !projects.length) return;
    const params = new URLSearchParams(window.location.search);
    const threadId = params.get("thread");
    const projectId = params.get("project");
    if (!threadId || !projectId) return;
    notificationLinkHandledRef.current = true;
    params.delete("thread");
    params.delete("project");
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`);
    if (projects.some((project) => project.id === projectId)) selectThread(threadId, projectId);
  }, [projects]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; threadId?: string; projectId?: string } | null;
      if (data?.type !== "codex.openThread" || !data.threadId || !data.projectId) return;
      if (projectsRef.current.some((project) => project.id === data.projectId)) selectThread(data.threadId, data.projectId);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [selectedUserId]);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    let cancelled = false;
    void navigator.serviceWorker.getRegistration("/").then(async (registration) => {
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription || cancelled) return;
      const enabledForCurrentUser = storedBooleanWithDefault(`codex-web-push:${selectedUserId}`, false);
      if (enabledForCurrentUser && Notification.permission === "granted") {
        await savePushSubscription(subscription.toJSON());
      } else {
        await subscription.unsubscribe();
      }
    }).catch(() => { /* Notifications are optional; never block chat startup. */ });
    return () => { cancelled = true; };
  }, [selectedUserId]);

  useEffect(() => {
    let cancelled = false;
    void getPushPublicKey().then((response) => { if (!cancelled) setNativeFeaturesReady(Boolean(response.data?.publicKey)); }).catch(() => {
      if (!cancelled) setNativeFeaturesReady(false);
    });
    return () => { cancelled = true; };
  }, [selectedUserId]);

  function prefetchThread(threadId: string, projectId = selectedProjectIdRef.current) {
    if (!projectId || !threadId) {
      return;
    }
    const cacheKey = `${projectId}:${threadId}`;
    const cached = threadPageCacheRef.current.get(cacheKey);
    if ((cached && Date.now() - cached.cachedAt < 30_000) || threadPrefetchesRef.current.has(cacheKey)) {
      return;
    }
    threadPrefetchesRef.current.add(cacheKey);
    void readThread(threadId, projectId, { before: 0, limit: 128 })
      .then((response) => {
        if (!response.history) {
          return;
        }
        const nextThread = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, response.thread, modelProfiles));
        threadPageCacheRef.current.set(cacheKey, { thread: nextThread, history: response.history, cachedAt: Date.now() });
      })
      .catch(() => undefined)
      .finally(() => {
        threadPrefetchesRef.current.delete(cacheKey);
      });
  }

  async function removeThread(thread: ThreadSummary) {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) {
      return;
    }
    try {
      setError("");
      await deleteThread(projectId, thread.id);
      setPendingDeleteThreadId(null);
      setThreads((current) => current.filter((entry) => entry.id !== thread.id));
      threadsRef.current = threadsRef.current.filter((entry) => entry.id !== thread.id);
      clearThreadResult(thread.id);
      window.localStorage.removeItem(threadModelPreferenceStorageKey(selectedUserId, thread.id));
      if (selectedThreadRef.current?.id === thread.id) {
        resetToNewThread(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function requestRemoveThread(thread: ThreadSummary) {
    if (pendingDeleteThreadId !== thread.id) {
      setPendingDeleteThreadId(thread.id);
      return;
    }
    void removeThread(thread);
  }

  function openThreadContextMenu(event: ReactMouseEvent<HTMLDivElement>, thread: ThreadSummary) {
    event.preventDefault();
    setPendingDeleteThreadId(null);
    setThreadContextMenu({
      thread,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 56))
    });
  }

  function beginThreadRename(thread: ThreadSummary) {
    setThreadContextMenu(null);
    setError("");
    setThreadRenameDraft(thread.name ?? thread.preview ?? "");
    setRenamingThread(thread);
  }

  async function createBranchFromTurn(turn: Turn) {
    const project = selectedProject;
    const sourceThread = selectedThread;
    if (!sourceThread?.id || !project?.id || branchingThreadRef.current) return;
    branchingThreadRef.current = true;
    setBranchingThread(true);
    setError("");
    const sourceViewToken = threadViewTokenRef.current;
    try {
      const response = await branchThread(project.id, sourceThread.id, { turnId: turn.id });
      const rawThread = response.data.thread;
      const normalizedThread = sanitizeThreadForRender({
        ...rawThread,
        pinned: false,
        configuredModel: rawThread.configuredModel ?? sourceThread.configuredModel ?? project.defaultModel,
        configuredReasoningEffort: rawThread.configuredReasoningEffort ?? sourceThread.configuredReasoningEffort ?? project.defaultReasoningEffort,
        turns: rawThread.turns ?? []
      });
      threadProjectIdsRef.current.set(normalizedThread.id, project.id);
      setThreads((current) => {
        const next = current.filter((thread) => thread.id !== normalizedThread.id);
        next.unshift(normalizedThread);
        threadsRef.current = next;
        return next;
      });
      if (threadViewTokenRef.current !== sourceViewToken || selectedThreadRef.current?.id !== sourceThread.id) {
        void refreshThreads(project.id);
        return;
      }
      const branchViewToken = ++threadViewTokenRef.current;
      newThreadDraftModeRef.current = false;
      selectedThreadRef.current = normalizedThread;
      setSelectedThread(normalizedThread);
      setThreadHistory(null);
      setDiffReview(null);
      setDiffPanelVisible(false);
      void openThread(normalizedThread.id, project.id, branchViewToken, { skipCache: true, requireFresh: true });
      void refreshThreads(project.id);
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".composerRichInput")?.focus());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      branchingThreadRef.current = false;
      setBranchingThread(false);
    }
  }

  async function editLatestPrompt(turnId: string, text: string, rawText: string, existingUploads: ComposerUpload[] = []) {
    const project = selectedProject;
    const thread = selectedThread;
    if (!project?.id || !thread?.id || editingLastPrompt || editingPromptDraft) return;
    if (getRunningTurnIdForThread(thread) && !(lastStoppedTurnForEdit?.threadId === thread.id && lastStoppedTurnForEdit.turnId === turnId)) {
      setError("请先停止当前回答，再编辑上一条提问。");
      return;
    }
    if (prompt.trim() || uploadedFiles.length) {
      setError("请先发送或清空输入框里的草稿，再编辑上一条提问。");
      return;
    }
    setEditingLastPrompt(true);
    setError("");
    try {
      const attachments = existingUploads.length ? [] : persistedUserAttachmentsFromText(rawText);
      const restoredUploads = existingUploads.length ? existingUploads : await Promise.all(attachments.map(async (attachment): Promise<ComposerUpload> => {
        const response = await previewProjectFile(project.id, attachment.target);
        const { name, path, relativePath, size, mime, rawUrl } = response.data;
        return { name, path, relativePath, size, mime, rawUrl, sourceFile: null, isImage: attachment.isImage };
      }));
      if (selectedThreadRef.current?.id !== thread.id) return;
      setEditingPromptDraft({ threadId: thread.id, turnId });
      setPrompt(text);
      setUploadedFiles(restoredUploads);
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".composerRichInput")?.focus());
    } catch (caught) {
      setError(`无法原样还原附件：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setEditingLastPrompt(false);
    }
  }

  function cancelEditingPrompt() {
    if (editingLastPrompt) return;
    setEditingPromptDraft(null);
    setPrompt("");
    setUploadedFiles([]);
  }

  async function deleteLatestTurn(turn: Turn) {
    const project = selectedProject;
    const thread = selectedThread;
    if (!project?.id || !thread?.id || editingLastPrompt || editingPromptDraft || getRunningTurnIdForThread(thread)) return;
    if (!window.confirm("撤回最后一轮提问和回答？模型后续将不再看到这一轮，但已经修改的文件不会自动恢复。")) return;
    setEditingLastPrompt(true);
    setError("");
    try {
      await editLatestThreadTurn(project.id, thread.id, turn.id);
      setDepartingTurnId(turn.id);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      setPendingUserMessages((current) => current.filter((entry) => entry.turnId !== turn.id));
      setLiveDeltas((current) => Object.fromEntries(Object.entries(current).filter(([, entry]) => entry.turnId !== turn.id)));
      setLiveTools((current) => Object.fromEntries(Object.entries(current).filter(([, entry]) => entry.turnId !== turn.id)));
      const viewToken = ++threadViewTokenRef.current;
      threadPageCacheRef.current.delete(`${project.id}:${thread.id}`);
      threadViewCacheRef.current.delete(`${project.id}:${thread.id}`);
      selectedThreadRef.current = null;
      threadHistoryRef.current = null;
      setSelectedThread(null);
      setThreadHistory(null);
      await openThread(thread.id, project.id, viewToken, { skipCache: true, requireFresh: true });
      void refreshThreads(project.id);
    } catch (caught) {
      setError(`撤回失败：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setDepartingTurnId(null);
      setEditingLastPrompt(false);
    }
  }

  async function startNativeReview(branch?: string) {
    const project = selectedProject;
    const thread = selectedThread;
    if (!project?.id || !thread?.id || startingNativeReview) return;
    if (!nativeFeaturesReady) {
      setError("代码审查接口等待后端服务安全重启后启用。");
      return;
    }
    if (getRunningTurnIdForThread(thread)) {
      setError("请等待当前轮次完成，再开始代码审查。");
      return;
    }
    setStartingNativeReview(true);
    setError("");
    try {
      const response = await startThreadReview(project.id, thread.id, branch);
      const reviewTurnId = response.data.turn.id;
      if (selectedThreadRef.current?.id === thread.id) {
        try {
          window.sessionStorage.setItem(`codex-web-diff-review:${selectedUserId}:${thread.id}`, JSON.stringify({ turnId: reviewTurnId, itemId: "native-review", title: branch ? `代码审查 · ${branch}` : "代码审查 · 未提交改动" }));
          window.sessionStorage.setItem(`codex-web-active-diff:${selectedUserId}`, JSON.stringify({ threadId: thread.id, projectId: project.id }));
        } catch { /* The review still opens when session storage is unavailable. */ }
        if (diffPanelCloseTimerRef.current !== null) window.clearTimeout(diffPanelCloseTimerRef.current);
        setDiffReview({ title: branch ? `代码审查 · ${branch}` : "代码审查 · 未提交改动", changes: [], reviewTurnId });
        window.requestAnimationFrame(() => setDiffPanelVisible(true));
        void openThread(thread.id, project.id, threadViewTokenRef.current, { skipCache: true, requireFresh: true });
      }
      void refreshThreads(project.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStartingNativeReview(false);
    }
  }

  async function refreshThreadContextStatus(projectId: string, threadId: string, showLoading = false) {
    if (showLoading) setThreadContextLoading(true);
    try {
      const response = await readThreadContext(projectId, threadId);
      if (selectedProjectIdRef.current === projectId && selectedThreadRef.current?.id === threadId) {
        setThreadContextStatus(response.data);
      }
    } catch (caught) {
      if (showLoading) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (showLoading && selectedProjectIdRef.current === projectId && selectedThreadRef.current?.id === threadId) {
        setThreadContextLoading(false);
      }
    }
  }

  async function showThreadStatus() {
    if (!selectedProject || !selectedThread?.id) {
      setError("请先打开一个会话，再查看状态。");
      return;
    }
    const threadId = selectedThread.id;
    if (statusPopoverThreadId === threadId && statusPopoverVisible) {
      closeStatusPopover();
      return;
    }
    try {
      const response = await readThreadContext(selectedProject.id, selectedThread.id);
      if (selectedThreadRef.current?.id !== threadId) return;
      setThreadContextStatus(response.data);
      const composer = composerRef.current;
      const trigger = composer?.querySelector<HTMLElement>(".v2ContextStatusButton");
      if (composer && trigger) {
        const composerBounds = composer.getBoundingClientRect();
        const triggerBounds = trigger.getBoundingClientRect();
        const panelWidth = Math.min(370, composerBounds.width);
        const centered = triggerBounds.left + triggerBounds.width / 2 - composerBounds.left - panelWidth / 2;
        setStatusPopoverLeft(Math.max(0, Math.min(composerBounds.width - panelWidth, centered)));
      }
      if (statusPopoverCloseTimerRef.current !== null) window.clearTimeout(statusPopoverCloseTimerRef.current);
      setStatusPopoverThreadId(threadId);
      window.requestAnimationFrame(() => {
        if (selectedThreadRef.current?.id === threadId) setStatusPopoverVisible(true);
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function closeStatusPopover() {
    setStatusPopoverVisible(false);
    if (statusPopoverCloseTimerRef.current !== null) window.clearTimeout(statusPopoverCloseTimerRef.current);
    statusPopoverCloseTimerRef.current = window.setTimeout(() => setStatusPopoverThreadId(null), 300);
  }

  function openContextPinDialog() {
    if (!selectedProject?.id) return;
    const loadId = contextDialogLoadIdRef.current + 1;
    contextDialogLoadIdRef.current = loadId;
    if (!selectedThread?.id) {
      setContextPinDraft(newThreadContextPin);
      setContextConfigDraft(newThreadContextConfig);
      setContextDialogLoading(false);
      setContextPinDialogOpen(true);
      return;
    }
    const projectId = selectedProject.id;
    const threadId = selectedThread.id;
    setContextPinDraft(threadContextStatus?.pin.text ?? "");
    setContextConfigDraft(threadContextStatus?.config ?? emptyThreadContextConfig(threadId));
    setContextPinDialogOpen(true);
    setContextDialogLoading(true);
    void readThreadContext(projectId, threadId).then((response) => {
      if (contextDialogLoadIdRef.current !== loadId) return;
      if (selectedProjectIdRef.current !== projectId || selectedThreadRef.current?.id !== threadId) return;
      setThreadContextStatus(response.data);
      setContextPinDraft(response.data.pin.text);
      setContextConfigDraft(response.data.config);
    }).catch((caught) => {
      if (contextDialogLoadIdRef.current !== loadId) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (contextDialogLoadIdRef.current !== loadId) return;
      if (selectedProjectIdRef.current === projectId && selectedThreadRef.current?.id === threadId) {
        setContextDialogLoading(false);
      }
    });
  }

  function closeContextPinDialog() {
    contextDialogLoadIdRef.current += 1;
    setContextDialogLoading(false);
    setContextPinDialogOpen(false);
  }

  async function saveContextPin() {
    const projectId = selectedProject?.id;
    const threadId = selectedThread?.id;
    if (!projectId) return;
    if (threadId && contextDialogLoading) {
      setError("当前会话设置仍在读取，请等待读取完成后再保存。");
      return;
    }
    const validationError = contextConfigValidationError(contextConfigDraft);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!threadId) {
      setNewThreadContextPin(contextPinDraft.trim());
      setNewThreadContextConfig({ ...contextConfigDraft, threadId: "", updatedAt: null });
      closeContextPinDialog();
      return;
    }
    setContextPinSaving(true);
    setError("");
    try {
      const [pinResponse, configResponse] = await Promise.all([
        updateThreadContextPin(projectId, threadId, contextPinDraft),
        updateThreadContextConfig(projectId, threadId, {
          profile: contextConfigDraft.profile,
          contextWindow: contextConfigDraft.contextWindow,
          compactTokenLimit: contextConfigDraft.compactTokenLimit,
          scope: contextConfigDraft.scope
        })
      ]);
      const refreshed = await readThreadContext(projectId, threadId);
      setThreadContextStatus(refreshed.data);
      setContextPinDraft(pinResponse.data.text);
      setContextConfigDraft(configResponse.data);
      closeContextPinDialog();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setContextPinSaving(false);
    }
  }

  async function copyThreadSessionId(thread: ThreadSummary) {
    const sessionId = (thread.sessionId || thread.id).trim();
    setThreadContextMenu(null);
    if (!sessionId) {
      setError("当前会话没有可复制的会话 ID。");
      return;
    }
    try {
      await copyTextToClipboard(sessionId);
      if (threadCopyNoticeTimerRef.current !== null) {
        window.clearTimeout(threadCopyNoticeTimerRef.current);
      }
      setThreadCopyNotice("会话 ID 已复制，可粘贴到其他会话中使用。");
      threadCopyNoticeTimerRef.current = window.setTimeout(() => {
        threadCopyNoticeTimerRef.current = null;
        setThreadCopyNotice(null);
      }, 2_400);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function toggleThreadPin(thread: ThreadSummary) {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) {
      return;
    }
    setThreadContextMenu(null);
    try {
      setError("");
      await updateThreadPresentation(projectId, thread.id, { pinned: !thread.pinned });
      await refreshThreads(projectId, threadSearch);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function clearThreadDragState() {
    if (threadLongPressTimerRef.current !== null) window.clearTimeout(threadLongPressTimerRef.current);
    const listeners = threadPointerListenersRef.current;
    if (listeners) {
      window.removeEventListener("pointermove", listeners.move, true);
      window.removeEventListener("pointerup", listeners.up, true);
      window.removeEventListener("pointercancel", listeners.cancel, true);
      document.removeEventListener("touchmove", listeners.touchMove, true);
      document.removeEventListener("selectstart", listeners.selectStart, true);
      threadPointerListenersRef.current = null;
    }
    document.body.classList.remove("v2ThreadDragActive");
    threadLongPressTimerRef.current = null;
    threadPointerDragRef.current = null;
    threadDropTargetRef.current = null;
    setDraggingThreadId(null);
    setDragOverThreadId(null);
    setThreadGhostPosition(null);
  }

  function moveThreadAround(orderedThreads: ThreadSummary[], sourceId: string, targetId: string, after: boolean): ThreadSummary[] {
    const sourceIndex = orderedThreads.findIndex((thread) => thread.id === sourceId);
    const targetIndex = orderedThreads.findIndex((thread) => thread.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      return orderedThreads;
    }
    const next = [...orderedThreads];
    const [source] = next.splice(sourceIndex, 1);
    const nextTargetIndex = next.findIndex((thread) => thread.id === targetId);
    next.splice(nextTargetIndex < 0 ? next.length : nextTargetIndex + Number(after), 0, source);
    return next;
  }

  async function persistThreadOrder(nextThreads: ThreadSummary[]) {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) {
      return;
    }
    setSavingThreadOrder(true);
    try {
      await updateThreadOrder(projectId, nextThreads.map((thread) => thread.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      void refreshThreads(projectId, threadSearch);
    } finally {
      setSavingThreadOrder(false);
    }
  }

  function finishThreadDrag() {
    const sourceId = threadPointerDragRef.current?.active ? threadPointerDragRef.current.id : null;
    const targetId = threadDropTargetRef.current?.id;
    const after = Boolean(threadDropTargetRef.current?.after);
    const source = threadsRef.current.find((thread) => thread.id === sourceId);
    const target = threadsRef.current.find((thread) => thread.id === targetId);
    clearThreadDragState();
    if (!sourceId || !source || !target || sourceId === target.id || savingThreadOrder) {
      return;
    }
    if (Boolean(source.pinned) !== Boolean(target.pinned)) {
      setError("置顶会话与普通会话分别排序；如需跨分组，请先取消或设置置顶。");
      return;
    }
    const next = moveThreadAround(threadsRef.current, sourceId, target.id, after);
    if (next === threadsRef.current) {
      return;
    }
    threadSearchRequestRef.current += 1;
    threadsRef.current = next;
    setThreads(next);
    window.localStorage.setItem(sidebarThreadsCacheKey(selectedUserId, selectedProjectIdRef.current), JSON.stringify(next));
    void persistThreadOrder(next);
  }

  function moveThreadDragAt(pointerId: number, x: number, y: number) {
    const drag = threadPointerDragRef.current;
    if (!drag?.active || drag.pointerId !== pointerId) return;
    if (threadGhostRef.current) {
      threadGhostRef.current.style.transform = `translate3d(${x + 12}px, ${y + 12}px, 0)`;
    }
    const threadList = document.querySelector<HTMLElement>(".v2WorkspaceGroup.selected .v2WorkspaceThreads");
    const bounds = threadList?.getBoundingClientRect();
    const rows = threadList ? Array.from(threadList.querySelectorAll<HTMLElement>(".threadRow[data-thread-id]"))
      .filter((row) => row.dataset.threadId !== drag.id) : [];
    if (!bounds || x < bounds.left - 12 || x > bounds.right + 12 || y < bounds.top - 16 || y > bounds.bottom + 16 || !rows.length) {
      threadDropTargetRef.current = null;
      setDragOverThreadId(null);
      return;
    }
    const row = rows.reduce((nearest, candidate) => {
      const center = (candidate.getBoundingClientRect().top + candidate.getBoundingClientRect().bottom) / 2;
      const nearestBounds = nearest.getBoundingClientRect();
      const nearestCenter = (nearestBounds.top + nearestBounds.bottom) / 2;
      return Math.abs(center - y) < Math.abs(nearestCenter - y) ? candidate : nearest;
    });
    const id = row.dataset.threadId;
    if (!id) return;
    const rowBounds = row.getBoundingClientRect();
    const after = y > rowBounds.top + rowBounds.height / 2;
    threadDropTargetRef.current = { id, after };
    setDragOverThreadId((current) => current === id ? current : id);
    setDragOverThreadAfter(after);
  }

  function moveThreadDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = threadPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.active) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 8) {
      clearThreadDragState();
      suppressThreadClickRef.current = true;
    }
  }

  function closeThreadRename() {
    if (renamingThreadId) {
      return;
    }
    setRenamingThread(null);
    setThreadRenameDraft("");
  }

  function applyThreadName(threadId: string, name: string) {
    setThreads((current) => {
      const next = current.map((thread) => thread.id === threadId ? { ...thread, name } : thread);
      threadsRef.current = next;
      return next;
    });
    if (selectedThreadRef.current?.id === threadId) {
      const nextThread = { ...selectedThreadRef.current, name };
      selectedThreadRef.current = nextThread;
      setSelectedThread(nextThread);
    }
  }

  function submitThreadRename() {
    const thread = renamingThread;
    const projectId = selectedProjectIdRef.current;
    const name = threadRenameDraft.trim();
    if (!thread || !projectId || !name) {
      setError("请输入会话名称。");
      return;
    }
    if (name.length > 160) {
      setError("会话名称最多 160 个字符。");
      return;
    }

    const requestId = `rename-${requestToken()}`;
    threadRenameRequestContextsRef.current.set(requestId, { threadId: thread.id, projectId, name });
    setRenamingThreadId(thread.id);
    try {
      codexSocket.send({ type: "thread.rename", requestId, projectId, threadId: thread.id, name });
    } catch (caught) {
      threadRenameRequestContextsRef.current.delete(requestId);
      setRenamingThreadId(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId, modelProfiles]);

  useEffect(() => {
    selectedThreadRef.current = selectedThread;
  }, [selectedThread]);

  useEffect(() => {
    const projectId = selectedProjectId;
    const threadId = selectedThread?.id;
    setStatusPopoverThreadId(null);
    setStatusPopoverVisible(false);
    closeContextPinDialog();
    if (!projectId || !threadId) {
      setThreadContextStatus(null);
      setThreadContextLoading(false);
      return;
    }
    setThreadContextStatus(null);
    setThreadContextLoading(true);
    void refreshThreadContextStatus(projectId, threadId, false).finally(() => {
      if (selectedProjectIdRef.current === projectId && selectedThreadRef.current?.id === threadId) {
        setThreadContextLoading(false);
      }
    });
  }, [selectedProjectId, selectedThread?.id]);

  useEffect(() => {
    pendingUserMessagesRef.current = pendingUserMessages;
  }, [pendingUserMessages]);

  useEffect(() => {
    if (!threadContextMenu) {
      return;
    }
    const closeMenu = () => setThreadContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [threadContextMenu]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    autoSendEnabledRef.current = autoSendGeneratedFiles;
  }, [autoSendGeneratedFiles]);

  useEffect(() => {
    void refreshLocalSendSettings(false);
  }, [selectedUserId]);

  useLayoutEffect(() => {
    if (Date.now() < searchNavigationLockUntilRef.current) return;
    stopToolReveal();
    messageScrollDirectionRef.current = null;
    manualMessageScrollLockRef.current = false;
    autoFollowMessagesRef.current = true;
    setShowScrollToBottom(false);
    conversationVirtualRef.current?.scrollToEnd("auto");
  }, [selectedProjectId, selectedThread?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (autoFollowMessagesRef.current) {
        scrollMessagesToBottom("auto");
      } else {
        updateMessageScrollState();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedThread?.turns, pendingUserMessages, liveDeltas, localMessages]);

  useEffect(() => {
    const threadId = selectedThread?.id;
    const projectId = selectedProjectId;
    const activeTurnId = threadId
      ? activeTurnsByThread[threadId]
      : undefined;
    const hasPendingPromptForThread = Boolean(threadId && pendingUserMessages.some((entry) => (
      entry.threadId === threadId && entry.requestId && entry.keepAtBottomUntil > Date.now()
    )));
    if (!threadId || !projectId || (!activeTurnId && !hasPendingPromptForThread)) {
      return;
    }
    let stopped = false;
    let timer: number | null = null;
    const reconcile = async () => {
      const key = `${projectId}:${threadId}:${activeTurnId ?? "pending"}`;
      if (stopped || document.visibilityState !== "visible" || activeThreadReconcileRef.current.has(key)) {
        return;
      }
      activeThreadReconcileRef.current.add(key);
      try {
        const nextThread = await openThread(threadId, projectId, threadViewTokenRef.current, { skipCache: true });
        if (!nextThread) {
          return;
        }
        if (stopped || selectedThreadRef.current?.id !== threadId) {
          return;
        }
        const mergedThread = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, applyThreadListName(nextThread), modelProfiles));
        const cacheKey = `${projectId}:${threadId}`;
        threadPageCacheRef.current.delete(cacheKey);
        threadViewCacheRef.current.delete(cacheKey);
        selectedThreadRef.current = mergedThread;
        setSelectedThread(mergedThread);
      } catch {
        // WebSocket remains the primary path; a temporary read failure should
        // not replace the live rendering with an error banner.
      } finally {
        activeThreadReconcileRef.current.delete(key);
      }
    };
    const scheduleRecoveryCheck = () => {
      if (stopped) {
        return;
      }
      const delay = socketStatus === "open" ? 2_000 : 500;
      timer = window.setTimeout(async () => {
        timer = null;
        const latestLiveAt = lastLiveEventAtRef.current[threadId] ?? 0;
        const silenceMs = Date.now() - latestLiveAt;
        if (socketStatus === "open" && silenceMs >= 8_000) {
          try {
            codexSocket.send({ type: "live.state", requestId: `live-${requestToken()}` });
          } catch {
            // The history recovery below remains the fallback.
          }
        }
        if (socketStatus !== "open" || silenceMs >= 8_000) {
          await reconcile();
          lastLiveEventAtRef.current[threadId] = Date.now();
        }
        scheduleRecoveryCheck();
      }, delay);
    };
    if (!lastLiveEventAtRef.current[threadId]) {
      lastLiveEventAtRef.current[threadId] = Date.now();
    }
    scheduleRecoveryCheck();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [selectedProjectId, selectedThread?.id, selectedThread?.id ? activeTurnsByThread[selectedThread.id] : undefined, pendingUserMessages, socketStatus]);

  useEffect(() => () => {
    if (liveDeltaFlushTimerRef.current !== null) {
      window.clearTimeout(liveDeltaFlushTimerRef.current);
    }
  }, []);

  useEffect(() => {
    void refreshModels();
    void refreshQuota(false, { force: false });
    void refreshUsers();
    const unsubscribe = codexSocket.subscribe(handleSocketMessage);
    const unsubscribeStatus = codexSocket.subscribeStatus(setSocketStatus);
    // Subscribe before opening the socket. The server sends the initial
    // hello/live snapshot immediately; connecting first could lose it in the
    // small race before the listener was registered.
    codexSocket.connect();
    return () => {
      unsubscribe();
      unsubscribeStatus();
    };
  }, []);

  useEffect(() => {
    const threadId = selectedThread?.id;
    setExhaustedAccountNotice(null);
    setDismissedExhaustedThreadId(null);
    if (!threadId) return;
    let cancelled = false;
    // The notice only needs the existing quota snapshot and this thread's
    // account mapping. A forced refresh waits for every account RPC and can
    // delay the hint by 20+ seconds; the normal quota poll keeps it current.
    void readCodexAccountPool(false, threadId)
      .then(({ data }) => {
        if (!cancelled) setExhaustedAccountNotice(exhaustedAccountSuggestion(data, threadId));
      })
      .catch(() => {
        // A failed quota read is not evidence that this thread is exhausted.
      });
    return () => { cancelled = true; };
  }, [selectedThread?.id, selectedUserId]);

  useEffect(() => {
    setQueuedSubmissions([]);
    if (socketStatus !== "open" || !selectedThread?.id) return;
    requestQueuedSubmissions(selectedThread.id);
  }, [selectedThread?.id, socketStatus]);

  useEffect(() => {
    if (!selectedThread?.id || diffReview) return;
    const saved = storedSessionJson<{ turnId: string; itemId: string; title: string; focusPath?: string } | null>(
      `codex-web-diff-review:${selectedUserId}:${selectedThread.id}`, null
    );
    if (!saved?.turnId || !saved.itemId) return;
    const turn = selectedThread.turns?.find((entry) => entry.id === saved.turnId);
    if (saved.itemId === "native-review") {
      if (!turn) return;
      setDiffReview({ title: saved.title || "代码审查", changes: [], reviewTurnId: saved.turnId });
      window.requestAnimationFrame(() => setDiffPanelVisible(true));
      return;
    }
    const item = turn?.items?.find((entry) => entry.id === saved.itemId);
    const changes = saved.itemId === `turn-changes:${saved.turnId}` && turn
      ? turnFileChanges(turn, liveTurnDiffs[saved.turnId])
      : item?.changes?.length ? item.changes
        : saved.itemId === `turn-diff:${saved.turnId}` && liveTurnDiffs[saved.turnId]
          ? changesFromUnifiedDiff(liveTurnDiffs[saved.turnId]) : null;
    if (!changes?.length) return;
    setDiffReview({ title: saved.title || "本轮文件变更", changes, focusPath: saved.focusPath });
    window.requestAnimationFrame(() => setDiffPanelVisible(true));
  }, [selectedThread, selectedUserId, liveTurnDiffs, diffReview]);

  useEffect(() => {
    if (diffInitialRestoreRef.current.has(selectedUserId) || selectedThread?.id) return;
    const saved = storedSessionJson<{ projectId: string; threadId: string } | null>(`codex-web-active-diff:${selectedUserId}`, null);
    if (!saved?.projectId || !saved.threadId || !projects.some((project) => project.id === saved.projectId)) return;
    diffInitialRestoreRef.current.add(selectedUserId);
    selectThread(saved.threadId, saved.projectId);
  }, [projects, selectedThread?.id, selectedUserId]);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;

    const cachedPoolNeedsRetry = () => {
      const cached = storedJson<CodexAccountPool | null>(accountPoolSnapshotStorageKey, null);
      return !cached?.accounts.length || cached.accounts.some((account) => !quotaHasUsableRateLimits(account.quota));
    };

    const scheduleNext = (delay = quotaAutoRefreshMs) => {
      if (stopped) {
        return;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timer = null;
        if (document.visibilityState !== "visible") {
          scheduleNext();
          return;
        }
        const force = cachedPoolNeedsRetry();
        void refreshQuota(false, { background: true, force }).finally(() => {
          scheduleNext(cachedPoolNeedsRetry() ? quotaRetryRefreshMs : quotaAutoRefreshMs);
        });
      }, delay);
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const force = cachedPoolNeedsRetry();
      void refreshQuota(false, { background: true, force }).finally(() => {
        scheduleNext(cachedPoolNeedsRetry() ? quotaRetryRefreshMs : quotaAutoRefreshMs);
      });
    };

    document.addEventListener("visibilitychange", refreshWhenVisible);
    scheduleNext(quotaRetryRefreshMs);
    return () => {
      stopped = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (!leaderboardOpen) {
      return;
    }

    let stopped = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      if (stopped) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        if (document.visibilityState === "visible") {
          void refreshLeaderboard(false, false);
        }
        scheduleNext();
      }, leaderboardAutoRefreshMs);
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshLeaderboard(false, false);
      }
    };

    document.addEventListener("visibilitychange", refreshWhenVisible);
    scheduleNext();
    return () => {
      stopped = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [leaderboardOpen]);

  useEffect(() => {
    void refreshTrackedQuota(false, false);
  }, []);

  useEffect(() => {
    if (!trackedQuotaOpen) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshTrackedQuota(false, false);
    }, trackedQuotaAutoRefreshMs);
    return () => window.clearInterval(timer);
  }, [trackedQuotaOpen]);

  useEffect(() => {
    if (!userEffectInitializedRef.current) {
      userEffectInitializedRef.current = true;
      setApiUserId(selectedUserId);
      setPushEnabled(storedBooleanWithDefault(`codex-web-push:${selectedUserId}`, false));
      setCodexFastModeEnabled(storedBoolean(codexFastModeStorageKey(selectedUserId)));
      const savedAutoSendPreference = storedBooleanWithDefault(autoSendPreferenceStorageKey(selectedUserId), true);
      autoSendEnabledRef.current = savedAutoSendPreference;
      setAutoSendGeneratedFiles(savedAutoSendPreference);
      void refreshProjects();
      return;
    }
    threadViewTokenRef.current += 1;
    newThreadDraftModeRef.current = true;
    selectedThreadRef.current = null;
    setApiUserId(selectedUserId);
    setPushEnabled(storedBooleanWithDefault(`codex-web-push:${selectedUserId}`, false));
    setProjectOrder(storedJson<string[]>(sidebarProjectOrderKey(selectedUserId), []));
    setExpandedProjectIds(storedJson<string[]>(sidebarExpandedProjectsKey(selectedUserId), []));
    const savedAutoSendPreference = storedBooleanWithDefault(autoSendPreferenceStorageKey(selectedUserId), true);
    autoSendEnabledRef.current = savedAutoSendPreference;
    setAutoSendGeneratedFiles(savedAutoSendPreference);
    setCodexFastModeEnabled(storedBoolean(codexFastModeStorageKey(selectedUserId)));
    autoSentGeneratedFileKeysRef.current.clear();
    autoSendInFlightFileKeysRef.current.clear();
    threadProjectIdsRef.current.clear();
    initializedProjectIdRef.current = "";
    setSelectedProjectId("");
    setThreadSearch("");
    setSelectedThread(null);
    setOpeningThreadId(null);
    setThreadHistory(null);
    setLoadingOlderHistory(false);
    setContinuationPrompt(null);
    setThreads([]);
    setLiveDeltas({});
    setActiveTurnsByThread({});
    setInterruptingTurns({});
    setQueuedInterruptPrompts({});
    setUnreadResultThreads({});
    promptRequestContextsRef.current.clear();
    pendingQueuedPromptsRef.current.clear();
    pendingQueueSteersRef.current.clear();
    interruptRequestContextsRef.current.clear();
    interruptRequestedTurnIdsRef.current.clear();
    queuedInterruptPromptRequestIdsRef.current.clear();
    setPendingUserMessages([]);
    setUploadedFiles([]);
    setLocalMessages([]);
    setDraggingUpload(false);
    setFilePreview(null);
    setFilePreviewObjectUrl("");
    setSettingsOpen(false);
    setLocalSendSettings(defaultLocalSendSettings);
    localSendSettingsRef.current = defaultLocalSendSettings;
    setDetectedClientHost("");
    setDirectoryBrowserOpen(false);
    setPendingDeleteProjectId(null);
    setPendingDeleteThreadId(null);
    void refreshProjects();
  }, [selectedUserId]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    if (initializedProjectIdRef.current === selectedProject.id) {
      return;
    }
    initializedProjectIdRef.current = selectedProject.id;
    const searchNavigation = searchProjectNavigationRef.current;
    const preserveSearchNavigation = searchNavigation?.projectId === selectedProject.id
      && searchNavigation.viewToken === threadViewTokenRef.current;
    searchProjectNavigationRef.current = null;
    if (!preserveSearchNavigation) {
      threadViewTokenRef.current += 1;
      newThreadDraftModeRef.current = true;
      selectedThreadRef.current = null;
      setSelectedThread(null);
      setOpeningThreadId(null);
      setThreadHistory(null);
    }
    setLoadingOlderHistory(false);
    setContinuationPrompt(null);
    setPendingUserMessages([]);
    setUploadedFiles([]);
    setDraggingUpload(false);
    setFilePreview(null);
    setFilePreviewObjectUrl("");
    setPendingDeleteThreadId(null);
    const savedModelProfileId = window.localStorage.getItem(modelPreferenceStorageKey(selectedUserId, selectedProject.id));
    setNewThreadModelProfileId(savedModelProfileId || modelProfileIdFor(
      selectedProject.defaultModel || "gpt-5.5",
      selectedProject.defaultReasoningEffort || "xhigh",
      modelProfiles
    ));
    setSandbox(selectedProject.defaultSandbox || "danger-full-access");
    setApprovalPolicy(selectedProject.defaultApprovalPolicy || "never");
    setLocalMessages([]);
    const cachedThreads = dedupeThreadListById(
      storedJson<ThreadSummary[]>(sidebarThreadsCacheKey(selectedUserId, selectedProject.id), []).filter((thread) => !isTemporaryAskThread(thread))
    );
    setThreads(cachedThreads);
    threadsRef.current = cachedThreads;
    window.localStorage.setItem(sidebarProjectSelectionKey(selectedUserId), selectedProject.id);
    void refreshSkills(selectedProject.id);
    void refreshThreads(selectedProject.id);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refreshThreads(selectedProjectId, threadSearch);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [threadSearch]);

  useEffect(() => {
    const openSearch = () => setGlobalSearchOpen(true);
    window.addEventListener("v2:open-thread-search", openSearch);
    return () => window.removeEventListener("v2:open-thread-search", openSearch);
  }, []);

  useEffect(() => {
    const requestId = ++globalSearchRequestRef.current;
    if (!globalSearchOpen) return;
    const query = globalSearchQuery.trim();
    if (!query) {
      setGlobalSearchResults([]);
      setGlobalSearchLoading(false);
      setGlobalSearchIndexing(false);
      setGlobalSearchNextOffset(null);
      return;
    }
    const controller = new AbortController();
    let pollTimer: number | undefined;
    const run = async () => {
      setGlobalSearchLoading(true);
      try {
        const response = await searchThreads(query, { offset: globalSearchPage, signal: controller.signal });
        if (controller.signal.aborted || requestId !== globalSearchRequestRef.current) return;
        const results: GlobalSearchResult[] = response.data.flatMap(thread => {
          const project = projects.find(entry => entry.id === thread.projectId);
          if (!project) return [];
          return [{ project, thread, match: thread.searchMatch
            ? { ...thread.searchMatch, projectId: project.id, threadId: thread.id }
            : undefined }];
        });
        setGlobalSearchResults(current => globalSearchPage === 0 ? results : [
          ...current.filter(entry => !results.some(result => result.thread.id === entry.thread.id)),
          ...results
        ]);
        setGlobalSearchIndexing(response.indexing);
        setGlobalSearchPendingThreads(response.pendingThreads ?? 0);
        setGlobalSearchNextOffset(response.nextOffset);
        if (response.indexError) setError(`搜索索引更新失败：${response.indexError}`);
        if (response.indexing || response.pendingThreads) pollTimer = window.setTimeout(() => void run(), response.indexing ? 800 : 5000);
      } catch (caught) {
        if (!controller.signal.aborted && requestId === globalSearchRequestRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!controller.signal.aborted && requestId === globalSearchRequestRef.current) setGlobalSearchLoading(false);
      }
    };
    const timer = window.setTimeout(() => void run(), globalSearchPage ? 0 : 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [globalSearchOpen, globalSearchQuery, globalSearchPage, projects]);

  useEffect(() => {
    const panel = threadSearchPanel;
    if (!panel || selectedThread?.id !== panel.threadId || !panel.query.trim()) return;
    const requestId = ++threadSearchPanelRequestRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const response = await searchThreadHits(panel.threadId, panel.projectId, panel.query.trim());
        if (requestId !== threadSearchPanelRequestRef.current) return;
        const hits = response.data.map(hit => ({ ...hit, projectId: panel.projectId }));
        const initialIndex = Math.max(0, hits.findIndex(hit => hit.itemId === panel.selectedItemId));
        setThreadSearchPanel(current => current?.threadId === panel.threadId && current.query === panel.query
          ? { ...current, hits, total: response.total, index: initialIndex, loading: false, error: undefined }
          : current);
        if (hits[initialIndex]) void navigateThreadSearchHit(hits[initialIndex], initialIndex);
      } catch (caught) {
        if (requestId === threadSearchPanelRequestRef.current) {
          setThreadSearchPanel(current => current?.threadId === panel.threadId ? {
            ...current, loading: false, error: caught instanceof Error ? caught.message : String(caught)
          } : current);
        }
      }
    }, 130);
    return () => { threadSearchPanelRequestRef.current += 1; window.clearTimeout(timer); };
  }, [threadSearchPanel?.threadId, threadSearchPanel?.projectId, threadSearchPanel?.query, threadSearchPanel?.refreshKey, selectedThread?.id]);

  useEffect(() => {
    if (threadSearchPanel && selectedThread?.id && selectedThread.id !== threadSearchPanel.threadId) {
      setThreadSearchPanel(null);
      clearSearchHighlights();
    }
  }, [selectedThread?.id, threadSearchPanel?.threadId]);

  useEffect(() => {
    threadHistoryRef.current = threadHistory;
  }, [threadHistory]);

  useEffect(() => {
    return () => {
      if (filePreviewObjectUrl) {
        URL.revokeObjectURL(filePreviewObjectUrl);
      }
    };
  }, [filePreviewObjectUrl]);

  useEffect(() => () => {
    if (globalSearchJumpNoticeTimerRef.current !== null) {
      window.clearTimeout(globalSearchJumpNoticeTimerRef.current);
    }
  }, []);

  async function refreshModels() {
    try {
      const response = await listModels();
      const visibleProfiles = response.data.filter((profile) => (
        !hiddenModelIds.has(profile.model) && !isUltraModelProfile(profile)
      ));
      const nextProfiles = visibleProfiles.length ? visibleProfiles : fallbackModelProfiles;
      setModelProfiles(nextProfiles);
      setNewThreadModelProfileId((current) => (
        nextProfiles.some((profile) => profile.id === current)
          ? current
          : modelProfileIdFor(response.defaultModel, response.defaultReasoningEffort, nextProfiles)
      ));
    } catch (caught) {
      setModelProfiles(fallbackModelProfiles);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function addLocalMessage(
    text: string,
    meta = "Codex Web · system",
    kind: LocalMessage["kind"] = "system",
    id = `local-${requestToken()}`,
    options: LocalMessageOptions = {}
  ) {
    setLocalMessages((current) => [...current, { id, meta, text, kind, ...options }]);
  }

  function renderLocalMessage(entry: LocalMessage) {
    if (entry.meta === "Codex Web · 分支续接" || entry.meta === "Codex Web · status") return null;
    return (
      <article className={`messageItem kind-${entry.kind ?? "system"}`} key={entry.id}>
        <div className="messageMeta">{entry.meta}</div>
        <MarkdownMessage text={entry.text} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
      </article>
    );
  }

  function appendLocalMessage(id: string, text: string, meta = "Codex Web · command", kind: LocalMessage["kind"] = "tool") {
    setLocalMessages((current) => {
      const existing = current.find((entry) => entry.id === id);
      if (!existing) {
        return [...current, { id, meta, text, kind }];
      }
      return current.map((entry) => (entry.id === id ? { ...entry, text: `${entry.text}${text}` } : entry));
    });
  }

  async function refreshQuota(showMessage = false, options: QuotaRefreshOptions = {}): Promise<CodexQuota | null> {
    const background = options.background === true;
    if (!background) {
      setQuotaLoading(true);
    }

    let refresh = quotaRefreshInFlightRef.current;
    if (!refresh) {
      refresh = readCodexAccountPool(options.force === true, selectedThread?.id)
        .then((response): QuotaRefreshResult => {
          const previous = storedJson<CodexAccountPool | null>(accountPoolSnapshotStorageKey, null);
          const nextPool = mergeAccountPoolWithLastKnownGood(previous, response.data);
          const nextQuota = selectedQuotaFromPool(nextPool);
          window.localStorage.setItem(accountPoolSnapshotStorageKey, JSON.stringify(nextPool));
          setAccountPool(nextPool);
          setQuota(nextQuota);
          return { quota: nextQuota, pool: nextPool, error: null };
        })
        .catch((caught): QuotaRefreshResult => ({
          quota: null,
          pool: null,
          error: caught instanceof Error ? caught.message : String(caught)
        }))
        .finally(() => {
          quotaRefreshInFlightRef.current = null;
        });
      quotaRefreshInFlightRef.current = refresh;
    }

    try {
      const result = await refresh;
      if (result.error && !background) {
        setError(result.error);
      }
      if (result.quota && showMessage) {
        addLocalMessage(quotaMarkdown(result.quota));
      }
      return result.quota;
    } finally {
      if (!background) {
        setQuotaLoading(false);
      }
    }
  }

  async function refreshLeaderboard(showDialog = true, force = false): Promise<CodexLeaderboard | null> {
    if (showDialog) {
      setLeaderboardOpen(true);
    }
    setLeaderboardLoading(true);

    let refresh = leaderboardRefreshInFlightRef.current;
    if (!refresh) {
      refresh = readCodexLeaderboard(force)
        .then((response): LeaderboardRefreshResult => {
          setLeaderboard(response.data);
          window.localStorage.setItem(`codex.v2.leaderboard.${getApiUserId()}`, JSON.stringify(response.data));
          return { leaderboard: response.data, error: null };
        })
        .catch((caught): LeaderboardRefreshResult => ({
          leaderboard: null,
          error: caught instanceof Error ? caught.message : String(caught)
        }))
        .finally(() => {
          leaderboardRefreshInFlightRef.current = null;
        });
      leaderboardRefreshInFlightRef.current = refresh;
    }

    try {
      const result = await refresh;
      if (result.error) {
        setError(result.error);
      }
      return result.leaderboard;
    } finally {
      setLeaderboardLoading(false);
    }
  }

  async function refreshTrackedQuota(showDialog = true, force = false): Promise<TrackedQuotaUsage | null> {
    if (showDialog) setTrackedQuotaOpen(true);
    setTrackedQuotaLoading(true);
    let refresh = trackedQuotaRefreshInFlightRef.current;
    if (!refresh) {
      refresh = readTrackedQuotaUsage(force)
        .then((response): TrackedQuotaRefreshResult => {
          setTrackedQuotaUsage(response.data);
          window.localStorage.setItem(trackedQuotaSnapshotStorageKey, JSON.stringify(response.data));
          return { usage: response.data, error: null };
        })
        .catch((caught): TrackedQuotaRefreshResult => ({
          usage: null,
          error: caught instanceof Error ? caught.message : String(caught)
        }))
        .finally(() => {
          trackedQuotaRefreshInFlightRef.current = null;
        });
      trackedQuotaRefreshInFlightRef.current = refresh;
    }
    try {
      const result = await refresh;
      if (result.error) setError(result.error);
      return result.usage;
    } finally {
      setTrackedQuotaLoading(false);
    }
  }

  async function refreshSkills(projectId = selectedProjectIdRef.current, reload = false, showMessage = false): Promise<CodexSkill[]> {
    if (!projectId) {
      return [];
    }
    setSkillsLoading(true);
    try {
      const response = await listCodexSkills(projectId, reload);
      setSkills(response.data);
      if (showMessage) {
        addLocalMessage(skillsMarkdown(response.data));
      }
      return response.data;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return [];
    } finally {
      setSkillsLoading(false);
    }
  }

  async function openSkillsPicker(reload = false) {
    setSkillsPickerOpen(true);
    setSkillSearch("");
    if (reload || !skills.length) {
      await refreshSkills(selectedProjectIdRef.current, reload, false);
    }
  }

  function toggleSelectedSkill(name: string) {
    setSelectedSkillNames((current) => (
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    ));
  }

  async function refreshProjects() {
    try {
      const response = await listProjects();
      setProjects(response.data);
      window.localStorage.setItem(sidebarProjectsCacheKey(selectedUserId), JSON.stringify(response.data));
      setProjectRoot(response.projectRoot);
      setSystemDirectoryPickerAvailable(Boolean(response.systemDirectoryPickerAvailable));
      setThreadContextFeatureEnabled(Boolean(response.threadContextFeatureEnabled));
      if (!response.data.some((project) => project.id === selectedProjectId)) {
        setSelectedThread(null);
        setThreads([]);
        setSelectedProjectId("");
      }
      if ((!selectedProjectId || !response.data.some((project) => project.id === selectedProjectId)) && response.data[0]) {
        setSelectedProjectId(response.data[0].id);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function showWorktreePicker() {
    const project = selectedProject;
    if (!project) return;
    setWorktreeOpen(true);
    setWorktreeLoading(true);
    try {
      const response = await listProjectGitRepositories(project.id);
      setWorktreeRepositories(response.data);
      setWorktreeRepositoryPath(response.data.find(item => item.rootPath === project.rootPath)?.rootPath ?? response.data[0]?.rootPath ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setWorktreeOpen(false);
    } finally { setWorktreeLoading(false); }
  }

  async function createIsolatedWorktree(repositoryPath: string) {
    const project = selectedProject;
    if (!project || !repositoryPath || creatingWorktree) return;
    const sourceThread = selectedThreadRef.current;
    const lastTurnId = sourceThread?.turns?.at(-1)?.id;
    setCreatingWorktree(true);
    setError("");
    try {
      const response = await createProjectWorktree(project.id, repositoryPath);
      setWorktreeOpen(false);
      setProjects(current => [response.data, ...current]);
      setExpandedProjectIds(current => current.includes(response.data.id) ? current : [...current, response.data.id]);
      activateWorkspaceProject(response.data.id);
      if (sourceThread && lastTurnId && response.repositoryRoot === project.rootPath) {
        try {
          const fork = await branchThread(project.id, sourceThread.id, { turnId: lastTurnId, targetProjectId: response.data.id });
          const thread = sanitizeThreadForRender({ ...fork.data.thread, turns: fork.data.thread.turns ?? [] });
          threadProjectIdsRef.current.set(thread.id, response.data.id);
          selectedThreadRef.current = thread;
          setSelectedThread(thread);
          setThreads([thread]);
          const viewToken = ++threadViewTokenRef.current;
          void openThread(thread.id, response.data.id, viewToken, { skipCache: true, requireFresh: true });
        } catch (caught) {
          setSelectedThread(null);
          setThreads([]);
          setError(`独立工作树已创建，但会话接力失败：${caught instanceof Error ? caught.message : String(caught)}`);
        }
      } else {
        setSelectedThread(null);
        setThreads([]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreatingWorktree(false);
    }
  }

  async function showArchivedThreads() {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) return;
    setArchivedThreads([]);
    setArchivedOpen(true);
    setArchivedLoading(true);
    try {
      const response = await listArchivedThreads(projectId);
      setArchivedThreads(response.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setArchivedOpen(false);
    } finally {
      setArchivedLoading(false);
    }
  }

  async function changeThreadArchive(thread: ThreadSummary, archived: boolean) {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) return;
    setThreadContextMenu(null);
    setError("");
    try {
      await setThreadArchived(projectId, thread.id, archived);
      if (archived) {
        if (selectedThreadRef.current?.id === thread.id) setSelectedThread(null);
      } else {
        setArchivedThreads(current => current?.filter(item => item.id !== thread.id) ?? null);
      }
      await refreshThreads(projectId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function showProjectHooks() {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) return;
    setHooksStatus({ hooks: [], warnings: [], errors: [] });
    setHookEditorOpen(false);
    setHooksOpen(true);
    setHooksLoading(true);
    try {
      setHooksStatus((await listProjectHooks(projectId, selectedThreadRef.current?.id)).data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setHooksOpen(false);
    } finally {
      setHooksLoading(false);
    }
  }

  async function saveProjectHook() {
    const projectId = selectedProjectIdRef.current;
    if (!projectId || !hookCommand.trim() || hookSaving) return;
    setHookSaving(true);
    setError("");
    try {
      await createProjectHook(projectId, { eventName: hookEventName, command: hookCommand.trim(), matcher: hookMatcher.trim() || undefined });
      setHookEditorOpen(false);
      setHookCommand("");
      setHookMatcher("");
      setHooksStatus((await listProjectHooks(projectId, selectedThreadRef.current?.id)).data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setHookSaving(false); }
  }

  async function changeProjectHookTrust(hook: NonNullable<typeof hooksStatus>["hooks"][number], trusted: boolean) {
    const projectId = selectedProjectIdRef.current;
    const threadId = selectedThreadRef.current?.id;
    if (!projectId || !hook.currentHash || !hook.trustable) return;
    setError("");
    try {
      await setProjectHookTrust(projectId, threadId, hook.key, hook.currentHash, trusted);
      setPendingHookTrustKey(null);
      setHooksStatus((await listProjectHooks(projectId, threadId)).data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    const handleWorkspaceAction = (event: Event) => {
      if (!selectedProject) return;
      const action = (event as CustomEvent<string>).detail;
      const running = Boolean(getRunningTurnIdForThread(selectedThread));
      if (action === "worktree" && !running && !creatingWorktree) void showWorktreePicker();
      if (action === "archive-list") void showArchivedThreads();
      if (action === "archive-current" && selectedThread && !running) void changeThreadArchive(selectedThread, true);
      if (action === "terminal") {
        if (terminalCloseTimerRef.current !== null) window.clearTimeout(terminalCloseTimerRef.current);
        setTerminalProjectId(selectedProject.id);
        window.requestAnimationFrame(() => setTerminalVisible(true));
      }
      if (action === "hooks") void showProjectHooks();
    };
    window.addEventListener("codex:workspace-action", handleWorkspaceAction);
    return () => window.removeEventListener("codex:workspace-action", handleWorkspaceAction);
  }, [selectedProject, selectedThread, creatingWorktree]);

  async function refreshUsers() {
    try {
      const response = await listUsers();
      setUsers(response.data);
      if (!response.data.some((user) => user.id === selectedUserId)) {
        const fallback = response.data.find((user) => user.id === response.defaultUserId) ?? response.data[0];
        if (fallback) {
          setSelectedUserId(fallback.id);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function refreshThreads(projectId = selectedProjectIdRef.current, search = threadSearch) {
    if (!projectId) {
      return;
    }
    const searchRequestId = ++threadSearchRequestRef.current;
    const searching = Boolean(search.trim());
    if (searching) {
      setThreadSearchLoading(true);
    }
    try {
      const response = await listThreads(projectId, search);
      if (searchRequestId !== threadSearchRequestRef.current) {
        return;
      }
      // While a temporary thread is starting, listThreads can observe it a few
      // milliseconds before the websocket ACK gives the browser its id. Do not
      // mistake that in-flight thread for an abandoned one and delete it.
      const leakedTemporaryThreads = temporaryAskRef.current
        ? []
        : response.data.filter((thread) => isTemporaryAskThread(thread) && !temporaryThreadIdsRef.current.has(thread.id));
      for (const thread of leakedTemporaryThreads) {
        void deleteThread(projectId, thread.id);
      }
      const visibleThreads = dedupeThreadListById(response.data
        .filter((thread) => !temporaryThreadIdsRef.current.has(thread.id) && !isTemporaryAskThread(thread))
        .map((thread) => sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, thread, modelProfiles))));
      setThreads(visibleThreads);
      threadsRef.current = visibleThreads;
      window.localStorage.setItem(sidebarThreadsCacheKey(selectedUserId, projectId), JSON.stringify(visibleThreads));
      for (const thread of visibleThreads) {
        threadProjectIdsRef.current.set(thread.id, projectId);
      }
      const visibleThreadIds = new Set(visibleThreads.map((thread) => thread.id));
      const currentThread = selectedThreadRef.current;
      if (currentThread?.id && search.trim() && !visibleThreadIds.has(currentThread.id)) {
        selectedThreadRef.current = null;
        setSelectedThread(null);
      }
    } catch (caught) {
      if (searchRequestId === threadSearchRequestRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (searchRequestId === threadSearchRequestRef.current) {
        setThreadSearchLoading(false);
      }
    }
  }

  async function openThread(
    threadId: string,
    projectId = selectedProjectIdRef.current,
    viewToken = threadViewTokenRef.current,
    options: ThreadLoadOptions = {}
  ): Promise<ThreadSummary | null> {
    if (!projectId || viewToken !== threadViewTokenRef.current) {
      return null;
    }
    if (!options.appendOlder && !options.skipCache) {
      const cached = threadPageCacheRef.current.get(`${projectId}:${threadId}`);
      const cachedHistoryIsUsable = Boolean(
        cached
        && cached.history.totalItems > 0
        && (cached.history.returnedItems >= 128 || !cached.history.hasOlder)
        && (!cached.history.hasOlder || Boolean(cached.history.nextCursor || cached.history.nextBefore > 0))
      );
      if (cached && !cachedHistoryIsUsable) {
        threadPageCacheRef.current.delete(`${projectId}:${threadId}`);
      } else if (cached && cachedHistoryIsUsable && Date.now() - cached.cachedAt < 30_000) {
        const current = selectedThreadRef.current;
        const currentHistory = current?.id === cached.thread.id ? threadHistoryRef.current : null;
        const preserveLoadedHistory = Boolean(current && currentHistory && currentHistory.nextBefore > cached.history.nextBefore);
        const cachedThread = preserveLoadedHistory && current
          ? mergeThreadHistoryPages(current, cached.thread)
          : cached.thread;
        const nextHistory = preserveLoadedHistory && currentHistory
          ? {
              ...currentHistory,
              totalItems: cached.history.totalItems,
              nextBefore: Math.min(
                cached.history.totalItems,
                currentHistory.nextBefore + Math.max(0, cached.history.totalItems - currentHistory.totalItems)
              ),
              indexState: cached.history.indexState
            }
          : cached.history;
        const nextThread = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, applyThreadListName(cachedThread), modelProfiles));
        selectedThreadRef.current = nextThread;
        setSelectedThread(nextThread);
        threadHistoryRef.current = nextHistory;
        setThreadHistory(nextHistory);
        threadViewCacheRef.current.set(`${projectId}:${threadId}`, { thread: nextThread, history: nextHistory });
        setOpeningThreadId((current) => current === threadId ? null : current);
        return nextThread;
      }
    }
    try {
      const response = await readThread(threadId, projectId, {
        before: options.before,
        cursor: options.cursor,
        fresh: options.requireFresh,
        limit: options.appendOlder ? 160 : 128
      });
      if (viewToken !== threadViewTokenRef.current) {
        return null;
      }
      // A reader can keep scrolling while the older page is in flight. Anchor
      // to the message visible at commit time, not where the request began.
      if (options.appendOlder && manualMessageScrollLockRef.current) conversationVirtualRef.current?.captureHistoryAnchor();
      const current = selectedThreadRef.current;
      const currentHistory = current?.id === response.thread.id ? threadHistoryRef.current : null;
      const preserveLoadedHistory = Boolean(
        !options.appendOlder
        && !options.cursor
        && current
        && currentHistory
        && response.history
        && currentHistory.nextBefore > response.history.nextBefore
      );
      const mergedThread = options.appendOlder && current?.id === response.thread.id
        ? mergeThreadHistoryPages(response.thread, current)
        : preserveLoadedHistory && current
          ? mergeThreadHistoryPages(current, response.thread)
          : response.thread;
      const nextHistory = preserveLoadedHistory && currentHistory && response.history
        ? {
            ...currentHistory,
            totalItems: response.history.totalItems,
            nextBefore: Math.min(
              response.history.totalItems,
              currentHistory.nextBefore + Math.max(0, response.history.totalItems - currentHistory.totalItems)
            ),
            indexState: response.history.indexState
          }
        : response.history ?? null;
      const latestThreadWithStoredModel = sanitizeThreadForRender(applyStoredThreadModelProfile(
        selectedUserId,
        applyThreadListName(response.thread),
        modelProfiles
      ));
      const nextThreadWithStoredModel = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, applyThreadListName(mergedThread), modelProfiles));
      selectedThreadRef.current = nextThreadWithStoredModel;
      setSelectedThread(nextThreadWithStoredModel);
      threadHistoryRef.current = nextHistory;
      setThreadHistory(nextHistory);
      setOpeningThreadId((current) => current === threadId ? null : current);
      if (nextHistory) {
        const cacheKey = `${projectId}:${nextThreadWithStoredModel.id}`;
        threadViewCacheRef.current.delete(cacheKey);
        threadViewCacheRef.current.set(cacheKey, { thread: nextThreadWithStoredModel, history: nextHistory });
        while (threadViewCacheRef.current.size > 12) {
          const oldestKey = threadViewCacheRef.current.keys().next().value;
          if (!oldestKey) {
            break;
          }
          threadViewCacheRef.current.delete(oldestKey);
        }
      }
      if (!options.appendOlder && response.history) {
        threadPageCacheRef.current.set(`${projectId}:${threadId}`, {
          thread: latestThreadWithStoredModel,
          history: response.history,
          cachedAt: Date.now()
        });
      }
      const now = Date.now();
      setPendingUserMessages((current) => current.filter((entry) => {
        if (entry.threadId && entry.threadId !== nextThreadWithStoredModel.id) {
          return true;
        }
        const attachedToLoadedTurn = Boolean(entry.turnId && nextThreadWithStoredModel.turns.some((turn) => turn.id === entry.turnId));
        return (!attachedToLoadedTurn && entry.keepAtBottomUntil > now) || !threadHasUserText(nextThreadWithStoredModel, entry.text);
      }));
      return nextThreadWithStoredModel;
    } catch (caught) {
      if (viewToken === threadViewTokenRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setOpeningThreadId((current) => current === threadId ? null : current);
      }
      return null;
    }
  }

  async function openGlobalSearchResult(result: GlobalSearchResult) {
    try { window.sessionStorage.removeItem(`codex-web-active-diff:${selectedUserId}`); } catch { /* Storage can be disabled. */ }
    const viewToken = ++threadViewTokenRef.current;
    newThreadDraftModeRef.current = false;
    searchProjectNavigationRef.current = initializedProjectIdRef.current !== result.project.id
      ? { projectId: result.project.id, viewToken } : null;
    threadProjectIdsRef.current.set(result.thread.id, result.project.id);
    setError("");
    setDiffReview(null);
    setDiffPanelVisible(false);
    selectedThreadRef.current = null;
    setSelectedThread(null);
    searchNavigationLockUntilRef.current = Date.now() + 5_000;
    manualMessageScrollLockRef.current = true;
    autoFollowMessagesRef.current = false;
    selectedProjectIdRef.current = result.project.id;
    setSelectedProjectId(result.project.id);
    setThreadSearch("");
    setGlobalSearchOpen(false);
    setGlobalSearchQuery("");
    const match = result.match ?? null;
    clearSearchHighlights();
    setThreadSearchPanel(match ? {
      threadId: result.thread.id, projectId: result.project.id, query: match.query,
      hits: [], total: 0, index: 0, loading: true, selectedItemId: match.itemId, refreshKey: 0
    } : null);
    const selected = await openThread(result.thread.id, result.project.id, viewToken, match?.cursor ? {
      cursor: typeof match.ordinal === "number" ? searchWindowCursor(result.thread.id, match.ordinal) : match.cursor,
      skipCache: true
    } : {});
    if (!selected || selected.id !== result.thread.id) {
      return;
    }
    if (match) {
      const found = await revealGlobalSearchMatch(match);
      if (!found) {
        const fallback = match.query ? `“${match.query}”` : "目标内容";
        setGlobalSearchJumpNoticeWithFade(`已打开会话，但未找到匹配消息：${fallback}`);
      }
      return;
    }
    setGlobalSearchJumpNoticeWithFade(`已打开会话：${selected.name || selected.preview || "未命名会话"}`);
  }

  function maybeLoadOlderHistory() {
    const messages = messagesRef.current;
    if (!messages || messages.scrollTop > Math.max(520, messages.clientHeight * 0.75)
      || Date.now() < olderHistoryNextEligibleAtRef.current
      || olderHistoryLoadingRef.current || olderHistoryRearmPendingRef.current
      || olderHistoryLoadFailed || !threadHistoryRef.current?.hasOlder) {
      return;
    }
    const rearmTop = olderHistoryRearmTopRef.current;
    if (rearmTop !== null) {
      if (rearmTop <= 1 && messages.scrollTop > 140) {
        // A failed anchor can leave the scrollport at zero. Let a deliberate
        // down-then-up gesture rearm pagination without chaining by itself.
        olderHistoryRearmTopRef.current = messages.scrollTop;
        return;
      }
      if (messages.scrollTop > rearmTop - 72) return;
      olderHistoryRearmTopRef.current = null;
    }
    void loadOlderHistory();
  }

  async function loadOlderHistory() {
    const thread = selectedThreadRef.current;
    const projectId = selectedProjectIdRef.current;
    const history = threadHistoryRef.current;
    if (!thread?.id || !projectId || !history?.hasOlder || olderHistoryLoadingRef.current) {
      return;
    }

    olderHistoryLoadingRef.current = true;
    olderHistoryNextEligibleAtRef.current = Date.now() + 800;
    olderHistoryRearmPendingRef.current = true;
    olderHistoryRearmTopRef.current = null;
    manualMessageScrollLockRef.current = true;
    autoFollowMessagesRef.current = false;
    conversationVirtualRef.current?.captureHistoryAnchor();
    setLoadingOlderHistory(true);
    setOlderHistoryLoadFailed(false);
    setError("");
    const viewToken = threadViewTokenRef.current;
    try {
      const loaded = await openThread(thread.id, projectId, viewToken, {
        before: history.nextBefore,
        cursor: history.nextCursor ?? undefined,
        appendOlder: true
      });
      if (!loaded && viewToken === threadViewTokenRef.current && selectedThreadRef.current?.id === thread.id) {
        setOlderHistoryLoadFailed(true);
      }
    } finally {
      // An old request can finish after another thread has started paginating.
      // It must not unlock that new request or clear its loading indicator.
      if (viewToken !== threadViewTokenRef.current || selectedThreadRef.current?.id !== thread.id) return;
      olderHistoryLoadingRef.current = false;
      olderHistoryNextEligibleAtRef.current = Date.now() + 950;
      setLoadingOlderHistory(false);
      window.setTimeout(() => {
        if (viewToken !== threadViewTokenRef.current || selectedThreadRef.current?.id !== thread.id) return;
        olderHistoryRearmTopRef.current = messagesRef.current?.scrollTop ?? 0;
        olderHistoryRearmPendingRef.current = false;
      }, 750);
    }
  }

  function applyThreadModelProfile(threadId: string, model: string, reasoningEffort: ReasoningEffort) {
    setThreads((current) => {
      const next = current.map((thread) => (
        thread.id === threadId
          ? { ...thread, configuredModel: model, configuredReasoningEffort: reasoningEffort }
          : thread
      ));
      threadsRef.current = next;
      return next;
    });
    if (selectedThreadRef.current?.id === threadId) {
      const nextThread = {
        ...selectedThreadRef.current,
        configuredModel: model,
        configuredReasoningEffort: reasoningEffort
      };
      selectedThreadRef.current = nextThread;
      setSelectedThread(nextThread);
    }
  }

  async function changeConversationModelProfile(nextProfileId: string) {
    const profile = modelProfileById(nextProfileId, modelProfiles);
    const thread = selectedThreadRef.current;
    if (!thread?.id) {
      setNewThreadModelProfileId(profile.id);
      if (selectedProjectIdRef.current) {
        window.localStorage.setItem(modelPreferenceStorageKey(selectedUserId, selectedProjectIdRef.current), profile.id);
      }
      return;
    }
    const projectId = selectedProjectIdRef.current;
    if (!projectId || savingThreadModel) {
      return;
    }
    const previousModel = thread.configuredModel ?? selectedProject?.defaultModel ?? profile.model;
    const previousEffort = thread.configuredReasoningEffort ?? selectedProject?.defaultReasoningEffort ?? profile.effort;
    setError("");
    setSavingThreadModel(true);
    setNewThreadModelProfileId(profile.id);
    window.localStorage.setItem(modelPreferenceStorageKey(selectedUserId, projectId), profile.id);
    window.localStorage.setItem(threadModelPreferenceStorageKey(selectedUserId, thread.id), profile.id);
    applyThreadModelProfile(thread.id, profile.model, profile.effort);
    try {
      const response = await updateThreadModelProfile(projectId, thread.id, {
        model: profile.model,
        reasoningEffort: profile.effort
      });
      applyThreadModelProfile(thread.id, response.data.model ?? profile.model, response.data.reasoningEffort ?? profile.effort);
    } catch (caught) {
      applyThreadModelProfile(thread.id, previousModel, previousEffort);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingThreadModel(false);
    }
  }

  async function connectProjectDirectory(rootPath: string) {
    const existingProject = projects.find((project) => project.rootPath === rootPath);
    if (existingProject) {
      setPendingDeleteProjectId(null);
      setSelectedThread(null);
      setThreads([]);
      setSelectedProjectId(existingProject.id);
      return;
    }

    try {
      const response = await createProject({
        name: projectNameFromPath(rootPath),
        rootPath,
        defaultModel: draftModelProfile.model,
        defaultReasoningEffort: draftModelProfile.effort,
        defaultSandbox: sandbox,
        defaultApprovalPolicy: approvalPolicy
      });
      setProjects((current) => [response.data, ...current.filter((project) => project.id !== response.data.id)]);
      setPendingDeleteProjectId(null);
      setSelectedProjectId(response.data.id);
      setSelectedThread(null);
      setThreads([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function openDirectoryBrowser(directoryPath?: string) {
    setDirectoryBrowser(null);
    setDirectoryBrowserLoading(true);
    setDirectoryBrowserOpen(true);
    setError("");
    try {
      const response = await listDirectories(directoryPath);
      setDirectoryBrowser(response.data);
    } catch (caught) {
      setDirectoryBrowserOpen(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDirectoryBrowserLoading(false);
    }
  }

  async function connectCurrentDirectory() {
    if (!directoryBrowser) {
      return;
    }
    await connectProjectDirectory(directoryBrowser.currentPath);
    setDirectoryBrowserOpen(false);
  }

  async function chooseDirectory() {
    setSelectingDirectory(true);
    setError("");
    try {
      if (!systemDirectoryPickerAvailable) {
        await openDirectoryBrowser(projectRoot);
        return;
      }
      const response = await selectDirectory();
      await connectProjectDirectory(response.data.rootPath);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes("system-directory-picker-unavailable")) {
        await openDirectoryBrowser(projectRoot);
        return;
      }
      if (!message.includes("canceled")) {
        setError(message);
      }
    } finally {
      setSelectingDirectory(false);
    }
  }

  async function removeProject(project: Project) {
    try {
      setError("");
      await deleteProject(project.id);
      if (selectedProjectId === project.id) {
        setSelectedProjectId("");
        setSelectedThread(null);
        setThreads([]);
      }
      setExpandedProjectIds((current) => {
        const next = current.filter((id) => id !== project.id);
        window.localStorage.setItem(sidebarExpandedProjectsKey(selectedUserId), JSON.stringify(next));
        return next;
      });
      setPendingDeleteProjectId(null);
      setProjects((current) => current.filter((entry) => entry.id !== project.id));
      await refreshProjects();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function requestRemoveProject(project: Project) {
    if (pendingDeleteProjectId !== project.id) {
      setPendingDeleteProjectId(project.id);
      return;
    }
    void removeProject(project);
  }

  function beginProjectRename(project: Project) {
    setPendingDeleteProjectId(null);
    setError("");
    setProjectRenameDraft(project.name);
    setRenamingProject(project);
  }

  function closeProjectRename() {
    if (renamingProjectId) {
      return;
    }
    setRenamingProject(null);
    setProjectRenameDraft("");
  }

  async function submitProjectRename() {
    const project = renamingProject;
    const name = projectRenameDraft.trim();
    if (!project || !name) {
      setError("请输入工作区名称。");
      return;
    }
    if (name.length > 120) {
      setError("工作区名称最多 120 个字符。");
      return;
    }
    if (name === project.name) {
      setRenamingProject(null);
      setProjectRenameDraft("");
      return;
    }

    setRenamingProjectId(project.id);
    try {
      setError("");
      const response = await updateProject(project.id, { name });
      setProjects((current) => current.map((entry) => (entry.id === project.id ? response.data : entry)));
      setRenamingProject(null);
      setProjectRenameDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRenamingProjectId(null);
    }
  }

  async function handleFileUpload(files: FileList | readonly File[] | null) {
    if (!files?.length) {
      return;
    }
    if (!selectedProject) {
      setError("请先选择一个项目，再上传文件。");
      return;
    }
    const projectId = selectedProject.id;
    const sourceFiles = Array.from(files);
    const uploadBatchId = requestToken();
    const pendingUploads = sourceFiles.map((sourceFile, index): ComposerUpload => ({
      name: sourceFile.name || `粘贴图片-${index + 1}.png`,
      path: "",
      relativePath: `__uploading__/${uploadBatchId}/${index}/${sourceFile.name || "clipboard.png"}`,
      size: sourceFile.size,
      mime: sourceFile.type || "application/octet-stream",
      rawUrl: "",
      sourceFile,
      isImage: sourceFile.type.startsWith("image/") || isInlineImageTarget(sourceFile.name),
      uploading: true,
    }));
    setUploadedFiles((current) => [...current, ...pendingUploads]);
    setUploadingFiles(true);
    setError("");
    try {
      const response = await uploadProjectFiles(projectId, sourceFiles);
      if (selectedProjectIdRef.current !== projectId) {
        setUploadedFiles((current) => current.filter((file) => !pendingUploads.some((pending) => pending.relativePath === file.relativePath)));
        return;
      }
      const uploads = response.data.map((file, index): ComposerUpload => {
        const sourceFile = sourceFiles[index] ?? null;
        return {
          ...file,
          sourceFile,
          isImage: isImageComposerUpload(file, sourceFile),
          uploading: false,
        };
      });
      setUploadedFiles((current) => current.flatMap((file) => {
        const pendingIndex = pendingUploads.findIndex((pending) => pending.relativePath === file.relativePath);
        return pendingIndex >= 0 && uploads[pendingIndex] ? [uploads[pendingIndex]!] : [file];
      }));
    } catch (caught) {
      setUploadedFiles((current) => current.filter((file) => !pendingUploads.some((pending) => pending.relativePath === file.relativePath)));
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setUploadingFiles(false);
      setDraggingUpload(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function removeUploadedFile(relativePath: string) {
    const removed = uploadedFiles.find((file) => file.relativePath === relativePath);
    setUploadedFiles((current) => current.filter((file) => file.relativePath !== relativePath));
    if (removed) {
      setExitingUploads((current) => [...current.filter((file) => file.relativePath !== relativePath), removed]);
      window.setTimeout(() => {
        setExitingUploads((current) => current.filter((file) => file.relativePath !== relativePath));
      }, 280);
    }
  }

  function handleUploadDragOver(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = selectedProject ? "copy" : "none";
    if (selectedProject && !uploadingFiles) {
      setDraggingUpload(true);
    }
  }

  function handleUploadDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingUpload(false);
    }
  }

  function handleUploadDrop(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    const files = event.dataTransfer.files;
    setDraggingUpload(false);
    void handleFileUpload(files);
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    // The editor handles plain text. File-bearing pastes are intercepted in
    // capture phase, before a browser/ProseMirror image can flash at full size.
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length) {
      void handleFileUpload(files);
    }
  }

  function closeFilePreview() {
    if (runnablePreview) {
      setRunnablePreview(null);
      return;
    }
    filePreviewRequestIdRef.current += 1;
    setFilePreview(null);
    setFilePreviewError("");
    setFilePreviewLoading(false);
    setFilePreviewObjectUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return "";
    });
  }

  const openFilePreview = useCallback(async (filePath: string, galleryTargets?: string[]) => {
    setRunnablePreview(null);
    const projectId = selectedProject?.id;
    if (!projectId) {
      return;
    }
    const requestId = ++filePreviewRequestIdRef.current;
    if (isInlineImageTarget(filePath)) {
      if (imageViewerCloseTimerRef.current !== null) window.clearTimeout(imageViewerCloseTimerRef.current);
      const targets = Array.from(new Set([...(galleryTargets ?? []).filter(isInlineImageTarget), filePath])).slice(0, 32);
      setImageGallery({ projectId, targets, index: targets.indexOf(filePath) });
      setImageViewerClosing(false);
      setImageViewerActionsOpen(false);
      setImageViewerReady(false);
      setImageViewerError(false);
      setImageViewerRetry(0);
      setImageViewerZoom(1);
      setImageViewerNaturalSize({ width: 0, height: 0 });
      setImageViewerStageSize({ width: 0, height: 0 });
      setImageViewerPrevious(null);
      setFilePreview(null);
      setFilePreviewLoading(false);
      setFilePreviewError("");
      return;
    }
    setImageGallery(null);
    setFilePreviewLoading(true);
    setImagePreviewMode("fit");
    setFilePreviewError("");
    setFilePreview(null);
    setFilePreviewObjectUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return "";
    });
    try {
      const response = await previewProjectFile(projectId, filePath);
      if (requestId !== filePreviewRequestIdRef.current) return;
      setFilePreview(response.data);
      if (response.data.kind === "image" || response.data.kind === "video" || response.data.kind === "pdf") {
        const blob = await fetchProjectFileBlob(projectId, response.data.relativePath);
        if (requestId !== filePreviewRequestIdRef.current) return;
        setFilePreviewObjectUrl(URL.createObjectURL(blob));
      }
    } catch (caught) {
      if (requestId === filePreviewRequestIdRef.current) setFilePreviewError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestId === filePreviewRequestIdRef.current) setFilePreviewLoading(false);
    }
  }, [selectedProject?.id]);

  const activeImageTarget = imageGallery?.targets[imageGallery.index] ?? "";
  const activeImageUrl = imageGallery && activeImageTarget ? rawFileUrlForProject(imageGallery.projectId, activeImageTarget) : "";
  const imageViewerFitScale = imageViewerNaturalSize.width && imageViewerNaturalSize.height && imageViewerStageSize.width && imageViewerStageSize.height
    ? Math.min(1, Math.max(1, imageViewerStageSize.width - 48) / imageViewerNaturalSize.width, Math.max(1, imageViewerStageSize.height - 48) / imageViewerNaturalSize.height)
    : 1;
  const imageViewerScale = imageViewerFitScale * imageViewerZoom;
  const imageViewerDisplayReady = imageViewerReady && imageViewerStageSize.width > 0 && imageViewerStageSize.height > 0;

  function closeImageViewer() {
    if (!imageGallery || imageViewerClosing) return;
    setImageViewerClosing(true);
    setImageViewerActionsOpen(false);
    if (imageViewerCloseTimerRef.current !== null) window.clearTimeout(imageViewerCloseTimerRef.current);
    if (imageViewerPreviousTimerRef.current !== null) window.clearTimeout(imageViewerPreviousTimerRef.current);
    imageViewerCloseTimerRef.current = window.setTimeout(() => {
      setImageGallery(null);
      setImageViewerPrevious(null);
      imageViewerPreloadsRef.current.clear();
      setImageViewerClosing(false);
      imageViewerCloseTimerRef.current = null;
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260);
  }

  function moveImageViewer(direction: -1 | 1) {
    if (!imageGallery || imageGallery.index + direction < 0 || imageGallery.index + direction >= imageGallery.targets.length) return;
    if (imageViewerPreviousTimerRef.current !== null) window.clearTimeout(imageViewerPreviousTimerRef.current);
    setImageViewerPrevious(imageViewerReady && imageViewerNaturalSize.width
      ? { src: activeImageUrl, width: imageViewerNaturalSize.width * imageViewerScale, height: imageViewerNaturalSize.height * imageViewerScale }
      : null);
    setImageGallery((current) => {
      if (!current) return current;
      const index = current.index + direction;
      return index < 0 || index >= current.targets.length ? current : { ...current, index };
    });
    setImageViewerActionsOpen(false);
    setImageViewerReady(false);
    setImageViewerError(false);
    setImageViewerZoom(1);
    setImageViewerNaturalSize({ width: 0, height: 0 });
    imageViewerStageRef.current?.scrollTo({ left: 0, top: 0 });
  }

  useEffect(() => {
    if (!imageGallery) return;
    const stage = imageViewerStageRef.current;
    if (!stage) return;
    const sync = () => setImageViewerStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [Boolean(imageGallery)]);

  useEffect(() => {
    if (!imageGallery || !imageViewerReady) return;
    for (const index of [imageGallery.index - 1, imageGallery.index + 1]) {
      const target = imageGallery.targets[index];
      if (!target) continue;
      const url = rawFileUrlForProject(imageGallery.projectId, target);
      if (imageViewerPreloadsRef.current.has(url)) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      imageViewerPreloadsRef.current.set(url, image);
      void image.decode().catch(() => undefined);
    }
    while (imageViewerPreloadsRef.current.size > 4) {
      const oldest = imageViewerPreloadsRef.current.keys().next().value;
      if (!oldest) break;
      imageViewerPreloadsRef.current.delete(oldest);
    }
  }, [imageGallery?.projectId, imageGallery?.index, imageGallery?.targets, imageViewerReady]);

  useEffect(() => {
    if (!imageGallery) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeImageViewer(); }
      if (event.key === "ArrowLeft") { event.preventDefault(); moveImageViewer(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); moveImageViewer(1); }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); setImageViewerZoom((current) => Math.min(Math.max(16, 1 / imageViewerFitScale), current * 1.25)); }
      if (event.key === "-") { event.preventDefault(); setImageViewerZoom((current) => Math.max(.25, current / 1.25)); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imageGallery, imageViewerClosing, imageViewerFitScale]);

  useEffect(() => () => {
    if (imageViewerCloseTimerRef.current !== null) window.clearTimeout(imageViewerCloseTimerRef.current);
    if (imageViewerPreviousTimerRef.current !== null) window.clearTimeout(imageViewerPreviousTimerRef.current);
  }, []);

  async function refreshLocalSendSettings(showErrors = false) {
    try {
      const response = await readLocalSendSettings();
      const detectedHost = response.detectedClientHost ?? "";
      const next = suggestLocalSendSettings(response.data, detectedHost, selectedUserId);
      localSendSettingsRef.current = next;
      setLocalSendSettings(next);
      setDetectedClientHost(detectedHost);
      return next;
    } catch (caught) {
      if (showErrors) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      return null;
    }
  }

  async function openSettingsDialog() {
    setSettingsOpen(true);
    setError("");
    setSettingsTestStatus(null);
    await refreshLocalSendSettings(true);
  }

  async function togglePushNotifications() {
    if (!nativeFeaturesReady) {
      setError("网页推送接口等待后端服务安全重启后启用。");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setError("此浏览器不支持网页推送；iPhone 请先将网页添加到主屏幕，再在主屏幕中开启。");
      return;
    }
    setPushSaving(true);
    setError("");
    try {
      if (!pushEnabled) {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("浏览器没有授权通知；请在浏览器设置中允许此站点通知。");
      }
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const existing = await registration.pushManager.getSubscription();
      if (pushEnabled) {
        if (existing) {
          await removePushSubscription(existing.endpoint);
          await existing.unsubscribe();
        }
        window.localStorage.setItem(`codex-web-push:${selectedUserId}`, "false");
        setPushEnabled(false);
        return;
      }
      const { data } = await getPushPublicKey();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushKeyBytes(data.publicKey)
      });
      await savePushSubscription(subscription.toJSON());
      window.localStorage.setItem(`codex-web-push:${selectedUserId}`, "true");
      setPushEnabled(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPushSaving(false);
    }
  }

  async function unsubscribePushAndLogout() {
    try {
      const registration = await navigator.serviceWorker?.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await removePushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
    } catch { /* Logout must never be blocked by optional push cleanup. */ }
    window.localStorage.removeItem(`codex-web-push:${selectedUserId}`);
    window.location.assign("/logout");
  }

  function answerApproval(id: string | number, decision: "accept" | "decline") {
    try {
      const requestId = `approval-${requestToken()}`;
      const pending = pendingApprovals[String(id)];
      if (pending) approvalResponseRequestsRef.current.set(requestId, pending);
      codexSocket.send({ type: "approval.respond", requestId, codexRequestId: id, result: { decision } });
      setPendingApprovals((current) => {
        const next = { ...current };
        delete next[String(id)];
        return next;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function updateLocalSendSetting<K extends keyof LocalSendSettings>(key: K, value: LocalSendSettings[K]) {
    setLocalSendSettings((current) => {
      const next = { ...current, [key]: value };
      localSendSettingsRef.current = next;
      return next;
    });
    setSettingsTestStatus(null);
  }

  function updateAutoSendGeneratedFiles(enabled: boolean) {
    autoSendEnabledRef.current = enabled;
    setAutoSendGeneratedFiles(enabled);
    try {
      window.localStorage.setItem(autoSendPreferenceStorageKey(selectedUserId), String(enabled));
    } catch {
      // Private browsing may reject localStorage writes; the current tab still
      // retains the selected preference through React state.
    }
  }

  function localSendSettingsInput(settings = localSendSettings) {
    return {
      sshHost: settings.sshHost,
      sshPort: Number(settings.sshPort) || 22,
      sshUser: settings.sshUser,
      destinationPath: settings.destinationPath,
      identityFile: settings.identityFile,
      outputPath: settings.outputPath
    };
  }

  async function persistLocalSendSettings(settings = localSendSettings) {
    const response = await updateLocalSendSettings(localSendSettingsInput(settings));
    localSendSettingsRef.current = response.data;
    setLocalSendSettings(response.data);
    return response.data;
  }

  async function applySuggestedLocalSendSettings() {
    const suggested = suggestLocalSendSettings(localSendSettingsRef.current, detectedClientHost, selectedUserId);
    localSendSettingsRef.current = suggested;
    setLocalSendSettings(suggested);
    setSettingsTesting(true);
    setError("");
    setSettingsTestStatus(null);
    let persisted = false;
    try {
      await persistLocalSendSettings(suggested);
      persisted = true;
      const response = await testLocalSendSettings();
      const target = response.data;
      setSettingsTestStatus({
        kind: "success",
        message: `本机发送已配置且 SSH 可写入：${target.sshUser}@${target.sshHost}:${target.destinationPath}`
      });
    } catch (caught) {
      setSettingsTestStatus({
        kind: "error",
        message: `${persisted ? "一键设置已保存，但 SSH 测试失败" : "一键设置失败"}：${caught instanceof Error ? caught.message : String(caught)}${persisted ? "。请确认 SSH 用户名与设备上的系统用户名一致。" : ""}`
      });
    } finally {
      setSettingsTesting(false);
    }
  }

  async function saveLocalSendSettings() {
    setSettingsSaving(true);
    setError("");
    setSettingsTestStatus(null);
    try {
      const saved = await persistLocalSendSettings();
      const currentThread = selectedThreadRef.current;
      if (currentThread?.id) {
        addLocalMessage(
          `访问设备发送设置已保存：${saved.sshUser}@${saved.sshHost || detectedClientHost || "当前访问 IP"}:${saved.destinationPath}`,
          "Codex Web · settings",
          "system",
          undefined,
          {
            placement: "conversation",
            threadId: currentThread.id,
            afterTurnId: currentThread.turns.at(-1)?.id ?? null
          }
        );
      }
      setSettingsOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function verifyLocalSendSettings() {
    setSettingsTesting(true);
    setError("");
    setSettingsTestStatus(null);
    try {
      await persistLocalSendSettings();
      const response = await testLocalSendSettings();
      const target = response.data;
      setSettingsTestStatus({
        kind: "success",
        message: `已保存且 SSH 可写入：${target.sshUser}@${target.sshHost}:${target.destinationPath}`
      });
    } catch (caught) {
      setSettingsTestStatus({
        kind: "error",
        message: `SSH 测试失败：${caught instanceof Error ? caught.message : String(caught)}`
      });
    } finally {
      setSettingsTesting(false);
    }
  }

  async function sendPreviewFileToLocal() {
    const projectId = imageGallery?.projectId ?? selectedProject?.id;
    const filePath = activeImageTarget || filePreview?.relativePath;
    if (!projectId || !filePath) {
      return;
    }
    setSendingLocalFile(true);
    setError("");
    try {
      const response = await sendProjectFileToLocal(projectId, filePath);
      addLocalMessage(
        `已通过 SSH 发送到当前访问设备：
- 源文件：${response.data.sourcePath}
- 访问设备：${response.data.sshUser}@${response.data.sshHost}:${response.data.remoteFile}`,
        "Codex Web · file transfer",
        "tool"
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSendingLocalFile(false);
    }
  }

  async function shareOrDownloadPreviewFile() {
    const projectId = imageGallery?.projectId ?? selectedProject?.id;
    const filePath = activeImageTarget || filePreview?.relativePath;
    const fileName = activeImageTarget ? compactFileLabel(activeImageTarget) : filePreview?.name;
    if (!projectId || !filePath || !fileName) {
      return;
    }
    setSharingBrowserFile(true);
    setError("");
    try {
      const blob = !activeImageTarget && filePreviewObjectUrl
        ? await fetch(filePreviewObjectUrl).then((response) => response.blob())
        : await fetchProjectFileBlob(projectId, filePath);
      const file = new File([blob], fileName, { type: filePreview?.mime || blob.type || "application/octet-stream" });
      const shareData: ShareData = { files: [file], title: fileName };
      const canShareFile = typeof navigator.share === "function"
        && (typeof navigator.canShare !== "function" || navigator.canShare(shareData));
      if (canShareFile) {
        try {
          await navigator.share(shareData);
          return;
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === "AbortError") {
            return;
          }
        }
      }

      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = fileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSharingBrowserFile(false);
    }
  }

  async function autoSendGeneratedFilesForThread(threadId: string, projectId: string, afterTurnId: string | null = null) {
    const settings = localSendSettingsRef.current;
    if (
      !autoSendEnabledRef.current ||
      !settings.updatedAt ||
      !settings.sshUser.trim() ||
      !settings.destinationPath.trim()
    ) {
      return;
    }

    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) {
      return;
    }

    let response;
    try {
      response = await readThread(threadId, projectId);
    } catch {
      // A just-completed turn can take a moment to appear in the persisted
      // JSONL file; the scheduled retry below handles that case.
      return;
    }

    // The completed notification can arrive before the first UI refresh sees
    // the newly persisted turn. Refresh the open view from this successful
    // read so the delivery status has its source turn available as an anchor.
    if (selectedThreadRef.current?.id === threadId) {
      void openThread(threadId, projectId, threadViewTokenRef.current);
    }

    const candidates = generatedFileCandidatesFromThread(response.thread, project.rootPath)
      .filter((candidate) => !afterTurnId || candidate.turnId === afterTurnId);
    let nextIndex = 0;
    const transferOne = async () => {
      for (;;) {
        const candidate = candidates[nextIndex++];
        if (!candidate) {
          return;
        }
        const key = `${threadId}\u0000${candidate.target}`;
        if (autoSentGeneratedFileKeysRef.current.has(key) || autoSendInFlightFileKeysRef.current.has(key)) {
          continue;
        }
        autoSendInFlightFileKeysRef.current.add(key);
        try {
          const sent = await sendProjectFileToLocal(project.id, candidate.target);
          autoSentGeneratedFileKeysRef.current.add(key);
          addLocalMessage(
            `已自动通过 SSH 发送生成文件：\n- ${sent.data.name}\n- 访问设备：${sent.data.sshUser}@${sent.data.sshHost}:${sent.data.remoteFile}`,
            "Codex Web · 自动发送",
            "tool",
            undefined,
            {
              placement: "conversation",
              threadId,
              afterTurnId: candidate.turnId ?? afterTurnId ?? response.thread.turns.at(-1)?.id ?? null
            }
          );
        } catch (caught) {
          const failureMessage = caught instanceof Error ? caught.message : String(caught);
          // Completion is checked twice to catch delayed persistence. A missing
          // path is a stale prose/history reference, not a user-facing transfer
          // failure, and must not be retried or injected into the conversation.
          autoSentGeneratedFileKeysRef.current.add(key);
          if (/file does not exist|enoent/i.test(failureMessage)) {
            continue;
          }
          addLocalMessage(
            `自动发送 ${compactFileLabel(candidate.target)} 失败：${failureMessage}`,
            "Codex Web · 自动发送",
            "tool",
            undefined,
            {
              placement: "conversation",
              threadId,
              afterTurnId: candidate.turnId ?? afterTurnId ?? response.thread.turns.at(-1)?.id ?? null
            }
          );
        } finally {
          autoSendInFlightFileKeysRef.current.delete(key);
        }
      }
    };

    // Keep SSH fan-out small so one user's batch of generated files cannot
    // compete with other users' interactive turns on the shared host.
    await Promise.all([transferOne(), transferOne()]);
  }

  function scheduleAutoSendGeneratedFiles(threadId: string, projectId: string, afterTurnId: string | null = null) {
    if (!threadId || !projectId || !autoSendEnabledRef.current) {
      return;
    }
    window.setTimeout(() => void autoSendGeneratedFilesForThread(threadId, projectId, afterTurnId), 900);
    window.setTimeout(() => void autoSendGeneratedFilesForThread(threadId, projectId, afterTurnId), 2_800);
  }


  async function exportCurrentThread(sendLocal = exportSendLocal, format = exportFormat) {
    if (!selectedProject || !selectedThread) {
      setError("请先选择一个会话再导出记录。");
      return;
    }
    setExportingThread(true);
    setError("");
    try {
      const response = await exportThreadRecord(selectedProject.id, selectedThread.id, {
        format,
        sendLocal,
        outputPath: localSendSettings.outputPath || undefined,
        destinationPath: localSendSettings.destinationPath || undefined
      });
      const exported = response.data;
      const localLine = exported.sentLocal
        ? `
- 已发送到当前访问设备：${exported.sentLocal.sshUser}@${exported.sentLocal.sshHost}:${exported.sentLocal.remoteFile}`
        : "";
      addLocalMessage(
        `对话记录已导出：
- [${exported.name}](${exported.relativePath})
- 4090-left 临时中转路径：${exported.path}${localLine}`,
        "Codex Web · export",
        "tool"
      );
      void openFilePreview(exported.relativePath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExportingThread(false);
    }
  }

  useEffect(() => {
    if (handledLocationFileTarget || !selectedProject || typeof window === "undefined") {
      return;
    }
    const target = fileTargetFromHref(window.location.href);
    if (!target || !target.startsWith(selectedProject.rootPath)) {
      return;
    }
    setHandledLocationFileTarget(true);
    window.history.replaceState(null, "", "/");
    void openFilePreview(target);
  }, [handledLocationFileTarget, selectedProjectId]);

  async function handleSlashCommand(promptText: string): Promise<boolean> {
    if (!promptText.startsWith("/") || uploadedFiles.length) {
      return false;
    }
    const match = promptText.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      return false;
    }
    const command = match[1].toLowerCase();
    const argument = (match[2] ?? "").trim();

    if (!localSlashCommands.has(command)) {
      return false;
    }

    if (command === "help" || command === "?") {
      addLocalMessage(commandHelpMarkdown());
      setPrompt("");
      return true;
    }
    if (command === "plan") {
      setPlanMode(true);
      setPrompt(argument);
      return true;
    }
    if (command === "fast") {
      const next = !codexFastModeEnabled;
      setCodexFastModeEnabled(next);
      window.localStorage.setItem(codexFastModeStorageKey(selectedUserId), String(next));
      setPrompt("");
      return true;
    }
    if (command === "quota" || command === "usage") {
      setPrompt("");
      await refreshQuota(true);
      return true;
    }
    if (command === "skills") {
      setPrompt("");
      await openSkillsPicker(true);
      return true;
    }
    if (command === "skill") {
      const [skillName] = argument.split(/\s+/, 1);
      const skillTask = skillName ? argument.slice(skillName.length).trim() : "";
      if (!skillName) {
        addLocalMessage("用法：`/skill skill-name`，例如 `/skill imagegen`。也可以 `/skill imagegen 生成一张小狗图片`。");
        setPrompt("");
        return true;
      }
      const availableSkills = skills.length ? skills : await refreshSkills(selectedProjectIdRef.current, false, false);
      const skill = availableSkills.find((entry) => entry.name === skillName || entry.displayName.toLowerCase() === skillName.toLowerCase());
      if (!skill) {
        addLocalMessage(`没有找到技能：\`${skillName}\`。使用 \`/skills\` 打开技能选择器。`);
        setPrompt(skillTask);
        return true;
      }
      setSelectedSkillNames((current) => current.includes(skill.name) ? current : [...current, skill.name]);
      setPrompt(skillTask);
      setSkillsPickerOpen(false);
      return true;
    }
    if (command === "new") {
      resetToNewThread(true);
      return true;
    }
    if (command === "send") {
      if (!selectedProject || !argument) {
        addLocalMessage("用法：`/send 文件路径`，先在设置里填写 SSH 用户名和当前访问设备保存目录。");
        setPrompt("");
        return true;
      }
      try {
        const response = await sendProjectFileToLocal(selectedProject.id, argument);
        addLocalMessage(
          `已通过 SSH 发送到当前设备：\n- 源文件：${response.data.sourcePath}\n- 访问设备：${response.data.sshUser}@${response.data.sshHost}:${response.data.remoteFile}`,
          "Codex Web · file transfer",
          "tool"
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      setPrompt("");
      return true;
    }
    if (command === "stop" || command === "interrupt") {
      const activeTurnId = getRunningTurnIdForThread(selectedThread);
      const projectId = selectedProject?.id || (selectedThread?.id ? threadProjectIdsRef.current.get(selectedThread.id) : undefined) || selectedProjectIdRef.current;
      if (!projectId || !selectedThread?.id || !activeTurnId) {
        setPrompt("");
        return true;
      }
      interruptCurrentTurn(selectedThread.id, activeTurnId, projectId);
      setPrompt("");
      return true;
    }
    if (command === "goal-stop" || command === "goalstop") {
      if (!selectedThread?.id) {
        addLocalMessage("/goal-stop 需要先打开一个已有会话。");
        setPrompt("");
        return true;
      }
      const requestId = `goal-clear-${requestToken()}`;
      codexSocket.send({
        type: "goal.clear",
        requestId,
        userId: selectedUserId,
        threadId: selectedThread.id
      });
      addLocalMessage("已请求彻底结束当前 Goal；现有轮次会停止，之后不会再自动续跑。", "Codex Web · Goal");
      setPrompt("");
      return true;
    }
    if (command === "goal") {
      if (!selectedThread?.id || !argument) {
        addLocalMessage("用法：`/goal 目标`，需要先打开一个会话并提供持续目标。");
        setPrompt("");
        return true;
      }
      const requestId = `goal-set-${requestToken()}`;
      codexSocket.send({
        type: "goal.set",
        requestId,
        userId: selectedUserId,
        threadId: selectedThread.id,
        objective: argument,
        status: "active"
      });
      addLocalMessage(`已设置并启动原生 Goal：${argument}`, "Codex Web · Goal");
      setPrompt("");
      return true;
    }
    if (command === "compact") {
      if (!selectedProject || !selectedThread?.id) {
        addLocalMessage("/compact 需要先打开一个当前用户自己的会话。");
        setPrompt("");
        return true;
      }
      const requestId = `slash-${requestToken()}`;
      codexSocket.send({ type: "thread.compact", requestId, projectId: selectedProject.id, threadId: selectedThread.id });
      addLocalMessage("已请求 Codex 压缩当前会话上下文。", "Codex Web · command");
      setPrompt("");
      return true;
    }
    if (command === "status") {
      setPrompt("");
      await showThreadStatus();
      return true;
    }
    if (command === "review") {
      if (!selectedProject || !selectedThread?.id) {
        addLocalMessage("请先打开一个会话，再使用 `/review` 或 `/review 分支名`。", "Codex Web · review");
      } else if (argument.includes(" ")) {
        addLocalMessage("用法：`/review` 审查未提交改动，或 `/review 分支名` 与指定分支比较。", "Codex Web · review");
      } else {
        void startNativeReview(argument || undefined);
      }
      setPrompt("");
      return true;
    }
    if (command === "rename") {
      if (!selectedProject || !selectedThread?.id || !argument) {
        addLocalMessage("用法：`/rename 新会话名`，且需要先打开一个会话。");
        setPrompt("");
        return true;
      }
      const requestId = `slash-${requestToken()}`;
      codexSocket.send({ type: "thread.rename", requestId, projectId: selectedProject.id, threadId: selectedThread.id, name: argument });
      addLocalMessage(`已请求重命名为：${argument}`, "Codex Web · command");
      window.setTimeout(() => void refreshThreads(selectedProjectIdRef.current), 500);
      setPrompt("");
      return true;
    }
    if (command === "shell") {
      if (!selectedProject || !selectedThread?.id || !argument) {
        addLocalMessage("用法：`/shell 命令`，且需要先打开一个会话。注意：该命令按 Codex thread shellCommand 执行。 ");
        setPrompt("");
        return true;
      }
      const requestId = `slash-${requestToken()}`;
      const viewToken = threadViewTokenRef.current;
      codexSocket.send({ type: "thread.shellCommand", requestId, projectId: selectedProject.id, threadId: selectedThread.id, command: argument });
      addLocalMessage(`已发送 shell command 到当前 Codex thread：\n\n\`\`\`bash\n${argument}\n\`\`\``, "Codex Web · command", "tool");
      window.setTimeout(() => void openThread(selectedThread.id, selectedProject.id, viewToken), 800);
      setPrompt("");
      return true;
    }
    if (command === "cmd") {
      if (!selectedProject || !argument) {
        addLocalMessage("用法：`/cmd 命令`，在当前项目目录直接运行一次 shell 命令。");
        setPrompt("");
        return true;
      }
      const processId = `cmd-${requestToken()}`;
      codexSocket.send({
        type: "command.exec",
        requestId: processId,
        projectId: selectedProject.id,
        processId,
        command: ["bash", "-lc", argument],
        cwd: selectedProject.rootPath,
        sandbox,
        tty: false,
        disableTimeout: false
      });
      addLocalMessage(`$ ${argument}\n`, "Codex Web · command", "tool", processId);
      setPrompt("");
      return true;
    }

    return false;
  }

  function requestQueuedSubmissions(threadId: string) {
    try {
      codexSocket.send({ type: "turn.queue.list", requestId: `queue-list-${requestToken()}`, threadId });
    } catch {
      // A reconnect will refresh the queue. Never fail rendering the thread.
    }
  }

  function queuedSubmissionText(entry: QueuedSubmission) {
    return skillReferencesInPrompt(entry.input.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ").trim()).body;
  }

  function steerQueuedSubmission(entry: QueuedSubmission) {
    if (!selectedThread?.id || !selectedActiveTurnId) return;
    const requestId = `queue-steer-${requestToken()}`;
    const threadId = selectedThread.id;
    try {
      codexSocket.send({
        type: "turn.queue.steer",
        requestId,
        threadId,
        expectedTurnId: selectedActiveTurnId,
        queuedSubmissionId: entry.id
      });
      pendingQueueSteersRef.current.set(requestId, { threadId, entry });
      setQueuedSubmissions((current) => current.filter((queued) => queued.id !== entry.id));
      setQueuedMenuOpen(false);
      autoFollowMessagesRef.current = true;
      setShowScrollToBottom(false);
      setPendingUserMessages((current) => [...current, {
        id: `user-${requestId}`,
        requestId,
        threadId,
          viewToken: threadViewTokenRef.current,
          text: queuedSubmissionText(entry),
        keepAtBottomUntil: 0
      }]);
      window.requestAnimationFrame(() => scrollMessagesToBottom("smooth"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function updateQueuedSubmission(entry: QueuedSubmission) {
    if (!selectedThread?.id || !queuedEditText.trim()) return;
    try {
      const skillNames = entry.input.flatMap((part) => part.type === "skill" && part.name ? [part.name] : []);
      // The running backend still recognizes skill prefixes on queued edits;
      // the updated backend uses skillNames and removes this compatibility text.
      const queuePrompt = [skillNames.map((name) => `$${name}`).join(" "), queuedEditText.trim()].filter(Boolean).join(" ");
      codexSocket.send({
        type: "turn.queue.update",
        requestId: `queue-update-${requestToken()}`,
        threadId: selectedThread.id,
        queuedSubmissionId: entry.id,
        prompt: queuePrompt,
        skillNames
      });
      setEditingQueuedId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function sendPrompt(mode: "queue" | "steer" = "queue", questionAnswer?: string): Promise<boolean> {
    const isQuestionAnswer = questionAnswer !== undefined;
    const promptText = (questionAnswer ?? prompt).trim();
    if ((!isQuestionAnswer && uploadingFiles) || editingLastPrompt || editingCommitRef.current || !selectedProject || (!promptText && (isQuestionAnswer || !uploadedFiles.length))) {
      return false;
    }
    if (isQuestionAnswer && editingPromptDraft) {
      setError("请先完成或取消当前提问的编辑，再回答选择题。");
      return false;
    }
    if (!isQuestionAnswer && !editingPromptDraft && await handleSlashCommand(promptText)) {
      return true;
    }
    if (planMode && selectedActiveTurnId && !isQuestionAnswer) {
      setError("计划模式请等当前轮次结束后发送；如需排队或立即纠偏，请先关闭计划模式。");
      return false;
    }
    if (editingPromptDraft) {
      if (selectedThread?.id !== editingPromptDraft.threadId || selectedActiveTurnId) {
        setError("原会话仍在运行或已切换，请停止回答并重新打开会话后再发送。");
        return false;
      }
      editingCommitRef.current = true;
      setEditingLastPrompt(true);
      try {
        await editLatestThreadTurn(selectedProject.id, selectedThread.id, editingPromptDraft.turnId);
        setDepartingTurnId(editingPromptDraft.turnId);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        setPendingUserMessages((current) => current.filter((entry) => entry.turnId !== editingPromptDraft.turnId));
        setLiveDeltas((current) => Object.fromEntries(Object.entries(current).filter(([, entry]) => entry.turnId !== editingPromptDraft.turnId)));
        setLiveTools((current) => Object.fromEntries(Object.entries(current).filter(([, entry]) => entry.turnId !== editingPromptDraft.turnId)));
        const revertedThread = { ...selectedThread, turns: selectedThread.turns.filter((turn) => turn.id !== editingPromptDraft.turnId) };
        selectedThreadRef.current = revertedThread;
        setSelectedThread(revertedThread);
        threadPageCacheRef.current.delete(`${selectedProject.id}:${selectedThread.id}`);
        threadViewCacheRef.current.delete(`${selectedProject.id}:${selectedThread.id}`);
        setEditingPromptDraft(null);
        setDepartingTurnId(null);
        void refreshThreads(selectedProject.id);
      } catch (caught) {
        setDepartingTurnId(null);
        setError(`撤回原提问失败，草稿和附件仍保留：${caught instanceof Error ? caught.message : String(caught)}`);
        return false;
      } finally {
        editingCommitRef.current = false;
        setEditingLastPrompt(false);
      }
    }
    const promptUploads = isQuestionAnswer ? [] : [...uploadedFiles];
    const skillNames = isQuestionAnswer ? [] : selectedSkills.map((skill) => skill.name);
    const sentPromptText = promptWithUploadedFiles(promptText, promptUploads);
    const visibleText = visiblePromptText(promptText, promptUploads);
    if (selectedThread && selectedActiveTurnId && mode === "queue") {
      const requestId = `queue-add-${requestToken()}`;
      try {
        codexSocket.send({
          type: "turn.queue.add",
          requestId,
          projectId: selectedProject.id,
          threadId: selectedThread.id,
          prompt: sentPromptText,
          skillNames
        });
        pendingQueuedPromptsRef.current.set(requestId, { threadId: selectedThread.id, text: promptText, uploads: promptUploads });
        setQueuedSubmissions((current) => [...current, { id: `pending:${requestId}`, input: [{ type: "text", text: sentPromptText }, ...skillNames.map((skill) => ({ type: "skill", name: skill }))], clientUserMessageId: requestId }]);
        if (!isQuestionAnswer) {
          setPrompt("");
          setUploadedFiles([]);
          setSelectedSkillNames([]);
        }
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      }
    }
    const requestId = `thread-${requestToken()}`;
    const requestViewToken = threadViewTokenRef.current;
    const keepAtBottomUntil = selectedActiveTurnId ? Date.now() + sentPromptBottomHoldMs : 0;
    newThreadDraftModeRef.current = false;
    promptRequestContextsRef.current.set(requestId, {
      viewToken: requestViewToken,
      projectId: selectedProject.id,
      threadId: selectedThread?.id ?? null,
      model: selectedModelProfile.model,
      reasoningEffort: selectedModelProfile.effort,
      sentPromptText,
      visibleText
    });
    const payload = selectedThread && selectedActiveTurnId && mode === "steer"
      ? {
          type: "turn.steer",
          requestId,
          userId: selectedUserId,
          projectId: selectedProject.id,
          threadId: selectedThread.id,
          expectedTurnId: selectedActiveTurnId,
          prompt: sentPromptText,
          skillNames
        }
      : selectedThread
      ? {
          type: "turn.start",
          requestId,
          userId: selectedUserId,
          projectId: selectedProject.id,
          threadId: selectedThread.id,
          prompt: sentPromptText,
          skillNames,
          model: selectedModelProfile.model,
          reasoningEffort: selectedModelProfile.effort,
          collaborationMode: planMode ? "plan" : "default",
          serviceTier: resolveServiceTier(codexFastModeEnabled),
          sandbox,
          approvalPolicy
        }
      : {
          type: "thread.start",
          requestId,
          userId: selectedUserId,
          projectId: selectedProject.id,
          prompt: sentPromptText,
          skillNames,
          model: selectedModelProfile.model,
          reasoningEffort: selectedModelProfile.effort,
          collaborationMode: planMode ? "plan" : "default",
          serviceTier: resolveServiceTier(codexFastModeEnabled),
          sandbox,
          approvalPolicy,
          ...(threadContextFeatureEnabled && hasContextConfigOverride(newThreadContextConfig)
            ? { contextConfig: contextConfigRequest(newThreadContextConfig) }
            : {}),
          ...(threadContextFeatureEnabled && newThreadContextPin.trim() ? { contextPin: newThreadContextPin.trim() } : {})
        };
    try {
      codexSocket.send(payload);
      if (payload.type !== "turn.steer") {
        setTopAnchoredPrompt({ requestId, threadId: selectedThread?.id ?? null, turnId: null, viewToken: requestViewToken });
      }
      autoFollowMessagesRef.current = true;
      setShowScrollToBottom(false);
      window.setTimeout(() => scrollMessagesToBottom("smooth"), 0);
      setPendingUserMessages((current) => [
        ...current,
        {
          id: `user-${requestId}`,
          requestId,
          threadId: selectedThread?.id ?? null,
          viewToken: requestViewToken,
          text: visibleText,
          keepAtBottomUntil,
          attachments: promptUploads
        }
      ]);
      releasePendingPromptBottomHold(requestId, keepAtBottomUntil);
      if (!isQuestionAnswer) {
        setPrompt("");
        setUploadedFiles([]);
        setSelectedSkillNames([]);
      }
      return true;
    } catch (caught) {
      promptRequestContextsRef.current.delete(requestId);
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  }

  function questionIsAnswered(itemId: string, turnId?: string, visibleItems?: ThreadItem[]): boolean {
    const threadId = selectedThread?.id;
    if (!threadId) return false;
    if (answeredQuestionItems[`${threadId}:${itemId}`]) return true;
    if (visibleItems && questionHasLaterUserMessage(visibleItems, itemId)) return true;
    const turns = selectedThread.turns;
    const turnIndex = turns.findIndex((turn) => turn.id === turnId || (turn.items ?? []).some((item) => item.id === itemId));
    if (turnIndex < 0) return false;
    if (questionHasLaterUserMessage(turns[turnIndex].items ?? [], itemId)) return true;
    return turns.slice(turnIndex + 1).some((turn) => turnHasUserItem(turn) || Boolean(turnUserText(turn)));
  }

  async function chooseToolQuestion(itemId: string, answer: string): Promise<boolean> {
    const threadId = selectedThread?.id;
    if (!threadId || !selectedProject || !answer.trim()) return false;
    const key = `${threadId}:${itemId}`;
    if (submittingQuestionItemsRef.current.has(key) || questionIsAnswered(itemId)) return false;
    submittingQuestionItemsRef.current.add(key);
    try {
      const accepted = await sendPrompt(selectedActiveTurnId ? "steer" : "queue", answer);
      if (accepted) setAnsweredQuestionItems((current) => ({ ...current, [key]: true }));
      return accepted;
    } finally {
      submittingQuestionItemsRef.current.delete(key);
    }
  }

  function continueInNewThread() {
    const continuation = continuationPrompt;
    const project = selectedProject;
    if (!continuation || !project || continuation.projectId !== project.id) {
      return;
    }
    const requestId = `thread-${requestToken()}`;
    const requestViewToken = ++threadViewTokenRef.current;
    const keepAtBottomUntil = 0;
    newThreadDraftModeRef.current = true;
    selectedThreadRef.current = null;
    setSelectedThread(null);
    setThreadHistory(null);
    setPrompt("");
    setError("");
    promptRequestContextsRef.current.set(requestId, {
      viewToken: requestViewToken,
      projectId: project.id,
      threadId: null,
      model: selectedModelProfile.model,
      reasoningEffort: selectedModelProfile.effort,
      sentPromptText: continuation.sentPromptText,
      visibleText: continuation.visibleText
    });
    try {
      codexSocket.send({
        type: "thread.start",
        requestId,
        userId: selectedUserId,
        projectId: project.id,
        prompt: continuation.sentPromptText,
        model: selectedModelProfile.model,
        reasoningEffort: selectedModelProfile.effort,
        collaborationMode: planMode ? "plan" : "default",
        serviceTier: resolveServiceTier(codexFastModeEnabled),
        sandbox,
        approvalPolicy,
        ...(threadContextFeatureEnabled && hasContextConfigOverride(newThreadContextConfig)
          ? { contextConfig: contextConfigRequest(newThreadContextConfig) }
          : {}),
        ...(threadContextFeatureEnabled && newThreadContextPin.trim() ? { contextPin: newThreadContextPin.trim() } : {})
      });
      setTopAnchoredPrompt({ requestId, threadId: null, turnId: null, viewToken: requestViewToken });
      setPendingUserMessages((current) => [
        ...current,
        {
          id: `user-${requestId}`,
          requestId,
          threadId: null,
          viewToken: requestViewToken,
          text: continuation.visibleText,
          keepAtBottomUntil
        }
      ]);
      releasePendingPromptBottomHold(requestId, keepAtBottomUntil);
      setContinuationPrompt(null);
      autoFollowMessagesRef.current = true;
      setShowScrollToBottom(false);
    } catch (caught) {
      promptRequestContextsRef.current.delete(requestId);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function interruptCurrentTurn(threadId: string, turnId: string, projectId: string) {
    if (!threadId || !turnId || !projectId || interruptRequestedTurnIdsRef.current.has(turnId)) {
      return;
    }
    const requestId = `interrupt-${requestToken()}`;
    interruptRequestContextsRef.current.set(requestId, { threadId, turnId, projectId });
    interruptRequestedTurnIdsRef.current.add(turnId);
    setLastStoppedTurnForEdit({ threadId, turnId });
    setInterruptingTurns((current) => ({ ...current, [turnId]: true }));
    setActiveTurnsByThread((current) => {
      if (current[threadId] !== turnId) {
        return current;
      }
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setSelectedThread((current) => {
      if (!current || current.id !== threadId) {
        return current;
      }
      const nextTurns = current.turns.map((turn) => (
        turn.id === turnId
          ? { ...turn, status: "interrupted", completedAt: turn.completedAt || Date.now() }
          : turn
      ));
      return {
        ...current,
        status: "interrupted",
        turns: nextTurns
      };
    });
    setThreads((current) => current.map((thread) => (
      thread.id !== threadId ? thread : {
        ...thread,
        status: "interrupted",
        turns: thread.turns.map((turn) => (
          turn.id === turnId ? { ...turn, status: "interrupted", completedAt: turn.completedAt || Date.now() } : turn
        ))
      }
    )));
    setLiveDeltas((current) => Object.fromEntries(
      Object.entries(current).filter(([, entry]) => entry.threadId !== threadId || entry.turnId !== turnId)
    ));
    setLiveTools((current) => Object.fromEntries(
      Object.entries(current).filter(([, entry]) => entry.threadId !== threadId || entry.turnId !== turnId)
    ));
    setError("");
    const timeoutId = window.setTimeout(() => {
      interruptRequestedTurnIdsRef.current.delete(turnId);
      setInterruptingTurns((current) => {
        const next = { ...current };
        delete next[turnId];
        return next;
      });
      interruptTimeoutsRef.current.delete(turnId);
      const currentTurnId = activeTurnsByThread[threadId];
      if (currentTurnId === turnId) {
        setActiveTurnsByThread((current) => {
          const next = { ...current };
          if (next[threadId] === turnId) {
            delete next[threadId];
          }
          return next;
        });
        if (activeTurnsByThreadRef.current[threadId]) {
          const next = { ...activeTurnsByThreadRef.current };
          delete next[threadId];
          activeTurnsByThreadRef.current = next;
        }
      }
    }, 10_000);
    interruptTimeoutsRef.current.set(turnId, timeoutId);
    try {
      codexSocket.send({
        type: "turn.interrupt",
        requestId,
        userId: selectedUserId,
        projectId,
        threadId,
        turnId
      });
    } catch (caught) {
      interruptRequestContextsRef.current.delete(requestId);
      interruptRequestedTurnIdsRef.current.delete(turnId);
      const timeout = interruptTimeoutsRef.current.get(turnId);
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
        interruptTimeoutsRef.current.delete(turnId);
      }
      setInterruptingTurns((current) => {
        const next = { ...current };
        delete next[turnId];
        return next;
      });
      setLastStoppedTurnForEdit((current) => current?.threadId === threadId && current.turnId === turnId ? null : current);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function queueInterruptAfterTurnStarts(promptRequestId: string) {
    if (!promptRequestId || queuedInterruptPromptRequestIdsRef.current.has(promptRequestId)) {
      return;
    }
    queuedInterruptPromptRequestIdsRef.current.add(promptRequestId);
    setQueuedInterruptPrompts((current) => ({ ...current, [promptRequestId]: true }));
    setError("");
  }

  function requestInterruptSelectedConversation(): boolean {
    if (composerStopBusy) {
      return false;
    }
    const projectId = selectedProject?.id
      || (selectedThread?.id ? threadProjectIdsRef.current.get(selectedThread.id) : undefined)
      || selectedProjectIdRef.current;
    if (selectedActiveTurnId && projectId && selectedThread?.id) {
      interruptCurrentTurn(selectedThread.id, selectedActiveTurnId, projectId);
      return true;
    }
    if (currentPendingTurnStart) {
      queueInterruptAfterTurnStarts(currentPendingTurnStart.requestId);
      return true;
    }
    return false;
  }

  function releasePendingPromptBottomHold(requestId: string, keepAtBottomUntil: number) {
    window.setTimeout(() => {
      const currentThread = selectedThreadRef.current;
      setPromptBottomHoldNow(Date.now());
      setPendingUserMessages((current) => current.flatMap((entry) => {
        if (entry.requestId !== requestId) {
          return [entry];
        }
        if (entry.threadId && currentThread?.id === entry.threadId && threadHasUserText(currentThread, entry.text)) {
          return [];
        }
        return [{ ...entry, keepAtBottomUntil: 0 }];
      }));
    }, Math.max(0, keepAtBottomUntil - Date.now()));
  }

  function clearQueuedInterrupt(promptRequestId: string) {
    queuedInterruptPromptRequestIdsRef.current.delete(promptRequestId);
    setQueuedInterruptPrompts((current) => {
      if (!current[promptRequestId]) {
        return current;
      }
      const next = { ...current };
      delete next[promptRequestId];
      return next;
    });
  }

  function hydrateLiveState(snapshot: LiveStateSnapshot | undefined) {
    if (!snapshot) {
      return;
    }
    [
      ...recentLiveSnapshotItems(snapshot.agentMessages, LIVE_RECONNECT_AGENT_LIMIT).filter((item) => item.itemId).map((item) => ({ kind: "agent" as const, id: item.itemId, startedAt: item.startedAt ?? item.updatedAt ?? "" })),
      ...recentLiveSnapshotItems(snapshot.toolItems, LIVE_RECONNECT_TOOL_LIMIT).filter((item) => item.itemId).map((item) => ({ kind: "tool" as const, id: item.itemId, startedAt: item.startedAt ?? "" }))
    ]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .forEach((item) => liveTimelineSequence(item.kind, item.id));
    pendingLiveDeltasRef.current.clear();
    if (liveDeltaFlushTimerRef.current !== null) {
      window.clearTimeout(liveDeltaFlushTimerRef.current);
      liveDeltaFlushTimerRef.current = null;
    }
    const activeTurns = activeTurnsFromSnapshot(snapshot);
    activeTurnsByThreadRef.current = activeTurns;
    const snapshotDeltas = liveDeltasFromSnapshot(snapshot, activeTurns);
    const snapshotTools = liveToolsFromSnapshot(snapshot);
    // A completed turn is removed from the server's live snapshot before its
    // JSONL history is always readable. Preserve the temporary panel's live
    // copy until promoteTemporaryTurn confirms the persisted replacement.
    setLiveDeltas((current) => {
      const next = { ...snapshotDeltas };
      const temporaryThreadId = temporaryAskRef.current?.threadId;
      if (temporaryThreadId || selectedThreadRef.current?.id) {
        for (const [itemId, item] of Object.entries(current)) {
          if ((item.threadId === temporaryThreadId || item.threadId === selectedThreadRef.current?.id) && !next[itemId]) next[itemId] = item;
        }
      }
      return next;
    });
    setLiveTools((current) => {
      const next = { ...snapshotTools };
      const temporaryThreadId = temporaryAskRef.current?.threadId;
      if (temporaryThreadId || selectedThreadRef.current?.id) {
        for (const [itemId, item] of Object.entries(current)) {
          if ((item.threadId === temporaryThreadId || item.threadId === selectedThreadRef.current?.id) && !next[itemId]) next[itemId] = item;
        }
      }
      return next;
    });
    setActiveTurnsByThread(activeTurns);
    turnThreadIdsRef.current.clear();
    for (const turn of safeLiveSnapshotItems(snapshot.activeTurns)) {
      if (turn.threadId && turn.turnId) {
        turnThreadIdsRef.current.set(turn.turnId, turn.threadId);
      }
    }
  }

  function refreshSelectedThreadFromLiveState(snapshot?: LiveStateSnapshot) {
    if (!snapshot) {
      return;
    }
    const thread = selectedThreadRef.current;
    if (!thread?.id) {
      return;
    }
    const activeFromSnapshot = activeTurnsFromSnapshot(snapshot);
    const activeTurnFromSnapshot = activeFromSnapshot[thread.id];
    const now = Date.now();
    const lastRecovery = threadLiveRecoveryAtRef.current[thread.id] ?? 0;
    if (now - lastRecovery < 10_000) {
      return;
    }
    const isRunning = Boolean(activeTurnFromSnapshot);
    const hasPendingForThread = pendingUserMessagesRef.current.some((entry) => (
      entry.threadId === thread.id && entry.keepAtBottomUntil > now
    ));
    const isPending = hasPendingForThread || thread.status === "starting";
    if (!isRunning && !isPending) {
      return;
    }
    const localActiveTurn = activeTurnsByThread[thread.id];
    if (isRunning && localActiveTurn === activeTurnFromSnapshot) {
      return;
    }
    const projectId = threadProjectIdsRef.current.get(thread.id) ?? selectedProjectIdRef.current;
    if (!projectId) {
      return;
    }
    const viewToken = threadViewTokenRef.current;
    threadLiveRecoveryAtRef.current[thread.id] = now;
    void openThread(thread.id, projectId, viewToken, { skipCache: true });
  }

  function markThreadResult(threadId: string) {
    const currentThread = selectedThreadRef.current;
    if (currentThread?.id !== threadId) {
      setUnreadResultThreads((current) => ({ ...current, [threadId]: true }));
    }
  }

  function handleSocketMessage(message: SocketMessage) {
    if (message.type === "turn.queue.started") {
      const data = message.data as { threadId?: string } | undefined;
      if (data?.threadId && data.threadId === selectedThreadRef.current?.id) {
        requestQueuedSubmissions(data.threadId);
      }
      return;
    }
    if (message.type === "hello") {
      const data = message.data as { liveState?: LiveStateSnapshot; pendingServerRequests?: Array<{ id: string | number; method: string; params: Record<string, unknown> }> } | undefined;
      hydrateLiveState(data?.liveState);
      refreshSelectedThreadFromLiveState(data?.liveState);
      setPendingApprovals(Object.fromEntries((data?.pendingServerRequests ?? [])
        .filter((request) => request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval")
        .map((request) => [String(request.id), request])));
      return;
    }

    if (message.type === "codex.serverRequest") {
      const request = message.data as { id?: string | number; method?: string; params?: Record<string, unknown> } | undefined;
      if (request?.id !== undefined && (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval")) {
        setPendingApprovals((current) => ({ ...current, [String(request.id!)]: {
          id: request.id!, method: request.method!, params: request.params ?? {}
        } }));
      }
      return;
    }

    if (message.type === "live.state") {
      hydrateLiveState(message.data as LiveStateSnapshot | undefined);
      refreshSelectedThreadFromLiveState(message.data as LiveStateSnapshot | undefined);
      return;
    }

    if (message.type === "live.tool") {
      const item = message.data as LiveToolEntry | undefined;
      if (item?.itemId) {
        liveTimelineSequence("tool", item.itemId);
        markLiveEvent(item.threadId);
        setLiveTools((current) => {
          const next = { ...current };
          // Keep completed tool rows visible until the completed turn has
          // been confirmed by the history response. Removing them here
          // creates a gap where tools only reappear after the whole answer.
          next[item.itemId] = item;
          return next;
        });
      }
      return;
    }

    if (message.type === "live.agent") {
      const item = message.data as LiveAgentMessage | undefined;
      if (item?.itemId) {
        markLiveEvent(item.threadId);
        if (typeof item.sequence === "number") {
          liveTimelineOrderRef.current.set(`agent:${item.itemId}`, item.sequence);
          liveTimelineSequenceRef.current = Math.max(liveTimelineSequenceRef.current, item.sequence);
        }
        setLiveDeltas((current) => ({
          ...current,
          [item.itemId]: {
            threadId: item.threadId,
            turnId: item.turnId,
            text: item.text,
            startedAt: item.startedAt,
            sequence: item.sequence,
            sourceItemId: item.sourceItemId
          }
        }));
      }
      return;
    }

    if (message.type === "terminal.output") {
      const data = message.data as { processId?: string; text?: string; stream?: string } | undefined;
      if (data?.processId && data.text && !data.processId.startsWith("term-")) {
        appendLocalMessage(data.processId, data.text, `Codex Web · ${data.stream ?? "stdout"}`, "tool");
      }
      return;
    }

    if (message.type === "ack") {
      // The embedded terminal owns its errors; they must not become a chat banner.
      if (message.requestId?.startsWith("term-")) return;
      if (message.requestId?.startsWith("approval-")) {
        const pending = approvalResponseRequestsRef.current.get(message.requestId);
        approvalResponseRequestsRef.current.delete(message.requestId);
        if (!message.ok) {
          if (pending) setPendingApprovals((current) => ({ ...current, [String(pending.id)]: pending }));
          setError(`批准操作失败：${message.error ?? "请重试"}`);
        }
        return;
      }
      if (message.requestId?.startsWith("queue-")) {
        if (message.requestId.startsWith("queue-steer-")) {
          const pending = pendingQueueSteersRef.current.get(message.requestId);
          pendingQueueSteersRef.current.delete(message.requestId);
          const data = message.data as { threadId?: string } | undefined;
          if (message.ok && data?.threadId) {
            requestQueuedSubmissions(data.threadId);
            const projectId = threadProjectIdsRef.current.get(data.threadId) ?? selectedProjectIdRef.current;
            const viewToken = threadViewTokenRef.current;
            if (projectId) window.setTimeout(() => {
              if (selectedThreadRef.current?.id === data.threadId && threadViewTokenRef.current === viewToken) {
                void openThread(data.threadId!, projectId, viewToken, { skipCache: true });
              }
            }, 1200);
          } else {
            if (pending && pending.threadId === selectedThreadRef.current?.id) {
              setQueuedSubmissions((current) => [pending.entry, ...current]);
            }
            setPendingUserMessages((current) => current.filter((entry) => entry.requestId !== message.requestId));
            setError(`调整方向失败：${message.error ?? "未收到确认，请检查当前回答是否仍在运行。"}`);
          }
          return;
        }
        const data = message.data as { threadId?: string; data?: QueuedSubmission[] } | undefined;
        const requestThreadId = data?.threadId ?? (message.requestId.startsWith("queue-add-") ? pendingQueuedPromptsRef.current.get(message.requestId)?.threadId : selectedThreadRef.current?.id);
        if (message.requestId.startsWith("queue-list-") && message.ok && requestThreadId === selectedThreadRef.current?.id) {
          setQueuedSubmissions((current) => {
            const listed = Array.isArray(data?.data) ? data.data : [];
            const pending = current.filter((entry) => entry.id.startsWith("pending:")
              && pendingQueuedPromptsRef.current.has(entry.clientUserMessageId)
              && !listed.some((item) => item.clientUserMessageId === entry.clientUserMessageId));
            return [...listed, ...pending];
          });
        }
        if (message.requestId.startsWith("queue-add-")) {
          const pending = pendingQueuedPromptsRef.current.get(message.requestId);
          pendingQueuedPromptsRef.current.delete(message.requestId);
          if (!message.ok && pending) {
            setQueuedSubmissions((current) => current.filter((entry) => entry.id !== `pending:${message.requestId}`));
            setPrompt((current) => current || pending.text);
            setUploadedFiles((current) => current.length ? current : pending.uploads);
            setError(`排队发送失败：${message.error ?? "Codex 未接受排队请求。"}`);
          } else if (message.ok && requestThreadId) {
            requestQueuedSubmissions(requestThreadId);
          }
        }
        if ((message.requestId.startsWith("queue-delete-") || message.requestId.startsWith("queue-update-")) && message.ok && requestThreadId) {
          requestQueuedSubmissions(requestThreadId);
        }
        if (!message.ok && !message.requestId.startsWith("queue-add-")
            && !(message.requestId.startsWith("queue-list-") && message.error?.includes("Codex thread was not found in any configured account."))) {
          setError(message.error ?? "读取排队消息失败。");
        }
        return;
      }
      if (message.requestId?.startsWith("temp-")) {
        const temporary = temporaryAskRef.current;
        if (!temporary || temporary.requestId !== message.requestId) {
          return;
        }
        if (!message.ok) {
          const failed = { ...temporary, status: "error" as const };
          temporaryAskRef.current = failed;
          setTemporaryAsk(failed);
          setError(`临时提问失败：${message.error ?? "Codex 未接受请求。"}`);
          return;
        }
        const data = message.data as { thread?: { thread?: ThreadSummary }; turn?: { turn?: { id?: string } } } | undefined;
        const threadId = data?.thread?.thread?.id ?? temporary.threadId;
        const turnId = data?.turn?.turn?.id ?? temporary.turnId;
        const next = {
          ...temporary,
          threadId: threadId ?? null,
          turnId: turnId ?? null,
          prompts: temporary.prompts.map((entry) => (
            entry.requestId === message.requestId ? { ...entry, turnId: turnId ?? null } : entry
          )),
          status: "running" as const
        };
        temporaryAskRef.current = next;
        setTemporaryAsk(next);
        if (threadId) {
          temporaryThreadIdsRef.current.add(threadId);
          threadProjectIdsRef.current.set(threadId, temporary.projectId);
        }
        if (turnId && threadId) {
          turnThreadIdsRef.current.set(turnId, threadId);
          activeTurnsByThreadRef.current = { ...activeTurnsByThreadRef.current, [threadId]: turnId };
          setActiveTurnsByThread((current) => ({ ...current, [threadId]: turnId }));
        }
        return;
      }
    const interruptContext = message.requestId ? interruptRequestContextsRef.current.get(message.requestId) : undefined;
      if (interruptContext) {
        if (message.requestId) {
          interruptRequestContextsRef.current.delete(message.requestId);
        }
        const timeout = interruptTimeoutsRef.current.get(interruptContext.turnId);
        if (timeout !== undefined) {
          window.clearTimeout(timeout);
          interruptTimeoutsRef.current.delete(interruptContext.turnId);
        }
        interruptRequestedTurnIdsRef.current.delete(interruptContext.turnId);
        setInterruptingTurns((current) => {
          const next = { ...current };
          delete next[interruptContext.turnId];
          return next;
        });
        if (!message.ok) {
          interruptRequestedTurnIdsRef.current.delete(interruptContext.turnId);
          // The turn may have finished just before the interrupt reached Codex.
          // Keep the user's stop intent so the latest prompt does not briefly
          // show an edit action and then lose it on the next thread refresh.
          setError(`终止请求未生效：${message.error ?? "回答可能已结束。"} 可编辑这条提问；发送修改时会再次核对会话状态。`);
          return;
        }
        setActiveTurnsByThread((current) => {
          if (current[interruptContext.threadId] !== interruptContext.turnId) {
            return current;
          }
          const next = { ...current };
          delete next[interruptContext.threadId];
          return next;
        });
        setLiveDeltas((current) => Object.fromEntries(
          Object.entries(current).filter(([, entry]) => entry.turnId !== interruptContext.turnId)
        ));
        if (selectedThreadRef.current?.id === interruptContext.threadId) {
          const viewToken = threadViewTokenRef.current;
          window.setTimeout(() => void openThread(interruptContext.threadId, interruptContext.projectId, viewToken), 350);
          window.setTimeout(() => void openThread(interruptContext.threadId, interruptContext.projectId, viewToken), 1_200);
        }
        void refreshThreads(interruptContext.projectId);
        return;
      }
      const renameContext = message.requestId ? threadRenameRequestContextsRef.current.get(message.requestId) : undefined;
      if (renameContext) {
        if (message.requestId) {
          threadRenameRequestContextsRef.current.delete(message.requestId);
        }
        setRenamingThreadId((current) => current === renameContext.threadId ? null : current);
        if (!message.ok) {
          setError(`重命名会话失败：${message.error ?? "Codex 未接受重命名请求。"}`);
          return;
        }
        applyThreadName(renameContext.threadId, renameContext.name);
        setRenamingThread(null);
        setThreadRenameDraft("");
        window.setTimeout(() => void refreshThreads(renameContext.projectId), 500);
        return;
      }
      const requestContext = message.requestId ? promptRequestContextsRef.current.get(message.requestId) : undefined;
      const requestViewToken = requestContext?.viewToken;
      const isPromptRequest = Boolean(message.requestId?.startsWith("thread-"));
      const interruptQueuedForPrompt = Boolean(message.requestId && queuedInterruptPromptRequestIdsRef.current.has(message.requestId));
      const isStalePromptAck = isPromptRequest && requestViewToken !== undefined && requestViewToken !== threadViewTokenRef.current;
      if (!message.ok) {
        if (message.requestId) setTopAnchoredPrompt((current) => current?.requestId === message.requestId ? null : current);
        if (message.requestId && interruptQueuedForPrompt) {
          clearQueuedInterrupt(message.requestId);
        }
        if (message.requestId && isPromptRequest) {
          setPendingUserMessages((current) => current.filter((entry) => entry.requestId !== message.requestId));
        }
        const errorMessage = message.error ?? "Socket request failed.";
        if (errorMessage.startsWith("CONTEXT_EXHAUSTED:") && requestContext && !isStalePromptAck) {
          setContinuationPrompt({
            projectId: requestContext.projectId,
            sourceThreadId: requestContext.threadId ?? "",
            sentPromptText: requestContext.sentPromptText,
            visibleText: requestContext.visibleText
          });
          if (message.requestId) {
            promptRequestContextsRef.current.delete(message.requestId);
          }
          setError("");
          return;
        }
        if (isThreadVisibilityError(errorMessage)) {
          const requestThreadId = requestContext?.threadId;
          const isCurrentThreadVisibilityError = isPromptRequest
            && requestThreadId != null
            && requestThreadId === selectedThreadRef.current?.id
            && (requestContext?.projectId ? requestContext.projectId === selectedProjectIdRef.current : true);
          if (!isStalePromptAck && isCurrentThreadVisibilityError) {
            selectedThreadRef.current = null;
            setSelectedThread(null);
          }
          if (message.requestId) {
            setPendingUserMessages((current) => current.filter((entry) => entry.requestId !== message.requestId));
          }
          void refreshThreads(selectedProjectIdRef.current);
          if (message.requestId) {
            promptRequestContextsRef.current.delete(message.requestId);
          }
          setError(isStalePromptAck
            ? "后台会话不可访问，本次请求未执行。"
            : "当前会话不属于当前登录用户，已自动回到新建会话；请重新发送。");
          return;
        }
        if (message.requestId) {
          promptRequestContextsRef.current.delete(message.requestId);
        }
        const providerNotice = isPromptRequest && !isStalePromptAck
          ? classifyProviderFailure(requestContext?.model ?? selectedModelProfile.model, errorMessage)
          : null;
        if (providerNotice) {
          setProviderFailure(providerNotice);
          setProviderFailureOpen(true);
          setError("");
          return;
        }
        setError(isStalePromptAck ? `后台会话执行失败：${errorMessage}` : errorMessage);
        return;
      }
      const data = message.data as { thread?: { thread?: ThreadSummary }; turn?: { turn?: { id?: string } }; migratedFromThreadId?: string; autoCompacted?: boolean } | undefined;
      const newThread = data?.thread?.thread;
      const promptThreadId = newThread?.id ?? requestContext?.threadId ?? null;
      if (promptThreadId) {
        const projectId = requestContext?.projectId ?? selectedProjectIdRef.current;
        if (projectId) {
          threadProjectIdsRef.current.set(promptThreadId, projectId);
        }
      }
      if (newThread?.id) {
        if (requestContext?.threadId === null) {
          setNewThreadContextPin("");
          setNewThreadContextConfig(emptyThreadContextConfig());
        }
        if (requestContext) {
          const createdThreadProfileId = modelProfileIdFor(requestContext.model, requestContext.reasoningEffort, modelProfiles);
          window.localStorage.setItem(threadModelPreferenceStorageKey(selectedUserId, newThread.id), createdThreadProfileId);
          if (requestContext.projectId) {
            window.localStorage.setItem(modelPreferenceStorageKey(selectedUserId, requestContext.projectId), createdThreadProfileId);
          }
        }
        const normalizedThread = {
          ...newThread,
          pinned: false,
          configuredModel: requestContext?.model ?? newThread.configuredModel ?? null,
          configuredReasoningEffort: requestContext?.reasoningEffort ?? newThread.configuredReasoningEffort ?? null,
          turns: newThread.turns ?? []
        };
        const normalizedThreadWithStoredModel = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, normalizedThread, modelProfiles));
        setThreads((current) => {
          const next = current.filter((thread) => thread.id !== normalizedThreadWithStoredModel.id);
          const firstUnpinnedIndex = next.findIndex((thread) => !thread.pinned);
          next.splice(firstUnpinnedIndex === -1 ? next.length : firstUnpinnedIndex, 0, normalizedThreadWithStoredModel);
          threadsRef.current = next;
          return next;
        });
        if (message.requestId) {
          setPendingUserMessages((current) =>
            current.map((entry) => (entry.requestId === message.requestId ? { ...entry, threadId: newThread.id } : entry))
          );
        }
        if (!isStalePromptAck) {
          newThreadDraftModeRef.current = false;
          selectedThreadRef.current = normalizedThreadWithStoredModel;
          setSelectedThread(normalizedThreadWithStoredModel);
          setThreadHistory(null);
          if (data?.migratedFromThreadId) {
            addLocalMessage("原会话的 Codex 上下文已用尽，继续发送会没有输出。已自动新建续接会话；原记录仍保留，可随时查看或导出。", "Codex Web · 会话迁移");
          }
        }
      }
      if (data?.autoCompacted && !isStalePromptAck) {
        addLocalMessage("当前会话接近上下文上限，已在本次发送前自动压缩历史；会话 ID 与完整记录保持不变。", "Codex Web · 自动压缩");
      }
      const acknowledgedTurnId = data?.turn?.turn?.id ?? null;
      if (message.requestId && promptThreadId) {
        setTopAnchoredPrompt((current) => current && current.requestId === message.requestId
          ? { ...current, threadId: promptThreadId, turnId: acknowledgedTurnId ?? current.turnId }
          : current);
      }
      if (acknowledgedTurnId && promptThreadId) {
        turnThreadIdsRef.current.set(acknowledgedTurnId, promptThreadId);
        if (message.requestId) {
          setPendingUserMessages((current) => current.map((entry) => entry.requestId === message.requestId
            ? { ...entry, threadId: promptThreadId, turnId: acknowledgedTurnId }
            : entry
          ));
        }
        activeTurnsByThreadRef.current = { ...activeTurnsByThreadRef.current, [promptThreadId]: acknowledgedTurnId };
        setActiveTurnsByThread((current) => ({ ...current, [promptThreadId]: acknowledgedTurnId }));
        if (message.requestId && interruptQueuedForPrompt) {
          clearQueuedInterrupt(message.requestId);
          interruptCurrentTurn(promptThreadId, acknowledgedTurnId, requestContext?.projectId ?? selectedProjectIdRef.current);
        }
      } else if (message.requestId && interruptQueuedForPrompt) {
        clearQueuedInterrupt(message.requestId);
      }
      const commandData = message.data as { processId?: string; result?: { exitCode?: number; stdout?: string; stderr?: string } } | undefined;
      if (commandData?.processId && !commandData.processId.startsWith("term-") && commandData.result) {
        const output = `${commandData.result.stdout ?? ""}${commandData.result.stderr ?? ""}`;
        appendLocalMessage(commandData.processId, `${output}${output.endsWith("\n") || !output ? "" : "\n"}[exit ${commandData.result.exitCode ?? "?"}]\n`, "Codex Web · command", "tool");
      }
      const shouldRefreshPromptThread = isPromptRequest && !isStalePromptAck;
      if (shouldRefreshPromptThread && promptThreadId) {
        const refreshProjectId = requestContext?.projectId ?? selectedProjectIdRef.current;
        // `ack` now updates selectedThread and thread index directly in-memory.
        // Only a lightweight thread list refresh is needed here; avoid forcing
        // repeated full history reads that can block streaming.
        window.setTimeout(() => void refreshThreads(refreshProjectId), 750);
      }
      if (message.requestId) {
        promptRequestContextsRef.current.delete(message.requestId);
      }
      if (!shouldRefreshPromptThread) {
        window.setTimeout(() => void refreshThreads(selectedProjectIdRef.current), 750);
      }
      return;
    }

    if (message.type === "codex.notification") {
      const notification = message.data as CodexNotification;
      const params = notification.params ?? {};
      if (notification.method === "turn/diff/updated") {
        const turnId = notificationTurnId(params);
        if (turnId && typeof params.diff === "string") {
          setLiveTurnDiffs((current) => ({ ...current, [turnId]: params.diff as string }));
        }
      }
      if (notification.method === "thread/queue/changed") {
        const threadId = notificationThreadId(params);
        if (threadId && threadId === selectedThreadRef.current?.id) {
          requestQueuedSubmissions(threadId);
        }
      }
      if (notification.method === "item/agentMessage/delta") {
        const itemId = String(params.itemId ?? "");
        const delta = String(params.delta ?? "");
        const cleanedDelta = stripInterruptArtifacts(delta);
        // Markdown block boundaries often arrive as whitespace-only deltas or
        // as leading/trailing whitespace around a text delta. The history
        // sanitizer may trim those boundaries, which makes headings, lists and
        // blockquotes collapse into prose until the completed history reloads.
        const visibleDelta = delta && !delta.trim()
          ? delta
          : (() => {
              const leadingWhitespace = delta.match(/^\s+/)?.[0] ?? "";
              const trailingWhitespace = delta.match(/\s+$/)?.[0] ?? "";
              const leading = leadingWhitespace && !cleanedDelta.startsWith(leadingWhitespace) ? leadingWhitespace : "";
              const trailing = trailingWhitespace && !cleanedDelta.endsWith(trailingWhitespace) ? trailingWhitespace : "";
              return `${leading}${cleanedDelta}${trailing}`;
            })();
        if (!visibleDelta) {
          return;
        }
        if (!itemId) {
          return;
        }
        const reportedTurnId = notificationTurnId(params);
        const reportedThreadId = notificationThreadId(params);
        const selectedThreadId = selectedThreadRef.current?.id ?? null;
        const inferredThreadId = reportedTurnId ? turnThreadIdsRef.current.get(reportedTurnId) ?? null : null;
        const threadId = reportedThreadId ?? inferredThreadId ?? selectedThreadId;
        const fallbackActiveTurnId = threadId ? activeTurnsByThreadRef.current[threadId] ?? null : null;
        // A queued prompt can emit turn/started and its first text delta in the
        // same React batch. In that window activeTurnsByThread still points at
        // the previous turn, while the notification already carries the new
        // authoritative turn id. Never replace an explicit event association
        // with state from the previous render.
        const turnId = reportedTurnId ?? fallbackActiveTurnId;
        markLiveEvent(threadId);
        // The server emits a normalized live.agent event immediately after
        // this raw notification. It carries the authoritative segment id and
        // sequence, so rendering the raw delta here would create a second,
        // incorrectly ordered copy.
      }
      if (notification.method === "turn/started") {
        const turnId = notificationTurnId(params);
        const threadId = notificationThreadId(params);
        if (threadId && turnId) {
          markLiveEvent(threadId);
          turnThreadIdsRef.current.set(turnId, threadId);
          activeTurnsByThreadRef.current = { ...activeTurnsByThreadRef.current, [threadId]: turnId };
          setActiveTurnsByThread((current) => ({ ...current, [threadId]: turnId }));
        }
      }
      if (notification.method === "turn/completed") {
        const turnId = notificationTurnId(params);
        const threadId = notificationThreadId(params) ?? (turnId ? turnThreadIdsRef.current.get(turnId) ?? null : null);
        const completedTurn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : {};
        const completedStatus = typeof completedTurn.status === "string" ? completedTurn.status : "completed";
        if (completedStatus === "failed" && threadId && selectedThreadRef.current?.id === threadId) {
          const model = selectedThreadRef.current.configuredModel ?? selectedModelProfile.model;
          const providerNotice = classifyProviderFailure(model, completedTurn.error);
          if (providerNotice) {
            setProviderFailure(providerNotice);
            setProviderFailureOpen(true);
            setError("");
          }
        }
        flushPendingLiveDeltas();
        markLiveEvent(threadId);
        if (!threadId) {
          if (turnId) {
            turnThreadIdsRef.current.delete(turnId);
            setLiveDeltas((current) => Object.fromEntries(
              Object.entries(current).filter(([, entry]) => entry.turnId !== turnId)
            ));
            setLiveTools((current) => Object.fromEntries(
              Object.entries(current).filter(([, entry]) => entry.turnId !== turnId)
            ));
          } else {
            setLiveDeltas((current) => Object.fromEntries(
              Object.entries(current).filter(([, entry]) => entry.threadId !== null)
            ));
            setLiveTools((current) => Object.fromEntries(
              Object.entries(current).filter(([, entry]) => entry.threadId !== null)
            ));
          }
          void refreshThreads(selectedProjectIdRef.current);
          return;
        }
        if (turnId) {
          turnThreadIdsRef.current.delete(turnId);
        }
        setActiveTurnsByThread((current) => {
          if (!current[threadId]) {
            return current;
          }
          const next = { ...current };
          delete next[threadId];
          return next;
        });
        const clearCompletedLiveItems = () => {
          setLiveDeltas((current) => Object.fromEntries(
            Object.entries(current).filter(([, entry]) => entry.threadId !== threadId && (!turnId || entry.turnId !== turnId))
          ));
          setLiveTools((current) => Object.fromEntries(
            Object.entries(current).filter(([, entry]) => entry.threadId !== threadId && (!turnId || entry.turnId !== turnId))
          ));
        };
        const now = Date.now();
        if (turnId) {
          setSelectedThread((current) => {
            if (!current || current.id !== threadId) {
              return current;
            }
            return {
              ...current,
              status: completedStatus,
              turns: current.turns.map((turn) => (
                turn.id === turnId ? { ...turn, status: completedStatus, completedAt: turn.completedAt || now } : turn
              ))
            };
          });
          setThreads((current) => current.map((item) => (
            item.id !== threadId ? item : {
              ...item,
              status: completedStatus,
              turns: item.turns.map((turn) => (
                turn.id === turnId ? { ...turn, status: completedStatus, completedAt: turn.completedAt || now } : turn
              ))
            }
          )));
        }
        const wasInterrupted = turnId ? interruptRequestedTurnIdsRef.current.delete(turnId) : false;
        if (turnId) {
          setInterruptingTurns((current) => {
            if (!current[turnId]) {
              return current;
            }
            const next = { ...current };
            delete next[turnId];
            return next;
          });
        }
        if (!wasInterrupted) {
          markThreadResult(threadId);
        }
        const threadProjectId = threadProjectIdsRef.current.get(threadId) ?? selectedProjectIdRef.current;
        const isTemporaryThread = temporaryAskRef.current?.threadId === threadId;
        if (!wasInterrupted && threadProjectId && !isTemporaryThread) {
          scheduleAutoSendGeneratedFiles(threadId, threadProjectId, turnId);
        }
        if (isTemporaryThread && !wasInterrupted) {
          const temporary = temporaryAskRef.current;
          if (temporary) {
            const completed = { ...temporary, status: "complete" as const };
            temporaryAskRef.current = completed;
            setTemporaryAsk(completed);
            void promoteTemporaryTurn(threadId, temporary.projectId, turnId);
          }
        }
        const currentThread = selectedThreadRef.current;
        if (currentThread?.id === threadId) {
          const projectId = selectedProjectIdRef.current;
          const viewToken = threadViewTokenRef.current;
          const promotePersistedTurn = async () => {
            const retryDelays = [0, 200, 400, 800, 1_200, 2_000];
            for (const delay of retryDelays) {
              if (delay > 0) {
                await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
              }
              const persistedThread = await openThread(threadId, projectId, viewToken, { skipCache: true, requireFresh: true });
              if (hasPersistedCompletedTurn(persistedThread, turnId)) {
                clearCompletedLiveItems();
                return;
              }
              if (viewToken !== threadViewTokenRef.current) {
                return;
              }
            }
            // Keep the completed live turn visible if persistence cannot yet be
            // confirmed. A later refresh can promote it without an empty gap.
          };
          void promotePersistedTurn();
        } else if (!isTemporaryThread) {
          clearCompletedLiveItems();
        }
        if (selectedThreadRef.current?.id === threadId && threadProjectId) {
          window.setTimeout(() => void refreshThreadContextStatus(threadProjectId, threadId), 600);
        }
        void refreshQuota(false, { background: true });
        void refreshThreads(selectedProjectIdRef.current);
      }
      return;
    }
  }

  const liveTimelineEntries: LiveTimelineEntry[] = [
    ...Object.entries(liveDeltas).map(([id, entry]) => ({ id, kind: "agent" as const, sequence: liveTimelineSequence("agent", id), ...entry })),
    ...Object.values(liveTools).map((entry) => ({ id: entry.itemId, kind: "tool" as const, sequence: liveTimelineSequence("tool", entry.itemId), ...entry }))
  ]
    .filter((entry) => selectedThread?.id ? entry.threadId === selectedThread.id || entry.threadId === null : entry.threadId === null)
    .sort((left, right) => left.sequence - right.sequence || left.startedAt.localeCompare(right.startedAt));
  const liveTimelineByTurn = new Map<string, LiveTimelineEntry[]>();
  const unmatchedLiveTimeline: LiveTimelineEntry[] = [];
  const fallbackLiveTurnId = selectedThread?.id ? activeTurnsByThread[selectedThread.id] : null;
  for (const entry of liveTimelineEntries) {
    const turnId = entry.turnId ?? fallbackLiveTurnId;
    if (!turnId) {
      unmatchedLiveTimeline.push(entry);
      continue;
    }
    const entries = liveTimelineByTurn.get(turnId) ?? [];
    entries.push(entry);
    liveTimelineByTurn.set(turnId, entries);
  }
  const renderLiveTimelineEntry = (entry: LiveTimelineEntry) => {
    if (entry.kind === "agent") {
      return stripInterruptArtifacts(entry.text) ? (
        <article className="messageItem kind-agent type-agentMessage live" key={entry.id}>
          <div className="messageMeta">Codex · agentMessage</div>
          <LiveAgentStreamMessage text={stripInterruptArtifacts(entry.text)} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
        </article>
      ) : null;
    }
    const liveToolItem: ThreadItem = { id: entry.id, type: "toolCall", tool: entry.tool, input: entry.input };
    const liveQuestions = parseQuestionTool(safeText(entry.tool), entry.input);
    if (liveQuestions && questionIsAnswered(entry.id, entry.turnId ?? undefined)) return null;
    return (
      <article className="messageItem kind-tool type-toolCall live" key={entry.id}>
        <div className="messageMeta">{entry.completed ? "工具输出" : "调用工具"} · {entry.tool}</div>
        {liveQuestions ? <ToolQuestionCard questions={liveQuestions} onChoose={(answer) => chooseToolQuestion(entry.id, answer)} /> : entry.input ? <pre>{safeText(entry.input)}</pre> : null}
        <MessageImagePreviews item={liveToolItem} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
        {!liveQuestions && entry.output ? <pre className="outputBlock">{displayOutputText(entry.output)}</pre> : entry.completed || liveQuestions ? null : <div className="messageBody">正在执行...</div>}
      </article>
    );
  };

  const addInlineReviewComment = (filePath: string, line: number, side: "new" | "old", source: string, commentText: string) => {
    const citation = `${filePath}:${line}${side === "old" ? "（原行）" : ""}`;
    const quotedSource = source.trim() ? `\n> ${source.trim()}` : "";
    setPrompt((current) => [current.trim(), `审查意见 ${citation}${quotedSource}\n${commentText}`].filter(Boolean).join("\n\n"));
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".composerRichInput")?.focus());
  };
  const openDiffReview = (changes: unknown[], title = "文件变更", turnId?: string, itemId?: string, threadId = selectedThread?.id, focusPath?: string) => {
    if (diffPanelCloseTimerRef.current !== null) window.clearTimeout(diffPanelCloseTimerRef.current);
    if (threadId && turnId && itemId) {
      try {
        window.sessionStorage.setItem(`codex-web-diff-review:${selectedUserId}:${threadId}`, JSON.stringify({ turnId, itemId, title, focusPath }));
        if (threadId === selectedThread?.id && selectedProject?.id) {
          window.sessionStorage.setItem(`codex-web-active-diff:${selectedUserId}`, JSON.stringify({ threadId, projectId: selectedProject.id }));
        }
      } catch {
        // Storage can be disabled; the panel should still open for this session.
      }
    }
    setDiffReview({ title, changes, focusPath });
    window.requestAnimationFrame(() => setDiffPanelVisible(true));
  };
  const closeDiffReview = () => {
    if (selectedThread?.id) {
      try {
        window.sessionStorage.removeItem(`codex-web-diff-review:${selectedUserId}:${selectedThread.id}`);
        window.sessionStorage.removeItem(`codex-web-active-diff:${selectedUserId}`);
      } catch { /* Storage can be disabled. */ }
    }
    setDiffPanelVisible(false);
    if (diffPanelCloseTimerRef.current !== null) window.clearTimeout(diffPanelCloseTimerRef.current);
    diffPanelCloseTimerRef.current = window.setTimeout(() => {
      setDiffReview(null);
      diffPanelCloseTimerRef.current = null;
    }, 380);
  };

  const toggleToolCardExpanded = (toolCard: HTMLElement | null) => {
    if (!toolCard) {
      return;
    }
    const expanded = toolCard.classList.toggle("toolExpanded");
    toolCard.setAttribute("aria-expanded", String(expanded));
    const output = toolCard.querySelector<DeferredToolOutputElement>("[data-deferred-tool-output]");
    if (output) {
      output.textContent = expanded ? output.fullToolOutput ?? "" : output.previewToolOutput ?? "";
    }
    toolCard.dispatchEvent(new CustomEvent("codex:tool-expanded", { detail: { expanded } }));
  };

  const renderToolBundleGroup = (
    bundleId: string,
    entries: ThreadItem[],
    groupIndex: number,
    contextThreadId = selectedThread?.id,
    contextProjectId = selectedProject?.id,
    contextTurnId?: string
  ) => {
    const entryKey = `${bundleId}:item:${entries[0].id}`;
    if (entries.length === 1 && itemKind(entries[0]) === "reasoning") {
      const reasoningText = reasoningItemDisplayText(entries[0]);
      return (
        <div className="toolBundleReasoningEntry" key={entryKey} onClick={(event) => event.stopPropagation()}>
          <ReasoningMessage text={reasoningText} projectId={contextProjectId} onOpenFileLink={openFilePreview} />
        </div>
      );
    }
    const expanded = Boolean(expandedToolEntries[entryKey]);
    const call = entries.find((entry) => safeText(entry.type).toLowerCase() === "toolcall") ?? entries[0];
    const toolName = safeText(call.tool).trim() || (safeText(call.type).toLowerCase() === "filechange" ? "文件变更" : "tool");
    const inputText = safeText(call.input) || safeText(call.command);
    const questions = parseQuestionToolItem(call);
    if (questions && questionIsAnswered(call.id, contextTurnId)) return null;
    const toolSummary = questions?.map((question) => question.title).join(" · ") || ([
      ...(Array.isArray(call.summary) ? call.summary.map(safeText) : []),
      safeText(call.command),
      inputText
    ].map((text) => text.replace(/\s+/g, " ").trim()).find(Boolean) ?? "");
    const hasChanges = Array.isArray(call.changes) && call.changes.length > 0;
    const outputItems = entries.filter((entry) => entry !== call);
    const outputText = [call, ...outputItems]
      .map((entry) => {
        if (typeof entry.aggregatedOutput === "string" && entry.aggregatedOutput.trim()) return entry.aggregatedOutput;
        if (typeof entry.output === "string" && safeText(entry.output).trim()) return safeText(entry.output);
        if (entry === call) return "";
        return itemText(entry);
      })
      .filter((text) => text.trim())
      .filter((text, index, values) => values.indexOf(text) === index)
      .join("\n");
    const deferredOutputItem = [call, ...outputItems].find((entry) => entry.outputDeferred === true);
    const running = call.completed === false;
    return (
      <article
        className={`messageItem kind-tool type-toolCall toolBundleEntry${expanded ? " toolExpanded" : ""}${running ? " live" : ""}`}
        key={entryKey}
        aria-expanded={expanded}
        onClick={(event) => {
          event.stopPropagation();
          if (!expanded) revealExpandedTool(event.currentTarget);
          setExpandedToolEntries((current) => {
            if (current[entryKey]) {
              const next = { ...current };
              delete next[entryKey];
              return next;
            }
            return { ...current, [entryKey]: true };
          });
        }}
      >
        <div className="messageMeta"><span className="toolBundleEntryLabel">调用工具 · {toolName}</span>{toolSummary ? <span className="toolBundleEntrySummary"> {toolSummary}</span> : null}</div>
        <ToolReveal open={expanded}>
        {questions ? <ToolQuestionCard questions={questions} onChoose={(answer) => chooseToolQuestion(call.id, answer)} /> : inputText ? <pre className="toolBundleInput">{inputText}</pre> : null}
        <MessageImagePreviews item={call} projectId={contextProjectId} onOpenFileLink={openFilePreview} />
        {hasChanges ? <button className="openDiffReviewButton" type="button" onClick={(event) => { event.stopPropagation(); openDiffReview(call.changes ?? [], "本轮文件变更", contextTurnId, call.id, contextThreadId); }}><FileText size={14} /> 查看变更 · {call.changes?.length ?? 0} 个文件</button> : null}
        {!questions && outputText ? <DeferredToolOutput text={displayOutputText(outputText)} deferred={Boolean(deferredOutputItem)} threadId={contextThreadId} itemId={String(deferredOutputItem?.outputItemId ?? deferredOutputItem?.id ?? call.id)} projectId={contextProjectId} /> : null}
        {!outputText && running ? <div className="messageBody">正在执行...</div> : null}
        </ToolReveal>
      </article>
    );
  };

  const getToolBundleGroups = (bundleItems: ThreadItem[]): ThreadItem[][] => {
    return coalesceToolOutputs(bundleItems).map((item) => [item]);
  };

  const summarizeToolBundleTitle = (bundleItems: ThreadItem[], complete = true): string => {
    const toolCallItems = bundleItems.filter((item) => safeText(item.type).toLowerCase() === "toolcall");
    const callToolNames = Array.from(new Set(
      bundleItems
        .filter((item) => safeText(item.type).toLowerCase() === "toolcall")
        .map((item) => safeText(item.tool).trim())
        .filter(Boolean)
    ));
    const displayedCount = toolCallItems.length > 0 ? toolCallItems.length : bundleItems.length;
    const toolLabel = callToolNames.length === 1
      ? callToolNames[0]
      : callToolNames.length > 1
        ? "工具"
        : "tool";
    return `调用工具 · ${toolLabel} × ${Math.max(1, displayedCount)}`;
  };

  const renderPersistedToolBundle = (
    bundleId: string,
    bundleItems: ThreadItem[],
    complete = true,
    contextThreadId = selectedThread?.id,
    contextProjectId = selectedProject?.id,
    contextTurnId?: string
  ) => {
    const hasRunningTool = bundleItems.some((item) => safeText(item.type).toLowerCase() === "toolcall" && item.completed === false);
    // A turn can still be generating text after its tools have completed.
    // The bundle shimmer must follow tool completion only, not turn completion.
    const running = hasRunningTool;
    const expanded = Boolean(expandedToolBundles[bundleId]);
    const bundleGroups = getToolBundleGroups(bundleItems);
    return (
      <article
        className={`messageItem kind-tool type-toolCall toolBundle${expanded ? " toolExpanded" : ""}${running ? " live" : ""}${running ? " toolBundleRunning" : ""}`}
        key={bundleId}
        data-message-key={bundleId}
        aria-expanded={expanded}
        onClick={(event) => {
          event.preventDefault();
          if (!expanded) revealExpandedTool(event.currentTarget);
          setExpandedToolBundles((current) => {
            if (current[bundleId]) {
              const next = { ...current };
              delete next[bundleId];
              return next;
            }
            if (bundleGroups.length === 1) {
              setExpandedToolEntries((entries) => ({ ...entries, [`${bundleId}:item:${bundleGroups[0][0].id}`]: true }));
            }
            return { ...current, [bundleId]: true };
          });
        }}
      >
        <div className={`messageMeta toolBundleTitle${running ? " live" : ""}`}>
          <span className="toolBundleTitleLabel">{summarizeToolBundleTitle(bundleItems, !running)}</span>
        </div>
        <ToolReveal open={expanded}>
          <div className="toolBundleEntries">
            {bundleGroups.map((bundleGroup, groupIndex) => (
              renderToolBundleGroup(bundleId, bundleGroup, groupIndex, contextThreadId, contextProjectId, contextTurnId)
            ))}
          </div>
        </ToolReveal>
      </article>
    );
  };

  const renderPersistedThreadItem = (item: ThreadItem, turn: Turn, navigationKey: string | null, messageRefKey: string) => {
    const itemKindValue = itemKind(item);
    const isUserMessage = itemKindValue === "user";
    const rawItemText = itemText(item);
    const cleanedItemText = isUserMessage ? visibleUserHistoryText(rawItemText) : stripInterruptArtifacts(rawItemText);
    const reasoningText = itemKindValue === "reasoning" ? reasoningItemDisplayText(item) : "";
    const userVisibleText = isUserMessage ? cleanedItemText : "";
    const isLiveAgent = itemKindValue === "agent" && item.timelineLive === true;
    const hasRenderableItemContent =
      Boolean(item.command) ||
      Boolean(safeText(item.output).trim()) ||
      Boolean(safeText(item.input).trim()) ||
      Boolean(safeText(item.tool).trim()) ||
      (Array.isArray((item as { changes?: unknown[] }).changes) && ((item as { changes?: unknown[] }).changes ?? []).length > 0) ||
      Boolean(item.aggregatedOutput) ||
      Boolean(cleanedItemText.trim());
    if (itemKindValue === "agent" && !hasRenderableItemContent) {
      return null;
    }
    if (itemKindValue === "reasoning" && !reasoningText) {
      return null;
    }
    if (navigationKey && heldPersistedPromptNavigationKeys.has(navigationKey)) {
      return null;
    }
    return (
      <article
        className={`${messageClassName(item)}${isLiveAgent ? " live" : ""}`}
        key={`${turn.id}-${item.id}`}
        data-message-key={messageRefKey}
        ref={(element) => {
          if (navigationKey) {
            setPromptMessageElement(navigationKey, element);
          }
          setMessageElement(messageRefKey, element);
        }}
      >
        {itemKindValue === "reasoning" ? (
          <ReasoningMessage text={reasoningText} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
        ) : (
          <div className="messageMeta">{itemLabel(item)}</div>
        )}
        {itemKindValue === "reasoning" ? null : item.command ? (
          <pre>{safeText(item.command)}</pre>
        ) : isUserMessage ? (
          <>
            <CollapsibleUserMessage text={userVisibleText} skillNames={skillReferencesInPrompt(rawItemText).names} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
            <PersistedUserAttachmentPreviews text={rawItemText} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
          </>
        ) : isLiveAgent ? (
          <LiveAgentStreamMessage text={cleanedItemText} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
        ) : Array.isArray(item.changes) && item.changes.length ? (
          <button className="openDiffReviewButton" type="button" onClick={() => openDiffReview(item.changes ?? [], "本轮文件变更", turn.id, item.id)}><FileText size={14} /> 查看变更 · {item.changes.length} 个文件</button>
        ) : (
          <MarkdownMessage
            text={cleanedItemText || toolItemDetails(item)}
            projectId={selectedProject?.id}
            onOpenFileLink={openFilePreview}
            renderMath={itemKindValue === "agent"}
          />
        )}
        {item.aggregatedOutput ? <DeferredToolOutput text={item.aggregatedOutput} deferred={item.outputDeferred === true} threadId={selectedThread?.id} itemId={item.id} projectId={selectedProject?.id} /> : null}
        {!isUserMessage ? <MessageImagePreviews item={item} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} /> : null}
        {isUserMessage ? (
          <div className="v2UserMessageActions" aria-label="用户消息操作">
            <button
              type="button"
              title="复制消息"
              aria-label="复制消息"
              onClick={() => void copyPlainText(userVisibleText)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.2" y="2.2" width="8.3" height="9.2" rx="1.4" /><path d="M10.8 13.8H3.9a1.4 1.4 0 0 1-1.4-1.4V5.6" /></svg>
            </button>
            {turn.id === displayedConversationTurns.at(-1)?.id && (turn.items ?? []).filter((entry) => itemKind(entry) === "user").length < 2 && (!selectedActiveTurnId || lastStoppedTurnForEdit?.turnId === turn.id) && (["interrupted", "failed"].some((status) => normalizedToken(turn.status).includes(status)) || (lastStoppedTurnForEdit?.threadId === selectedThread?.id && lastStoppedTurnForEdit?.turnId === turn.id)) ? <button
              type="button"
              title="编辑最后一条提问"
              aria-label="编辑最后一条提问"
              disabled={editingLastPrompt || Boolean(editingPromptDraft)}
              onClick={() => void editLatestPrompt(turn.id, userVisibleText, rawItemText)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11.7-.5 2.1 2.1-.5L12.8 5 11 3.2 3 11.7Z" /><path d="m9.9 4.3 1.8 1.8" /></svg>
            </button> : null}
            {turn.id === displayedConversationTurns.at(-1)?.id && !selectedActiveTurnId ? <button
              type="button"
              title="撤回最后一轮问答（不撤销文件改动）"
              aria-label="撤回最后一轮问答"
              disabled={editingLastPrompt || Boolean(editingPromptDraft)}
              onClick={() => void deleteLatestTurn(turn)}
            ><Trash2 size={15} /></button> : null}
          </div>
        ) : null}
      </article>
    );
  };

  const temporaryPersistedTurnIds = new Set((temporaryThread?.turns ?? []).map((turn) => turn.id));
  const temporaryCompletedTurnIds = new Set((temporaryThread?.turns ?? [])
    .filter((turn) => !isRunningStatus(turn.status) && Boolean(turn.completedAt || (turn.items ?? []).length))
    .map((turn) => turn.id));
  const temporaryPersistedItemIds = new Set((temporaryThread?.turns ?? [])
    .flatMap((turn) => turn.items ?? [])
    .map((item) => item.id));
  const temporaryLiveTimeline = temporaryAsk?.threadId ? [
    ...Object.entries(liveDeltas)
      .filter(([, item]) => item.threadId === temporaryAsk.threadId)
      .map(([id, item]) => ({ id, kind: "agent" as const, sequence: liveTimelineSequence("agent", id), ...item })),
    ...Object.values(liveTools)
      .filter((item) => item.threadId === temporaryAsk.threadId)
      .map((item) => ({ id: item.itemId, kind: "tool" as const, sequence: liveTimelineSequence("tool", item.itemId), ...item }))
  ]
    .filter((entry) => !temporaryCompletedTurnIds.has(entry.turnId ?? ""))
    .filter((entry) => !temporaryPersistedItemIds.has(entry.kind === "agent" ? entry.sourceItemId ?? entry.id : entry.id))
    .sort((left, right) => left.sequence - right.sequence || left.startedAt.localeCompare(right.startedAt)) : [];

  const renderTemporaryPrompt = (text: string, key: string) => (
    <article className="messageItem kind-user type-userMessage temporaryAskUser" key={key}>
      <div className="messageMeta">用户</div>
      <CollapsibleUserMessage text={text} projectId={temporaryAsk?.projectId} onOpenFileLink={openFilePreview} />
    </article>
  );

  const renderTemporaryPersistedTurn = (turn: Turn) => {
    const mappedPrompt = temporaryAsk?.prompts.find((entry) => entry.turnId === turn.id)?.text;
    const storedUserText = (turn.items ?? [])
      .filter((item) => itemKind(item) === "user")
      .map((item) => itemText(item))
      .find((text) => text.trim()) ?? turnUserText(turn);
    const visiblePrompt = mappedPrompt ?? temporaryQuestionText(storedUserText);
    const rendered: React.ReactNode[] = [];
    if (visiblePrompt) rendered.push(renderTemporaryPrompt(visiblePrompt, `${turn.id}-prompt`));

    const pendingTools: ThreadItem[] = [];
    let toolBundleIndex = 0;
    const flushTools = () => {
      if (!pendingTools.length) return;
      if (pendingTools.some((item) => itemKind(item) === "tool")) {
        rendered.push(renderPersistedToolBundle(
          `temporary-${turn.id}-tools-${toolBundleIndex++}`,
          [...pendingTools],
          true,
          temporaryAsk?.threadId ?? undefined,
          temporaryAsk?.projectId
        ));
      } else {
        for (const item of pendingTools) {
          const text = stripInterruptArtifacts(itemText(item));
          rendered.push(
            <article className={messageClassName(item)} key={`${turn.id}-${item.id}`}>
              <ReasoningMessage text={text} projectId={temporaryAsk?.projectId} onOpenFileLink={openFilePreview} />
            </article>
          );
        }
      }
      pendingTools.length = 0;
    };
    for (const item of turn.items ?? []) {
      if (isInternalRuntimeUserMessage(item)) continue;
      const kind = itemKind(item);
      if (kind === "user") continue;
      if (kind === "tool" || kind === "reasoning") {
        if (kind === "reasoning" && !reasoningItemDisplayText(item)) continue;
        pendingTools.push(item);
        continue;
      }
      flushTools();
      const text = stripInterruptArtifacts(itemText(item));
      if (!text.trim() && kind === "agent") continue;
      rendered.push(
        <article className={messageClassName(item, kind === "agent" ? "temporaryAskAgent" : "")} key={`${turn.id}-${item.id}`}>
          <div className="messageMeta">{itemLabel(item)}</div>
          <MarkdownMessage text={text || toolItemDetails(item)} projectId={temporaryAsk?.projectId} onOpenFileLink={openFilePreview} renderMath={kind === "agent"} />
          <MessageImagePreviews item={item} projectId={temporaryAsk?.projectId} onOpenFileLink={openFilePreview} />
        </article>
      );
    }
    flushTools();
    return <section className="conversationTurnRow" data-turn-id={turn.id} key={`temporary-turn:${turn.id}`}>{rendered}</section>;
  };

  const renderPendingUserMessage = (entry: PendingUserMessage) => {
    const item: ThreadItem = {
      id: entry.id,
      type: "userMessage",
      role: "user",
      text: entry.text
    };
    const navigationKey = pendingPromptNavigationKey(entry.id);
    return (
      <article
        className={`${messageClassName(item, "live pending")}${entry.turnId === editingPromptDraft?.turnId ? " editingOriginalMessage" : ""}`}
        key={entry.id}
        ref={(element) => setPromptMessageElement(navigationKey, element)}
      >
        <div className="messageMeta">用户 · sending</div>
        <CollapsibleUserMessage text={visibleUserHistoryText(entry.text)} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
        {entry.attachments?.length
          ? <PendingUserImagePreviews uploads={entry.attachments} onOpenFileLink={openFilePreview} />
          : <PersistedUserAttachmentPreviews text={entry.text} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />}
        {entry.turnId && selectedThread?.id === entry.threadId && (!selectedActiveTurnId || lastStoppedTurnForEdit?.turnId === entry.turnId) && (interruptRequestedTurnIdsRef.current.has(entry.turnId) || interruptingTurns[entry.turnId] || lastStoppedTurnForEdit?.turnId === entry.turnId || selectedThread.turns.some((turn) => turn.id === entry.turnId && ["interrupted", "failed"].some((status) => normalizedToken(turn.status).includes(status)))) ? <div className="v2UserMessageActions" aria-label="用户消息操作">
          <button type="button" title="编辑最后一条提问" aria-label="编辑最后一条提问" disabled={editingLastPrompt || Boolean(editingPromptDraft)} onClick={() => void editLatestPrompt(entry.turnId!, entry.attachments?.length && /^上传了 \d+ 个文件：/.test(entry.text) ? "" : entry.text, entry.text, entry.attachments ?? [])}><PencilLine size={15} /></button>
        </div> : null}
      </article>
    );
  };
  const visiblePendingUserMessages = useMemo(() => pendingUserMessages.filter((entry) => {
    if (!selectedThread?.id) {
      return entry.threadId === null && entry.viewToken === threadViewTokenRef.current;
    }
    return entry.threadId === selectedThread.id;
  }), [pendingUserMessages, selectedThread]);
  const persistedSelectedTurnIds = new Set((selectedThread?.turns ?? []).map((turn) => turn.id));
  const selectedUnpersistedLiveTurnId = selectedThread?.id
    ? [...liveTimelineEntries].reverse().find((entry) => entry.turnId && !persistedSelectedTurnIds.has(entry.turnId))?.turnId ?? null
    : null;
  const selectedSnapshotTurnId = selectedThread?.id
    ? activeTurnsByThread[selectedThread.id] ?? selectedUnpersistedLiveTurnId
    : null;
  const displayedTurnIds = useMemo(() => {
    const ids = new Set((selectedThread?.turns ?? []).map((turn) => turn.id));
    if (selectedSnapshotTurnId) ids.add(selectedSnapshotTurnId);
    return ids;
  }, [selectedSnapshotTurnId, selectedThread]);
  const persistedUserTurnIds = useMemo(() => new Set(
    (selectedThread?.turns ?? [])
      .filter((turn) => turnHasUserItem(turn) || Boolean(turnUserText(turn).trim()))
      .map((turn) => turn.id)
  ), [selectedThread]);
  const pendingUserMessagesByTurn = useMemo(() => {
    const byTurn = new Map<string, PendingUserMessage[]>();
    for (const entry of visiblePendingUserMessages) {
      if (!entry.turnId || !displayedTurnIds.has(entry.turnId) || persistedUserTurnIds.has(entry.turnId)) {
        continue;
      }
      const entries = byTurn.get(entry.turnId) ?? [];
      entries.push(entry);
      byTurn.set(entry.turnId, entries);
    }
    return byTurn;
  }, [displayedTurnIds, persistedUserTurnIds, visiblePendingUserMessages]);
  const detachedPendingUserMessages = useMemo(() => {
    return visiblePendingUserMessages.filter((entry) => !entry.turnId || !displayedTurnIds.has(entry.turnId));
  }, [displayedTurnIds, visiblePendingUserMessages]);
  const heldPendingUserMessages = useMemo(
    () => detachedPendingUserMessages.filter((entry) => entry.keepAtBottomUntil > promptBottomHoldNow),
    [detachedPendingUserMessages, promptBottomHoldNow]
  );
  const timelinePendingUserMessages = useMemo(
    () => detachedPendingUserMessages.filter((entry) => entry.keepAtBottomUntil <= promptBottomHoldNow),
    [detachedPendingUserMessages, promptBottomHoldNow]
  );
  const heldPersistedPromptNavigationKeys = useMemo(() => {
    const hiddenKeys = new Set<string>();
    const threadId = selectedThread?.id;
    if (!threadId || heldPendingUserMessages.length === 0) {
      return hiddenKeys;
    }

    const heldByTurnId = new Map<string, PendingUserMessage[]>();
    for (const entry of heldPendingUserMessages) {
      if (entry.threadId !== threadId || !entry.turnId) {
        continue;
      }
      const entries = heldByTurnId.get(entry.turnId) ?? [];
      entries.push(entry);
      heldByTurnId.set(entry.turnId, entries);
    }

    for (const turn of selectedThread?.turns ?? []) {
      const heldEntries = heldByTurnId.get(turn.id);
      if (!heldEntries?.length) {
        continue;
      }
      const syntheticUserText = turnHasUserItem(turn) ? "" : turnUserText(turn);
      const syntheticUserItem: ThreadItem | null = syntheticUserText.trim()
        ? { id: `${turn.id}-user-input`, type: "userMessage", role: "user", text: syntheticUserText }
        : null;
      const candidates = (syntheticUserItem ? [syntheticUserItem, ...(turn.items ?? [])] : turn.items ?? [])
        .filter((item) => itemKind(item) === "user" && itemText(item).trim());
      for (const heldEntry of heldEntries) {
        const candidateIndex = candidates.findIndex((item) => userTextsMatch(itemText(item), heldEntry.text));
        const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : candidates.length === 1 ? candidates[0] : null;
        if (!candidate) {
          continue;
        }
        hiddenKeys.add(promptNavigationKey(turn.id, candidate.id));
        candidates.splice(candidateIndex >= 0 ? candidateIndex : 0, 1);
      }
    }
    return hiddenKeys;
  }, [heldPendingUserMessages, selectedThread]);
function getRunningTurnIdForThread(thread?: ThreadSummary | null): string | null {
    if (!thread?.id) {
      return null;
    }
    const snapshotTurnId = activeTurnsByThread[thread.id];
    if (snapshotTurnId) {
      const snapshotTurn = thread.turns.find((turn) => turn.id === snapshotTurnId);
      if ((!snapshotTurn && !interruptRequestedTurnIdsRef.current.has(snapshotTurnId) && !interruptingTurns[snapshotTurnId])
        || (snapshotTurn && isInterruptableTurnRunning(snapshotTurnId, snapshotTurn))) {
        return snapshotTurnId;
      }
    }
    return null;
  }
  function isInterruptableTurnRunning(turnId: string | undefined, turn: { id?: string; status?: unknown }) {
    if (!turnId) {
      return false;
    }
    return !interruptRequestedTurnIdsRef.current.has(turnId)
      && !interruptingTurns[turnId]
      && isRunningStatus(turn.status);
  }
  const currentPendingTurnStart = visiblePendingUserMessages[visiblePendingUserMessages.length - 1] ?? null;
  const selectedActiveTurnId = getRunningTurnIdForThread(selectedThread);
  const displayedConversationTurns = useMemo(() => {
    const turns = selectedThread?.turns ?? [];
    if (!selectedSnapshotTurnId || turns.some((turn) => turn.id === selectedSnapshotTurnId)) {
      return turns;
    }
    return [...turns, {
      id: selectedSnapshotTurnId,
      status: selectedActiveTurnId === selectedSnapshotTurnId ? "running" : "completed",
      startedAt: null,
      completedAt: null,
      items: []
    } as Turn];
  }, [selectedActiveTurnId, selectedSnapshotTurnId, selectedThread]);
  const topAnchoredTurnId = topAnchoredPrompt?.viewToken === threadViewTokenRef.current
    && topAnchoredPrompt.threadId === selectedThread?.id
    // Queued prompts can start a later turn without passing through sendPrompt.
    // Never leave the previous turn's viewport-sized spacer ahead of that turn.
    && displayedConversationTurns[displayedConversationTurns.length - 1]?.id === topAnchoredPrompt.turnId
    ? topAnchoredPrompt.turnId
    : null;
  const topAnchoredLiveTail = Boolean(topAnchoredPrompt
    && topAnchoredPrompt.viewToken === threadViewTokenRef.current
    && !topAnchoredTurnId
    && visiblePendingUserMessages.some((entry) => entry.requestId === topAnchoredPrompt.requestId));
  const latestBranchableTurn = useMemo(() => (
    [...displayedConversationTurns].reverse().find((turn) => (
      turn.id !== selectedActiveTurnId && turn.items.some((item) => itemKind(item) === "agent" && itemText(item).trim())
    )) ?? null
  ), [displayedConversationTurns, selectedActiveTurnId]);
  const contextWarningVisible = Boolean(
    selectedThread
    && threadContextStatus?.usedPercent !== null
    && threadContextStatus?.usedPercent !== undefined
    && threadContextStatus.usedPercent >= threadContextStatus.warningPercent
  );
  const composerIsStopMode = Boolean(selectedActiveTurnId || currentPendingTurnStart);
  const composerHasDraft = Boolean(prompt.trim() || uploadedFiles.length);
  const composerCanSteer = Boolean(selectedActiveTurnId && composerHasDraft);
  const composerShowsStop = composerIsStopMode && !composerCanSteer;
  const composerStopBusy = selectedActiveTurnId
    ? Boolean(interruptingTurns[selectedActiveTurnId])
    : Boolean(currentPendingTurnStart && queuedInterruptPrompts[currentPendingTurnStart.requestId]);
  const conversationRunState = selectedActiveTurnId || currentPendingTurnStart ? "running" : "idle";
  const olderHistoryItemCount = threadHistory?.hasOlder ? Math.max(0, threadHistory.totalItems - threadHistory.nextBefore) : 0;
  const loadedHistoryItemCount = threadHistory ? Math.min(threadHistory.nextBefore, threadHistory.totalItems) : 0;
  const conversationLocalMessageLayout = useMemo(() => {
    const byTurn = new Map<string, LocalMessage[]>();
    const beforePending: LocalMessage[] = [];
    const tail: LocalMessage[] = [];
    const currentThreadId = selectedThread?.id ?? null;
    // Include the synthetic live turn so a thread-scoped status can be placed
    // at its real chronological position before that turn reaches persistence.
    const currentTurnIds = new Set(displayedConversationTurns.map((turn) => turn.id));

    for (const entry of localMessages) {
      if (entry.placement !== "conversation") {
        tail.push(entry);
        continue;
      }
      if (entry.threadId !== currentThreadId) {
        continue;
      }
      if (entry.afterTurnId) {
        if (!currentTurnIds.has(entry.afterTurnId)) {
          // An anchored status must never be detached and shown at the bottom
          // of another page of the same long conversation. It appears when its
          // source turn is loaded instead.
          continue;
        }
        const entries = byTurn.get(entry.afterTurnId) ?? [];
        entries.push(entry);
        byTurn.set(entry.afterTurnId, entries);
      } else {
        beforePending.push(entry);
      }
    }
    return { byTurn, beforePending, tail };
  }, [displayedConversationTurns, localMessages, selectedThread?.id]);
  const promptNavigationItems = useMemo(() => {
    const items = promptNavigationItemsForThread(selectedThread)
      .filter((item) => !heldPersistedPromptNavigationKeys.has(item.key));
    for (const pendingMessage of pendingUserMessages) {
      const belongsToCurrentThread = selectedThread?.id
        ? pendingMessage.threadId === selectedThread.id
        : pendingMessage.threadId === null && pendingMessage.viewToken === threadViewTokenRef.current;
      if (!belongsToCurrentThread || (pendingMessage.turnId && persistedUserTurnIds.has(pendingMessage.turnId))) {
        continue;
      }
      const navigationItem = createPromptNavigationItem(pendingPromptNavigationKey(pendingMessage.id), pendingMessage.text);
      if (navigationItem) {
        items.push(navigationItem);
      }
    }
    return items;
  }, [heldPersistedPromptNavigationKeys, pendingUserMessages, persistedUserTurnIds, selectedThread]);
  const hoveredPromptNavigationItem = promptNavigationItems.find((item) => item.key === hoveredPromptNavigationKey) ?? null;
  const promptPreviewPresence = useExitPresence(Boolean(hoveredPromptNavigationItem), 220);
  if (hoveredPromptNavigationItem) {
    lastPromptPreviewRef.current = {
      item: hoveredPromptNavigationItem,
      index: promptNavigationItems.findIndex((item) => item.key === hoveredPromptNavigationItem.key) + 1,
      threadId: selectedThread?.id ?? null,
      userId: selectedUserId
    };
  }
  const displayedPromptPreview = lastPromptPreviewRef.current?.threadId === (selectedThread?.id ?? null)
    && lastPromptPreviewRef.current.userId === selectedUserId ? lastPromptPreviewRef.current : null;
  const visibleDepartingPromptPreview = departingPromptPreview?.threadId === (selectedThread?.id ?? null)
    && departingPromptPreview.userId === selectedUserId ? departingPromptPreview : null;
  function hoverPromptNavigation(key: string | null) {
    if (promptPreviewSwitchTimerRef.current !== null) window.clearTimeout(promptPreviewSwitchTimerRef.current);
    if (key && hoveredPromptNavigationItem && hoveredPromptNavigationItem.key !== key) {
      setDepartingPromptPreview({
        item: hoveredPromptNavigationItem,
        index: promptNavigationItems.findIndex((item) => item.key === hoveredPromptNavigationItem.key) + 1,
        threadId: selectedThread?.id ?? null,
        userId: selectedUserId
      });
      promptPreviewSwitchTimerRef.current = window.setTimeout(() => {
        setDepartingPromptPreview(null);
        promptPreviewSwitchTimerRef.current = null;
      }, 220);
    } else {
      setDepartingPromptPreview(null);
      promptPreviewSwitchTimerRef.current = null;
    }
    setHoveredPromptNavigationKey(key);
  }
  const showPromptNavigator = promptNavigationItems.length > 0 || Boolean(selectedThread && threadHistory?.hasOlder);
  const globalEnterSendBlocked = Boolean(
    settingsPresence.present ||
    globalSearchPresence.present ||
    renamingThread ||
    directoryBrowserPresence.present ||
    leaderboardPresence.present ||
    trackedQuotaPresence.present ||
    filePreview ||
    filePreviewLoading ||
    filePreviewError
  );

  useEffect(() => {
    if (!temporaryAsk) return;
    const frame = window.requestAnimationFrame(() => {
      temporaryMessagesEndRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [temporaryAsk, temporaryThread, temporaryLiveTimeline.length, liveDeltas, liveTools]);

  useEffect(() => {
    if (promptNavigationItems.length === 0) {
      setActivePromptNavigationKey(null);
      setHoveredPromptNavigationKey(null);
      return;
    }
    setActivePromptNavigationKey((current) => promptNavigationItems.some((item) => item.key === current) ? current : promptNavigationItems.at(-1)?.key ?? null);
    setHoveredPromptNavigationKey((current) => promptNavigationItems.some((item) => item.key === current) ? current : null);
    schedulePromptNavigationActiveUpdate();
  }, [promptNavigationItems]);

  useEffect(() => () => {
    if (promptNavigationFrameRef.current !== null) {
      window.cancelAnimationFrame(promptNavigationFrameRef.current);
    }
    if (threadCopyNoticeTimerRef.current !== null) {
      window.clearTimeout(threadCopyNoticeTimerRef.current);
    }
    if (promptPreviewSwitchTimerRef.current !== null) {
      window.clearTimeout(promptPreviewSwitchTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const handleGlobalEnter = (event: KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        globalEnterSendBlocked ||
        (composerIsStopMode && !selectedActiveTurnId) ||
        uploadingFiles ||
        !selectedProject ||
        (!prompt.trim() && !uploadedFiles.length) ||
        blocksGlobalEnterSend(event.target)
      ) {
        return;
      }
      event.preventDefault();
      void sendPrompt();
    };

    window.addEventListener("keydown", handleGlobalEnter);
    return () => window.removeEventListener("keydown", handleGlobalEnter);
  }, [composerIsStopMode, globalEnterSendBlocked, prompt, selectedActiveTurnId, selectedProject, sendPrompt, uploadedFiles.length, uploadingFiles]);

  useEffect(() => {
    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        globalEnterSendBlocked ||
        threadContextMenu ||
        composerStopBusy
      ) {
        return;
      }
      if (!selectedActiveTurnId && !currentPendingTurnStart) {
        return;
      }
      event.preventDefault();
      requestInterruptSelectedConversation();
    };

    window.addEventListener("keydown", handleGlobalEscape);
    return () => window.removeEventListener("keydown", handleGlobalEscape);
  }, [
    composerStopBusy,
    currentPendingTurnStart,
    globalEnterSendBlocked,
    selectedActiveTurnId,
    selectedProject,
    selectedThread,
    threadContextMenu
  ]);

  if (selectedThread && queuedSubmissions[0]) {
    lastQueuedSubmissionRef.current = { threadId: selectedThread.id, entry: queuedSubmissions[0] };
  }
  const lastQueuedSubmission = lastQueuedSubmissionRef.current;
  const visibleQueuedSubmission = queuedSubmissions[0]
    ?? (lastQueuedSubmission?.threadId === selectedThread?.id ? lastQueuedSubmission?.entry : null);

  return (
    <RunnablePreviewContext.Provider value={setRunnablePreview}>
    <main
      className={`appShell${temporaryAsk ? " temporaryPanelOpen" : ""}`}
      style={{
        gridTemplateColumns: sidebarCollapsed
          ? `0px 0px minmax(${temporaryAsk ? "0px" : "620px"}, 1fr)`
          : `${sidebarWidth}px 8px minmax(${temporaryAsk ? "0px" : "620px"}, 1fr)`,
        paddingRight: temporaryAsk ? `${temporaryAskWidth}px` : undefined,
        "--v2-sidebar-width": `${threadListWidth}px`
      } as CSSProperties}
    >
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="brand">
          <Bot size={22} />
          <div>
            <div className="brandTitleRow">
              <strong>Codex Web</strong>
            </div>
            <span className={`statusDot ${socketStatus}`}>{socketStatus}</span>
          </div>
          <button
            className="panelCollapseButton"
            type="button"
            onClick={() => {
              setSidebarCollapsed(true);
              window.localStorage.setItem(sidebarCollapsedStorageKey, "true");
            }}
            title="折叠项目侧栏"
            aria-label="折叠项目侧栏"
          >
            <IconParkSmallArrow direction="left" />
          </button>
        </div>

        <div className="userSwitcher">
          <div className="miniHeader splitHeader">
            <span>用户</span>
            <a href="/change-password">改密码</a>
          </div>
          <div className="lockedUserBadge" title="当前登录姓名已绑定为 Codex Web 用户">
            {selectedUser?.name ?? selectedUserId}
          </div>
          <p className="creatorHint">Codex Web 用户已锁定为当前登录姓名；前端不可切换，服务端也会忽略伪造的用户 ID。</p>
          <div className="userLinks">
            <a href="/change-password">修改密码</a>
            <a href="/logout" onClick={(event) => { event.preventDefault(); void unsubscribePushAndLogout(); }}>退出登录</a>
          </div>
        </div>

        <div className="projectCreator">
          <div className="miniHeader">
            <FolderOpen size={16} />
            <span>连接本地记录</span>
          </div>
          <button
            className="iconTextButton primary full"
            type="button"
            onClick={() => void chooseDirectory()}
            disabled={selectingDirectory}
          >
            <FolderOpen size={16} />
            {selectingDirectory ? "选择中" : "选择目录"}
          </button>
          <p className="creatorHint">选择后会自动连接该目录的 Codex 记录，并用目录名作为项目名。</p>
        </div>

        <div className="listHeader">
          <span>本地项目</span>
          <button className="iconButton" type="button" onClick={() => void refreshProjects()} title="Refresh projects">
            <RefreshCcw size={15} />
          </button>
        </div>
        <div className="projectList">
          {projects.map((project) => {
            const deletePending = pendingDeleteProjectId === project.id;
            return (
              <div
                className={`projectRow ${project.id === selectedProjectId ? "selected" : ""}`}
                key={project.id}
              >
                <button
                  className="projectSelectButton"
                  type="button"
                  onClick={() => {
                    setPendingDeleteProjectId(null);
                    setSelectedProjectId(project.id);
                  }}
                >
                  <GitBranch size={15} />
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.rootPath}</small>
                  </span>
                </button>
                <button
                  className={`projectDeleteButton ${deletePending ? "confirm" : ""}`}
                  type="button"
                  onClick={() => requestRemoveProject(project)}
                  title={deletePending ? `确认移除 ${project.name}` : `移除 ${project.name}`}
                >
                  {deletePending ? "确认" : <Trash2 size={15} />}
                </button>
                <button
                  className="projectRenameButton"
                  type="button"
                  onClick={() => beginProjectRename(project)}
                  title="重命名工作区"
                  aria-label="重命名工作区"
                >
                  <PencilLine size={15} />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {sidebarCollapsed ? (
        <button
          className="panelRestoreButton sidebarRestoreButton"
          type="button"
          onClick={() => {
            setSidebarCollapsed(false);
            window.localStorage.setItem(sidebarCollapsedStorageKey, "false");
          }}
          title="展开项目侧栏"
          aria-label="展开项目侧栏"
        >
          <IconParkSmallArrow direction="right" />
        </button>
      ) : null}

      <div
        className="resizeHandle verticalResizeHandle appShellResizeHandle"
        style={{ display: sidebarCollapsed ? "none" : undefined }}
        role="separator"
        aria-orientation="vertical"
        title="拖动调整 Codex Web 面板宽度"
        onMouseDown={(event) => beginHorizontalResize(
          event,
          sidebarWidth,
          setSidebarWidth,
          sidebarWidthStorageKey,
          220,
          // Keep enough room for the thread list and a readable conversation.
          Math.min(480, window.innerWidth - 8 - (threadListCollapsed ? 0 : 180) - 520)
        )}
      />

      {threadContextMenu ? (
        <div
          className="threadContextMenu"
          role="menu"
          aria-label={`会话操作：${threadContextMenu.thread.name || threadContextMenu.thread.preview || "Untitled"}`}
          style={{ left: threadContextMenu.x, top: threadContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => void copyThreadSessionId(threadContextMenu.thread)}>
            <Copy size={15} />
            复制会话 ID
          </button>
          <button type="button" role="menuitem" onClick={() => beginThreadRename(threadContextMenu.thread)}>
            <PencilLine size={15} />
            重命名会话
          </button>
          <button type="button" role="menuitem" onClick={() => void toggleThreadPin(threadContextMenu.thread)}>
            <Pin size={15} />
            {threadContextMenu.thread.pinned ? "取消置顶" : "置顶会话"}
          </button>
          <button type="button" role="menuitem" onClick={() => void changeThreadArchive(threadContextMenu.thread, true)}>
            <Archive size={15} />归档会话
          </button>
        </div>
      ) : null}

      {newThreadProjectPickerPresence.present ? <div className={`workspaceFeatureScrim${newThreadProjectPickerPresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={newThreadProjectPickerPresence.closing} inert={newThreadProjectPickerPresence.closing} onMouseDown={(event) => { if (event.target === event.currentTarget) setNewThreadProjectPickerOpen(false); }}>
        <section className="workspaceFeatureDialog newThreadProjectPicker uiGlassSurface" role="dialog" aria-modal="true" aria-label="选择新对话的工作区">
          <header><strong>选择工作区</strong><button type="button" onClick={() => setNewThreadProjectPickerOpen(false)} aria-label="关闭"><X size={17} /></button></header>
          <div className="workspaceFeatureBody">
            <div className="newThreadProjectList">{orderedProjects.map((project) => <button type="button" key={project.id} onClick={() => startNewThreadInProject(project.id)}>
              <Folder size={17} strokeWidth={2.2} /><span>{project.name}</span><SquarePen size={15} strokeWidth={2.2} />
            </button>)}</div>
            <button className="newThreadCreateProject" type="button" onClick={() => { setNewThreadProjectPickerOpen(false); window.setTimeout(() => void chooseDirectory(), 260); }}><FolderPlus size={17} strokeWidth={2.2} />新建工作区</button>
          </div>
        </section>
      </div> : null}

      {archivedPresence.present && archivedThreads !== null ? <div className={`workspaceFeatureScrim${archivedPresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={archivedPresence.closing} inert={archivedPresence.closing} onMouseDown={(event) => { if (event.target === event.currentTarget) setArchivedOpen(false); }}>
        <section className="workspaceFeatureDialog uiGlassSurface" role="dialog" aria-modal="true" aria-label="归档会话">
          <header><strong>归档会话</strong><button type="button" onClick={() => setArchivedOpen(false)} aria-label="关闭"><X size={17} /></button></header>
          <div className="workspaceFeatureBody">{archivedLoading ? <p>正在读取…</p> : archivedThreads.length ? archivedThreads.map(thread => <div className="workspaceFeatureRow" key={thread.id}>
            <span><strong>{thread.name || thread.preview || "未命名会话"}</strong><small>{formatTime(thread.updatedAt)}</small></span>
            <button type="button" onClick={() => void changeThreadArchive(thread, false)}>恢复</button>
          </div>) : <p>这个工作区没有归档会话。</p>}</div>
        </section>
      </div> : null}

      {worktreePresence.present ? <div className={`workspaceFeatureScrim${worktreePresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={worktreePresence.closing} inert={worktreePresence.closing} onMouseDown={(event) => { if (event.target === event.currentTarget) setWorktreeOpen(false); }}>
        <section className="workspaceFeatureDialog uiGlassSurface" role="dialog" aria-modal="true" aria-label="创建独立工作树">
          <header><strong>创建独立工作树</strong><button type="button" onClick={() => setWorktreeOpen(false)} aria-label="关闭"><X size={17} /></button></header>
          <div className="workspaceFeatureBody">
            <p>选择一个 Git 仓库。新工作树会拥有独立分支和工作区，不会覆盖原目录。</p>
            {worktreeLoading ? <p>正在查找仓库…</p> : worktreeRepositories.length ? <div className="worktreeRepositoryList">{worktreeRepositories.map(repository => <button className={worktreeRepositoryPath === repository.rootPath ? "selected" : ""} type="button" key={repository.rootPath} onClick={() => setWorktreeRepositoryPath(repository.rootPath)}><GitBranch size={15} /><span><strong>{repository.name}</strong><small>{repository.rootPath}</small></span></button>)}</div> : <p>当前工作区内没有找到 Git 仓库；可以先在项目目录初始化 Git，或新建一个指向 Git 仓库的工作区。</p>}
            {worktreeRepositoryPath ? <p className="workspaceFeatureCaution">{worktreeRepositoryPath === selectedProject?.rootPath && selectedThread ? "创建后将从当前会话接力到新工作树。" : "所选仓库与当前会话目录不同：将创建空白会话，不会把现有对话接到其他仓库。"}</p> : null}
            <div className="workspaceFeatureFooter"><button type="button" onClick={() => setWorktreeOpen(false)}>取消</button><button type="button" className="primary" disabled={!worktreeRepositoryPath || creatingWorktree} onClick={() => void createIsolatedWorktree(worktreeRepositoryPath)}>{creatingWorktree ? "创建中…" : "创建工作树"}</button></div>
          </div>
        </section>
      </div> : null}

      {hooksPresence.present && hooksStatus !== null ? <div className={`workspaceFeatureScrim${hooksPresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={hooksPresence.closing} inert={hooksPresence.closing} onMouseDown={(event) => { if (event.target === event.currentTarget) setHooksOpen(false); }}>
        <section className="workspaceFeatureDialog uiGlassSurface" role="dialog" aria-modal="true" aria-label="Hooks 状态">
          <header><strong>Hooks 状态</strong><div className="workspaceFeatureHeaderActions"><button type="button" className="workspaceFeatureAddButton" onClick={() => setHookEditorOpen(current => !current)}>{hookEditorOpen ? "取消添加" : "添加 Hook"}</button><button type="button" onClick={() => setHooksOpen(false)} aria-label="关闭"><X size={17} /></button></div></header>
          <div className="workspaceFeatureBody">{hookEditorPresence.present ? <div className={`workspaceHookEditor${hookEditorPresence.closing ? " uiClosing" : ""}`} aria-hidden={hookEditorPresence.closing} inert={hookEditorPresence.closing}>
            <label>触发时机<select value={hookEventName} onChange={event => setHookEventName(event.target.value as typeof hookEventName)}><option value="SessionStart">会话启动 SessionStart</option><option value="Stop">回答结束 Stop</option><option value="PreToolUse">工具执行前 PreToolUse</option><option value="PostToolUse">工具执行后 PostToolUse</option></select></label>
            {(hookEventName === "PreToolUse" || hookEventName === "PostToolUse") ? <label>工具匹配（默认 Bash）<input value={hookMatcher} onChange={event => setHookMatcher(event.target.value)} placeholder="Bash" /></label> : null}
            <label>执行命令<textarea value={hookCommand} onChange={event => setHookCommand(event.target.value)} rows={3} placeholder="输入你已经审核的本地命令或脚本路径" spellCheck={false} /></label>
            <p>按 OpenAI 官方 hooks.json 格式保存到此项目；保存后仍须审核并信任当前内容，才会在你的会话中执行。</p>
            <div className="workspaceFeatureFooter"><button type="button" disabled={!hookCommand.trim() || hookSaving} className="primary" onClick={() => void saveProjectHook()}>{hookSaving ? "保存中…" : "保存 Hook"}</button></div>
          </div> : null}{hooksLoading ? <p>正在检查当前工作区…</p> : hooksStatus.hooks.length ? hooksStatus.hooks.map(hook => <article className="workspaceHookItem" key={hook.key}>
            <div className="workspaceFeatureRow"><span><strong>{hook.eventName}{hook.matcher ? ` · ${hook.matcher}` : ""}</strong><small>{hook.pluginId || hook.source} · {hook.handlerType} · {hook.enabled ? "已启用" : "已停用"}</small></span>
              <em className={hook.userTrusted || hook.trustStatus === "trusted" ? "trusted" : ""}>{hook.userTrusted ? "本用户已信任" : hook.trustStatus === "trusted" ? "运行时已信任" : hook.trustStatus === "modified" ? "已修改，待复核" : hook.trustStatus === "untrusted" ? "待信任" : hook.trustStatus}</em></div>
            {hook.command ? <code>{hook.command}</code> : null}
            {hook.trustable && hook.currentHash && hook.trustStatus !== "trusted" ? <div className="workspaceHookActions">
              {hook.userTrusted ? <button type="button" onClick={() => void changeProjectHookTrust(hook, false)}>撤销本用户信任</button>
                : pendingHookTrustKey === hook.key ? <><span>确认只在你的会话中执行上方 Hook？</span><button type="button" onClick={() => void changeProjectHookTrust(hook, true)}>确认信任</button><button type="button" onClick={() => setPendingHookTrustKey(null)}>取消</button></>
                  : <button type="button" onClick={() => setPendingHookTrustKey(hook.key)}>审核并信任</button>}
            </div> : null}
          </article>) : <p>当前工作区没有配置 Hooks。可从上方选择触发时机并添加已审核的命令。</p>}
          {hooksStatus.warnings.map((warning, index) => <p key={`w-${index}`}>{warning}</p>)}
          {hooksStatus.errors.map((error, index) => <p key={`e-${index}`}>{error}</p>)}
          <p className="workspaceFeatureCaution">仅当前工作区内的 Hook 可由你按当前内容哈希授予会话级信任；共享账号的全局／插件 Hooks 仍由管理员在官方 /hooks 中审核。修改 Hook 后必须重新审核。</p>
          </div>
        </section>
      </div> : null}

      {threadCopyNotice ? <div className="threadCopyToast" role="status">{threadCopyNotice}</div> : null}

      {globalSearchPresence.present ? (
        <div className={`globalSearchScrim uiExitLayer${globalSearchPresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={globalSearchPresence.closing} inert={globalSearchPresence.closing} onMouseDown={(event) => {
          if (event.target === event.currentTarget) setGlobalSearchOpen(false);
        }}>
          <section className="globalSearchDialog" role="dialog" aria-modal="true" aria-label="搜索会话和消息">
            <div className="globalSearchInputRow">
              <span aria-hidden="true">⌕</span>
              <input autoFocus value={globalSearchQuery} onChange={(event) => {
                setGlobalSearchQuery(event.target.value);
                setGlobalSearchPage(0);
                setGlobalSearchResults([]);
                setGlobalSearchNextOffset(null);
                setGlobalSearchIndexing(false);
                setGlobalSearchLoading(Boolean(event.target.value.trim()));
                setGlobalSearchExpandedThread(null);
              }} placeholder="搜索会话和消息" />
              <button type="button" onClick={() => setGlobalSearchOpen(false)} aria-label="关闭搜索">×</button>
            </div>
            <div className="globalSearchResults">
              {!globalSearchQuery.trim() ? <p className="globalSearchHint">输入关键词，搜索全部项目中的会话标题和消息正文。</p> : null}
              {globalSearchIndexing ? <p className="globalSearchHint">正在后台建立搜索索引，结果会自动更新。</p> : null}
              {!globalSearchIndexing && globalSearchPendingThreads > 0 ? <p className="globalSearchHint">有 {globalSearchPendingThreads} 个会话的正文索引尚不可用，后台正在检查历史文件。</p> : null}
              {globalSearchLoading ? <p className="globalSearchHint">正在搜索…</p> : null}
              {!globalSearchLoading && !globalSearchIndexing && globalSearchQuery.trim() && !globalSearchResults.length ? <p className="globalSearchHint">没有匹配的会话。</p> : null}
              {globalSearchResults.map(({ project, thread, match }) => (
                <div key={`${project.id}-${thread.id}`}>
                <button className="globalSearchResult" type="button" onClick={() => void openGlobalSearchResult({ project, thread, match })}>
                  <span>
                    <strong>{thread.name || thread.preview || "未命名会话"}</strong>
                    <small className="searchResultSnippet">{match ? match.snippet : (thread.preview || "点击打开此会话")}</small>
                    <em className="searchResultType">{match ? `命中 ${thread.searchHitCount ?? 1} 条消息` : "会话标题/摘要匹配"}</em>
                  </span>
                  <em>{project.name}</em>
                </button>
                {(thread.searchMatches?.length ?? 0) > 1 ? <button type="button" className="iconTextButton" onClick={() => setGlobalSearchExpandedThread(current => current === thread.id ? null : thread.id)}>
                  {globalSearchExpandedThread === thread.id ? "收起匹配消息" : "查看其他匹配消息（最近 3 条）"}
                </button> : null}
                {globalSearchExpandedThread === thread.id ? thread.searchMatches?.slice(1).map(hit => (
                  <button key={hit.itemId} className="globalSearchResult" type="button" onClick={() => void openGlobalSearchResult({ project, thread, match: { ...hit, projectId: project.id } })}>
                    <small className="searchResultSnippet">{hit.snippet}</small>
                  </button>
                )) : null}
                </div>
              ))}
              {globalSearchNextOffset !== null ? <button type="button" className="iconTextButton" disabled={globalSearchLoading} onClick={() => setGlobalSearchPage(globalSearchNextOffset)}>加载更多会话</button> : null}
            </div>
          </section>
        </div>
      ) : null}

      {renamingThread ? (
        <div className="modalScrim" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            closeThreadRename();
          }
        }}>
          <form
            className="renameThreadDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-thread-title"
            onSubmit={(event) => {
              event.preventDefault();
              submitThreadRename();
            }}
          >
            <h2 id="rename-thread-title">重命名会话</h2>
            <p>仅会修改当前登录用户拥有的这条会话记录。</p>
            <label className="renameThreadLabel" htmlFor="thread-rename-input">会话名称</label>
            <input
              id="thread-rename-input"
              autoFocus
              value={threadRenameDraft}
              onChange={(event) => setThreadRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeThreadRename();
                }
              }}
              maxLength={160}
              disabled={renamingThreadId === renamingThread.id}
            />
            <div className="dialogActions">
              <button className="iconTextButton" type="button" onClick={closeThreadRename} disabled={renamingThreadId === renamingThread.id}>
                取消
              </button>
              <button className="iconTextButton primary" type="submit" disabled={renamingThreadId === renamingThread.id || !threadRenameDraft.trim()}>
                {renamingThreadId === renamingThread.id ? "重命名中" : "保存"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {renamingProject ? (
        <div className="modalScrim" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            closeProjectRename();
          }
        }}>
          <form
            className="renameThreadDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-project-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitProjectRename();
            }}
          >
            <h2 id="rename-project-title">重命名工作区</h2>
            <p>仅修改当前登录用户在此实例下创建的工作区名称。</p>
            <label className="renameThreadLabel" htmlFor="project-rename-input">工作区名称</label>
            <input
              id="project-rename-input"
              autoFocus
              value={projectRenameDraft}
              onChange={(event) => setProjectRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeProjectRename();
                }
              }}
              maxLength={120}
              disabled={renamingProjectId === renamingProject.id}
            />
            <div className="dialogActions">
              <button className="iconTextButton" type="button" onClick={closeProjectRename} disabled={renamingProjectId === renamingProject.id}>
                取消
              </button>
              <button className="iconTextButton primary" type="submit" disabled={renamingProjectId === renamingProject.id || !projectRenameDraft.trim()}>
                {renamingProjectId === renamingProject.id ? "重命名中" : "保存"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {directoryBrowserPresence.present ? (
        <div className={`modalScrim directoryPickerScrim uiExitLayer${directoryBrowserPresence.closing ? " uiClosing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="directory-browser-title" aria-hidden={directoryBrowserPresence.closing} inert={directoryBrowserPresence.closing}>
          <div className="directoryDialog uiGlassSurface">
            <div className="directoryDialogHeader">
              <div>
                <h2 id="directory-browser-title">选择项目目录</h2>
                <p>{directoryBrowser?.currentPath ?? projectRoot}</p>
              </div>
              <button className="iconButton" type="button" onClick={() => setDirectoryBrowserOpen(false)} title="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="directoryToolbar">
              <button
                className="iconTextButton"
                type="button"
                onClick={() => void openDirectoryBrowser(directoryBrowser?.parentPath ?? directoryBrowser?.rootPath)}
                disabled={directoryBrowserLoading || !directoryBrowser?.parentPath}
              >
                上级
              </button>
              <button
                className="iconButton"
                type="button"
                onClick={() => void openDirectoryBrowser(directoryBrowser?.currentPath)}
                disabled={directoryBrowserLoading}
                title="刷新"
              >
                <RefreshCcw size={15} />
              </button>
            </div>
            <div className="directoryList">
              {directoryBrowserLoading ? <div className="directoryEmpty">加载中</div> : null}
              {!directoryBrowserLoading && directoryBrowser?.directories.length === 0 ? (
                <div className="directoryEmpty">没有可进入的子目录</div>
              ) : null}
              {directoryBrowser?.directories.map((entry) => (
                <button
                  className="directoryRow"
                  type="button"
                  key={entry.path}
                  onClick={() => void openDirectoryBrowser(entry.path)}
                  disabled={directoryBrowserLoading}
                >
                  <FolderOpen size={16} />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{entry.path}</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="dialogActions">
              <button className="iconTextButton" type="button" onClick={() => setDirectoryBrowserOpen(false)}>
                取消
              </button>
              <button
                className="iconTextButton primary"
                type="button"
                onClick={() => void connectCurrentDirectory()}
                disabled={directoryBrowserLoading || !directoryBrowser}
              >
                连接当前目录
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {leaderboardPresence.present ? (
        <div className={`modalBackdrop uiExitLayer${leaderboardPresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={leaderboardPresence.closing} inert={leaderboardPresence.closing} onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setLeaderboardOpen(false);
          }
        }}>
          <section className="settingsDialog leaderboardDialog" role="dialog" aria-modal="true" aria-label="模型 Token 排行榜">
            <div className="dialogHeader">
              <div>
                <h2>Token 排行榜</h2>
                <p>按本机会话 token_count 统计，包含 API 模型；不等同供应商账单。</p>
              </div>
              <button className="iconButton" type="button" onClick={() => setLeaderboardOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="leaderboardBody">
              {leaderboardLoading && !leaderboard ? (
                <div className="emptyState">读取排行榜中...</div>
              ) : leaderboard ? (
                <>
                  <LeaderboardScopeView title="当前周期" scope={leaderboard.currentCycle} users={users} />
                  <LeaderboardScopeView title="历史累计" scope={leaderboard.lifetime} users={users} />
                  {leaderboard.errors.length ? <p className="leaderboardWarning">读取警告：{leaderboard.errors.join("；")}</p> : null}
                  <p className="leaderboardUpdated">{leaderboardLoading ? "正在更新 · " : ""}更新于 {new Date(leaderboard.updatedAt).toLocaleString()}</p>
                </>
              ) : (
                <div className="emptyState">还没有排行榜数据。</div>
              )}
            </div>
            <div className="dialogActions">
              <button className="iconTextButton" type="button" onClick={() => leaderboard && addLocalMessage(leaderboardMarkdown(leaderboard, users))} disabled={!leaderboard}>
                发到对话
              </button>
              <button className="iconTextButton primary" type="button" onClick={() => void refreshLeaderboard(true, true)} disabled={leaderboardLoading}>
                {leaderboardLoading ? "刷新中" : "刷新"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {trackedQuotaPresence.present ? (
        <div className={`modalBackdrop uiExitLayer${trackedQuotaPresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={trackedQuotaPresence.closing} inert={trackedQuotaPresence.closing} onMouseDown={(event) => {
          if (event.target === event.currentTarget) setTrackedQuotaOpen(false);
        }}>
          <section className="settingsDialog trackedQuotaDialog" role="dialog" aria-modal="true" aria-label="lzc 额度占用">
            <div className="dialogHeader">
              <div>
                <h2>lzc 额度占用</h2>
                <p>各账号分别统计，并按自然日合计。</p>
              </div>
              <button className="iconButton" type="button" onClick={() => setTrackedQuotaOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>
            {trackedQuotaLoading && !trackedQuotaUsage
              ? <div className="emptyState">正在核对各账号的会话记录…</div>
              : trackedQuotaUsage
                ? <TrackedQuotaDetails usage={trackedQuotaUsage} />
                : <div className="emptyState">暂未读取到 lzc 用量。</div>}
            <div className="dialogActions">
              <span className="trackedQuotaUpdated">{trackedQuotaUsage ? `更新于 ${new Date(trackedQuotaUsage.updatedAt).toLocaleString()}` : ""}</span>
              <button className="iconTextButton" type="button" onClick={() => setTrackedQuotaOpen(false)}>关闭</button>
              <button className="iconTextButton primary" type="button" onClick={() => void refreshTrackedQuota(false, true)} disabled={trackedQuotaLoading}>
                {trackedQuotaLoading ? "刷新中" : "刷新"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {threadContextFeatureEnabled && contextPinDialogOpen && selectedProject ? (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !contextPinSaving) closeContextPinDialog();
        }}>
          <section className="settingsDialog contextDialog" role="dialog" aria-modal="true" aria-labelledby="context-dialog-title">
            <div className="dialogHeader">
              <div>
                <h2 id="context-dialog-title">{selectedThread ? "会话上下文" : "新会话上下文"}</h2>
                <p>{selectedThread
                  ? "监控当前活跃上下文，并保存 compact 后仍需保留的关键信息。"
                  : "只为下一条新会话选择独立的上下文窗口；创建后不会影响其他会话。"}</p>
              </div>
              <button className="iconButton" type="button" onClick={closeContextPinDialog} disabled={contextPinSaving} title="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="contextDialogBody">
              {selectedThread ? <section className="contextUsageCard" aria-label="上下文使用情况">
                <div className="contextUsageSummary">
                  <strong>{threadContextStatus?.usedPercent === null || threadContextStatus?.usedPercent === undefined ? "等待下一轮统计" : `已使用 ${threadContextStatus.usedPercent.toFixed(1)}%`}</strong>
                  <span>{threadContextStatus?.usedTokens === null || threadContextStatus?.usedTokens === undefined
                    ? threadContextStatus?.effectiveCompactTokenLimit
                      ? `自动 compact：${formatNumber(threadContextStatus.effectiveCompactTokenLimit)} token`
                      : "自动 compact：Codex 默认"
                    : `${formatNumber(threadContextStatus.usedTokens)} / ${formatNumber(threadContextStatus.contextWindow)} token`}</span>
                </div>
                <div className="contextUsageMeter" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, Math.max(0, threadContextStatus?.usedPercent ?? 0))}%` }} />
                </div>
                <p>{threadContextStatus?.effectiveCompactTokenLimit
                  ? `当前安全 compact 阈值 ${formatNumber(threadContextStatus.effectiveCompactTokenLimit)} token${threadContextStatus.compactAtPercent ? `（最近有效窗口约 ${threadContextStatus.compactAtPercent.toFixed(1)}%）` : ""}。`
                  : "当前会话未覆盖参数，跟随 Codex 对所选模型的默认调优。"} 比例来自最近一次 token 统计，不改变原会话记录。</p>
              </section> : null}

              <section className="contextConfigEditor" aria-label="当前会话上下文参数">
                <div className="contextSectionHeading">
                  <div>
                    <strong>{selectedThread ? "当前会话策略" : "下一条新会话策略"}</strong>
                    <span>{selectedThread
                      ? "只影响你自己的这个会话，保存后从下一次发送开始生效。"
                      : "设置随 thread/start 一次性提交，创建成功后自动恢复默认。"}</span>
                  </div>
                  {contextConfigDraft.profile === "maximum" ? <em>高额度消耗</em> : null}
                </div>
                <div className="contextProfileGrid">
                  {contextProfileOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`${contextConfigDraft.profile === option.id ? "selected" : ""} ${option.risk ? "risk" : ""}`}
                      onClick={() => setContextConfigDraft((current) => contextConfigForProfile(current, option.id))}
                      disabled={contextPinSaving || Boolean(selectedThread && contextDialogLoading)}
                    >
                      <strong>{option.title}</strong>
                      <span>{option.detail}</span>
                    </button>
                  ))}
                </div>
                {selectedThread && contextApplicationNote(threadContextStatus) ? (
                  <p className={`contextApplicationNote ${contextApplicationNote(threadContextStatus)?.capped ? "capped" : ""}`}>
                    {contextApplicationNote(threadContextStatus)?.text}
                    {contextApplicationNote(threadContextStatus)?.capped ? " 账号或当前模型尚未开放所请求的大窗口，但设置会保留。" : ""}
                  </p>
                ) : null}
                {contextConfigDraft.profile === "custom" ? (
                  <div className="contextCustomFields">
                    <label>
                      <span>model_context_window</span>
                      <input
                        type="number"
                        min={64_000}
                        max={1_000_000}
                        step={1_000}
                        value={contextConfigDraft.contextWindow ?? ""}
                        onChange={(event) => setContextConfigDraft((current) => ({
                          ...current,
                          contextWindow: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : null
                        }))}
                        disabled={contextPinSaving || Boolean(selectedThread && contextDialogLoading)}
                      />
                    </label>
                    <label>
                      <span>model_auto_compact_token_limit</span>
                      <input
                        type="number"
                        min={32_000}
                        max={900_000}
                        step={1_000}
                        value={contextConfigDraft.compactTokenLimit ?? ""}
                        onChange={(event) => setContextConfigDraft((current) => ({
                          ...current,
                          compactTokenLimit: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : null
                        }))}
                        disabled={contextPinSaving || Boolean(selectedThread && contextDialogLoading)}
                      />
                    </label>
                    <label>
                      <span>计数范围</span>
                      <select
                        value={contextConfigDraft.scope}
                        onChange={(event) => setContextConfigDraft((current) => ({
                          ...current,
                          scope: event.target.value === "body_after_prefix" ? "body_after_prefix" : "total"
                        }))}
                        disabled={contextPinSaving || Boolean(selectedThread && contextDialogLoading)}
                      >
                        <option value="total">全部活跃上下文（推荐）</option>
                        <option value="body_after_prefix">仅 compact 后新增内容</option>
                      </select>
                    </label>
                  </div>
                ) : null}
                <small>自定义窗口范围 64K–1M，compact 最多为窗口的 90%。1M/900K 会明显加快订阅额度消耗；“默认最佳”恢复当前 Codex 的 272K / 244.8K 调优值。</small>
              </section>

              <label className="contextPinEditor">
                <span><Pin size={14} /> 固定到上下文</span>
                <textarea
                  value={contextPinDraft}
                  onChange={(event) => setContextPinDraft(event.target.value.slice(0, 16_000))}
                  placeholder={"建议按结构填写：\n项目目标：\n关键结论：\n重要路径：\n必须遵守的约束："}
                  disabled={contextPinSaving || Boolean(selectedThread && contextDialogLoading)}
                />
                <small>{contextPinDraft.length.toLocaleString()} / 16,000 字符。{selectedThread
                  ? "内容单独保存在网页数据库，每次续接会话时重新注入；不会替换、隐藏或删除历史消息。"
                  : "内容将在创建会话时注入，并在创建后保存到这个新会话。"}</small>
              </label>

              {selectedThread ? <section className="contextCompactHistory">
                <strong>自动 compact 时间</strong>
                {contextDialogLoading ? <span>读取中…</span> : threadContextStatus?.compactedAt.length ? (
                  <ol>
                    {[...threadContextStatus.compactedAt].reverse().map((at) => <li key={at}>{new Date(at).toLocaleString()}</li>)}
                  </ol>
                ) : <span>当前记录中尚未检测到自动 compact。</span>}
              </section> : null}
            </div>
            <div className="dialogActions">
              <button className="iconTextButton" type="button" onClick={closeContextPinDialog} disabled={contextPinSaving}>取消</button>
              <button
                className="iconTextButton primary"
                type="button"
                onClick={() => void saveContextPin()}
                disabled={contextPinSaving || Boolean(selectedThread && contextDialogLoading)}
              >
                <Pin size={15} />
                {contextPinSaving
                  ? "保存中…"
                  : selectedThread && contextDialogLoading
                    ? "正在读取会话设置…"
                    : selectedThread
                      ? "保存会话设置"
                      : "用于下一条新会话"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {settingsPresence.present ? (
        <div className={`modalScrim uiExitLayer${settingsPresence.closing ? " uiClosing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" aria-hidden={settingsPresence.closing} inert={settingsPresence.closing}>
          <section className="settingsDialog">
            <header className="settingsHeader">
              <div>
                <h2 id="settings-dialog-title">设置</h2>
                <p>通过 SSH 把 4090-left 上生成的图片、文件和导出记录发送到你的设备。</p>
              </div>
              <button className="iconButton" type="button" onClick={() => setSettingsOpen(false)} title="关闭设置">
                <X size={17} />
              </button>
            </header>
            <div className="settingsBody">
              <div className="settingsGrid">
                <label>
                  <span>访问设备 ZeroTier IP / SSH 地址</span>
                  <input
                    value={localSendSettings.sshHost}
                    onChange={(event) => updateLocalSendSetting("sshHost", event.target.value)}
                    placeholder={detectedClientHost || "自动识别本机 ZeroTier IP"}
                  />
                </label>
                <label>
                  <span>SSH 端口</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={localSendSettings.sshPort}
                    onChange={(event) => updateLocalSendSetting("sshPort", Number(event.target.value) || 22)}
                  />
                </label>
                <label>
                  <span>SSH 用户名</span>
                  <input
                    value={localSendSettings.sshUser}
                    onChange={(event) => updateLocalSendSetting("sshUser", event.target.value)}
                    placeholder="例如 wxr"
                  />
                </label>
                <label>
                  <span>访问设备下载目录</span>
                  <input
                    value={localSendSettings.destinationPath}
                    onChange={(event) => updateLocalSendSetting("destinationPath", event.target.value)}
                    placeholder="Downloads（远端 SSH 用户的 ~/Downloads）"
                  />
                </label>
                <label className="settingsWide">
                  <span>4090-left 私钥路径（可选）</span>
                  <input
                    value={localSendSettings.identityFile}
                    onChange={(event) => updateLocalSendSetting("identityFile", event.target.value)}
                    placeholder="例如 ~/.ssh/id_ed25519；不填则使用默认 SSH 配置"
                  />
                </label>
                <label className="settingsWide">
                  <span>4090-left 临时中转目录</span>
                  <input
                    value={localSendSettings.outputPath}
                    onChange={(event) => updateLocalSendSetting("outputPath", event.target.value)}
                    placeholder="例如 /tmp/codex_remote_exports，只作导出中转"
                  />
                </label>
              </div>
              <p className="settingsHint">
                ZeroTier IP、当前登录名和下载目录会自动填入；下载目录默认是远端 SSH 用户的 Downloads。SSH 用户名可修改，需与设备上的系统用户名一致。保存并测试 SSH 成功后，生成文件即可自动发送。设备需开启 SSH/远程登录并允许 4090-left 免密登录；4090-left 目录只作临时中转，不是最终保存位置。
                {detectedClientHost ? ` 当前浏览器来源 ZeroTier IP：${detectedClientHost}` : ""}
              </p>
              {settingsTestStatus ? <p className={`settingsTestStatus ${settingsTestStatus.kind}`}>{settingsTestStatus.message}</p> : null}
              <div className="settingsExportBox">
                <strong>任务通知</strong>
                <span>任务完成或等待批准时发送系统通知。需要浏览器授权和 HTTPS；iPhone 需先将网页添加到主屏幕。通知不包含回答正文。</span>
                <button className="iconTextButton" type="button" disabled={pushSaving || !nativeFeaturesReady} onClick={() => void togglePushNotifications()}>
                  {!nativeFeaturesReady ? "等待服务更新" : pushSaving ? "设置中…" : pushEnabled ? "关闭此设备通知" : "开启此设备通知"}
                </button>
              </div>
              <div className="settingsExportBox">
                <strong>自动发送生成文件</strong>
                <span>会话完成后，检测到的图片、PDF、PPT、Word、表格等生成文件会自动通过 SSH 写入当前设备的 Downloads 文件夹。仅发送当前登录用户会话中检测到的文件。</span>
                <label className="inlineCheckbox">
                  <input type="checkbox" checked={autoSendGeneratedFiles} onChange={(event) => updateAutoSendGeneratedFiles(event.target.checked)} />
                  <span>自动发送生成文件到 Downloads</span>
                </label>
              </div>
              <div className="settingsExportBox">
                <strong>对话记录导出</strong>
                <span>导出文件会先写入 4090-left 输出目录；勾选后再通过 SSH 发送到访问设备保存目录。</span>
                <div className="settingsExportControls">
                  <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ThreadExportFormat)}>
                    <option value="markdown">Markdown</option>
                    <option value="json">JSON</option>
                  </select>
                  <label className="inlineCheckbox">
                    <input type="checkbox" checked={exportSendLocal} onChange={(event) => setExportSendLocal(event.target.checked)} />
                    <span>导出后发送到当前访问设备</span>
                  </label>
                  <button className="iconTextButton" type="button" onClick={() => void exportCurrentThread()} disabled={!selectedThread || exportingThread}>
                    {exportingThread ? "导出中" : "导出当前会话"}
                  </button>
                </div>
              </div>
              <div className="dialogActions">
                {detectedClientHost || localSendSettings.sshHost ? (
                  <button className="iconTextButton" type="button" onClick={() => void applySuggestedLocalSendSettings()} disabled={settingsSaving || settingsTesting}>
                    {settingsTesting ? "测试中" : "一键填入并测试"}
                  </button>
                ) : null}
                <button className="iconTextButton" type="button" onClick={() => setSettingsOpen(false)}>
                  取消
                </button>
                <button className="iconTextButton" type="button" onClick={() => void verifyLocalSendSettings()} disabled={settingsSaving || settingsTesting}>
                  {settingsTesting ? "测试中" : "保存并测试 SSH"}
                </button>
                <button className="iconTextButton primary" type="button" onClick={() => void saveLocalSendSettings()} disabled={settingsSaving || settingsTesting}>
                  {settingsSaving ? "保存中" : "保存设置"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      <section className="threadColumn">
        <header className="topbar">
          <div className="projectTitle">
            <h1>{selectedThread?.name || selectedThread?.preview || "新对话"}</h1>
            <p>{selectedProject?.rootPath ?? projectRoot}</p>
            {selectedProject ? <span className="recordMapping">记录来源：cwd 匹配该目录的 Codex threads</span> : null}
          </div>
          <div className="controls">
            <button className="iconTextButton v2SettingsBridge v2MovedIntoPlus" type="button" onClick={() => void openSettingsDialog()} title="设置当前访问设备 SSH 发送路径" aria-hidden="true" tabIndex={-1}>
              <Settings2 size={17} />
              设置
            </button>
            <button
              className={`trackedQuotaButton ${trackedQuotaUsage && trackedQuotaUsage.todayQuotaPercent > 50 ? "warning" : trackedQuotaUsage?.blocked ? "blocked" : ""}`}
              type="button"
              onClick={() => void refreshTrackedQuota(true, false)}
              disabled={trackedQuotaLoading && !trackedQuotaUsage}
              title="查看 lzc 在全部账号中的当前周期与自然日额度占用"
            >
              {trackedQuotaLoading && !trackedQuotaUsage
                ? "lzc..."
                : trackedQuotaUsage
                  ? `lzc ${percentText(trackedQuotaUsage.todayQuotaPercent)}%`
                  : "lzc 用量"}
            </button>
            <div
              className="quotaPopoverAnchor"
              onMouseEnter={() => {
                setQuotaPopoverOpen(true);
                void refreshQuota(false, { background: true });
              }}
              onMouseLeave={() => {
                if (quotaPopoverPinned) return;
                setQuotaPopoverOpen(false);
              }}
            >
              <button
                className="quotaButton v2QuotaTopButton"
                type="button"
                onClick={() => {
                  setQuotaPopoverPinned((current) => {
                    const next = !current;
                    setQuotaPopoverOpen(next);
                    return next;
                  });
                  void refreshQuota(false, { force: true, background: true });
                }}
                disabled={quotaLoading}
                title="悬停查看；点击可固定或收起额度详情"
              >
                {quotaLoading ? "额度..." : quotaSummaryLabel(quota, accountPool)}
              </button>
              {quotaPopoverPresence.present ? <QuotaPopover quota={quota} pool={accountPool} loading={quotaLoading} closing={quotaPopoverPresence.closing} /> : null}
            </div>
            <button
              className="leaderboardButton"
              type="button"
              onClick={() => {
                setLeaderboardOpen(true);
                void refreshLeaderboard(false, false);
              }}
              title="查看当前周期和历史累计 token 排行榜"
            >
              <Trophy size={14} />
              排行榜
            </button>
            <PolishedSelect<SandboxMode>
              className="topbarPolicySelect"
              value={sandbox}
              onChange={setSandbox}
              options={[
                { value: "danger-full-access", label: "完全访问", detail: "可读取和修改所有文件" },
                { value: "workspace-write", label: "项目可写", detail: "仅可修改当前工作区" },
                { value: "read-only", label: "只读", detail: "不允许写入文件" }
              ]}
            />
            <PolishedSelect<ApprovalPolicy>
              className="topbarPolicySelect approvalSelect"
              value={approvalPolicy}
              onChange={setApprovalPolicy}
              options={[
                { value: "never", label: "不询问", detail: "自动执行允许的操作" },
                { value: "on-request", label: "需要时询问", detail: "由 Codex 请求确认" },
                { value: "untrusted", label: "不可信命令询问", detail: "仅危险操作需要确认" }
              ]}
            />
          </div>
        </header>

        {error ? (
          <div className="errorBanner" onClick={() => setError("")}>
            {error}
          </div>
        ) : null}

        {providerFailurePresence.present && providerFailure ? (
          <div className={`providerFailureNotice${providerFailurePresence.closing ? " uiClosing" : ""}`}
            role="alertdialog" aria-label="模型请求失败" aria-hidden={providerFailurePresence.closing} inert={providerFailurePresence.closing}>
            <strong>{providerFailure.kind === "limit" ? "供应商额度或请求频率受限" : "模型本轮请求失败"}</strong>
            <p>{providerFailure.kind === "limit"
              ? `${providerFailure.model} 返回了额度或限流错误，无法完成本轮回答。`
              : `${providerFailure.model} 没有完成本轮回答；这不一定是额度问题。`}</p>
            <div className="providerFailureActions">
              <button type="button" onClick={() => {
                setProviderFailureOpen(false);
                resetToNewThread(true);
                window.setTimeout(() => document.querySelector<HTMLButtonElement>(".composerTools .groupedModelPicker .polishedSelectTrigger")?.click(), 100);
              }}>新对话·选模型</button>
              <button type="button" onClick={() => setProviderFailureOpen(false)}>关闭</button>
            </div>
          </div>
        ) : null}


        <div className={`workspace${diffPanelVisible || terminalVisible ? " diffPanelOpen" : ""}${diffPanelResizing ? " diffPanelResizing" : ""}`} style={{ gridTemplateColumns: `${threadListCollapsed ? 56 : threadListWidth}px 0px minmax(0, 1fr) auto` }}>
          <nav className={`threadList ${threadListCollapsed ? "collapsed" : ""}`}>
            <div className="v2ProjectDock">
              <div className="v2BrandRow">
                <strong>Codex</strong>
                <button
                  className="v2ThemeToggle"
                  type="button"
                  onClick={() => setColorTheme((theme) => theme === "dark" ? "light" : "dark")}
                  title={colorTheme === "dark" ? "切换到白天模式" : "切换到夜间模式"}
                  aria-label={colorTheme === "dark" ? "切换到白天模式" : "切换到夜间模式"}
                >{colorTheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>
                <button
                  className="v2SidebarToggle"
                  type="button"
                  onClick={() => {
                    setThreadListCollapsed((collapsed) => {
                      window.localStorage.setItem(threadListCollapsedStorageKey, String(!collapsed));
                      return !collapsed;
                    });
                  }}
                  title={threadListCollapsed ? "展开侧边栏" : "折叠侧边栏"}
                  aria-label={threadListCollapsed ? "展开侧边栏" : "折叠侧边栏"}
                  aria-expanded={!threadListCollapsed}
                ><IconParkSmallArrow direction={threadListCollapsed ? "right" : "left"} /></button>
              </div>
              <div className="v2PrimaryNav">
                <button type="button" onClick={() => setNewThreadProjectPickerOpen(true)}>
                  <svg className="v2NavGlyph v2NewThreadGlyph" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="M16 3h5v5" /><path d="m21 3-9 9" /></svg>
                  <strong>新建对话</strong>
                </button>
                <button type="button" onClick={() => void openSkillsPicker(false)}>
                  <svg className="v2NavGlyph v2PluginGlyph" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></svg>
                  <strong>插件</strong>
                </button>
                <button type="button" onClick={() => void chooseDirectory()} disabled={selectingDirectory}>
                  <svg className="v2NavGlyph v2NewWorkspaceGlyph" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 10v6" /><path d="M9 13h6" /><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                  <strong>{selectingDirectory ? "选择中…" : "新建工作区"}</strong>
                </button>
              </div>
            </div>
            <div className="listHeader">
              <span>项目</span>
              <span className="listHeaderActions">
                <button className="iconButton v2SidebarSearchButton" type="button" onClick={() => setGlobalSearchOpen(true)} title="搜索会话和消息" aria-label="搜索会话和消息">
                  <Search size={17} strokeWidth={2.2} />
                </button>
                <button className="iconButton" type="button" onClick={() => void refreshThreads(selectedProjectIdRef.current, threadSearch)} title="Refresh threads">
                  <RefreshCcw size={17} strokeWidth={2.2} />
                </button>
              </span>
            </div>
            {draggingProjectId && projectGhostPosition ? createPortal(
              <div ref={projectGhostRef} className="v2WorkspaceDragGhost" style={{ transform: `translate3d(${projectGhostPosition.x + 12}px, ${projectGhostPosition.y + 12}px, 0)` }}>
                {orderedProjects.find((project) => project.id === draggingProjectId)?.name}
              </div>, document.body
            ) : null}
            {draggingThreadId && threadGhostPosition ? createPortal(
              <div ref={threadGhostRef} className="v2WorkspaceDragGhost" style={{ transform: `translate3d(${threadGhostPosition.x + 12}px, ${threadGhostPosition.y + 12}px, 0)` }}>
                {threads.find((thread) => thread.id === draggingThreadId)?.name ?? "对话"}
              </div>, document.body
            ) : null}
            <div className="v2WorkspaceTree">
              {orderedProjects.map((project) => {
                const projectSelected = project.id === selectedProjectId;
                const projectExpanded = expandedProjectIds.includes(project.id);
                return (
                <section data-project-id={project.id} className={`v2WorkspaceGroup ${projectSelected ? "selected" : ""} ${draggingProjectId === project.id ? "dragging" : ""} ${projectDropTarget?.id === project.id ? (projectDropTarget.after ? "dropAfter" : "dropBefore") : ""}`} key={project.id}>
                    <div
                      className="v2WorkspaceFolderButton"
                      role="button"
                      tabIndex={0}
                      aria-expanded={projectExpanded}
                      onClick={(event) => {
                        if (suppressProjectClickRef.current) {
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        toggleWorkspaceProject(project.id);
                      }}
                      onContextMenu={(event) => { if (projectPointerDragRef.current?.active) event.preventDefault(); }}
                      onPointerDown={(event) => {
                        if (event.button !== 0 || projectPointerDragRef.current || (event.target as HTMLElement).closest("button")) return;
                        projectPointerDragRef.current = { id: project.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
                        event.currentTarget.setPointerCapture(event.pointerId);
                        projectLongPressTimerRef.current = window.setTimeout(() => {
                          const drag = projectPointerDragRef.current;
                          if (!drag || drag.pointerId !== event.pointerId) return;
                          drag.active = true;
                          setDraggingProjectId(project.id);
                          setProjectGhostPosition({ x: drag.x, y: drag.y });
                          projectLongPressTimerRef.current = null;
                        }, 180);
                      }}
                      onPointerMove={moveProjectDrag}
                      onPointerUp={() => {
                        if (projectPointerDragRef.current?.active) {
                          suppressProjectClickRef.current = true;
                        }
                        if (suppressProjectClickRef.current) window.setTimeout(() => { suppressProjectClickRef.current = false; }, 0);
                        finishProjectDrag();
                      }}
                      onPointerCancel={() => {
                        if (projectLongPressTimerRef.current !== null) window.clearTimeout(projectLongPressTimerRef.current);
                        projectLongPressTimerRef.current = null;
                        projectPointerDragRef.current = null;
                        projectDropTargetRef.current = null;
                        suppressProjectClickRef.current = false;
                        setDraggingProjectId(null);
                        setProjectDropTarget(null);
                        setProjectGhostPosition(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleWorkspaceProject(project.id);
                        }
                      }}
                      title={project.rootPath}
                    >
                      <Folder className="v2WorkspaceFolderGlyph" size={18} strokeWidth={2.2} aria-hidden="true" />
                      <strong>{project.name}</strong>
                      <button
                        className="projectNewThreadButton"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          startNewThreadInProject(project.id);
                        }}
                        title={`在 ${project.name} 新建对话`}
                        aria-label={`在 ${project.name} 新建对话`}
                      >
                        <SquarePen size={16} strokeWidth={2.2} />
                      </button>
                      <button
                        className="projectRenameButton"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          beginProjectRename(project);
                        }}
                        title="重命名工作区"
                        aria-label="重命名工作区"
                      >
                        <PencilLine size={16} strokeWidth={2.2} />
                      </button>
                      <button
                        className={`projectDeleteButton ${pendingDeleteProjectId === project.id ? "confirm" : ""}`}
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          requestRemoveProject(project);
                        }}
                        title={pendingDeleteProjectId === project.id ? `确认移除 ${project.name}` : `移除 ${project.name}`}
                      >
                        {pendingDeleteProjectId === project.id ? "确认" : <Trash2 size={16} strokeWidth={2.2} />}
                      </button>
                    </div>
                    <ToolReveal open={projectExpanded} className="v2WorkspaceThreadsReveal" settleMs={380}>
                      {() => {
                        const projectThreads = projectSelected && initializedProjectIdRef.current === project.id
                          ? threads
                          : dedupeThreadListById(
                            storedJson<ThreadSummary[]>(sidebarThreadsCacheKey(selectedUserId, project.id), [])
                              .filter((thread) => !isTemporaryAskThread(thread))
                          );
                        return (
                      <div className="v2WorkspaceThreads">
            <div className="threadSearchBox">
              <input
                value=""
                readOnly
                onClick={() => setGlobalSearchOpen(true)}
                onFocus={() => setGlobalSearchOpen(true)}
                placeholder="搜索会话和消息"
              />
            </div>
              {projectThreads.map((thread) => (
              (() => {
                const threadRunning = Boolean(activeTurnsByThread[thread.id]);
                const hasNewResult = Boolean(unreadResultThreads[thread.id]);
                const deletePending = pendingDeleteThreadId === thread.id;
                const dragEnabled = projectSelected && initializedProjectIdRef.current === project.id && !threadSearch && !savingThreadOrder;
                return (
                  <div
                    key={thread.id}
                    data-thread-id={thread.id}
                    className={`threadRow ${selectedThread?.id === thread.id ? "selected" : ""} ${threadRunning ? "running" : ""} ${thread.pinned ? "pinned" : ""} ${draggingThreadId === thread.id ? "dragging" : ""} ${dragOverThreadId === thread.id ? `dragOver ${dragOverThreadAfter ? "dropAfter" : ""}` : ""}`}
                    onContextMenu={(event) => {
                      if (threadPointerDragRef.current?.active) {
                        event.preventDefault();
                        return;
                      }
                      activateWorkspaceProject(project.id);
                      openThreadContextMenu(event, thread);
                    }}
                    onPointerDown={(event) => {
                      const selectButton = (event.target as HTMLElement).closest<HTMLButtonElement>(".threadSelectButton");
                      if (!dragEnabled || event.button !== 0 || !selectButton || threadPointerDragRef.current) return;
                      if (event.pointerType === "mouse") event.preventDefault();
                      threadPointerDragRef.current = { id: thread.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
                      selectButton.setPointerCapture(event.pointerId);
                      threadLongPressTimerRef.current = window.setTimeout(() => {
                        const drag = threadPointerDragRef.current;
                        if (!drag || drag.pointerId !== event.pointerId) return;
                        drag.active = true;
                        const move = (pointer: PointerEvent) => moveThreadDragAt(pointer.pointerId, pointer.clientX, pointer.clientY);
                        const up = (pointer: PointerEvent) => {
                          if (threadPointerDragRef.current?.pointerId !== pointer.pointerId) return;
                          moveThreadDragAt(pointer.pointerId, pointer.clientX, pointer.clientY);
                          suppressThreadClickRef.current = true;
                          window.setTimeout(() => { suppressThreadClickRef.current = false; }, 450);
                          finishThreadDrag();
                        };
                        const cancel = (pointer: PointerEvent) => {
                          if (threadPointerDragRef.current?.pointerId !== pointer.pointerId) return;
                          clearThreadDragState();
                          suppressThreadClickRef.current = false;
                        };
                        const touchMove = (touch: TouchEvent) => { if (threadPointerDragRef.current?.active) touch.preventDefault(); };
                        const selectStart = (selection: Event) => selection.preventDefault();
                        threadPointerListenersRef.current = { move, up, cancel, touchMove, selectStart };
                        document.getSelection()?.removeAllRanges();
                        document.body.classList.add("v2ThreadDragActive");
                        window.addEventListener("pointermove", move, true);
                        window.addEventListener("pointerup", up, true);
                        window.addEventListener("pointercancel", cancel, true);
                        document.addEventListener("touchmove", touchMove, { capture: true, passive: false });
                        document.addEventListener("selectstart", selectStart, true);
                        setPendingDeleteThreadId(null);
                        setDraggingThreadId(thread.id);
                        setThreadGhostPosition({ x: drag.x, y: drag.y });
                        threadLongPressTimerRef.current = null;
                      }, 180);
                    }}
                    onDragStart={(event) => event.preventDefault()}
                    onPointerMove={moveThreadDrag}
                    onPointerUp={() => {
                      if (threadPointerDragRef.current?.active) suppressThreadClickRef.current = true;
                      if (suppressThreadClickRef.current) window.setTimeout(() => { suppressThreadClickRef.current = false; }, 450);
                      finishThreadDrag();
                    }}
                    onPointerCancel={() => { clearThreadDragState(); suppressThreadClickRef.current = false; }}
                    title={threadSearch ? "清空搜索后可长按排序" : thread.pinned ? "长按拖动；置顶与普通会话分别排序" : "长按拖动调整会话顺序"}
                  >
                    <button className="threadSelectButton" type="button" title="右键打开会话操作" onMouseEnter={() => prefetchThread(thread.id, project.id)} onFocus={() => prefetchThread(thread.id, project.id)} onClick={() => {
                      if (suppressThreadClickRef.current) {
                        suppressThreadClickRef.current = false;
                        return;
                      }
                      setPendingDeleteThreadId(null);
                      selectThread(thread.id, project.id);
                    }}>
                      {thread.pinned ? <Pin className="threadPinnedIcon" size={14} /> : <Archive size={14} />}
                      <span>
                        <strong>{thread.name || thread.preview || "Untitled"}</strong>
                        <small>{formatTime(thread.updatedAt)}</small>
                      </span>
                      {hasNewResult ? <span className="threadResultDot" aria-label="有新结果" title="有新结果" /> : threadRunning ? <span className="threadRunningSpinner" role="status" aria-label="对话运行中" title="对话运行中" /> : null}
                    </button>
                    <button
                      className="threadRenameButton"
                      type="button"
                      onClick={() => {
                        activateWorkspaceProject(project.id);
                        beginThreadRename(thread);
                      }}
                      title="重命名会话"
                      aria-label="重命名会话"
                    >
                      <PencilLine size={14} />
                    </button>
                    <button
                      className={`threadRenameButton threadPinButton ${thread.pinned ? "active" : ""}`}
                      type="button"
                      onClick={() => {
                        activateWorkspaceProject(project.id);
                        void toggleThreadPin(thread);
                      }}
                      title={thread.pinned ? "取消置顶" : "置顶会话"}
                      aria-label={thread.pinned ? "取消置顶" : "置顶会话"}
                    >
                      <Pin size={14} />
                    </button>
                    <button
                      className={`threadDeleteButton ${deletePending ? "confirm" : ""}`}
                      type="button"
                      disabled={threadRunning}
                      onClick={() => {
                        activateWorkspaceProject(project.id);
                        requestRemoveThread(thread);
                      }}
                      title={threadRunning ? "运行中的会话不能删除" : deletePending ? "再次点击确认删除" : "删除会话"}
                    >
                      {deletePending ? "确认" : <Trash2 size={14} />}
                    </button>
                  </div>
                );
              })()
            ))}
                      </div>
                        );
                      }}
                    </ToolReveal>
                  </section>
                );
              })}
            </div>
            <div
              className="v2AccountDock"
              onBlur={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setAccountMenuOpen(false);
                }
              }}
            >
              <div className={`v2AccountMenu${accountMenuPresence.closing ? " uiClosing" : ""}`} hidden={!accountMenuPresence.present} aria-hidden={!accountMenuOpen} inert={!accountMenuOpen}>
                <div className="v2AccountIdentity">
                  <span className="v2Avatar">{userInitials(selectedUser?.name ?? selectedUserId)}</span>
                  <strong>{selectedUser?.name ?? selectedUserId}</strong>
                </div>
                <button
                  type="button"
                  id="v2QuotaMenuButton"
                  onClick={() => {
                    document.querySelector<HTMLButtonElement>(".quotaButton.v2QuotaTopButton")?.click();
                    setAccountMenuOpen(false);
                  }}
                >
                  <span className="v2MenuIcon">◔</span>
                  <span>剩余用量</span>
                  <small>查看详情</small>
                  <span className="v2ChevronGlyph" aria-hidden="true" />
                </button>
                <div className="v2QuotaStrip"><span /></div>
                <button type="button" onClick={() => window.location.assign("/__v2_logout")}>
                  <span className="v2MenuIcon">↪</span><span>退出登录</span>
                </button>
              </div>
              <button
                className="v2AccountTrigger"
                type="button"
                aria-expanded={accountMenuOpen}
                onClick={() => setAccountMenuOpen((open) => !open)}
              >
                <span className="v2Avatar">{userInitials(selectedUser?.name ?? selectedUserId)}</span>
                <strong>{selectedUser?.name ?? selectedUserId}</strong>
              </button>
            </div>
          </nav>

          <div
            className="resizeHandle verticalResizeHandle threadListResizeHandle"
            style={{ display: threadListCollapsed ? "none" : undefined }}
            role="separator"
            aria-orientation="vertical"
            title="拖动调整 Codex 记录框宽度"
            onMouseDown={(event) => beginHorizontalResize(
              event,
              threadListWidth,
              setThreadListWidth,
              threadListWidthStorageKey,
              180,
              Math.min(460, window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth) - 8 - 520)
            )}
          />

          {threadListCollapsed ? (
            <button
              className="panelRestoreButton threadListRestoreButton"
              type="button"
              onClick={() => {
                setThreadListCollapsed(false);
                window.localStorage.setItem(threadListCollapsedStorageKey, "false");
              }}
              title="展开会话列表"
              aria-label="展开会话列表"
            >
              <IconParkSmallArrow direction="right" />
            </button>
          ) : null}

          <section className="conversation">
            <div className="conversationHeader">
              <div className="conversationTitle">
                <h2>{selectedThread?.name || selectedThread?.preview || "New Thread"}</h2>
                <div className={`threadRunState ${conversationRunState}`}>
                  <span>{conversationRunState}</span>
                  <span className="runLamp" />
                </div>
              </div>
              <label className="conversationModelSelect">
                <span>{selectedThread ? "会话模型" : "新会话模型"}</span>
                <select
                  value={activeModelProfileId}
                  onChange={(event) => void changeConversationModelProfile(event.target.value)}
                  disabled={savingThreadModel || conversationRunState === "running"}
                  title={conversationRunState === "running"
                    ? "当前会话运行中；完成后可切换下一轮模型"
                    : `仅影响${selectedThread ? "当前会话后续轮次" : "这次新会话"}：${selectedModelProfile.model} / ${selectedModelProfile.effort}`}
                >
                  {modelProfiles.filter((profile) => !isUltraModelProfile(profile)).map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {exhaustedAccountNoticePresence.present
              && exhaustedAccountNotice
              && exhaustedAccountNotice.threadId === selectedThread?.id ? (
              <aside
                className={`exhaustedAccountNotice uiGlassSurface${exhaustedAccountNoticePresence.closing ? " uiClosing" : ""}`}
                role="status"
                aria-hidden={exhaustedAccountNoticePresence.closing}
                inert={exhaustedAccountNoticePresence.closing}
              >
                <p className="exhaustedAccountNoticeCopy">
                  {exhaustedAccountNotice.sourceLabel} 剩余额度不足 10%。
                  {exhaustedAccountNotice.hasAvailableAlternative
                    ? "可分支到额度最高的可用账号继续。"
                    : "其它账号暂无可用额度。"}
                </p>
                <div className="exhaustedAccountNoticeActions">
                  <button
                    type="button"
                    className="exhaustedAccountBranchButton"
                    disabled={!exhaustedAccountNotice.hasAvailableAlternative || !latestBranchableTurn || branchingThread}
                    title={!latestBranchableTurn ? "当前没有可分支的已完成回答" : undefined}
                    onClick={() => {
                      if (latestBranchableTurn) void createBranchFromTurn(latestBranchableTurn);
                    }}
                  >
                    <GitBranch size={14} /> {branchingThread ? "分支中…" : "分支"}
                  </button>
                  <button type="button" onClick={() => setDismissedExhaustedThreadId(selectedThread?.id ?? null)}>关闭</button>
                </div>
              </aside>
            ) : null}
            {threadContextFeatureEnabled && contextWarningVisible ? (
              <aside className="contextWarningBanner" role="status">
                <div>
                  <strong>上下文已使用 {threadContextStatus?.usedPercent?.toFixed(1)}%</strong>
                  <span>建议在自动 compact 前分支续接；新分支会原生保留截至当前节点的完整模型历史和固定内容，原会话及历史记录不变。</span>
                </div>
                <div className="contextWarningActions">
                  <button
                    type="button"
                    onClick={() => {
                      if (!latestBranchableTurn) return;
                      void createBranchFromTurn(latestBranchableTurn);
                    }}
                    disabled={!latestBranchableTurn || branchingThread}
                  >
                    <GitBranch size={14} /> {branchingThread ? "正在创建分支…" : "从此处分支"}
                  </button>
                  <button type="button" onClick={() => resetToNewThread(false)}><SquarePen size={14} /> 新建空白会话</button>
                </div>
              </aside>
            ) : null}
            <div className="conversationContent">
              {showPromptNavigator ? (
                <nav
                  className="promptNavigator"
                  aria-label="本会话提示词导航"
                  onMouseLeave={() => hoverPromptNavigation(null)}
                >
                  <span className="promptNavigatorLabel" aria-hidden="true">提示</span>
                  <div className="promptNavigatorList">
                    {promptNavigationItems.map((navigationItem, index) => (
                      <button
                        className={`promptNavigatorMarker ${activePromptNavigationKey === navigationItem.key ? "active" : ""}`}
                        type="button"
                        key={navigationItem.key}
                        aria-label={`提示词 ${index + 1}：${navigationItem.title}`}
                        aria-current={activePromptNavigationKey === navigationItem.key ? "true" : undefined}
                        aria-controls="conversation-messages"
                        title={`${navigationItem.title}\n${navigationItem.preview}`}
                        onMouseEnter={() => hoverPromptNavigation(navigationItem.key)}
                        onFocus={() => hoverPromptNavigation(navigationItem.key)}
                        onClick={() => scrollToPromptNavigationItem(navigationItem.key)}
                      >
                        <span className="promptNavigatorMarkerBar" aria-hidden="true" />
                        <span className="promptNavigatorMarkerIndex" aria-hidden="true">{index + 1}</span>
                      </button>
                    ))}
                    {selectedThread && threadHistory?.hasOlder ? (
                      <button
                        className="promptNavigatorLoadMore"
                        type="button"
                        onClick={() => void loadOlderHistory()}
                        disabled={loadingOlderHistory}
                        aria-label={loadingOlderHistory ? "正在加载更早提示词" : `加载更早提示词，剩余 ${olderHistoryItemCount} 条记录`}
                        title={loadingOlderHistory ? "正在加载更早提示词" : `加载更早提示词（剩余 ${olderHistoryItemCount} 条记录）`}
                      >
                        {loadingOlderHistory ? "…" : "+"}
                      </button>
                    ) : null}
                  </div>
                  {visibleDepartingPromptPreview && promptPreviewPresence.present && !promptPreviewPresence.closing ? (
                    <div className="promptNavigatorPreview departing" aria-hidden="true">
                      <span>提示词 {visibleDepartingPromptPreview.index}</span>
                      <strong>{visibleDepartingPromptPreview.item.title}</strong>
                      <p>{visibleDepartingPromptPreview.item.preview}</p>
                      <small>点击跳转到这条消息</small>
                    </div>
                  ) : null}
                  {promptPreviewPresence.present && displayedPromptPreview ? (
                    <div className={`promptNavigatorPreview${promptPreviewPresence.closing ? " closing" : ""}`} key={displayedPromptPreview.item.key} aria-live="polite" aria-hidden={promptPreviewPresence.closing}>
                      <span>提示词 {displayedPromptPreview.index}</span>
                      <strong>{displayedPromptPreview.item.title}</strong>
                      <p>{displayedPromptPreview.item.preview}</p>
                      <small>点击跳转到这条消息</small>
                    </div>
                  ) : null}
                </nav>
              ) : null}
              <VirtualConversation
                ref={conversationVirtualRef}
                containerRef={messagesRef}
                threadKey={`${selectedProjectId}:${selectedThread?.id ?? "new"}`}
                virtualize={Boolean(selectedThread && threadHistory?.hasOlder)}
                historyRevision={loadedHistoryItemCount}
                shouldFollowEnd={() => autoFollowMessagesRef.current && !manualMessageScrollLockRef.current}
                className="messages"
                id="conversation-messages"
                onPointerDownCapture={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  if (event.clientX >= bounds.right - 18) {
                    messageScrollDirectionRef.current = null;
                    manualMessageScrollLockRef.current = true;
                    autoFollowMessagesRef.current = false;
                    setShowScrollToBottom(true);
                  }
                }}
                onKeyDownCapture={(event) => {
                  if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
                    messageScrollDirectionRef.current = "up";
                    manualMessageScrollLockRef.current = true;
                    autoFollowMessagesRef.current = false;
                    setShowScrollToBottom(true);
                  } else if (["ArrowDown", "PageDown", "End"].includes(event.key)) {
                    messageScrollDirectionRef.current = "down";
                  }
                }}
                onWheelCapture={(event) => {
                  if (searchScrollFrameRef.current !== null) stopSearchScroll();
                  if (event.deltaY) messageScrollDirectionRef.current = event.deltaY < 0 ? "up" : "down";
                  if (event.deltaY < 0 && autoFollowMessagesRef.current) {
                    manualMessageScrollLockRef.current = true;
                    autoFollowMessagesRef.current = false;
                    setShowScrollToBottom(true);
                  }
                  if (event.deltaY < 0) maybeLoadOlderHistory();
                  if (event.deltaY > 0 && manualMessageScrollLockRef.current) {
                    // The scroll event handles the new offset. Also handle a
                    // deliberate downward gesture at an already-clamped bottom,
                    // without queuing a callback that can outlive this gesture.
                    updateMessageScrollState();
                  }
                }}
                onTouchStartCapture={(event) => { stopSearchScroll(); messageTouchYRef.current = event.touches[0]?.clientY ?? null; }}
                onTouchMoveCapture={(event) => {
                  const y = event.touches[0]?.clientY;
                  if (y === undefined || messageTouchYRef.current === null) return;
                  if (y > messageTouchYRef.current + 3) {
                    messageScrollDirectionRef.current = "up";
                    manualMessageScrollLockRef.current = true;
                    autoFollowMessagesRef.current = false;
                    setShowScrollToBottom(true);
                    maybeLoadOlderHistory();
                  } else if (y < messageTouchYRef.current - 3) {
                    messageScrollDirectionRef.current = "down";
                  }
                  messageTouchYRef.current = y;
                }}
                onScroll={() => {
                  updateMessageScrollState();
                }}
                onMouseUp={(event) => {
                  const selection = window.getSelection();
                  const text = selection?.toString().trim() ?? "";
                  if (!text || text.length > 6000) {
                    return;
                  }
                  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
                  const rect = range?.getBoundingClientRect();
                  if (!rect || rect.width === 0 || rect.height === 0) {
                    return;
                  }
                  setSelectionAction({
                    text,
                    left: Math.min(Math.max(rect.left + rect.width / 2 - 78, 12), window.innerWidth - 190),
                    top: Math.min(rect.bottom + 8, window.innerHeight - 54),
                  });
                }}
                onClick={(event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest("a, button, input, textarea, select")) {
                    return;
                  }
                  const toolCard = target.closest<HTMLElement>(".messageItem.kind-tool");
                  if (!toolCard || !event.currentTarget.contains(toolCard)) {
                    return;
                  }
                  const expanded = toolCard.classList.toggle("toolExpanded");
                  toolCard.setAttribute("aria-expanded", String(expanded));
                  const output = toolCard.querySelector<DeferredToolOutputElement>("[data-deferred-tool-output]");
                  if (output) {
                    output.textContent = expanded ? output.fullToolOutput ?? "" : output.previewToolOutput ?? "";
                  }
                  toolCard.dispatchEvent(new CustomEvent("codex:tool-expanded", { detail: { expanded } }));
                }}
              >
                {selectedThread && threadHistory?.hasOlder ? (
                  <div className="historyPageControl" role="status" aria-live="polite">
                    {olderHistoryLoadFailed ? (
                      <button type="button" onClick={() => void loadOlderHistory()}>更早记录加载失败，点击重试</button>
                    ) : loadingOlderHistory ? (
                      <span>正在接续更早记录…</span>
                    ) : (
                      <span>继续上滑查看更早记录 · 已载入 {loadedHistoryItemCount} / {threadHistory.totalItems}</span>
                    )}
                  </div>
                ) : null}
                {temporaryAsk ? createPortal((
                  <aside className="temporaryAskPanel" style={{ width: temporaryAskWidth }} aria-label="临时侧边对话">
                    <div
                      className="temporaryAskResizeHandle"
                      role="separator"
                      aria-orientation="vertical"
                      title="拖动调整临时对话宽度"
                      onMouseDown={(event) => beginRightPanelResize(event, temporaryAskWidth, setTemporaryAskWidth, "codex-web-temporary-ask-width", 340, Math.min(900, window.innerWidth - 420))}
                    />
                    <header className="temporaryAskHeader">
                      <div className="temporaryAskHeaderLeft">
                        <span className="temporaryAskHeaderBadge" aria-hidden="true"><MessageSquare size={15} /></span>
                        <div className="temporaryAskHeaderText">
                          <span className="temporaryAskHeaderTitle">侧边聊天</span>
                          <span className={`temporaryAskHeaderState ${temporaryAsk.status}`}>
                            {temporaryAsk.status === "running"
                              ? "实时处理中"
                              : temporaryAsk.status === "starting"
                                ? "启动中"
                                : temporaryAsk.threadId
                                  ? "已就绪"
                                  : "等待提问"}
                          </span>
                          <small>关闭后自动删除，不会进入历史会话</small>
                        </div>
                      </div>
                      <button className="iconButton temporaryAskHeaderButton" type="button" onClick={closeTemporaryAsk} title="关闭并删除临时对话" aria-label="关闭并删除临时对话"><X size={16} /></button>
                    </header>
                    <div className="temporaryAskMessages messages">
                      <article className="messageItem kind-user type-userMessage temporaryAskQuote">
                        <div className="messageMeta">已选文本片段</div>
                        <CollapsibleUserMessage text={temporaryAsk.selectedText} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
                      </article>
                      {(temporaryThread?.turns ?? []).map(renderTemporaryPersistedTurn)}
                      {temporaryAsk.prompts
                        .filter((entry) => !entry.turnId || !temporaryPersistedTurnIds.has(entry.turnId))
                        .map((entry) => renderTemporaryPrompt(entry.text, `temporary-prompt:${entry.requestId}`))}
                      {temporaryLiveTimeline.map((entry) => entry.kind === "agent"
                        ? (stripInterruptArtifacts(entry.text) ? (
                          <article className="messageItem kind-agent type-agentMessage live temporaryAskAgent" key={`temporary-live:${entry.id}`}>
                            <div className="messageMeta">Codex · agentMessage</div>
                            <LiveAgentStreamMessage text={stripInterruptArtifacts(entry.text)} projectId={temporaryAsk.projectId} onOpenFileLink={openFilePreview} />
                          </article>
                        ) : null)
                        : (
                          <article className="messageItem kind-tool type-toolCall live temporaryAskTool" key={`temporary-live:${entry.id}`}>
                            <div className="messageMeta">{entry.completed ? "工具输出" : "调用工具"} · {entry.tool}</div>
                            {entry.input ? <pre>{safeText(entry.input)}</pre> : null}
                            {entry.output ? <pre className="outputBlock">{displayOutputText(entry.output)}</pre> : entry.completed ? null : <div className="messageBody">正在执行...</div>}
                          </article>
                        ))}
                      {temporaryAsk.status === "starting" ? <div className="v2ThinkingLine">正在建立临时会话</div> : null}
                      {temporaryAsk.status === "running" ? <div className="v2ThinkingLine">正在思考</div> : null}
                      {temporaryAsk.status === "error" ? <div className="v2ThinkingLine">本轮发送失败，可以修改后重试</div> : null}
                      <div ref={temporaryMessagesEndRef} className="messagesEnd" aria-hidden="true" />
                    </div>
                    <div className="composer temporaryAskComposer">
                      <div className="composerBody">
                        <MarkdownComposerEditor
                          value={temporaryPrompt}
                          onChange={setTemporaryPrompt}
                          onSubmit={sendTemporaryPrompt}
                          placeholder="随心输入"
                          disabled={temporaryAsk.status === "starting" || temporaryAsk.status === "running"}
                        />
                        <div className="composerTools temporaryAskComposerTools">
                          <span className="temporarySelectionCount"><MessageSquare size={13} />1 个已选文本片段</span>
                          <ModelGroupedSelect
                            value={temporaryModelProfileId}
                            onChange={setTemporaryModelProfileId}
                            disabled={temporaryAsk.status === "starting" || temporaryAsk.status === "running"}
                            profiles={modelProfiles}
                          />
                          <PolishedSelect<SandboxMode>
                            className="temporaryPolicySelect"
                            value={sandbox}
                            onChange={setSandbox}
                            options={[{ value: "danger-full-access", label: "完全访问" }, { value: "workspace-write", label: "项目可写" }, { value: "read-only", label: "只读" }]}
                          />
                        </div>
                      </div>
                      <button className="iconButton sendButton primary" type="button" onClick={sendTemporaryPrompt} disabled={!temporaryPrompt.trim() || temporaryAsk.status === "starting" || temporaryAsk.status === "running"} title="发送临时提问"><Send size={16} /></button>
                    </div>
                  </aside>
                ), document.body) : null}
                {temporaryClosePresence.present ? createPortal((
                  <div className={`temporaryCloseScrim uiExitLayer${temporaryClosePresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={temporaryClosePresence.closing} inert={temporaryClosePresence.closing} onMouseDown={(event) => { if (event.target === event.currentTarget) setTemporaryCloseConfirm(false); }}>
                    <section className="temporaryCloseDialog" role="dialog" aria-modal="true" aria-labelledby="temporary-close-title">
                      <h2 id="temporary-close-title">关闭侧边聊天?</h2>
                      <p>这个侧边聊天将被删除，且无法恢复。你确定吗?</p>
                      <label className="temporaryCloseCheckbox">
                        <input type="checkbox" checked={temporaryCloseDontAsk} onChange={(event) => setTemporaryCloseDontAsk(event.target.checked)} />
                        <span>不再询问</span>
                      </label>
                      <div className="temporaryCloseActions">
                        <button type="button" onClick={() => setTemporaryCloseConfirm(false)}>取消</button>
                        <button className="danger" type="button" onClick={confirmCloseTemporaryAsk}>关闭侧边聊天</button>
                      </div>
                    </section>
                  </div>
                ), document.body) : null}
                {displayedConversationTurns.map((turn) => (
                  <DeferredConversationTurn key={`turn:${turn.id}`} data-turn-id={turn.id} render={() => {
                  const syntheticUserText = turnHasUserItem(turn) ? "" : turnUserText(turn);
                  const syntheticUserItem: ThreadItem | null = syntheticUserText.trim()
                    ? {
                        id: `${turn.id}-user-input`,
                        type: "userMessage",
                        role: "user",
                        text: syntheticUserText
                      }
                    : null;
                  const historyItems = syntheticUserItem ? [syntheticUserItem, ...(turn.items ?? [])] : turn.items ?? [];
                  const liveItems = sanitizeTurnItems(liveTimelineItems(liveTimelineByTurn.get(turn.id) ?? []));
                  // Merge identities and chronology before introducing message boundaries.
                  const items = collapseCodeModeWrappers(coalesceToolOutputs(mergeTimelineItems(coalesceToolOutputs(historyItems), liveItems)));
                  const renderedHistoryItems: React.ReactNode[] = [];
                  const pendingTurnUserMessages = pendingUserMessagesByTurn.get(turn.id) ?? [];
                  const isRunningTurn = Boolean(selectedActiveTurnId && selectedActiveTurnId === turn.id);
                  const thinkingNode = isRunningTurn
                    ? <div className="v2ThinkingLine" key={`${turn.id}-thinking-status`}>正在思考</div>
                    : null;
                  const latestUserItemIndex = pendingTurnUserMessages.length === 0 ? latestUserTimelineIndex(items) : -1;
                  let thinkingInserted = false;
                  if (pendingTurnUserMessages.length > 0) {
                    renderedHistoryItems.push(...pendingTurnUserMessages.map(renderPendingUserMessage));
                    if (thinkingNode) {
                      renderedHistoryItems.push(thinkingNode);
                      thinkingInserted = true;
                    }
                  }
                  const pendingToolGroup: ThreadItem[] = [];
                  const flushToolGroup = (indexBase: number) => {
                    if (pendingToolGroup.length === 0) {
                      return indexBase;
                    }
                    const bundleId = `${turn.id}-toolbundle-${pendingToolGroup[0].id}`;
                    const isLiveRunningTurn = Boolean(selectedActiveTurnId && turn.id === selectedActiveTurnId);
                    const isBundleComplete = !isLiveRunningTurn || pendingToolGroup.every((toolItem) => safeText(toolItem.type).toLowerCase() !== "toolcall" || toolItem.completed !== false);
                    if (pendingToolGroup.some((item) => itemKind(item) === "tool")) {
                      renderedHistoryItems.push(
                        renderPersistedToolBundle(
                          bundleId,
                          [...pendingToolGroup],
                          isBundleComplete,
                          selectedThread?.id,
                          selectedProject?.id,
                          turn.id
                        )
                      );
                    } else {
                      for (const reasoningItem of pendingToolGroup) {
                        renderedHistoryItems.push(renderPersistedThreadItem(
                          reasoningItem,
                          turn,
                          null,
                          messageElementKey(selectedThread?.id ?? "", turn.id, reasoningItem.id)
                        ));
                      }
                    }
                    pendingToolGroup.length = 0;
                    return indexBase + 1;
                  };
                  let toolGroupIndex = 0;
                  for (const [itemIndex, item] of items.entries()) {
                    const kind = itemKind(item);
                    const inlineQuestions = kind === "tool" ? parseQuestionToolItem(item) : null;
                    if (inlineQuestions) {
                      toolGroupIndex = flushToolGroup(toolGroupIndex);
                      if (!questionIsAnswered(item.id, turn.id, items)) renderedHistoryItems.push(
                        <article className="messageItem kind-question" key={`${turn.id}-${item.id}-question`}>
                          <ToolQuestionCard questions={inlineQuestions} onChoose={(answer) => chooseToolQuestion(item.id, answer)} />
                        </article>
                      );
                      continue;
                    }
                    if (kind === "tool" || kind === "reasoning") {
                      const itemForRender = item;
                      const itemRefText = kind === "reasoning" ? reasoningItemDisplayText(itemForRender) : itemText(itemForRender);
                      const hasRenderableItemContent = Boolean(itemForRender.command) ||
                        Boolean(safeText(itemForRender.output).trim()) ||
                        Boolean(safeText(itemForRender.input).trim()) ||
                        Boolean(safeText(itemForRender.tool).trim()) ||
                        (Array.isArray((itemForRender as { changes?: unknown[] }).changes) && ((itemForRender as { changes?: unknown[] }).changes ?? []).length > 0) ||
                        Boolean(itemForRender.aggregatedOutput) ||
                        Boolean(stripInterruptArtifacts(itemRefText).trim());
                      if (hasRenderableItemContent) {
                        pendingToolGroup.push(itemForRender);
                        continue;
                      }
                    }
                    toolGroupIndex = flushToolGroup(toolGroupIndex);
                    const itemKindValue = kind;
                    const isUserMessage = itemKindValue === "user";
                    const rawItemText = itemText(item);
                    const cleanedItemText = isUserMessage ? visibleUserHistoryText(rawItemText) : stripInterruptArtifacts(rawItemText);
                    const userVisibleText = isUserMessage ? cleanedItemText : "";
                    const hasRenderableItemContent =
                      Boolean(item.command) ||
                      Boolean(safeText(item.output).trim()) ||
                      Boolean(safeText(item.input).trim()) ||
                      Boolean(safeText(item.tool).trim()) ||
                      (Array.isArray((item as { changes?: unknown[] }).changes) && ((item as { changes?: unknown[] }).changes ?? []).length > 0) ||
                      Boolean(item.aggregatedOutput) ||
                      Boolean(cleanedItemText.trim());
                    if (itemKindValue === "agent" && !hasRenderableItemContent) {
                      continue;
                    }
                    const navigationKey = isUserMessage ? promptNavigationKey(turn.id, item.id) : null;
                    const messageRefKey = messageElementKey(selectedThread?.id ?? "", turn.id, item.id);
                    if (navigationKey && heldPersistedPromptNavigationKeys.has(navigationKey)) {
                      continue;
                    }
                    const renderedItem = renderPersistedThreadItem(item, turn, navigationKey, messageRefKey);
                    renderedHistoryItems.push(renderedItem);
                    if (thinkingNode && !thinkingInserted && itemIndex === latestUserItemIndex) {
                      renderedHistoryItems.push(thinkingNode);
                      thinkingInserted = true;
                    }
                  }
                  const turnAgentText = items
                    .filter((item) => itemKind(item) === "agent")
                    .map((item) => stripInterruptArtifacts(itemText(item)).trim())
                    .filter(Boolean)
                    .join("\n\n");
                  const normalizedTurnStatus = normalizedToken(turn.status);
                  const turnHasTerminalStatus = Boolean(turn.completedAt)
                    || ["completed", "succeeded", "failed", "interrupted", "cancelled", "canceled", "aborted"]
                      .some((status) => normalizedTurnStatus.includes(status));
                  const turnChanges = turnFileChanges(turn, liveTurnDiffs[turn.id]);
                  const turnChangeCard = turnAgentText && turnHasTerminalStatus && turnChanges.length
                    ? <TurnFileChangesCard
                        key={`${turn.id}-file-changes`}
                        changes={turnChanges}
                        onReview={() => openDiffReview(turnChanges, "本轮文件变更", turn.id, `turn-changes:${turn.id}`)}
                        onFile={(path) => openDiffReview(turnChanges, "本轮文件变更", turn.id, `turn-changes:${turn.id}`, selectedThread?.id, path)}
                      />
                    : null;
                  const turnCopyAction = turnAgentText
                    && turnHasTerminalStatus
                    && selectedActiveTurnId !== turn.id
                    ? [
                        <div className="v2AgentMessageActions v2TurnCopyAction" key={`${turn.id}-copy-all`} aria-label="本轮回答操作">
                          <button type="button" title="复制本次回答全部文字" aria-label="复制本次回答全部文字" onClick={() => void copyPlainText(turnAgentText)}>
                            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.2" y="2.2" width="8.3" height="9.2" rx="1.4" /><path d="M10.8 13.8H3.9a1.4 1.4 0 0 1-1.4-1.4V5.6" /></svg>
                          </button>
                          <button type="button" title={branchingThread ? "正在创建分支" : "从此回答直接创建新会话"} aria-label="从此回答直接创建新会话" disabled={branchingThread} onClick={() => void createBranchFromTurn(turn)}>
                            <GitBranch size={15} />
                          </button>
                          {turn.id === displayedConversationTurns.at(-1)?.id ? <button type="button" title="撤回最后一轮问答（不撤销文件改动）" aria-label="撤回最后一轮问答" disabled={editingLastPrompt || Boolean(editingPromptDraft)} onClick={() => void deleteLatestTurn(turn)}><Trash2 size={15} /></button> : null}
                        </div>
                      ]
                    : [];

                  flushToolGroup(toolGroupIndex);
                  if (thinkingNode && !thinkingInserted) renderedHistoryItems.push(thinkingNode);
                  const renderedHistoryTurnItems = renderedHistoryItems.flatMap((item) => (item ? [item] : []));
                  return (
                    <section className={`conversationTurnRow${turn.id === topAnchoredTurnId ? " topAnchoredTurn" : ""}${turn.id === editingPromptDraft?.turnId ? " editingOriginalTurn" : ""}${turn.id === departingTurnId ? " departingTurn" : ""}`} data-turn-id={turn.id} key={`turn:${turn.id}`}>
                      {[
                        ...renderedHistoryTurnItems,
                        ...(liveTurnDiffs[turn.id] && !turnChangeCard && !items.some((item) => Array.isArray(item.changes) && item.changes.some((change) => isRecord(change) && typeof change.diff === "string" && change.diff))
                          ? [<article className="messageItem kind-tool liveTurnDiff" key={`${turn.id}-diff`}><div className="messageMeta">本轮文件变更 · diff</div><button className="openDiffReviewButton" type="button" onClick={() => openDiffReview(changesFromUnifiedDiff(liveTurnDiffs[turn.id]), "本轮文件变更", turn.id, `turn-diff:${turn.id}`)}><FileText size={14} /> 在右侧查看变更</button></article>]
                          : []),
                        ...(conversationLocalMessageLayout.byTurn.get(turn.id) ?? []).map(renderLocalMessage),
                        ...(turnChangeCard ? [turnChangeCard] : []),
                        ...turnCopyAction,
                      ]}
                    </section>
                  );
                  }} />
                ))}
                <div className={`conversationLiveTail${topAnchoredLiveTail ? " topAnchoredTurn" : ""}`} key={`tail:${selectedThread?.id ?? "new"}`}>
                  {conversationLocalMessageLayout.beforePending.map(renderLocalMessage)}
                  {timelinePendingUserMessages.map(renderPendingUserMessage)}
                  {!selectedThread ? unmatchedLiveTimeline.map(renderLiveTimelineEntry) : null}
                  {conversationLocalMessageLayout.tail.map(renderLocalMessage)}
                  {heldPendingUserMessages.map((entry) => renderPendingUserMessage(entry))}
                  {!selectedThread && !openingThreadId && !openingThreadPresence.present && liveTimelineEntries.length === 0 && visiblePendingUserMessages.length === 0 && localMessages.length === 0 ? (
                    <div className="emptyState">Ready for a new Codex turn.</div>
                  ) : null}
                  <div ref={messagesEndRef} className="messagesEnd" aria-hidden="true" />
                </div>
              </VirtualConversation>
              {threadSearchPanel && threadSearchPanel.threadId === selectedThread?.id ? <div className="threadSearchNavigator" role="search" aria-label="在当前会话中搜索">
                <div className="threadSearchNavigatorInput">
                  <Search size={15} aria-hidden="true" />
                  <input aria-label="搜索当前会话" value={threadSearchPanel.query} onChange={event => setThreadSearchPanel(current => current ? {
                    ...current, query: event.target.value, hits: [], total: 0, index: 0, loading: Boolean(event.target.value.trim()), selectedItemId: undefined, error: undefined
                  } : current)} onKeyDown={event => {
                    if (event.key === "Escape") void closeThreadSearchPanel();
                    if (event.key === "Enter" && threadSearchPanel.hits.length) {
                      const next = event.shiftKey ? (threadSearchPanel.index - 1 + threadSearchPanel.hits.length) % threadSearchPanel.hits.length
                        : (threadSearchPanel.index + 1) % threadSearchPanel.hits.length;
                      void navigateThreadSearchHit(threadSearchPanel.hits[next], next);
                    }
                  }} />
                  <button type="button" aria-label="关闭会话搜索并返回最新消息" title="关闭并返回最新" onClick={() => void closeThreadSearchPanel()}><X size={15} /></button>
                </div>
                <div className="threadSearchNavigatorActions">
                  <button type="button" aria-label="上一个结果" disabled={!threadSearchPanel.hits.length} onClick={() => {
                    const next = (threadSearchPanel.index - 1 + threadSearchPanel.hits.length) % threadSearchPanel.hits.length;
                    void navigateThreadSearchHit(threadSearchPanel.hits[next], next);
                  }}><ChevronLeft size={17} /></button>
                  <button type="button" aria-label="下一个结果" disabled={!threadSearchPanel.hits.length} onClick={() => {
                    const next = (threadSearchPanel.index + 1) % threadSearchPanel.hits.length;
                    void navigateThreadSearchHit(threadSearchPanel.hits[next], next);
                  }}><ChevronRight size={17} /></button>
                  {threadSearchPanel.error ? <button type="button" className="threadSearchRetry" title={threadSearchPanel.error} onClick={() => setThreadSearchPanel(current => current ? { ...current, loading: true, error: undefined, refreshKey: current.refreshKey + 1 } : current)}>重试</button> : null}
                  <span>{threadSearchPanel.loading ? "检索中…" : threadSearchPanel.error ? "检索暂不可用" : threadSearchPanel.total ? `${threadSearchPanel.index + 1} / ${threadSearchPanel.total} 条` : "无匹配"}</span>
                </div>
              </div> : null}
              {globalSearchJumpNotice ? <div className="globalSearchJumpNotice" role="status">{globalSearchJumpNotice}</div> : null}
              {openingThreadPresence.present ? (
                <div className={`threadOpeningLayer${openingThreadPresence.closing ? " closing" : ""}`} role="status" aria-label="正在加载对话" aria-live="polite" aria-hidden={openingThreadPresence.closing}>
                  <div className="threadOpeningIndicator">
                    <span className="threadOpeningPulse" aria-hidden="true"><i /><i /><i /></span>
                  </div>
                </div>
              ) : null}
            </div>
            {showScrollToBottom ? (
              <button
                className="scrollToBottomButton"
                type="button"
                onClick={() => scrollMessagesToBottom("smooth")}
                aria-label="回到底部"
                title="回到底部"
              >
                ↓
              </button>
            ) : null}
            <div
              ref={composerRef}
              className={`composer ${draggingUpload ? "draggingUpload" : ""}`}
              data-has-thread={Boolean(selectedThread)}
              data-plan-mode={planMode}
              onDragOver={handleUploadDragOver}
              onDragEnter={handleUploadDragOver}
              onDragLeave={handleUploadDragLeave}
              onDrop={handleUploadDrop}
            >
              {selectedThread && statusPopoverThreadId === selectedThread.id ? (
                <aside className={`threadStatusPopover uiGlassSurface uiGlassPopover${statusPopoverVisible ? " open" : ""}`} style={{ left: statusPopoverLeft }} role="dialog" aria-label="当前会话状态" aria-hidden={!statusPopoverVisible}>
                  <header><strong>会话状态</strong><button type="button" aria-label="关闭会话状态" tabIndex={statusPopoverVisible ? 0 : -1} onClick={closeStatusPopover}><X size={15} /></button></header>
                  <dl>
                    <dt>工作区</dt><dd>{selectedProject?.name || selectedProject?.rootPath}</dd>
                    <dt>会话</dt><dd>{selectedThread.name || selectedThread.preview || selectedThread.id}</dd>
                    <dt>模型</dt><dd>{selectedModelProfile.model} / {selectedModelProfile.effort}</dd>
                    <dt>上下文</dt><dd>{threadContextStatus?.usedTokens == null || threadContextStatus.contextWindow == null ? "等待下一轮 token 统计" : `${formatNumber(threadContextStatus.usedTokens)} / ${formatNumber(threadContextStatus.contextWindow)} token（${threadContextStatus.usedPercent?.toFixed(1) ?? "--"}%）`}</dd>
                    <dt>运行</dt><dd>{getRunningTurnIdForThread(selectedThread) ? "进行中" : "空闲"}</dd>
                  </dl>
                </aside>
              ) : null}
              {selectedThread && displayedConversationTurns.length > 0 && queuedSubmissionPresence.present && visibleQueuedSubmission ? (
                <div className={`queuedSubmissionStrip${queuedSubmissionPresence.closing ? " closing" : ""}`} role="status" aria-label="排队发送的消息" aria-hidden={queuedSubmissionPresence.closing} inert={queuedSubmissionPresence.closing}>
                  {(() => {
                    const entry = visibleQueuedSubmission;
                    return <div className="queuedSubmission" key={entry.id}>
                      {editingQueuedId === entry.id ? (
                        <>
                          <input className="queuedEditInput" value={queuedEditText} onChange={(event) => setQueuedEditText(event.target.value)} onKeyDown={(event) => {
                            if (event.key === "Escape") setEditingQueuedId(null);
                            if (event.key === "Enter") updateQueuedSubmission(entry);
                          }} autoFocus aria-label="编辑排队消息" />
                          <button type="button" onClick={() => updateQueuedSubmission(entry)}>保存</button>
                        </>
                      ) : (
                        <>
                          <span className="queuedSubmissionLabel">{entry.id.startsWith("pending:") ? "排队中" : "已排队"}{queuedSubmissions.length > 1 ? ` · ${queuedSubmissions.length} 条` : ""}</span>
                          <span className="queuedSubmissionText" title={queuedSubmissionText(entry)}>{queuedSubmissionText(entry)}</span>
                          {selectedActiveTurnId ? <button className="queuedSteerButton" type="button" disabled={entry.id.startsWith("pending:")} onClick={() => steerQueuedSubmission(entry)}>调整方向</button> : null}
                          {!entry.id.startsWith("pending:") ? <button className="queuedIconButton" type="button" aria-label="移除排队消息" title="移除排队消息" onClick={() => codexSocket.send({ type: "turn.queue.delete", requestId: `queue-delete-${requestToken()}`, threadId: selectedThread.id, queuedSubmissionId: entry.id })}><X size={13} /></button> : null}
                          {!entry.id.startsWith("pending:") ? <button className="queuedIconButton" type="button" aria-label="更多排队操作" aria-expanded={queuedMenuOpen} onClick={() => setQueuedMenuOpen((open) => !open)}>⋯</button> : null}
                        </>
                      )}
                    </div>;
                  })()}
                  {queuedMenuOpen && queuedSubmissions.length ? <div className="queuedSubmissionMenu">
                    <button type="button" onClick={() => { setQueuedEditText(queuedSubmissionText(queuedSubmissions[0])); setEditingQueuedId(queuedSubmissions[0].id); setQueuedMenuOpen(false); }}>编辑消息</button>
                    <button type="button" onClick={() => { openTemporaryAsk(queuedSubmissionText(queuedSubmissions[0]), window.innerWidth / 2, window.innerHeight / 2); setQueuedMenuOpen(false); }}>在侧边聊天中打开</button>
                    <button type="button" onClick={() => { codexSocket.send({ type: "turn.queue.delete", requestId: `queue-delete-${requestToken()}`, threadId: selectedThread.id, queuedSubmissionId: queuedSubmissions[0].id }); setQueuedMenuOpen(false); }}>关闭排队</button>
                  </div> : null}
                </div>
              ) : null}
              {Object.values(pendingApprovals).filter((request) => request.params.threadId === selectedThread?.id).map((request) => (
                <div className="codexApprovalCard" role="alert" key={String(request.id)}>
                  <strong>Codex 等待批准{request.method.includes("fileChange") ? "文件修改" : "命令执行"}</strong>
                  <code>{String(request.params.command ?? request.params.reason ?? "请确认此操作")}</code>
                  <div>
                    <button type="button" onClick={() => answerApproval(request.id, "decline")}>拒绝</button>
                    <button type="button" onClick={() => answerApproval(request.id, "accept")}>仅批准这次</button>
                  </div>
                </div>
              ))}
              {skillsPickerPresence.present ? createPortal(
                <div className={`skillPickerScrim uiExitLayer${skillsPickerPresence.closing ? " uiClosing" : ""}`} role="presentation" aria-hidden={skillsPickerPresence.closing} inert={skillsPickerPresence.closing} onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setSkillsPickerOpen(false);
                }} onKeyDown={(event) => {
                  if (event.key === "Escape") setSkillsPickerOpen(false);
                }}>
                <section className="skillPickerPopover" role="dialog" aria-modal="true" aria-label="选择 Codex 技能">
                  <header className="skillPickerHeader">
                    <div>
                      <strong>选择技能</strong>
                      <span>{skills.filter((skill) => skill.enabled).length} 项真实可用技能 · 选择后在发送时调用</span>
                    </div>
                    <button className="skillPickerClose" type="button" onClick={() => setSkillsPickerOpen(false)} aria-label="关闭技能选择器">
                      <X size={16} />
                    </button>
                  </header>
                  <label className="skillPickerSearch">
                    <Search size={15} />
                    <input value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} placeholder="搜索技能名称或用途" autoFocus />
                  </label>
                  <div className="skillPickerList">
                    {filteredSkills.map((skill, index) => {
                      const copy = localizedSkill(skill);
                      const selected = selectedSkillNames.includes(skill.name);
                      return (
                        <Fragment key={skill.name}>
                        {index === 0 || skillSection(filteredSkills[index - 1].name) !== skillSection(skill.name) ? <span className="skillPickerSection">{skillSection(skill.name)}</span> : null}
                        <button className={`skillPickerItem${selected ? " selected" : ""}`} type="button" onClick={() => toggleSelectedSkill(skill.name)}>
                          <span className="skillPickerCheck">{selected ? "✓" : ""}</span>
                          <span className="skillPickerCopy">
                            <strong>{copy.name}</strong>
                            <small>{copy.description}</small>
                          </span>
                        </button>
                        </Fragment>
                      );
                    })}
                    {!skillsLoading && !filteredSkills.length ? <div className="skillPickerEmpty">没有匹配的技能</div> : null}
                    {skillsLoading ? <div className="skillPickerEmpty">正在加载技能...</div> : null}
                  </div>
                  <footer className="skillPickerFooter">
                    <span>已选 {selectedSkillNames.length} 个</span>
                    <button type="button" onClick={() => setSkillsPickerOpen(false)}>完成</button>
                  </footer>
                </section>
                </div>,
                document.body
              ) : null}
              <div
                className="resizeHandle horizontalResizeHandle composerResizeHandle"
                role="separator"
                aria-orientation="horizontal"
                title="拖动输入框顶部边缘调整高度"
                onMouseDown={(event) => beginVerticalResize(event, composerHeight, setComposerHeight, composerHeightStorageKey, 38, Math.min(320, window.innerHeight - 260))}
              />
              {editingPromptDraft ? <div className="editingPromptNotice" role="status">
                <PencilLine size={14} /> 正在编辑上一条提问
                <button type="button" onClick={cancelEditingPrompt} disabled={editingLastPrompt}>取消</button>
              </div> : null}
              <div className="composerBody">
                <div className="composerTools">
                  {planMode ? <button className="v2PlanActiveChip" type="button" onClick={() => setPlanMode(false)} title="关闭计划模式，恢复可执行改动"><Lightbulb size={14} />计划</button> : null}
                  {selectedSkills.map((skill) => (
                    <button className="selectedSkillChip" type="button" key={skill.name} onClick={() => toggleSelectedSkill(skill.name)} title={`移除 $${skill.name}`}>
                      <span>{localizedSkill(skill).name}</span>
                      <X size={12} />
                    </button>
                  ))}
                  {selectedProject && (selectedThread || threadContextFeatureEnabled) ? (
                    <button
                      className={`iconTextButton v2FastModeButton v2ContextStatusButton ${contextWarningVisible ? "v2ContextStatusButtonWarning" : ""} ${threadContextStatus?.pin.text ? "v2ContextStatusButtonPinned" : ""}`}
                      type="button"
                      onClick={threadContextFeatureEnabled ? openContextPinDialog : () => void showThreadStatus()}
                      title={threadContextFeatureEnabled ? "查看上下文比例、compact 时间并固定关键信息" : "查看当前会话状态"}
                    >
                      <span>{selectedThread && threadContextLoading && !threadContextStatus
                        ? "上下文…"
                        : selectedThread
                          ? `上下文 ${threadContextStatus?.usedPercent === null || threadContextStatus?.usedPercent === undefined ? "--" : `${Math.round(threadContextStatus.usedPercent)}%`}`
                          : threadContextFeatureEnabled ? `新会话上下文 ${contextConfigShortLabel(newThreadContextConfig)}` : "会话状态"}</span>
                    </button>
                  ) : null}
                  <button
                    className={`iconTextButton v2FastModeButton ${codexFastModeEnabled ? "v2FastModeButtonActive" : ""}`}
                    type="button"
                    onClick={() => {
                      const next = !codexFastModeEnabled;
                      setCodexFastModeEnabled(next);
                      if (typeof window !== "undefined") {
                        window.localStorage.setItem(codexFastModeStorageKey(selectedUserId), String(next));
                      }
                    }}
                    title={codexFastModeEnabled ? "已开启 Fast 模式（下次请求会带 service_tier: fast）" : "开启 Fast 模式"}
                  >
                    <span>{codexFastModeEnabled ? "Fast On" : "Fast Off"}</span>
                  </button>
                  <ModelGroupedSelect
                    value={activeModelProfileId}
                    onChange={(profileId) => void changeConversationModelProfile(profileId)}
                    disabled={savingThreadModel || conversationRunState === "running"}
                    title={conversationRunState === "running" ? "当前会话运行中，完成后可切换模型" : "选择当前会话后续轮次使用的真实模型"}
                    profiles={modelProfiles}
                  />
                  <button
                    className="v2SendMarkdownLocalAction"
                    type="button"
                    onClick={() => void exportCurrentThread(true, "markdown")}
                    disabled={exportingThread}
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    {exportingThread ? "发送中" : "Markdown 发到本机"}
                  </button>
                  <input
                    ref={fileInputRef}
                    className="hiddenFileInput"
                    multiple
                    type="file"
                    onChange={(event) => void handleFileUpload(event.target.files)}
                  />
                  <button
                    className="iconTextButton"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!selectedProject || uploadingFiles}
                  >
                    <Upload size={15} />
                    {uploadingFiles ? "传输中" : "上传/粘贴/拖拽文件"}
                  </button>
                  <button className="iconTextButton" type="button" onClick={() => void refreshQuota(true, { force: true })} disabled={quotaLoading}>
                    {quotaLoading ? "额度..." : "额度"}
                  </button>
                  <button className="iconTextButton skillsButton" type="button" onClick={() => void openSkillsPicker(true)} disabled={!selectedProject || skillsLoading}>
                    {skillsLoading ? "加载技能..." : `技能 ${skills.length || ""}`}
                  </button>
                  <button className="v2PlanModeBridge v2MovedIntoPlus" type="button" aria-pressed={planMode} aria-hidden="true" tabIndex={-1} onClick={() => setPlanMode((current) => !current)} title={planMode ? "关闭计划模式，下次发送可执行改动" : "开启 Codex 原生计划模式：先给出方案，不执行改动"}>{planMode ? "计划模式已开启" : "计划模式"}</button>
                  <select
                    className="skillSelect"
                    value=""
                    onChange={(event) => {
                      const skill = skills.find((entry) => entry.name === event.target.value);
                      if (skill) {
                        setSelectedSkillNames((current) => current.includes(skill.name) ? current : [...current, skill.name]);
                      }
                    }}
                    disabled={!selectedProject || !skills.length}
                    title="插入 Codex skill"
                  >
                    <option value="">插入 skill</option>
                    {skills.map((skill) => (
                      <option key={skill.name} value={skill.name}>
                        {"$"}{skill.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="exportFormatSelect"
                    value={exportFormat}
                    onChange={(event) => setExportFormat(event.target.value as ThreadExportFormat)}
                    title="导出对话记录格式"
                  >
                    <option value="markdown">MD</option>
                    <option value="json">JSON</option>
                  </select>
                  <label className="inlineCheckbox compactCheckbox" title="导出后通过 SSH 发送到访问设备保存目录">
                    <input type="checkbox" checked={exportSendLocal} onChange={(event) => setExportSendLocal(event.target.checked)} />
                    <span>发当前设备</span>
                  </label>
                  <button className="iconTextButton composerExportButton" type="button" onClick={() => void exportCurrentThread()} disabled={!selectedThread || exportingThread}>
                    {exportingThread ? "导出中" : "导出记录"}
                  </button>
                  {uploadedFiles.length ? (
                    <span className="uploadCount">
                      {uploadedFiles.some((file) => file.uploading)
                        ? `正在上传 ${uploadedFiles.filter((file) => file.uploading).length} 个文件`
                        : `${uploadedFiles.length} 个文件已上传`}
                    </span>
                  ) : null}
                </div>
                {uploadedFiles.length || exitingUploads.length ? (
                  <div className="uploadedFileList">
                    {[...uploadedFiles, ...exitingUploads].map((file) => {
                      const leaving = exitingUploads.some((entry) => entry.relativePath === file.relativePath);
                      return <div className={`uploadedFileChip${file.isImage ? " uploadedImageChip" : ""}${/\.pdf$/i.test(file.name) ? " uploadedPdfChip" : ""}${leaving ? " attachmentLeaving" : ""}`} key={file.relativePath} title={file.relativePath} aria-hidden={leaving}>
                      <button
                          className={`uploadedFilePreviewButton${file.isImage ? " uploadedImageFilePreviewButton" : ""}`}
                          type="button"
                          onClick={() => void openFilePreview(file.relativePath, file.isImage ? uploadedFiles.filter((entry) => entry.isImage && !entry.uploading).map((entry) => entry.relativePath) : undefined)}
                          disabled={file.uploading || leaving}
                          title={file.isImage ? "查看图片预览" : "查看文件预览"}
                        >
                          {file.isImage ? <ComposerImageThumbnail upload={file} /> : <FileText className="uploadedFileIcon" size={14} />}
                          {file.isImage ? null : (
                            <>
                              <span>{file.name}</span>
                              <small>{file.uploading ? "正在上传" : (file.name.split(".").pop()?.toUpperCase() || "文件")}</small>
                            </>
                          )}
                        </button>
                        <button
                          className="removeUploadedFileButton"
                          type="button"
                          onClick={() => removeUploadedFile(file.relativePath)}
                          disabled={leaving}
                          aria-label={`取消 ${file.name} 作为本轮输入`}
                          title="取消作为本轮会话输入"
                        >
                          <X size={14} />
                        </button>
                      </div>;
                    })}
                  </div>
                ) : null}
                <div className="dropUploadHint">
                  {draggingUpload ? "松开鼠标上传到 4090-left 的 /tmp/codex_remote_uploads/用户名/时间/" : "支持 Ctrl/Cmd+V 粘贴图片或文件，也可拖拽上传；仅已知 /命令 会由网页处理，/路径 会原样发送给 Codex。"}
                </div>
                {continuationPrompt ? (
                  <div className="continuationPrompt" role="status">
                    <span>当前会话上下文已满，原输入已保留，尚未发送。</span>
                    <div>
                      <button type="button" onClick={continueInNewThread}>新建续接会话并发送</button>
                      <button type="button" className="secondary" onClick={() => setContinuationPrompt(null)}>取消</button>
                    </div>
                  </div>
                ) : null}
                <MarkdownComposerEditor
                  value={prompt}
                  height={composerHeight}
                  onChange={setPrompt}
                  onPaste={handleComposerPaste}
                  onSubmit={() => void sendPrompt()}
                  skills={skills}
                  onChooseSkill={(name) => setSelectedSkillNames((current) => current.includes(name) ? current : [...current, name])}
                  placeholder={planMode ? "描述你的任务，先生成可审阅的方案…" : "随心输入"}
                />
              </div>
              <button
                className={`iconButton sendButton ${composerShowsStop ? "stopMode" : "primary"}`}
                type="button"
                onClick={() => {
                  if (composerShowsStop && requestInterruptSelectedConversation()) {
                    return;
                  }
                  void sendPrompt();
                }}
                disabled={composerShowsStop ? composerStopBusy : uploadingFiles || editingLastPrompt || !selectedProject || !composerHasDraft}
                aria-label={composerShowsStop ? "终止当前对话" : "发送"}
                title={composerShowsStop ? (composerStopBusy ? "正在终止当前对话" : "终止当前对话（Esc）") : "发送"}
              >
                {composerShowsStop ? <Square size={16} fill="currentColor" /> : <Send size={18} />}
              </button>
            </div>
          </section>
          {diffReview || terminalProjectId ? <aside className={`diffReviewPanel${diffReview && terminalProjectId ? " rightPanelSplit" : ""}`} style={{ width: diffPanelVisible || terminalVisible ? diffPanelWidth : 0 }} aria-label="工作区右侧面板">
            <div className="diffReviewResizeHandle" role="separator" aria-orientation="vertical" aria-label="拖动调整变更面板宽度" onMouseDown={(event) => {
              setDiffPanelResizing(true);
              beginRightPanelResize(event, diffPanelWidth, setDiffPanelWidth, "codex-web-diff-panel-width", 350, Math.min(900, window.innerWidth - (threadListCollapsed ? 56 : threadListWidth) - 320));
              window.addEventListener("mouseup", () => setDiffPanelResizing(false), { once: true });
            }} />
            {diffReview ? <section className={`rightPaneDiff${diffPanelVisible ? " open" : ""}`}><header className="diffReviewPanelHeader">
              <div><h2>{diffReview.focusPath || diffReview.title}</h2><small>{diffReview.reviewTurnId ? "Codex 原生审查" : diffReview.focusPath ? "当前文件" : `${diffReview.changes.length} 个文件`}</small></div>
              {!diffReview.reviewTurnId && nativeFeaturesReady ? <button className="nativeReviewStartButton" type="button" disabled={startingNativeReview || !selectedThread || Boolean(selectedActiveTurnId)} title="用 Codex 原生审查当前工作区的未提交改动" onClick={() => void startNativeReview()}>{startingNativeReview ? "审查中…" : "代码审查"}</button> : null}
              <button type="button" aria-label="收起文件变更面板" title="收起" onClick={closeDiffReview}><X size={18} /></button>
            </header>
            <div className="diffReviewPanelBody">{diffReview.reviewTurnId ? (() => {
              const reviewTurn = displayedConversationTurns.find((turn) => turn.id === diffReview.reviewTurnId);
              const reviewText = reviewTurn?.items
                .filter((item) => itemKind(item) === "agent")
                .map((item) => stripInterruptArtifacts(itemText(item)).trim())
                .filter(Boolean)
                .join("\n\n") ?? "";
              const reviewProgress = reviewTurn?.items
                .filter((item) => itemKind(item) === "reasoning")
                .map((item) => reasoningItemDisplayText(item).trim())
                .filter(Boolean)
                .at(-1)?.slice(0, 180);
              return reviewText
                ? <div className="nativeReviewResult"><div className="nativeReviewResultLabel">审查结果 · 原始意见</div><MarkdownMessage text={reviewText.replace(/^Full review comments:/m, "审查意见：")} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} /></div>
                : <div className="nativeReviewPending" role="status"><span className="nativeReviewActivity" aria-hidden="true" />{reviewTurn?.completedAt ? "本次审查没有文字结果，请查看会话记录。" : reviewProgress ? `正在审查 · ${reviewProgress}` : "正在审查；原生审查通常在完成后一次性返回意见。"}</div>;
            })() : <FileChangeReview changes={diffReview.focusPath ? diffReview.changes.filter((change) => fileChangePath(change) === diffReview.focusPath) : diffReview.changes} onComment={addInlineReviewComment} />}</div></section> : null}
            {terminalProjectId ? <TerminalPanel key={terminalProjectId} projectId={terminalProjectId} projectName={projects.find(project => project.id === terminalProjectId)?.name ?? "工作区"} split={Boolean(diffReview)} onClose={() => {
              setTerminalVisible(false);
              if (terminalCloseTimerRef.current !== null) window.clearTimeout(terminalCloseTimerRef.current);
              terminalCloseTimerRef.current = window.setTimeout(() => {
                setTerminalProjectId(null);
                terminalCloseTimerRef.current = null;
              }, 390);
            }} /> : null}
          </aside> : null}
        </div>
      </section>

      {imageGallery ? (
        <div
          className={`imageViewer${imageViewerClosing ? " closing" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={`图片预览：${compactFileLabel(activeImageTarget)}`}
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeImageViewer(); }}
        >
          <header className="imageViewerHeader">
            <div className="imageViewerTitle" title={activeImageTarget}>
              <strong>{compactFileLabel(activeImageTarget)}</strong>
              {imageGallery.targets.length > 1 ? <span>{imageGallery.index + 1} / {imageGallery.targets.length}</span> : null}
            </div>
            <div className="imageViewerHeaderActions">
              <div className="imageViewerActionWrap">
                <button className="imageViewerRoundButton" type="button" aria-label="图片操作" title="下载、分享或 SSH 发送" aria-expanded={imageViewerActionsOpen} onClick={() => setImageViewerActionsOpen((current) => !current)}><MoreHorizontal size={20} /></button>
                <div className={`imageViewerActionMenu${imageViewerActionsOpen ? " open" : ""}`} aria-hidden={!imageViewerActionsOpen}>
                  <button type="button" disabled={!imageViewerActionsOpen || sharingBrowserFile} onClick={() => { setImageViewerActionsOpen(false); void shareOrDownloadPreviewFile(); }}>{sharingBrowserFile ? "准备中…" : "下载 / 分享"}</button>
                  <button type="button" disabled={!imageViewerActionsOpen || sendingLocalFile} onClick={() => { setImageViewerActionsOpen(false); void sendPreviewFileToLocal(); }}>{sendingLocalFile ? "发送中…" : "SSH 发送"}</button>
                </div>
              </div>
              <button className="imageViewerRoundButton" type="button" aria-label="关闭图片预览" title="关闭（Esc）" onClick={closeImageViewer}><X size={20} /></button>
            </div>
          </header>
          {imageGallery.index > 0 ? <button className="imageViewerArrow previous" type="button" aria-label="上一张图片" onClick={() => moveImageViewer(-1)}><ChevronLeft size={24} /></button> : null}
          <div className="imageViewerStage" ref={imageViewerStageRef} onMouseDown={(event) => { if (event.target === event.currentTarget) closeImageViewer(); }}>
            <div className="imageViewerCanvas">
              {!imageViewerDisplayReady && !imageViewerError && !imageViewerPrevious ? <span className="imageViewerLoading" role="status">正在打开图片…</span> : null}
              {imageViewerError ? <button className="imageViewerRetry" type="button" onClick={() => { setImageViewerError(false); setImageViewerReady(false); setImageViewerRetry((current) => current + 1); }}>图片暂不可用，点击重试</button> : null}
              {imageViewerPrevious ? <img className={`imageViewerPrevious${imageViewerDisplayReady ? " fading" : ""}`} src={imageViewerPrevious.src} alt="" aria-hidden="true" style={{ width: imageViewerPrevious.width, height: imageViewerPrevious.height }} /> : null}
              <img
                key={`${activeImageTarget}-${imageViewerRetry}`}
                className={`imageViewerImage${imageViewerDisplayReady ? " ready" : ""}`}
                src={activeImageUrl}
                alt={compactFileLabel(activeImageTarget)}
                loading="eager"
                decoding="async"
                fetchPriority="high"
                style={imageViewerDisplayReady ? { width: imageViewerNaturalSize.width * imageViewerScale, height: imageViewerNaturalSize.height * imageViewerScale } : undefined}
                onLoad={(event) => {
                  setImageViewerNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
                  setImageViewerReady(true);
                  setImageViewerError(false);
                  if (imageViewerPreviousTimerRef.current !== null) window.clearTimeout(imageViewerPreviousTimerRef.current);
                  imageViewerPreviousTimerRef.current = window.setTimeout(() => {
                    setImageViewerPrevious(null);
                    imageViewerPreviousTimerRef.current = null;
                  }, 340);
                }}
                onError={() => { setImageViewerError(true); setImageViewerReady(false); setImageViewerPrevious(null); }}
              />
            </div>
          </div>
          {imageGallery.index < imageGallery.targets.length - 1 ? <button className="imageViewerArrow next" type="button" aria-label="下一张图片" onClick={() => moveImageViewer(1)}><ChevronRight size={24} /></button> : null}
          <div className="imageViewerZoomControls" role="group" aria-label="图片缩放">
            <button type="button" aria-label="缩小图片" title="缩小" onClick={() => setImageViewerZoom((current) => Math.max(.25, current / 1.25))}><Minus size={17} /></button>
            <button className="imageViewerZoomValue" type="button" title="重置为适应窗口" onClick={() => setImageViewerZoom(1)}>{Math.round(imageViewerScale * 100)}%</button>
            <button type="button" aria-label="放大图片" title="放大" onClick={() => setImageViewerZoom((current) => Math.min(Math.max(16, 1 / imageViewerFitScale), current * 1.25))}><Plus size={17} /></button>
          </div>
        </div>
      ) : null}
      {filePreview || filePreviewLoading || filePreviewError || runnablePreview ? (
        <div className="modalScrim filePreviewScrim" role="dialog" aria-modal="true" aria-labelledby="file-preview-title">
          <section className="filePreviewDialog">
            <header className="filePreviewHeader">
              <div>
                <h2 id="file-preview-title">{runnablePreview?.title ?? filePreview?.name ?? "文件预览"}</h2>
                <p>
                  {runnablePreview ? "隔离预览 · 无法访问号池页面或本地文件" : filePreview?.relativePath ?? filePreviewError}
                  {filePreview?.line ? <span>:{filePreview.line}</span> : null}
                </p>
              </div>
              <div className="filePreviewActions">
                {!runnablePreview && filePreview?.kind === "text" && !filePreview.truncated && /\.(?:html?|mmd|mermaid)$/i.test(filePreview.name) ? (
                  <button className="iconTextButton" type="button" onClick={() => setRunnablePreview({ kind: /\.(?:mmd|mermaid)$/i.test(filePreview.name) ? "mermaid" : "html", title: filePreview.name, source: filePreview.content ?? "" })}>运行</button>
                ) : null}
                {runnablePreview && filePreview ? <button className="iconTextButton" type="button" onClick={() => setRunnablePreview(null)}>查看源码</button> : null}
                {filePreview?.kind === "image" ? (
                  <div className="imagePreviewModes" role="group" aria-label="图片显示方式">
                    {([ ["fit", "适应窗口"], ["width", "适应宽度"], ["actual", "原始大小"] ] as const).map(([mode, label]) => (
                      <button key={mode} type="button" className="imagePreviewModeButton" aria-pressed={imagePreviewMode === mode} onClick={() => setImagePreviewMode(mode)}>{label}</button>
                    ))}
                  </div>
                ) : null}
                {filePreview && !runnablePreview ? (
                  <>
                    <button className="iconTextButton" type="button" onClick={() => void shareOrDownloadPreviewFile()} disabled={sharingBrowserFile}>
                      {sharingBrowserFile ? "准备中" : "下载/分享"}
                    </button>
                    <button className="iconTextButton" type="button" onClick={() => void sendPreviewFileToLocal()} disabled={sendingLocalFile}>
                      {sendingLocalFile ? "发送中" : "SSH 发送"}
                    </button>
                  </>
                ) : null}
                <button className="iconButton" type="button" onClick={closeFilePreview} title="Close preview">
                  <X size={17} />
                </button>
              </div>
            </header>
            <div className={`filePreviewBody${filePreview?.kind === "image" && filePreviewObjectUrl ? ` imagePreviewBody imagePreviewBody-${imagePreviewMode}` : ""}`}>
              {runnablePreview ? <RunnablePreviewFrame preview={runnablePreview} /> : null}
              {!runnablePreview && filePreviewLoading ? <div className="emptyState">Loading file preview.</div> : null}
              {!runnablePreview && !filePreviewLoading && filePreviewError ? <div className="filePreviewError">{filePreviewError}</div> : null}
              {!runnablePreview && !filePreviewLoading && filePreview ? (
                <>
                  {filePreview.kind === "markdown" ? (
                    <div className="fileMarkdownPreview">
                      <MarkdownMessage text={filePreview.content ?? ""} projectId={selectedProject?.id} onOpenFileLink={(target) => void openFilePreview(target)} />
                    </div>
                  ) : null}
                  {filePreview.kind === "text" ? <pre className="fileTextPreview">{filePreview.content ?? ""}</pre> : null}
                  {filePreview.kind === "image" && filePreviewObjectUrl ? (
                    <img className="fileImagePreview" src={filePreviewObjectUrl} alt={filePreview.name} onLoad={(event) => {
                      const image = event.currentTarget;
                      if (image.naturalHeight > image.naturalWidth * 1.5) {
                        setImagePreviewMode((current) => current === "fit" ? "width" : current);
                      }
                    }} />
                  ) : null}
                  {filePreview.kind === "video" && filePreviewObjectUrl ? (
                    <video className="fileVideoPreview" src={filePreviewObjectUrl} controls playsInline preload="metadata">
                      当前浏览器无法播放此视频。
                    </video>
                  ) : null}
                  {filePreview.kind === "pdf" && filePreviewObjectUrl ? (
                    <iframe className="filePdfPreview" src={filePreviewObjectUrl} title={filePreview.name} />
                  ) : null}
                  {filePreview.kind === "binary" ? (
                    <div className="fileBinaryPreview">
                      <FileText size={28} />
                      <strong>{filePreview.mime}</strong>
                      <span>{formatBytes(filePreview.size)}</span>
                    </div>
                  ) : null}
                  {filePreview.truncated ? <p className="previewHint">Preview truncated at 2 MB.</p> : null}
                </>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {selectionAction ? (
        <button
          className="selectionAskButton"
          type="button"
          style={{ left: selectionAction.left, top: selectionAction.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openTemporaryAsk(selectionAction.text, selectionAction.left, selectionAction.top)}
        >
          <MessageSquare size={14} />
          在侧边提问
        </button>
      ) : null}
    </main>
    </RunnablePreviewContext.Provider>
  );
}
