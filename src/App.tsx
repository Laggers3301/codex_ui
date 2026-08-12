import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import "katex/dist/katex.min.css";
import {
  Archive,
  Bot,
  Copy,
  FileText,
  FolderOpen,
  GitBranch,
  MessageSquare,
  PencilLine,
  Pin,
  RefreshCcw,
  Search,
  Send,
  Settings2,
  Square,
  Trophy,
  Trash2,
  Upload,
  X
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import {
  createProject,
  deleteProject,
  deleteThread,
  exportThreadRecord,
  getApiUserId,
  fetchProjectFileBlob,
  listDirectories,
  listModels,
  listCodexSkills,
  listProjects,
  listThreads,
  listUsers,
  migrateSessionsFrom4090,
  previewProjectFile,
  readCodexLeaderboard,
  readCodexQuota,
  readLocalSendSettings,
  readThread,
  selectDirectory,
  sendProjectFileToLocal,
  setApiUserId,
  testLocalSendSettings,
  updateLocalSendSettings,
  updateProject,
  updateThreadModelProfile,
  updateThreadOrder,
  updateThreadPresentation,
  uploadProjectFiles
} from "./api";
import { codexSocket } from "./codexSocket";
import type {
  ApprovalPolicy,
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
  ThreadHistoryPage,
  ThreadSummary,
  Turn,
  UserProfile
} from "./types";

interface LocalMessage {
  id: string;
  meta: string;
  text: string;
  kind?: "system" | "tool";
  placement?: "tail" | "conversation";
  threadId?: string | null;
  afterTurnId?: string | null;
}

interface TemporaryAsk {
  requestId: string;
  projectId: string;
  threadId: string | null;
  selectedText: string;
  prompt: string;
  turnId: string | null;
  status: "ready" | "starting" | "running" | "complete" | "error";
}

function isTemporaryAskThread(thread: ThreadSummary): boolean {
  const text = `${thread.name ?? ""} ${thread.preview ?? ""}`;
  return text.includes("请基于下面选中的文字回答") || text.includes("选中文字：");
}

type GlobalSearchResult = {
  project: Project;
  thread: ThreadSummary;
};

interface PolishedSelectOption<T extends string> {
  value: T;
  label: string;
  detail?: string;
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
      {open ? (
        <div className="polishedSelectMenu" role="listbox">
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

type LocalMessageOptions = Pick<LocalMessage, "placement" | "threadId" | "afterTurnId">;

interface LiveDeltaEntry {
  threadId: string | null;
  turnId: string | null;
  text: string;
  startedAt: string;
}

interface LiveToolEntry extends LiveToolItem {}

type LiveTimelineEntry =
  | { id: string; kind: "agent"; threadId: string | null; turnId: string | null; startedAt: string; text: string }
  | { id: string; kind: "tool"; threadId: string | null; turnId: string | null; startedAt: string; tool: string; input: string; output: string; completed: boolean };

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

interface PromptRequestContext {
  viewToken: number;
  projectId: string;
  threadId: string | null;
  model: string;
  reasoningEffort: ReasoningEffort;
  sentPromptText: string;
  visibleText: string;
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
  appendOlder?: boolean;
  skipCache?: boolean;
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

const quotaAutoRefreshMs = 180_000;
const sentPromptBottomHoldMs = 5_000;
// A leading slash is common in filesystem paths. Only reserve the commands
// that this UI actually implements; everything else must reach Codex verbatim.
const localSlashCommands = new Set(["help", "?", "quota", "usage", "skills", "skill", "new", "send", "stop", "interrupt", "compact", "rename", "shell", "cmd"]);

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

function stripInterruptArtifacts(text: string): string {
  let filtered = text.replace(/<turn_aborted\b[^>]*>[\s\S]*?<\/turn_aborted>/gi, "");
  if (filtered !== text) {
    text = filtered;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const lower = line.toLowerCase();
      if (!line.trim()) {
        return false;
      }
      return (
        lower !== "<turn_aborted>" &&
        lower !== "<turn_aborted/>" &&
        lower !== "<turn_aborted />" &&
        lower !== "the user interrupted the previous turn on purpose." &&
        lower !== "any running unified exec processes may still be running in the background." &&
        lower !== "if any tools/commands were aborted, they may have partially executed."
      );
    })
    .join("\n")
    .trim();
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

const DeferredToolOutput = memo(function DeferredToolOutput({ text }: { text: string }) {
  const output = useMemo(() => displayOutputText(text), [text]);
  const preview = useMemo(() => {
    const lines = output.split(/\r?\n/).filter((line) => line.trim()).slice(0, 2).join("\n");
    return lines.length > 420 ? `${lines.slice(0, 420)}...` : lines;
  }, [output]);
  const outputRef = useRef<DeferredToolOutputElement>(null);

  useEffect(() => {
    const element = outputRef.current;
    if (!element) {
      return;
    }
    element.fullToolOutput = output;
    element.previewToolOutput = preview;
    element.textContent = element.closest(".toolExpanded") ? output : preview;
  }, [output, preview]);

  return <pre ref={outputRef} className="outputBlock" data-deferred-tool-output>{preview}</pre>;
});

function normalizedToken(value: unknown): string {
  return safeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function itemKind(item: ThreadItem): MessageKind {
  const token = `${normalizedToken(item.role)} ${normalizedToken(item.type)} ${normalizedToken(item.tool)}`;
  if (token.includes("user")) {
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

function sanitizeTurnItems(items: unknown[]): ThreadItem[] {
  return items
    .filter(isThreadItem)
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
    if (text.trim()) {
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
  const appendTurns = (turns: Turn[]) => {
    for (const turn of turns ?? []) {
      const existing = mergedTurns.get(turn.id);
      if (!existing) {
        mergedTurns.set(turn.id, { ...turn, items: [...(turn.items ?? [])] });
        continue;
      }
      const known = new Set((existing.items ?? []).map(threadItemKey));
      const added = (turn.items ?? []).filter((item, index) => {
        const key = threadItemKey(item, index);
        if (known.has(key)) {
          return false;
        }
        known.add(key);
        return true;
      });
      mergedTurns.set(turn.id, { ...existing, ...turn, items: [...(existing.items ?? []), ...added] });
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
  { id: "gpt-5.6-sol:max", label: "GPT-5.6-Sol max", model: "gpt-5.6-sol", effort: "max" },
  { id: "gpt-5.6-sol:xhigh", label: "GPT-5.6-Sol xhigh", model: "gpt-5.6-sol", effort: "xhigh" },
  { id: "gpt-5.6-sol:high", label: "GPT-5.6-Sol high", model: "gpt-5.6-sol", effort: "high" },
  { id: "gpt-5.6-sol:medium", label: "GPT-5.6-Sol medium", model: "gpt-5.6-sol", effort: "medium" },
  { id: "gpt-5.6-sol:low", label: "GPT-5.6-Sol low", model: "gpt-5.6-sol", effort: "low" },
  { id: "gpt-5.6-terra:ultra", label: "GPT-5.6-Terra ultra", model: "gpt-5.6-terra", effort: "ultra" },
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
  { id: "gpt-5.5:low", label: "GPT-5.5 low", model: "gpt-5.5", effort: "low" },
  { id: "gpt-5.4:xhigh", label: "GPT-5.4 xhigh", model: "gpt-5.4", effort: "xhigh" },
  { id: "gpt-5.4:high", label: "GPT-5.4 high", model: "gpt-5.4", effort: "high" },
  { id: "gpt-5.4:medium", label: "GPT-5.4 medium", model: "gpt-5.4", effort: "medium" },
  { id: "gpt-5.4:low", label: "GPT-5.4 low", model: "gpt-5.4", effort: "low" },
  { id: "gpt-5.4-mini:xhigh", label: "GPT-5.4-Mini xhigh", model: "gpt-5.4-mini", effort: "xhigh" },
  { id: "gpt-5.4-mini:high", label: "GPT-5.4-Mini high", model: "gpt-5.4-mini", effort: "high" },
  { id: "gpt-5.4-mini:medium", label: "GPT-5.4-Mini medium", model: "gpt-5.4-mini", effort: "medium" },
  { id: "gpt-5.4-mini:low", label: "GPT-5.4-Mini low", model: "gpt-5.4-mini", effort: "low" },
  { id: "gpt-5.3-codex-spark:xhigh", label: "GPT-5.3-Codex-Spark xhigh", model: "gpt-5.3-codex-spark", effort: "xhigh" },
  { id: "gpt-5.3-codex-spark:high", label: "GPT-5.3-Codex-Spark high", model: "gpt-5.3-codex-spark", effort: "high" },
  { id: "gpt-5.3-codex-spark:medium", label: "GPT-5.3-Codex-Spark medium", model: "gpt-5.3-codex-spark", effort: "medium" },
  { id: "gpt-5.3-codex-spark:low", label: "GPT-5.3-Codex-Spark low", model: "gpt-5.3-codex-spark", effort: "low" }
];

const defaultModelProfileId = "gpt-5.5:xhigh";
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

function normalizeMathInText(text: string): string {
  return text
    .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, (whole, equation: string) => {
      const content = equation.trim();
      return content ? `$$\n${content}\n$$` : whole;
    })
    .replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g, (whole, equation: string) => {
      const content = equation.trim();
      return content ? `$${content}$` : whole;
    });
}

function normalizeMathInProse(text: string): string {
  const codeSpanPattern = /(`+)([\s\S]*?)\1/g;
  let result = "";
  let cursor = 0;

  for (const match of text.matchAll(codeSpanPattern)) {
    const start = match.index ?? cursor;
    result += normalizeMathInText(text.slice(cursor, start));
    result += match[0];
    cursor = start + match[0].length;
  }

  return result + normalizeMathInText(text.slice(cursor));
}

function normalizeMathMarkdown(text: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const output: string[] = [];
  let prose = "";
  let fence: { character: "`" | "~"; length: number } | null = null;

  const flushProse = () => {
    if (prose) {
      output.push(normalizeMathInProse(prose));
      prose = "";
    }
  };

  for (const line of lines) {
    if (fence) {
      output.push(line);
      const closingFence = new RegExp(`^\\s*${fence.character}{${fence.length},}`);
      if (closingFence.test(line)) {
        fence = null;
      }
      continue;
    }

    const openingFence = line.match(/^\s*(`{3,}|~{3,})/);
    if (openingFence) {
      flushProse();
      const marker = openingFence[1];
      fence = { character: marker[0] as "`" | "~", length: marker.length };
      output.push(line);
      continue;
    }

    prose += line;
  }

  flushProse();
  return output.join("");
}

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
    const parsed = new URL(href, window.location.href);
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
  suppressImageGrid = false
}: {
  text: string;
  projectId?: string;
  onOpenFileLink?: (target: string) => void;
  renderMath?: boolean;
  suppressImageGrid?: boolean;
}) {
  const inlineImageTargets = useMemo(() => (projectId ? imageTargetsFromText(text) : []), [projectId, text]);
  const markdownText = useMemo(() => (renderMath ? normalizeMathMarkdown(text || " ") : text || " "), [renderMath, text]);
  const markdownComponents = useMemo<Components>(
    () => ({
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
      table({ children, ...props }) {
        return (
          <div className="markdownTableWrap">
            <table className="markdownTable" {...props}>
              {children}
            </table>
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
              onClick={() => onOpenFileLink?.(fileTarget)}
              title="打开图片预览"
            >
              <img className="inlineMessageImage" src={rawFileUrlForProject(projectId, fileTarget)} alt={alt ?? fileTarget} />
            </button>
          );
        }

        return <img className="inlineMessageImage" src={srcText} alt={alt ?? ""} loading="lazy" decoding="async" />;
      }
    }),
    [onOpenFileLink, projectId]
  );

  return (
    <div className="messageMarkdown">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={renderMath ? mathMarkdownRemarkPlugins : markdownRemarkPlugins}
        rehypePlugins={renderMath ? markdownRehypePlugins : []}
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
              onClick={() => onOpenFileLink?.(target)}
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

const userMessageCollapseMaxLines = 12;
const userMessageCollapseMaxCharacters = 900;

function isLongUserMessage(text: string): boolean {
  return text.length > userMessageCollapseMaxCharacters || text.split(/\r?\n/).length > userMessageCollapseMaxLines;
}

function visibleUserHistoryText(text: string): string {
  const withoutUploads = text.replace(/(?:\r?\n){0,2}上传文件：\s*(?:\r?\n-\s+[^\r\n]+)+\s*$/, "").trim();
  return stripInterruptArtifacts(withoutUploads);
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
  projectId,
  onOpenFileLink
}: {
  text: string;
  projectId?: string;
  onOpenFileLink?: (target: string) => void;
  suppressImageGrid?: boolean;
}) {
  const collapsible = isLongUserMessage(text);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [text]);

  return (
    <>
      <div className={`userMessageContent ${collapsible && !expanded ? "collapsed" : ""}`}>
        <MarkdownMessage text={text} projectId={projectId} onOpenFileLink={onOpenFileLink} suppressImageGrid />
      </div>
      {collapsible ? (
        <button
          className={`userMessageToggle ${expanded ? "expanded" : ""}`}
          type="button"
          onClick={() => setExpanded((current) => !current)}
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
  collectImagePreviewsFromValue(item, projectId, previews, seen);
  const uploadPathPattern = /(\/tmp\/codex_remote_uploads\/[^\s)\]]+\.(?:png|jpe?g|gif|webp|bmp))/gi;
  for (const match of itemText(item).matchAll(uploadPathPattern)) {
    addImagePreview(previews, seen, match[1], projectId, "图片");
  }
  return previews;
}

const MessageImagePreviews = memo(function MessageImagePreviews({
  item,
  projectId,
  onOpenFileLink
}: {
  item: ThreadItem;
  projectId?: string;
  onOpenFileLink?: (target: string) => void;
}) {
  const previews = useMemo(() => imagePreviewsFromItem(item, projectId), [item, projectId]);
  if (!previews.length) {
    return null;
  }

  return (
    <div className="inlineImagePreviewGrid" aria-label="图片预览">
      {previews.map((preview) => {
        const displayLabel = compactFileLabel(preview.label);
        const image = <img className="inlineMessageImage" src={preview.src} alt={preview.label} loading="lazy" decoding="async" />;
        if (preview.target && onOpenFileLink) {
          return (
            <button
              className="inlineImageButton"
              type="button"
              key={preview.key}
              onClick={() => onOpenFileLink(preview.target!)}
              title="打开图片预览"
              aria-label={`打开图片：${displayLabel}`}
            >
              {image}
            </button>
          );
        }
        return (
          <div className="inlineImageButton inlineImageStatic" key={preview.key}>
            {image}
          </div>
        );
      })}
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
      setSource("");
      return;
    }
    const objectUrl = URL.createObjectURL(upload.sourceFile);
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [upload.sourceFile]);

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
  onOpenFileLink: (target: string) => void;
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
          onClick={() => onOpenFileLink(upload.relativePath)}
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
    const match = line.match(/^\s*-\s+(.+?):\s*(\S+)\s*$/);
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
  return attachments.slice(0, 12);
}

const PersistedUserAttachmentPreviews = memo(function PersistedUserAttachmentPreviews({
  text,
  projectId,
  onOpenFileLink
}: {
  text: string;
  projectId?: string;
  onOpenFileLink: (target: string) => void;
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
            onClick={() => onOpenFileLink(attachment.target)}
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

function modelProfileIdFor(model: string, effort: ReasoningEffort, profiles: ModelProfile[]): string {
  return profiles.find((profile) => profile.model === model && profile.effort === effort)?.id ?? profiles[0]?.id ?? defaultModelProfileId;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return new Intl.NumberFormat("en-US").format(value);
}

function formatResetTime(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) {
    return "-";
  }
  return new Date(epochSeconds * 1000).toLocaleString();
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

function rateWindowText(window: CodexRateLimitWindow | null | undefined): string {
  if (!window) {
    return "-";
  }
  const windowLabel = window.windowDurationMins ? `${Math.round(window.windowDurationMins / 60)}h` : "window";
  const remaining = remainingQuotaPercent(window.usedPercent);
  const used = window.usedPercent ?? null;
  return `剩余 ${percentText(remaining)}% / ${windowLabel}，已用 ${percentText(used)}%，重置 ${formatResetTime(window.resetsAt)}`;
}

function rateLimitSnapshotText(snapshot: CodexRateLimitSnapshot | null | undefined): string {
  if (!snapshot) {
    return "-";
  }
  const parts = snapshot.primary ? [rateWindowText(snapshot.primary)] : [];
  const individual = snapshot.individualLimit;
  if (individual?.resetsAt && individual.resetsAt !== snapshot.primary?.resetsAt) {
    const remaining = individual.remainingPercent === null ? "" : `剩余 ${percentText(individual.remainingPercent)}%`;
    parts.push([remaining, `重置 ${formatResetTime(individual.resetsAt)}`].filter(Boolean).join("，"));
  }
  return parts.join("；") || "-";
}

function quotaSummaryLabel(quota: CodexQuota | null): string {
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
      lines.push(`- ${value.limitName ?? key}：${rateWindowText(value.primary)}`);
    }
  }
  if (quota.errors.length) {
    lines.push("", `读取警告：${quota.errors.join("；")}`);
  }
  return lines.join("\n");
}

function QuotaPopover({ quota, loading }: { quota: CodexQuota | null; loading: boolean }) {
  const primary = quota?.rateLimits?.primary ?? null;
  const secondary = quota?.rateLimits?.secondary ?? null;
  const otherLimits = Object.entries(quota?.rateLimitsByLimitId ?? {}).filter(([key]) => key !== "codex");
  return (
    <section className="quotaPopover" role="status" aria-label="Codex 额度详情">
      <header><strong>Codex 额度</strong><span>{loading ? "更新中" : quota?.account?.planType ?? quota?.rateLimits?.planType ?? ""}</span></header>
      {quota ? (
        <div className="quotaPopoverRows">
          <div><span>主额度</span><strong>{rateWindowText(primary)}</strong></div>
          <div><span>次额度</span><strong>{rateWindowText(secondary)}</strong></div>
          {otherLimits.map(([key, limit]) => (
            <div key={key}><span>{limit.limitName ?? key}</span><strong>{rateLimitSnapshotText(limit)}</strong></div>
          ))}
          <div><span>累计 Token</span><strong>{formatNumber(quota.usage?.summary?.lifetimeTokens)}</strong></div>
          <div><span>重置额度</span><strong>{formatNumber(quota.resetCredits?.availableCount)}</strong></div>
        </div>
      ) : <p>{loading ? "正在读取额度…" : "暂未读取到额度"}</p>}
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
    for (const user of scope.users.slice(0, 12)) {
      const name = userDisplayName(user.userId, users);
      const quotaPart = user.quotaPercent === null ? "" : `，约吃掉总额度 ${percentText(user.quotaPercent)}%`;
      lines.push(`- ${name}：${formatNumber(user.totalTokens)} token，占本榜 ${percentText(user.sharePercent)}%${quotaPart}`);
      lines.push(`  输入 ${formatNumber(user.inputTokens)} / 输出 ${formatNumber(user.outputTokens)} / reasoning ${formatNumber(user.reasoningOutputTokens)} / 会话 ${user.sessionCount}`);
      if (user.models.length) {
        lines.push(`  模型：${user.models.slice(0, 4).map((model) => `${model.model}${model.effort ? ` ${model.effort}` : ""} ${formatNumber(model.totalTokens)}`).join("；")}`);
      }
    }
    return lines;
  };
  const lines = [
    "**Codex Token 排行榜**",
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
                    {user.models.slice(0, 4).map((model) => (
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

function skillsMarkdown(skills: CodexSkill[]): string {
  if (!skills.length) {
    return "当前项目没有发现可用 skill。";
  }
  return [`**可用 Codex Skills（${skills.length}）**`, ...skills.slice(0, 80).map((skill) => `- $${skill.name} · ${skill.displayName}${skill.shortDescription ? `：${skill.shortDescription}` : ""}`)].join("\n");
}

const localizedSkillCopy: Record<string, { name: string; description: string }> = {
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

function commandHelpMarkdown(): string {
  return [
    "**Codex Web 命令**",
    "- `/quota` 或 `/usage`：查看 Codex 额度/用量",
    "- `/skills`：打开中文技能选择器",
    "- `/skill 名称`：显式选择一个技能，发送时使用 `$技能名` 调用",
    "- `/stop`：终止当前会话正在生成的这一轮（保留历史记录）",
    "- `/compact`：压缩当前会话上下文",
    "- `/rename 新名称`：重命名当前会话",
    "- `/shell 命令`：把 shell 命令作为 Codex thread 命令执行（需要当前会话）",
    "- `/cmd 命令`：在当前项目目录直接运行一次 shell 命令",
    "- `/new`：回到新建会话"
  ].join("\n");
}

function isThreadVisibilityError(message: string | undefined): boolean {
  return Boolean(message && message.includes("Thread is not visible for this logged-in user"));
}

function liveDeltasFromSnapshot(snapshot: LiveStateSnapshot): Record<string, LiveDeltaEntry> {
  return Object.fromEntries(
    snapshot.agentMessages
      .filter((message) => message.itemId && message.text && !message.completed)
      .map((message) => [
        message.itemId,
        { threadId: message.threadId, turnId: message.turnId, text: message.text, startedAt: message.startedAt ?? message.updatedAt }
      ])
  );
}

function liveToolsFromSnapshot(snapshot: LiveStateSnapshot): Record<string, LiveToolEntry> {
  return Object.fromEntries(
    (snapshot.toolItems ?? [])
      .filter((item) => item.itemId)
      .map((item) => [item.itemId, item])
  );
}

function activeTurnsFromSnapshot(snapshot: LiveStateSnapshot): Record<string, string> {
  return Object.fromEntries(
    snapshot.activeTurns
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

const sidebarWidthStorageKey = "codex-web-sidebar-width";
const threadListWidthStorageKey = "codex-web-thread-list-width";
const composerHeightStorageKey = "codex-web-composer-height";
const sidebarCollapsedStorageKey = "codex-web-sidebar-collapsed";
const threadListCollapsedStorageKey = "codex-web-thread-list-collapsed";
const sidebarProjectsCacheKey = (userId: string) => `codex-v2-projects-${userId}`;
const sidebarProjectSelectionKey = (userId: string) => `codex-v2-project-${userId}`;
const sidebarThreadsCacheKey = (userId: string, projectId: string) => `codex-v2-threads-${userId}-${projectId}`;
const modelPreferenceStorageKey = (userId: string, projectId: string) => `codex-v2-model-${encodeURIComponent(userId)}-${encodeURIComponent(projectId)}`;
const threadModelPreferenceStorageKey = (userId: string, threadId: string) => `codex-v2-thread-model-${encodeURIComponent(userId)}-${encodeURIComponent(threadId)}`;

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

type ResizeSetter = (value: number) => void;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = Number(window.localStorage.getItem(key));
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollRepaintFrameRef = useRef<number | null>(null);
  const promptNavigationFrameRef = useRef<number | null>(null);
  const threadCopyNoticeTimerRef = useRef<number | null>(null);
  const promptMessageElementsRef = useRef(new Map<string, HTMLElement>());
  const historyPrependAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const threadViewCacheRef = useRef(new Map<string, { thread: ThreadSummary; history: ThreadHistoryPage | null }>());
  const autoFollowMessagesRef = useRef(true);
  const manualMessageScrollLockRef = useRef(false);
  const threadViewTokenRef = useRef(0);
  const initializedProjectIdRef = useRef("");
  const threadPageCacheRef = useRef(new Map<string, { thread: ThreadSummary; history: ThreadHistoryPage; cachedAt: number }>());
  const activeThreadReconcileRef = useRef(new Set<string>());
  const threadPrefetchesRef = useRef(new Set<string>());
  const promptRequestContextsRef = useRef(new Map<string, PromptRequestContext>());
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
  const threadSearchRequestRef = useRef(0);
  const globalSearchRequestRef = useRef(0);
  const [projects, setProjects] = useState<Project[]>(() => storedJson<Project[]>(sidebarProjectsCacheKey(getApiUserId()), []));
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState(getApiUserId());
  const userEffectInitializedRef = useRef(false);
  const [projectRoot, setProjectRoot] = useState("/Volumes/DevDrive/program");
  const [sidebarWidth, setSidebarWidth] = useState(() => storedNumber(sidebarWidthStorageKey, 280, 220, 640));
  const [threadListWidth, setThreadListWidth] = useState(() => storedNumber(threadListWidthStorageKey, 260, 180, 620));
  const [composerHeight, setComposerHeight] = useState(() => storedNumber(composerHeightStorageKey, 54, 38, 520));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => storedBoolean(sidebarCollapsedStorageKey));
  const [threadListCollapsed, setThreadListCollapsed] = useState(() => storedBoolean(threadListCollapsedStorageKey));
  const [systemDirectoryPickerAvailable, setSystemDirectoryPickerAvailable] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => window.localStorage.getItem(sidebarProjectSelectionKey(getApiUserId())) ?? "");
  const [threadSearch, setThreadSearch] = useState("");
  const [threadSearchLoading, setThreadSearchLoading] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchResult[]>([]);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>(() => {
    const userId = getApiUserId();
    const projectId = window.localStorage.getItem(sidebarProjectSelectionKey(userId)) ?? "";
    return projectId ? storedJson<ThreadSummary[]>(sidebarThreadsCacheKey(userId, projectId), []).filter((thread) => !isTemporaryAskThread(thread)) : [];
  });
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null);
  const [dragOverThreadId, setDragOverThreadId] = useState<string | null>(null);
  const [savingThreadOrder, setSavingThreadOrder] = useState(false);
  const [selectedThread, setSelectedThread] = useState<ThreadSummary | null>(null);
  const [threadHistory, setThreadHistory] = useState<ThreadHistoryPage | null>(null);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
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
  const [threadCopyNotice, setThreadCopyNotice] = useState<string | null>(null);
  const [renamingThread, setRenamingThread] = useState<ThreadSummary | null>(null);
  const [threadRenameDraft, setThreadRenameDraft] = useState("");
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [modelProfiles, setModelProfiles] = useState<ModelProfile[]>(fallbackModelProfiles);
  const [newThreadModelProfileId, setNewThreadModelProfileId] = useState(defaultModelProfileId);
  const [savingThreadModel, setSavingThreadModel] = useState(false);
  const [sandbox, setSandbox] = useState<SandboxMode>("danger-full-access");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>("never");
  const [socketStatus, setSocketStatus] = useState<"connecting" | "open" | "closed">("closed");
  const [liveDeltas, setLiveDeltas] = useState<Record<string, LiveDeltaEntry>>({});
  const [liveTools, setLiveTools] = useState<Record<string, LiveToolEntry>>({});
  const [pendingUserMessages, setPendingUserMessages] = useState<PendingUserMessage[]>([]);
  const [promptBottomHoldNow, setPromptBottomHoldNow] = useState(() => Date.now());
  const [uploadedFiles, setUploadedFiles] = useState<ComposerUpload[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [draggingUpload, setDraggingUpload] = useState(false);
  const [filePreview, setFilePreview] = useState<ProjectFilePreview | null>(null);
  const [filePreviewObjectUrl, setFilePreviewObjectUrl] = useState<string>("");
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [filePreviewError, setFilePreviewError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [migratingSessions, setMigratingSessions] = useState(false);
  const [sendingLocalFile, setSendingLocalFile] = useState(false);
  const [quota, setQuota] = useState<CodexQuota | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaPopoverOpen, setQuotaPopoverOpen] = useState(false);
  const [leaderboard, setLeaderboard] = useState<CodexLeaderboard | null>(() => storedJson<CodexLeaderboard | null>(`codex.v2.leaderboard.${getApiUserId()}`, null));
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsPickerOpen, setSkillsPickerOpen] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [selectedSkillNames, setSelectedSkillNames] = useState<string[]>([]);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([]);
  const [handledLocationFileTarget, setHandledLocationFileTarget] = useState(false);
  const [activeTurnsByThread, setActiveTurnsByThread] = useState<Record<string, string>>({});
  const [interruptingTurns, setInterruptingTurns] = useState<Record<string, true>>({});
  const [queuedInterruptPrompts, setQueuedInterruptPrompts] = useState<Record<string, true>>({});
  const [unreadResultThreads, setUnreadResultThreads] = useState<Record<string, true>>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [activePromptNavigationKey, setActivePromptNavigationKey] = useState<string | null>(null);
  const [hoveredPromptNavigationKey, setHoveredPromptNavigationKey] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [temporaryAsk, setTemporaryAsk] = useState<TemporaryAsk | null>(null);
  const [temporaryPrompt, setTemporaryPrompt] = useState("");
  const [temporaryModelProfileId, setTemporaryModelProfileId] = useState(defaultModelProfileId);
  const [temporaryAskWidth, setTemporaryAskWidth] = useState(() => storedNumber("codex-web-temporary-ask-width", 390, 300, 760));
  const [selectionAction, setSelectionAction] = useState<{ text: string; left: number; top: number } | null>(null);
  const [temporaryCloseConfirm, setTemporaryCloseConfirm] = useState(false);
  const [temporaryCloseDontAsk, setTemporaryCloseDontAsk] = useState(() => storedBoolean("codex-web-temporary-close-dont-ask"));

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
    if (!query) return skills;
    return skills.filter((skill) => {
      const copy = localizedSkill(skill);
      return `${copy.name} ${copy.description} ${skill.name}`.toLowerCase().includes(query);
    });
  }, [skillSearch, skills]);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedThreadRef = useRef<ThreadSummary | null>(selectedThread);
  const threadsRef = useRef<ThreadSummary[]>(threads);
  const projectsRef = useRef<Project[]>(projects);
  const temporaryAskRef = useRef<TemporaryAsk | null>(null);
  const temporaryThreadIdsRef = useRef(new Set<string>());
  const pendingUserMessagesRef = useRef<PendingUserMessage[]>(pendingUserMessages);
  const threadLiveRecoveryAtRef = useRef<Record<string, number>>({});

  function performCloseTemporaryAsk() {
    const current = temporaryAskRef.current;
    temporaryAskRef.current = null;
    setTemporaryAsk(null);
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
      turnId: null,
      status: "ready",
    };
    temporaryAskRef.current = next;
    setTemporaryAsk(next);
    setTemporaryPrompt("");
    setTemporaryModelProfileId(activeModelProfileId);
    setSelectionAction(null);
  }

  function sendTemporaryPrompt() {
    const current = temporaryAskRef.current;
    const text = temporaryPrompt.trim();
    if (!current || !text || current.status === "starting" || current.status === "running") return;
    const requestId = `temp-${requestToken()}`;
    const next = { ...current, requestId, prompt: text, status: "starting" as const };
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
        sandbox,
        approvalPolicy,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
    // The conversation is vertical-only. Some WebKit/Safari trackpad gestures can
    // leave a scrollable message container with a non-zero horizontal offset when
    // a long path/image exists; visually this looks like a huge blank white block.
    // Force it back so history content never slides out of view horizontally.
    if (element.scrollLeft !== 0) {
      element.scrollLeft = 0;
    }
    // Safari/WebKit can occasionally leave a composited scroll layer blank while
    // the user scrolls upward through large text/image cards. Toggle a harmless
    // data attribute in the next frame to force the scroll layer to repaint
    // without changing React state or the user-visible scroll position.
    if (scrollRepaintFrameRef.current === null) {
      const repaintTarget = element;
      scrollRepaintFrameRef.current = window.requestAnimationFrame(() => {
        scrollRepaintFrameRef.current = null;
        repaintTarget.toggleAttribute("data-scroll-repaint");
      });
    }
    const bottomGap = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = bottomGap < 96;
    const atBottom = bottomGap < 2;
    if (atBottom) {
      manualMessageScrollLockRef.current = false;
    }
    const shouldFollow = nearBottom && !manualMessageScrollLockRef.current;
    autoFollowMessagesRef.current = shouldFollow;
    setShowScrollToBottom(!shouldFollow);
    schedulePromptNavigationActiveUpdate();
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
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
    manualMessageScrollLockRef.current = false;
    autoFollowMessagesRef.current = true;
    setShowScrollToBottom(false);
    schedulePromptNavigationActiveUpdate();
  }

  const setPromptMessageElement = useCallback((key: string, element: HTMLElement | null) => {
    if (element) {
      promptMessageElementsRef.current.set(key, element);
    } else {
      promptMessageElementsRef.current.delete(key);
    }
  }, []);

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
    const targetTop = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, targetTop - 18), left: 0, behavior: "smooth" });
    autoFollowMessagesRef.current = false;
    setShowScrollToBottom(true);
    setActivePromptNavigationKey(key);
  }

  function resetToNewThread(clearPrompt = false) {
    threadViewTokenRef.current += 1;
    newThreadDraftModeRef.current = true;
    selectedThreadRef.current = null;
    autoFollowMessagesRef.current = true;
    setSelectedThread(null);
    setThreadHistory(null);
    setLoadingOlderHistory(false);
    setContinuationPrompt(null);
    historyPrependAnchorRef.current = null;
    setLocalMessages([]);
    setUploadedFiles([]);
    setDraggingUpload(false);
    setError("");
    if (clearPrompt) {
      setPrompt("");
    }
    window.setTimeout(() => scrollMessagesToBottom("auto"), 0);
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

  function selectThread(threadId: string) {
    const viewToken = ++threadViewTokenRef.current;
    const projectId = selectedProjectIdRef.current;
    newThreadDraftModeRef.current = false;
    if (selectedProjectIdRef.current) {
      threadProjectIdsRef.current.set(threadId, selectedProjectIdRef.current);
    }
    setThreadContextMenu(null);
    setError("");
    const cachedView = projectId ? threadViewCacheRef.current.get(`${projectId}:${threadId}`) : undefined;
    if (cachedView?.history?.totalItems === 0) {
      threadViewCacheRef.current.delete(`${projectId}:${threadId}`);
    }
    if (cachedView && (cachedView.history?.totalItems ?? 1) > 0) {
      const nextThread = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, applyThreadListName(cachedView.thread), modelProfiles));
      selectedThreadRef.current = nextThread;
      setSelectedThread(nextThread);
      setThreadHistory(cachedView.history);
    } else {
      setThreadHistory(null);
    }
    setLoadingOlderHistory(false);
    setContinuationPrompt(null);
    historyPrependAnchorRef.current = null;
    clearThreadResult(threadId);
    void openThread(threadId, projectId, viewToken);
  }

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
        threadViewCacheRef.current.set(cacheKey, { thread: nextThread, history: response.history });
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
    setDraggingThreadId(null);
    setDragOverThreadId(null);
  }

  function moveThreadBefore(orderedThreads: ThreadSummary[], sourceId: string, targetId: string): ThreadSummary[] {
    const sourceIndex = orderedThreads.findIndex((thread) => thread.id === sourceId);
    const targetIndex = orderedThreads.findIndex((thread) => thread.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      return orderedThreads;
    }
    const next = [...orderedThreads];
    const [source] = next.splice(sourceIndex, 1);
    const nextTargetIndex = next.findIndex((thread) => thread.id === targetId);
    next.splice(nextTargetIndex < 0 ? next.length : nextTargetIndex, 0, source);
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

  function startThreadDrag(event: ReactDragEvent<HTMLDivElement>, thread: ThreadSummary) {
    if (threadSearch || savingThreadOrder) {
      event.preventDefault();
      return;
    }
    setPendingDeleteThreadId(null);
    setDraggingThreadId(thread.id);
    setDragOverThreadId(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", thread.id);
  }

  function dragOverThread(event: ReactDragEvent<HTMLDivElement>, thread: ThreadSummary) {
    const sourceId = draggingThreadId || event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === thread.id || savingThreadOrder) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverThreadId((current) => current === thread.id ? current : thread.id);
  }

  function dropThread(event: ReactDragEvent<HTMLDivElement>, target: ThreadSummary) {
    event.preventDefault();
    const sourceId = draggingThreadId || event.dataTransfer.getData("text/plain");
    const source = threadsRef.current.find((thread) => thread.id === sourceId);
    clearThreadDragState();
    if (!sourceId || !source || sourceId === target.id || savingThreadOrder) {
      return;
    }
    if (Boolean(source.pinned) !== Boolean(target.pinned)) {
      setError("置顶会话与普通会话分别排序；如需跨分组，请先取消或设置置顶。");
      return;
    }
    const next = moveThreadBefore(threadsRef.current, sourceId, target.id);
    if (next === threadsRef.current) {
      return;
    }
    threadsRef.current = next;
    setThreads(next);
    void persistThreadOrder(next);
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

  useLayoutEffect(() => {
    const anchor = historyPrependAnchorRef.current;
    const element = messagesRef.current;
    if (!anchor || !element) {
      return;
    }
    historyPrependAnchorRef.current = null;
    element.scrollTop = anchor.scrollTop + (element.scrollHeight - anchor.scrollHeight);
    if (element.scrollLeft !== 0) {
      element.scrollLeft = 0;
    }
    autoFollowMessagesRef.current = false;
    setShowScrollToBottom(true);
  }, [selectedThread?.turns]);

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

  useEffect(() => {
    autoFollowMessagesRef.current = true;
    setShowScrollToBottom(false);
    const timer = window.setTimeout(() => scrollMessagesToBottom("auto"), 0);
    return () => window.clearTimeout(timer);
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
    const reconcileHint = activeTurnId ?? "pending";

    let stopped = false;
    let timer: number | null = null;
    const reconcile = async () => {
      const key = `${projectId}:${threadId}:${reconcileHint}`;
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
    const schedule = () => {
      if (stopped) return;
      timer = window.setTimeout(async () => {
        timer = null;
        await reconcile();
        schedule();
      }, 3_000);
    };
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [selectedProjectId, selectedThread?.id, selectedThread?.id ? activeTurnsByThread[selectedThread.id] : undefined, pendingUserMessages]);

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
    let stopped = false;
    let timer: number | null = null;

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
        void refreshQuota(false, { background: true }).finally(() => scheduleNext());
      }, delay);
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshQuota(false, { background: true });
      scheduleNext();
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
      }, quotaAutoRefreshMs);
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
    if (!userEffectInitializedRef.current) {
      userEffectInitializedRef.current = true;
      setApiUserId(selectedUserId);
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
    const savedAutoSendPreference = storedBooleanWithDefault(autoSendPreferenceStorageKey(selectedUserId), true);
    autoSendEnabledRef.current = savedAutoSendPreference;
    setAutoSendGeneratedFiles(savedAutoSendPreference);
    autoSentGeneratedFileKeysRef.current.clear();
    autoSendInFlightFileKeysRef.current.clear();
    threadProjectIdsRef.current.clear();
    initializedProjectIdRef.current = "";
    setSelectedProjectId("");
    setThreadSearch("");
    setSelectedThread(null);
    setThreadHistory(null);
    setLoadingOlderHistory(false);
    setContinuationPrompt(null);
    historyPrependAnchorRef.current = null;
    setThreads([]);
    setLiveDeltas({});
    setActiveTurnsByThread({});
    setInterruptingTurns({});
    setQueuedInterruptPrompts({});
    setUnreadResultThreads({});
    promptRequestContextsRef.current.clear();
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
    threadViewTokenRef.current += 1;
    newThreadDraftModeRef.current = true;
    selectedThreadRef.current = null;
    setSelectedThread(null);
    setThreadHistory(null);
    setLoadingOlderHistory(false);
    setContinuationPrompt(null);
    historyPrependAnchorRef.current = null;
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
    if (!globalSearchOpen) {
      return;
    }
    const query = globalSearchQuery.trim();
    if (!query) {
      setGlobalSearchResults([]);
      setGlobalSearchLoading(false);
      return;
    }
    const requestId = ++globalSearchRequestRef.current;
    const timer = window.setTimeout(() => {
      setGlobalSearchLoading(true);
      void Promise.all(projects.map(async (project) => {
        const response = await listThreads(project.id, query);
        const normalizedQuery = query.toLocaleLowerCase();
        return response.data
          .filter((thread) => `${thread.name ?? ""} ${thread.preview ?? ""}`.toLocaleLowerCase().includes(normalizedQuery))
          .map((thread): GlobalSearchResult => ({ project, thread }));
      })).then((groups) => {
        if (requestId === globalSearchRequestRef.current) {
          setGlobalSearchResults(groups.flat().slice(0, 30));
        }
      }).catch((caught) => {
        if (requestId === globalSearchRequestRef.current) setError(caught instanceof Error ? caught.message : String(caught));
      }).finally(() => {
        if (requestId === globalSearchRequestRef.current) setGlobalSearchLoading(false);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [globalSearchOpen, globalSearchQuery, projects]);

  useEffect(() => {
    return () => {
      if (filePreviewObjectUrl) {
        URL.revokeObjectURL(filePreviewObjectUrl);
      }
    };
  }, [filePreviewObjectUrl]);

  async function refreshModels() {
    try {
      const response = await listModels();
      const visibleProfiles = response.data.filter((profile) => !(profile.model === "gpt-5.6-sol" && profile.effort === "ultra"));
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
      refresh = readCodexQuota(options.force === true)
        .then((response): QuotaRefreshResult => {
          setQuota(response.data);
          return { quota: response.data, error: null };
        })
        .catch((caught): QuotaRefreshResult => ({
          quota: null,
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

  async function migrateAllSessionsFromLittleRight() {
    if (migratingSessions) {
      return;
    }
    setMigratingSessions(true);
    setError("");
    try {
      const response = await migrateSessionsFrom4090();
      const result = response.data;
      await refreshProjects();
      if (result.projectId) {
        const projectId = result.projectId;
        selectedProjectIdRef.current = projectId;
        threadViewTokenRef.current += 1;
        selectedThreadRef.current = null;
        setSelectedThread(null);
        setThreadHistory(null);
        setThreads([]);
        setSelectedProjectId(projectId);
        await refreshThreads(projectId, "");
      }
      const skipped = result.skippedThreadIds.length ? `；${result.skippedThreadIds.length} 个源端记录文件缺失，未迁移` : "";
      addLocalMessage(
          response.message ?? `已从 little right 导入 ${result.importedThreadIds.length} 个新会话，已存在 ${result.alreadyPresentThreadIds.length} 个。${skipped}`,
        "Codex Web · 会话迁移"
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMigratingSessions(false);
    }
  }

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
      const leakedTemporaryThreads = response.data.filter((thread) => isTemporaryAskThread(thread) && !temporaryThreadIdsRef.current.has(thread.id));
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
      if (cached && cached.history.totalItems === 0) {
        threadPageCacheRef.current.delete(`${projectId}:${threadId}`);
      } else if (cached && Date.now() - cached.cachedAt < 30_000 && (cached.history.returnedItems >= 128 || !cached.history.hasOlder)) {
        const nextThread = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, applyThreadListName(cached.thread), modelProfiles));
        selectedThreadRef.current = nextThread;
        setSelectedThread(nextThread);
        setThreadHistory(cached.history);
        return nextThread;
      }
    }
    try {
      const response = await readThread(threadId, projectId, {
        before: options.before,
        limit: options.appendOlder ? 160 : 128
      });
      if (viewToken !== threadViewTokenRef.current) {
        return null;
      }
      const current = selectedThreadRef.current;
      const mergedThread = options.appendOlder && current?.id === response.thread.id
        ? mergeThreadHistoryPages(response.thread, current)
        : response.thread;
      const nextThreadWithStoredModel = sanitizeThreadForRender(applyStoredThreadModelProfile(selectedUserId, applyThreadListName(mergedThread), modelProfiles));
      selectedThreadRef.current = nextThreadWithStoredModel;
      setSelectedThread(nextThreadWithStoredModel);
      setThreadHistory(response.history ?? null);
      if (!options.appendOlder) {
        const cacheKey = `${projectId}:${nextThreadWithStoredModel.id}`;
        threadViewCacheRef.current.delete(cacheKey);
        threadViewCacheRef.current.set(cacheKey, { thread: nextThreadWithStoredModel, history: response.history ?? null });
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
          thread: nextThreadWithStoredModel,
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
      if (options.appendOlder) {
        historyPrependAnchorRef.current = null;
      }
      if (viewToken === threadViewTokenRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      return null;
    }
  }

  async function openGlobalSearchResult(result: GlobalSearchResult) {
    const viewToken = ++threadViewTokenRef.current;
    selectedProjectIdRef.current = result.project.id;
    setSelectedProjectId(result.project.id);
    setThreadSearch("");
    setGlobalSearchOpen(false);
    setGlobalSearchQuery("");
    await openThread(result.thread.id, result.project.id, viewToken);
  }

  async function loadOlderHistory() {
    const thread = selectedThreadRef.current;
    const projectId = selectedProjectIdRef.current;
    const history = threadHistory;
    if (!thread?.id || !projectId || !history?.hasOlder || loadingOlderHistory) {
      return;
    }

    const element = messagesRef.current;
    if (element) {
      historyPrependAnchorRef.current = { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
    }
    setLoadingOlderHistory(true);
    setError("");
    try {
      await openThread(thread.id, projectId, threadViewTokenRef.current, {
        before: history.nextBefore,
        appendOlder: true
      });
    } finally {
      setLoadingOlderHistory(false);
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
    setDirectoryBrowserLoading(true);
    setError("");
    try {
      const response = await listDirectories(directoryPath);
      setDirectoryBrowser(response.data);
      setDirectoryBrowserOpen(true);
    } catch (caught) {
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
    setUploadedFiles((current) => current.filter((file) => file.relativePath !== relativePath));
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

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    // Do not preventDefault: textual clipboard data must continue to paste into
    // the composer normally. Files from Ctrl/Cmd+V are uploaded in parallel.
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length) {
      void handleFileUpload(files);
    }
  }

  function closeFilePreview() {
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

  const openFilePreview = useCallback(async (filePath: string) => {
    const projectId = selectedProject?.id;
    if (!projectId) {
      return;
    }
    setFilePreviewLoading(true);
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
      setFilePreview(response.data);
      if (response.data.kind === "image" || response.data.kind === "pdf") {
        const blob = await fetchProjectFileBlob(projectId, response.data.relativePath);
        setFilePreviewObjectUrl(URL.createObjectURL(blob));
      }
    } catch (caught) {
      setFilePreviewError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFilePreviewLoading(false);
    }
  }, [selectedProject?.id]);

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
    if (!selectedProject || !filePreview) {
      return;
    }
    setSendingLocalFile(true);
    setError("");
    try {
      const response = await sendProjectFileToLocal(selectedProject.id, filePreview.relativePath);
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

    const candidates = generatedFileCandidatesFromThread(response.thread, project.rootPath);
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
          addLocalMessage(
            `自动发送 ${compactFileLabel(candidate.target)} 失败：${caught instanceof Error ? caught.message : String(caught)}`,
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

  async function sendPrompt() {
    const promptText = prompt.trim();
    if (uploadingFiles || !selectedProject || (!promptText && !uploadedFiles.length)) {
      return;
    }
    if (await handleSlashCommand(promptText)) {
      return;
    }
    const promptUploads = [...uploadedFiles];
    const skillPrefix = selectedSkills.map((skill) => `$${skill.name}`).join(" ");
    const sentPromptText = promptWithUploadedFiles([skillPrefix, promptText].filter(Boolean).join(" "), promptUploads);
    const visibleText = visiblePromptText(promptText, promptUploads);
    const requestId = `thread-${requestToken()}`;
    const requestViewToken = threadViewTokenRef.current;
    const keepAtBottomUntil = Date.now() + sentPromptBottomHoldMs;
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
    const payload = selectedThread
      ? {
          type: "turn.start",
          requestId,
          userId: selectedUserId,
          projectId: selectedProject.id,
          threadId: selectedThread.id,
          prompt: sentPromptText,
          model: selectedModelProfile.model,
          reasoningEffort: selectedModelProfile.effort,
          sandbox,
          approvalPolicy
        }
      : {
          type: "thread.start",
          requestId,
          userId: selectedUserId,
          projectId: selectedProject.id,
          prompt: sentPromptText,
          model: selectedModelProfile.model,
          reasoningEffort: selectedModelProfile.effort,
          sandbox,
          approvalPolicy
    };
    try {
      codexSocket.send(payload);
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
      setPrompt("");
      setUploadedFiles([]);
      setSelectedSkillNames([]);
    } catch (caught) {
      promptRequestContextsRef.current.delete(requestId);
      setError(caught instanceof Error ? caught.message : String(caught));
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
    const keepAtBottomUntil = Date.now() + sentPromptBottomHoldMs;
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
        sandbox,
        approvalPolicy
      });
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
    setLiveDeltas(liveDeltasFromSnapshot(snapshot));
    setLiveTools(liveToolsFromSnapshot(snapshot));
    setActiveTurnsByThread(activeTurnsFromSnapshot(snapshot));
    turnThreadIdsRef.current.clear();
    for (const turn of snapshot.activeTurns) {
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
    const now = Date.now();
    const lastRecovery = threadLiveRecoveryAtRef.current[thread.id] ?? 0;
    if (now - lastRecovery < 2_000) {
      return;
    }
    const isRunning = Boolean(activeFromSnapshot[thread.id]);
    const hasPendingForThread = pendingUserMessagesRef.current.some((entry) => (
      entry.threadId === thread.id && entry.keepAtBottomUntil > now
    ));
    const isPending = hasPendingForThread || thread.status === "starting" || isRunning;
    if (!isRunning && !isPending) {
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
    if (message.type === "hello") {
      const data = message.data as { liveState?: LiveStateSnapshot } | undefined;
      hydrateLiveState(data?.liveState);
      refreshSelectedThreadFromLiveState(data?.liveState);
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

    if (message.type === "terminal.output") {
      const data = message.data as { processId?: string; text?: string; stream?: string } | undefined;
      if (data?.processId && data.text) {
        appendLocalMessage(data.processId, data.text, `Codex Web · ${data.stream ?? "stdout"}`, "tool");
      }
      return;
    }

    if (message.type === "ack") {
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
        const next = { ...temporary, threadId: threadId ?? null, turnId: turnId ?? null, status: "running" as const };
        temporaryAskRef.current = next;
        setTemporaryAsk(next);
        if (threadId) {
          temporaryThreadIdsRef.current.add(threadId);
          threadProjectIdsRef.current.set(threadId, temporary.projectId);
        }
        if (turnId && threadId) {
          turnThreadIdsRef.current.set(turnId, threadId);
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
      if (acknowledgedTurnId && promptThreadId) {
        turnThreadIdsRef.current.set(acknowledgedTurnId, promptThreadId);
        if (message.requestId) {
          setPendingUserMessages((current) => current.map((entry) => entry.requestId === message.requestId
            ? { ...entry, threadId: promptThreadId, turnId: acknowledgedTurnId }
            : entry
          ));
        }
        setActiveTurnsByThread((current) => ({ ...current, [promptThreadId]: acknowledgedTurnId }));
        if (message.requestId && interruptQueuedForPrompt) {
          clearQueuedInterrupt(message.requestId);
          interruptCurrentTurn(promptThreadId, acknowledgedTurnId, requestContext?.projectId ?? selectedProjectIdRef.current);
        }
      } else if (message.requestId && interruptQueuedForPrompt) {
        clearQueuedInterrupt(message.requestId);
      }
      const commandData = message.data as { processId?: string; result?: { exitCode?: number; stdout?: string; stderr?: string } } | undefined;
      if (commandData?.processId && commandData.result) {
        const output = `${commandData.result.stdout ?? ""}${commandData.result.stderr ?? ""}`;
        appendLocalMessage(commandData.processId, `${output}${output.endsWith("\n") || !output ? "" : "\n"}[exit ${commandData.result.exitCode ?? "?"}]\n`, "Codex Web · command", "tool");
      }
      const shouldRefreshPromptThread = isPromptRequest && !isStalePromptAck;
      const refreshViewToken = requestViewToken ?? threadViewTokenRef.current;
      if (shouldRefreshPromptThread && promptThreadId) {
        const refreshProjectId = requestContext?.projectId ?? selectedProjectIdRef.current;
        window.setTimeout(() => void openThread(promptThreadId, refreshProjectId, refreshViewToken), 900);
        window.setTimeout(() => void openThread(promptThreadId, refreshProjectId, refreshViewToken), 2_500);
      }
      if (message.requestId) {
        promptRequestContextsRef.current.delete(message.requestId);
      }
      window.setTimeout(() => void refreshThreads(selectedProjectIdRef.current), 750);
      return;
    }

    if (message.type === "codex.notification") {
      const notification = message.data as CodexNotification;
      const params = notification.params ?? {};
      if (notification.method === "item/agentMessage/delta") {
        const itemId = String(params.itemId ?? "");
        const delta = String(params.delta ?? "");
        const visibleDelta = stripInterruptArtifacts(delta);
        if (!visibleDelta) {
          return;
        }
        if (!itemId) {
          return;
        }
        const turnId = notificationTurnId(params);
        const threadId = notificationThreadId(params) ?? (turnId ? turnThreadIdsRef.current.get(turnId) ?? null : null);
        setLiveDeltas((current) => {
          const existing = current[itemId];
          return {
            ...current,
            [itemId]: {
              threadId: existing?.threadId ?? threadId,
              turnId: existing?.turnId ?? turnId,
              text: `${existing?.text ?? ""}${visibleDelta}`,
              startedAt: existing?.startedAt ?? new Date().toISOString()
            }
          };
        });
      }
      if (notification.method === "turn/started") {
        const turnId = notificationTurnId(params);
        const threadId = notificationThreadId(params);
        if (threadId && turnId) {
          turnThreadIdsRef.current.set(turnId, threadId);
          setActiveTurnsByThread((current) => ({ ...current, [threadId]: turnId }));
        }
      }
      if (notification.method === "turn/completed") {
        const turnId = notificationTurnId(params);
        const threadId = notificationThreadId(params) ?? (turnId ? turnThreadIdsRef.current.get(turnId) ?? null : null);
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
        setPendingUserMessages((current) => current.filter((entry) => entry.threadId !== threadId || entry.keepAtBottomUntil > now));
        if (turnId) {
          setSelectedThread((current) => {
            if (!current || current.id !== threadId) {
              return current;
            }
            return {
              ...current,
              status: "completed",
              turns: current.turns.map((turn) => (
                turn.id === turnId ? { ...turn, status: "completed", completedAt: turn.completedAt || now } : turn
              ))
            };
          });
          setThreads((current) => current.map((item) => (
            item.id !== threadId ? item : {
              ...item,
              status: "completed",
              turns: item.turns.map((turn) => (
                turn.id === turnId ? { ...turn, status: "completed", completedAt: turn.completedAt || now } : turn
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
              const persistedThread = await openThread(threadId, projectId, viewToken, { skipCache: true });
              if (hasPersistedCompletedTurn(persistedThread, turnId)) {
                clearCompletedLiveItems();
                return;
              }
              if (viewToken !== threadViewTokenRef.current) {
                return;
              }
            }
            if (viewToken === threadViewTokenRef.current) {
              clearCompletedLiveItems();
            }
          };
          void promotePersistedTurn();
        } else if (!isTemporaryThread) {
          clearCompletedLiveItems();
        }
        void refreshQuota(false, { background: true });
        void refreshThreads(selectedProjectIdRef.current);
      }
      return;
    }
  }

  const liveTimelineEntries: LiveTimelineEntry[] = [
    ...Object.entries(liveDeltas).map(([id, entry]) => ({ id, kind: "agent" as const, ...entry })),
    ...Object.values(liveTools).map((entry) => ({ id: entry.itemId, kind: "tool" as const, ...entry }))
  ]
    .filter((entry) => selectedThread?.id ? entry.threadId === selectedThread.id || entry.threadId === null : entry.threadId === null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
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
  const renderLiveTimelineEntry = (entry: LiveTimelineEntry) => entry.kind === "agent" ? (
    stripInterruptArtifacts(entry.text) ? (
    <article className="messageItem kind-agent type-agentMessage live" key={entry.id}>
      <div className="messageMeta">Codex · agentMessage</div>
      <MarkdownMessage text={stripInterruptArtifacts(entry.text)} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} renderMath />
    </article>
    ) : null
  ) : (
    <article className="messageItem kind-tool type-toolCall live" key={entry.id}>
      <div className="messageMeta">{entry.completed ? "工具输出" : "调用工具"} · {entry.tool}</div>
      {entry.input ? <pre>{safeText(entry.input)}</pre> : null}
      {entry.output ? <pre className="outputBlock">{displayOutputText(entry.output)}</pre> : entry.completed ? null : <div className="messageBody">正在执行...</div>}
    </article>
  );
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
        className={messageClassName(item, "live pending")}
        key={entry.id}
        ref={(element) => setPromptMessageElement(navigationKey, element)}
      >
        <div className="messageMeta">用户 · sending</div>
        <CollapsibleUserMessage text={entry.text} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
        <PendingUserImagePreviews uploads={entry.attachments} onOpenFileLink={openFilePreview} />
      </article>
    );
  };
  const visiblePendingUserMessages = useMemo(() => pendingUserMessages.filter((entry) => {
    if (!selectedThread?.id) {
      return entry.threadId === null && entry.viewToken === threadViewTokenRef.current;
    }
    return entry.threadId === selectedThread.id;
  }), [pendingUserMessages, selectedThread]);
  const pendingUserMessagesByTurn = useMemo(() => {
    const byTurn = new Map<string, PendingUserMessage[]>();
    const turnIds = new Set((selectedThread?.turns ?? []).map((turn) => turn.id));
    for (const entry of visiblePendingUserMessages) {
      if (!entry.turnId || !turnIds.has(entry.turnId)) {
        continue;
      }
      const entries = byTurn.get(entry.turnId) ?? [];
      entries.push(entry);
      byTurn.set(entry.turnId, entries);
    }
    return byTurn;
  }, [selectedThread, visiblePendingUserMessages]);
  const detachedPendingUserMessages = useMemo(() => {
    const turnIds = new Set((selectedThread?.turns ?? []).map((turn) => turn.id));
    return visiblePendingUserMessages.filter((entry) => !entry.turnId || !turnIds.has(entry.turnId));
  }, [selectedThread, visiblePendingUserMessages]);
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
      if (snapshotTurn && isInterruptableTurnRunning(snapshotTurnId, snapshotTurn)) {
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
  const composerIsStopMode = Boolean(selectedActiveTurnId || currentPendingTurnStart);
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
    const currentTurnIds = new Set((selectedThread?.turns ?? []).map((turn) => turn.id));

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
  }, [localMessages, selectedThread]);
  const promptNavigationItems = useMemo(() => {
    const items = promptNavigationItemsForThread(selectedThread)
      .filter((item) => !heldPersistedPromptNavigationKeys.has(item.key));
    for (const pendingMessage of pendingUserMessages) {
      const belongsToCurrentThread = selectedThread?.id
        ? pendingMessage.threadId === selectedThread.id
        : pendingMessage.threadId === null && pendingMessage.viewToken === threadViewTokenRef.current;
      if (!belongsToCurrentThread) {
        continue;
      }
      const navigationItem = createPromptNavigationItem(pendingPromptNavigationKey(pendingMessage.id), pendingMessage.text);
      if (navigationItem) {
        items.push(navigationItem);
      }
    }
    return items;
  }, [heldPersistedPromptNavigationKeys, pendingUserMessages, selectedThread]);
  const hoveredPromptNavigationItem = promptNavigationItems.find((item) => item.key === hoveredPromptNavigationKey) ?? null;
  const showPromptNavigator = promptNavigationItems.length > 0 || Boolean(selectedThread && threadHistory?.hasOlder);
  const globalEnterSendBlocked = Boolean(
    settingsOpen ||
    globalSearchOpen ||
    renamingThread ||
    directoryBrowserOpen ||
    leaderboardOpen ||
    filePreview ||
    filePreviewLoading ||
    filePreviewError
  );

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
        composerIsStopMode ||
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
  }, [composerIsStopMode, globalEnterSendBlocked, prompt, selectedProject, sendPrompt, uploadedFiles.length, uploadingFiles]);

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

  return (
    <main
      className={`appShell${temporaryAsk ? " temporaryPanelOpen" : ""}`}
      style={{
        gridTemplateColumns: sidebarCollapsed
          ? `0px 0px minmax(${temporaryAsk ? "0px" : "620px"}, 1fr)`
          : `${sidebarWidth}px 8px minmax(${temporaryAsk ? "0px" : "620px"}, 1fr)`,
        paddingRight: temporaryAsk ? `${temporaryAskWidth}px` : undefined,
      }}
    >
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="brand">
          <Bot size={22} />
          <div>
            <div className="brandTitleRow">
              <strong>Codex Web</strong>
              <span className="brandMarker">260803</span>
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
            ‹
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
            <a href="/logout">退出登录</a>
          </div>
          <button
            className="iconTextButton full"
            type="button"
            onClick={() => void migrateAllSessionsFromLittleRight()}
            disabled={migratingSessions}
            title="仅导入 little right 上当前用户的新会话；已有会话跳过，不覆盖本地记录。"
          >
            <Archive size={15} />
            {migratingSessions ? "导入中…" : "导入 little right 会话"}
          </button>
          <p className="creatorHint">只导入新会话，已有记录自动跳过，不会覆盖本地内容。</p>
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
          ›
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
        </div>
      ) : null}

      {threadCopyNotice ? <div className="threadCopyToast" role="status">{threadCopyNotice}</div> : null}

      {globalSearchOpen ? (
        <div className="globalSearchScrim" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setGlobalSearchOpen(false);
        }}>
          <section className="globalSearchDialog" role="dialog" aria-modal="true" aria-label="搜索会话和消息">
            <div className="globalSearchInputRow">
              <span aria-hidden="true">⌕</span>
              <input autoFocus value={globalSearchQuery} onChange={(event) => setGlobalSearchQuery(event.target.value)} placeholder="搜索会话和消息" />
              <button type="button" onClick={() => setGlobalSearchOpen(false)} aria-label="关闭搜索">×</button>
            </div>
            <div className="globalSearchResults">
              {!globalSearchQuery.trim() ? <p className="globalSearchHint">输入关键词，搜索全部项目中的会话标题和摘要。</p> : null}
              {globalSearchLoading ? <p className="globalSearchHint">正在搜索…</p> : null}
              {!globalSearchLoading && globalSearchQuery.trim() && !globalSearchResults.length ? <p className="globalSearchHint">没有匹配的会话。</p> : null}
              {globalSearchResults.map(({ project, thread }) => (
                <button className="globalSearchResult" type="button" key={`${project.id}-${thread.id}`} onClick={() => void openGlobalSearchResult({ project, thread })}>
                  <span><strong>{thread.name || thread.preview || "未命名会话"}</strong><small>{thread.preview || "点击打开此会话"}</small></span>
                  <em>{project.name}</em>
                </button>
              ))}
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

      {directoryBrowserOpen ? (
        <div className="modalScrim" role="dialog" aria-modal="true" aria-labelledby="directory-browser-title">
          <div className="directoryDialog">
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

      {leaderboardOpen ? (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setLeaderboardOpen(false);
          }
        }}>
          <section className="settingsDialog leaderboardDialog" role="dialog" aria-modal="true" aria-label="Codex Token 排行榜">
            <div className="dialogHeader">
              <div>
                <h2>Token 排行榜</h2>
                <p>按本机 Codex 会话记录统计。</p>
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
                  <p className="leaderboardUpdated">更新于 {new Date(leaderboard.updatedAt).toLocaleString()}</p>
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

      {settingsOpen ? (
        <div className="modalScrim" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
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
            <div
              className="quotaPopoverAnchor"
              onMouseEnter={() => {
                setQuotaPopoverOpen(true);
                void refreshQuota(false, { background: true });
              }}
              onMouseLeave={() => setQuotaPopoverOpen(false)}
            >
              <button
                className="quotaButton v2QuotaTopButton"
                type="button"
                onClick={() => void refreshQuota(false, { force: true })}
                disabled={quotaLoading}
                title="悬停查看额度详情"
              >
                {quotaLoading ? "额度..." : quotaSummaryLabel(quota)}
              </button>
              {quotaPopoverOpen ? <QuotaPopover quota={quota} loading={quotaLoading} /> : null}
            </div>
            <button
              className="leaderboardButton"
              type="button"
              onClick={() => void refreshLeaderboard(true, false)}
              disabled={leaderboardLoading}
              title="查看当前周期和历史累计 token 排行榜"
            >
              <Trophy size={14} />
              {leaderboardLoading ? "排行榜..." : "排行榜"}
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

        <div className="workspace" style={{ gridTemplateColumns: threadListCollapsed ? "0px 0px minmax(0, 1fr)" : `${threadListWidth}px 8px minmax(0, 1fr)` }}>
          <nav className={`threadList ${threadListCollapsed ? "collapsed" : ""}`}>
            <div className="listHeader">
              <span>项目</span>
              <span className="listHeaderActions">
                <button className="iconButton" type="button" onClick={() => void refreshThreads(selectedProjectIdRef.current, threadSearch)} title="Refresh threads">
                  <RefreshCcw size={15} />
                </button>
                <button
                  className="panelCollapseButton"
                  type="button"
                  onClick={() => {
                    setThreadListCollapsed(true);
                    window.localStorage.setItem(threadListCollapsedStorageKey, "true");
                  }}
                  title="折叠会话列表"
                  aria-label="折叠会话列表"
                >
                  ‹
                </button>
              </span>
            </div>
            <div className="v2WorkspaceTree">
              {projects.map((project) => {
                const projectSelected = project.id === selectedProjectId;
                return (
                <section className={`v2WorkspaceGroup ${projectSelected ? "selected" : ""}`} key={project.id}>
                    <div
                      className="v2WorkspaceFolderButton"
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setPendingDeleteProjectId(null);
                        setSelectedProjectId(project.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          setPendingDeleteProjectId(null);
                          setSelectedProjectId(project.id);
                        }
                      }}
                      title={project.rootPath}
                    >
                      <span className="v2WorkspaceFolderGlyph" aria-hidden="true" />
                      <strong>{project.name}</strong>
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
                        <PencilLine size={14} />
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
                        {pendingDeleteProjectId === project.id ? "确认" : <Trash2 size={15} />}
                      </button>
                    </div>
                    {projectSelected ? <div className="v2WorkspaceThreads">
            <div className="threadSearchBox">
              <input
                value=""
                readOnly
                onClick={() => setGlobalSearchOpen(true)}
                onFocus={() => setGlobalSearchOpen(true)}
                placeholder="搜索会话和消息"
              />
            </div>
            <button
              type="button"
              className="newThreadButton"
              onClick={() => resetToNewThread(true)}
            >
              <MessageSquare size={15} />
              新建会话
            </button>
              {threads.map((thread) => (
              (() => {
                const threadRunning = Boolean(activeTurnsByThread[thread.id]);
                const hasNewResult = Boolean(unreadResultThreads[thread.id]);
                const deletePending = pendingDeleteThreadId === thread.id;
                const dragEnabled = !threadSearch && !savingThreadOrder;
                return (
                  <div
                    key={thread.id}
                    className={`threadRow ${selectedThread?.id === thread.id ? "selected" : ""} ${threadRunning ? "running" : ""} ${thread.pinned ? "pinned" : ""} ${draggingThreadId === thread.id ? "dragging" : ""} ${dragOverThreadId === thread.id ? "dragOver" : ""}`}
                    draggable={dragEnabled}
                    onContextMenu={(event) => openThreadContextMenu(event, thread)}
                    onDragStart={(event) => startThreadDrag(event, thread)}
                    onDragOver={(event) => dragOverThread(event, thread)}
                    onDrop={(event) => dropThread(event, thread)}
                    onDragEnd={clearThreadDragState}
                    title={threadSearch ? "清空搜索后可拖动排序" : thread.pinned ? "已置顶；可在同组内拖动排序" : "可拖动调整会话顺序"}
                  >
                    <button className="threadSelectButton" type="button" title="右键打开会话操作" onMouseEnter={() => prefetchThread(thread.id)} onFocus={() => prefetchThread(thread.id)} onClick={() => {
                      setPendingDeleteThreadId(null);
                      selectThread(thread.id);
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
                      onClick={() => beginThreadRename(thread)}
                      title="重命名会话"
                      aria-label="重命名会话"
                    >
                      <PencilLine size={14} />
                    </button>
                    <button
                      className={`threadRenameButton threadPinButton ${thread.pinned ? "active" : ""}`}
                      type="button"
                      onClick={() => void toggleThreadPin(thread)}
                      title={thread.pinned ? "取消置顶" : "置顶会话"}
                      aria-label={thread.pinned ? "取消置顶" : "置顶会话"}
                    >
                      <Pin size={14} />
                    </button>
                    <button
                      className={`threadDeleteButton ${deletePending ? "confirm" : ""}`}
                      type="button"
                      disabled={threadRunning}
                      onClick={() => requestRemoveThread(thread)}
                      title={threadRunning ? "运行中的会话不能删除" : deletePending ? "再次点击确认删除" : "删除会话"}
                    >
                      {deletePending ? "确认" : <Trash2 size={14} />}
                    </button>
                  </div>
                );
              })()
            ))}
                    </div> : null}
                  </section>
                );
              })}
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
              ›
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
                  {modelProfiles.filter((profile) => profile.id !== "gpt-5.6-sol:ultra").map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="conversationContent">
              {showPromptNavigator ? (
                <nav
                  className="promptNavigator"
                  aria-label="本会话提示词导航"
                  onMouseLeave={() => setHoveredPromptNavigationKey(null)}
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
                        onMouseEnter={() => setHoveredPromptNavigationKey(navigationItem.key)}
                        onFocus={() => setHoveredPromptNavigationKey(navigationItem.key)}
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
                  {hoveredPromptNavigationItem ? (
                    <div className="promptNavigatorPreview" aria-live="polite">
                      <span>提示词 {promptNavigationItems.findIndex((item) => item.key === hoveredPromptNavigationItem.key) + 1}</span>
                      <strong>{hoveredPromptNavigationItem.title}</strong>
                      <p>{hoveredPromptNavigationItem.preview}</p>
                      <small>点击跳转到这条消息</small>
                    </div>
                  ) : null}
                </nav>
              ) : null}
              <div
                className="messages"
                id="conversation-messages"
                ref={messagesRef}
                onWheelCapture={(event) => {
                  if (event.deltaY < 0 && autoFollowMessagesRef.current) {
                    manualMessageScrollLockRef.current = true;
                    autoFollowMessagesRef.current = false;
                    setShowScrollToBottom(true);
                  }
                }}
                onScroll={updateMessageScrollState}
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
                }}
              >
                {selectedThread && threadHistory?.hasOlder ? (
                  <div className="historyPageControl">
                    <span>为保证流畅，当前已加载最新 {loadedHistoryItemCount} / {threadHistory.totalItems} 条记录。</span>
                    <button type="button" onClick={() => void loadOlderHistory()} disabled={loadingOlderHistory}>
                      {loadingOlderHistory ? "正在加载更早记录..." : `加载更早记录（剩余 ${olderHistoryItemCount} 条）`}
                    </button>
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
                      {temporaryAsk.prompt ? <article className="messageItem kind-user type-userMessage temporaryAskUser"><div className="messageMeta">用户</div><CollapsibleUserMessage text={temporaryAsk.prompt} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} /></article> : null}
                      {temporaryAsk.threadId ? [
                        ...Object.entries(liveDeltas).filter(([, item]) => item.threadId === temporaryAsk.threadId).map(([itemId, item]) => ({ kind: "agent" as const, item: { ...item, itemId } })),
                        ...Object.values(liveTools).filter((item) => item.threadId === temporaryAsk.threadId).map((item) => ({ kind: "tool" as const, item })),
                      ].sort((left, right) => left.item.startedAt.localeCompare(right.item.startedAt)).map(({ kind, item }) => kind === "agent"
                        ? <article className="messageItem kind-agent type-agentMessage temporaryAskAgent" key={item.itemId}><div className="messageMeta">Codex</div><MarkdownMessage text={item.text} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} renderMath /></article>
                        : <article className="messageItem kind-tool type-toolCall temporaryAskTool" key={item.itemId}><div className="messageMeta">{item.completed ? "工具输出" : "调用工具"} · {item.tool}</div>{item.input ? <pre>{safeText(item.input)}</pre> : null}{item.output ? <DeferredToolOutput text={displayOutputText(item.output)} /> : null}</article>) : null}
                      {temporaryAsk.status === "starting" ? <div className="v2ThinkingLine">正在建立临时会话</div> : null}
                      {temporaryAsk.status === "running" ? <div className="v2ThinkingLine">正在思考</div> : null}
                    </div>
                    <div className="composer temporaryAskComposer">
                      <div className="composerBody">
                        <textarea value={temporaryPrompt} onChange={(event) => setTemporaryPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendTemporaryPrompt(); } }} placeholder="随心输入" disabled={temporaryAsk.status === "starting" || temporaryAsk.status === "running"} />
                        <div className="composerTools temporaryAskComposerTools">
                          <span className="temporarySelectionCount"><MessageSquare size={13} />1 个已选文本片段</span>
                          <PolishedSelect<string>
                            className="v2ModelPicker"
                            value={temporaryModelProfileId}
                            onChange={setTemporaryModelProfileId}
                            disabled={temporaryAsk.status === "starting" || temporaryAsk.status === "running"}
                            options={modelProfiles.map((profile) => ({ value: profile.id, label: profile.label, detail: `${profile.model} · 推理 ${profile.effort}` }))}
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
                {temporaryCloseConfirm ? createPortal((
                  <div className="temporaryCloseScrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemporaryCloseConfirm(false); }}>
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
                {(selectedThread?.turns ?? []).flatMap((turn) => {
                  const syntheticUserText = turnHasUserItem(turn) ? "" : turnUserText(turn);
                  const syntheticUserItem: ThreadItem | null = syntheticUserText.trim()
                    ? {
                        id: `${turn.id}-user-input`,
                        type: "userMessage",
                        role: "user",
                        text: syntheticUserText
                      }
                    : null;
                  const items = syntheticUserItem ? [syntheticUserItem, ...(turn.items ?? [])] : turn.items ?? [];
                  const renderedItems = items.map((item) => {
                    const itemKindValue = itemKind(item);
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
                      return null;
                    }
                    const navigationKey = isUserMessage ? promptNavigationKey(turn.id, item.id) : null;
                    if (navigationKey && heldPersistedPromptNavigationKeys.has(navigationKey)) {
                      return null;
                    }
                    return (
                      <article
                        className={messageClassName(item)}
                        key={`${turn.id}-${item.id}`}
                        ref={navigationKey ? (element) => setPromptMessageElement(navigationKey, element) : undefined}
                      >
                        <div className="messageMeta">{itemLabel(item)}</div>
                        {item.command ? (
                          <pre>{safeText(item.command)}</pre>
                        ) : isUserMessage ? (
                            <>
                              <CollapsibleUserMessage text={userVisibleText} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
                              <PersistedUserAttachmentPreviews text={rawItemText} projectId={selectedProject?.id} onOpenFileLink={openFilePreview} />
                            </>
                          ) : (
                            <MarkdownMessage
                              text={cleanedItemText || toolItemDetails(item)}
                              projectId={selectedProject?.id}
                              onOpenFileLink={openFilePreview}
                              renderMath={itemKindValue === "agent"}
                            />
                          )}
                        {item.aggregatedOutput ? <DeferredToolOutput text={item.aggregatedOutput} /> : null}
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
                            <button
                              type="button"
                              title="编辑并重新发送"
                              aria-label="编辑并重新发送"
                              onClick={() => {
                                setPrompt(userVisibleText);
                                window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
                              }}
                            >
                              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11.7-.5 2.1 2.1-.5L12.8 5 11 3.2 3 11.7Z" /><path d="m9.9 4.3 1.8 1.8" /></svg>
                            </button>
                          </div>
                        ) : null}
                        {itemKind(item) === "agent" ? (
                          <div className="v2AgentMessageActions" aria-label="AI 回答操作">
                            <button type="button" title="复制回答" aria-label="复制回答" onClick={() => void copyPlainText(itemText(item))}>
                              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.2" y="2.2" width="8.3" height="9.2" rx="1.4" /><path d="M10.8 13.8H3.9a1.4 1.4 0 0 1-1.4-1.4V5.6" /></svg>
                            </button>
                          </div>
                        ) : null}
                      </article>
                    );
                  });
                  return [
                    ...renderedItems,
                    ...(pendingUserMessagesByTurn.get(turn.id) ?? []).map(renderPendingUserMessage),
                    ...(turn.id && turn.id === selectedActiveTurnId ? [
                    <div className="v2ThinkingLine" key={`${turn.id}-thinking-status`}>正在思考</div>
                    ] : []),
                    ...(conversationLocalMessageLayout.byTurn.get(turn.id) ?? []).map(renderLocalMessage),
                    ...(activeTurnsByThread[selectedThread?.id ?? ""] === turn.id
                      ? (liveTimelineByTurn.get(turn.id) ?? []).map(renderLiveTimelineEntry)
                      : [])
                  ];
                })}
                {conversationLocalMessageLayout.beforePending.map(renderLocalMessage)}
                {timelinePendingUserMessages.map(renderPendingUserMessage)}
                {!selectedThread ? unmatchedLiveTimeline.map(renderLiveTimelineEntry) : null}
                {conversationLocalMessageLayout.tail.map(renderLocalMessage)}
                {heldPendingUserMessages.map((entry) => renderPendingUserMessage(entry))}
                {!selectedThread && liveTimelineEntries.length === 0 && visiblePendingUserMessages.length === 0 && localMessages.length === 0 ? (
                  <div className="emptyState">Ready for a new Codex turn.</div>
                ) : null}
                <div ref={messagesEndRef} className="messagesEnd" aria-hidden="true" />
              </div>
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
              className={`composer ${draggingUpload ? "draggingUpload" : ""}`}
              onDragOver={handleUploadDragOver}
              onDragEnter={handleUploadDragOver}
              onDragLeave={handleUploadDragLeave}
              onDrop={handleUploadDrop}
            >
              {skillsPickerOpen ? (
                <section className="skillPickerPopover" aria-label="选择 Codex 技能">
                  <header className="skillPickerHeader">
                    <div>
                      <strong>选择技能</strong>
                      <span>发送时将使用真实的 $技能名 显式调用</span>
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
                    {filteredSkills.map((skill) => {
                      const copy = localizedSkill(skill);
                      const selected = selectedSkillNames.includes(skill.name);
                      return (
                        <button className={`skillPickerItem${selected ? " selected" : ""}`} type="button" key={skill.name} onClick={() => toggleSelectedSkill(skill.name)}>
                          <span className="skillPickerCheck">{selected ? "✓" : ""}</span>
                          <span className="skillPickerCopy">
                            <strong>{copy.name}</strong>
                            <small>{copy.description}</small>
                            <code>${skill.name}</code>
                          </span>
                        </button>
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
              ) : null}
              <div
                className="resizeHandle horizontalResizeHandle composerResizeHandle"
                role="separator"
                aria-orientation="horizontal"
                title="拖动输入框顶部边缘调整高度"
                onMouseDown={(event) => beginVerticalResize(event, composerHeight, setComposerHeight, composerHeightStorageKey, 38, Math.min(320, window.innerHeight - 260))}
              />
              <div className="composerBody">
                <div className="composerTools">
                  {selectedSkills.map((skill) => (
                    <button className="selectedSkillChip" type="button" key={skill.name} onClick={() => toggleSelectedSkill(skill.name)} title={`移除 $${skill.name}`}>
                      <span>{localizedSkill(skill).name}</span>
                      <X size={12} />
                    </button>
                  ))}
                  <PolishedSelect<string>
                    className="v2ModelPicker"
                    value={activeModelProfileId}
                    onChange={(profileId) => void changeConversationModelProfile(profileId)}
                    disabled={savingThreadModel || conversationRunState === "running"}
                    title={conversationRunState === "running" ? "当前会话运行中，完成后可切换模型" : "选择当前会话后续轮次使用的真实模型"}
                    options={modelProfiles.filter((profile) => profile.id !== "gpt-5.6-sol:ultra").map((profile) => ({
                      value: profile.id,
                      label: profile.label,
                      detail: `${profile.model} · 推理 ${profile.effort}`
                    }))}
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
                  <select
                    className="skillSelect"
                    value=""
                    onChange={(event) => {
                      const skill = skills.find((entry) => entry.name === event.target.value);
                      if (skill) {
                        setPrompt((current) => current ? `${current}\n\n$${skill.name} ` : (skill.defaultPrompt || `$${skill.name} `));
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
                {uploadedFiles.length ? (
                  <div className="uploadedFileList">
                    {uploadedFiles.map((file) => (
                      <div className={`uploadedFileChip${file.isImage ? " uploadedImageChip" : ""}${/\.pdf$/i.test(file.name) ? " uploadedPdfChip" : ""}`} key={file.relativePath} title={file.relativePath}>
                      <button
                          className={`uploadedFilePreviewButton${file.isImage ? " uploadedImageFilePreviewButton" : ""}`}
                          type="button"
                          onClick={() => void openFilePreview(file.relativePath)}
                          disabled={file.uploading}
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
                          aria-label={`取消 ${file.name} 作为本轮输入`}
                          title="取消作为本轮会话输入"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
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
                <textarea
                  value={prompt}
                  style={{ height: composerHeight }}
                  onChange={(event) => setPrompt(event.target.value)}
                  onPaste={handleComposerPaste}
                  onKeyDown={(event) => {
                    // While an IME is composing, Enter confirms the candidate;
                    // it must not accidentally submit the prompt.
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) {
                      return;
                    }
                    event.preventDefault();
                    void sendPrompt();
                  }}
                  placeholder="Enter 发送；Shift+Enter 换行；输入法组词时不会发送"
                />
              </div>
              <button
                className={`iconButton sendButton ${composerIsStopMode ? "stopMode" : "primary"}`}
                type="button"
                onClick={() => {
                  if (requestInterruptSelectedConversation()) {
                    return;
                  }
                  void sendPrompt();
                }}
                disabled={composerIsStopMode ? composerStopBusy : uploadingFiles || !selectedProject || (!prompt.trim() && !uploadedFiles.length)}
                aria-label={composerIsStopMode ? "终止当前对话" : "发送"}
                title={composerIsStopMode ? (composerStopBusy ? "正在终止当前对话" : "终止当前对话（Esc）") : "发送"}
              >
                {composerIsStopMode ? <Square size={16} fill="currentColor" /> : <Send size={18} />}
              </button>
            </div>
          </section>
        </div>
      </section>

      {filePreview || filePreviewLoading || filePreviewError ? (
        <div className="modalScrim filePreviewScrim" role="dialog" aria-modal="true" aria-labelledby="file-preview-title">
          <section className="filePreviewDialog">
            <header className="filePreviewHeader">
              <div>
                <h2 id="file-preview-title">{filePreview?.name ?? "文件预览"}</h2>
                <p>
                  {filePreview?.relativePath ?? filePreviewError}
                  {filePreview?.line ? <span>:{filePreview.line}</span> : null}
                </p>
              </div>
              <div className="filePreviewActions">
                {filePreview ? (
                  <button className="iconTextButton" type="button" onClick={() => void sendPreviewFileToLocal()} disabled={sendingLocalFile}>
                    {sendingLocalFile ? "发送中" : "发送到当前设备"}
                  </button>
                ) : null}
                <button className="iconButton" type="button" onClick={closeFilePreview} title="Close preview">
                  <X size={17} />
                </button>
              </div>
            </header>
            <div className="filePreviewBody">
              {filePreviewLoading ? <div className="emptyState">Loading file preview.</div> : null}
              {!filePreviewLoading && filePreviewError ? <div className="filePreviewError">{filePreviewError}</div> : null}
              {!filePreviewLoading && filePreview ? (
                <>
                  {filePreview.kind === "markdown" ? (
                    <div className="fileMarkdownPreview">
                      <MarkdownMessage text={filePreview.content ?? ""} projectId={selectedProject?.id} onOpenFileLink={(target) => void openFilePreview(target)} />
                    </div>
                  ) : null}
                  {filePreview.kind === "text" ? <pre className="fileTextPreview">{filePreview.content ?? ""}</pre> : null}
                  {filePreview.kind === "image" && filePreviewObjectUrl ? (
                    <img className="fileImagePreview" src={filePreviewObjectUrl} alt={filePreview.name} />
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
  );
}
