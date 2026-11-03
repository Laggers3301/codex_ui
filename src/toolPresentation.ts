import { toolDescription } from "../shared/toolDescription";
import type { ThreadItem } from "./types";

export type ToolIconKind = "web" | "file" | "search" | "agent" | "terminal" | "image" | "tool";

function parsed(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 64000) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function webQuery(item: ThreadItem): string | undefined {
  const value = parsed(item.input ?? item.arguments);
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  const searches = data.search_query ?? data.searchQuery;
  const first = Array.isArray(searches) ? searches[0] : undefined;
  const query = typeof data.query === "string" ? data.query : first && typeof first === "object" ? (first as Record<string, unknown>).q : undefined;
  if (typeof query !== "string") return;
  const text = query.replace(/\s+/g, " ").trim();
  return text && text.length <= 100 ? text : undefined;
}

function changedFile(item: ThreadItem): { name: string; action: string } | undefined {
  const input = parsed(item.input ?? item.command ?? item.changes);
  let path: unknown;
  let action = "变更";
  if (typeof input === "string") {
    const match = input.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/m);
    path = match?.[2];
    action = match?.[1] === "Add" ? "新增" : match?.[1] === "Delete" ? "删除" : "修改";
  }
  else if (Array.isArray(input)) path = (input[0] as Record<string, unknown> | undefined)?.path;
  else if (input && typeof input === "object") path = (input as Record<string, unknown>).path;
  if (typeof path !== "string") return;
  const name = path.replace(/\\/g, "/").split("/").pop()?.trim();
  return name && name.length <= 100 && !/[\r\n]/.test(name) ? { name, action } : undefined;
}

function commandSummary(command: string): string | undefined {
  const first = command.split(/;|&&|\n/)[0].trim();
  const basename = (path: string) => path.replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop();
  if (/^(?:rg|grep)\s/.test(first)) {
    const query = first.match(/['"]([^'"\r\n]{1,100})['"]/)?.[1];
    return query ? `搜索：${query}` : '搜索内容';
  }
  if (/^(?:cat|head|tail|sed\s+-n)\s/.test(first) && !/[<>|]/.test(first)) {
    const file = basename(first.trim().split(/\s+/).at(-1) ?? '');
    if (file && !file.startsWith('-')) return `读取 ${file}${command !== first ? ' 等操作' : ''}`;
  }
  const script = first.match(/(?:^|\s)(?:\/[^\s]+\/)?node\s+([^\s'";]+\.(?:mjs|cjs|js|ts))(?=\s|$)/)?.[1];
  if (script) return `运行 ${basename(script)}`;
  return undefined;
}

export function toolPresentation(item: ThreadItem): { description?: string; icon: ToolIconKind } {
  const name = String(item.tool ?? item.type ?? "").toLowerCase();
  const supplied = toolDescription(item, item.input, item.arguments);
  if (/web.?search|web__run|browser|search_query|fetch_url/.test(name)) {
    const query = webQuery(item);
    return { description: supplied ?? (query ? `搜索：${query}` : "联网查询"), icon: "web" };
  }
  if (/collab|agent|send_message|spawn_agent|followup_task/.test(name)) return { description: supplied, icon: "agent" };
  if (/image|view_image/.test(name)) return { description: supplied, icon: "image" };
  if (/apply_patch|filechange|write_file|edit_file/.test(name)) {
    const file = changedFile(item);
    return { description: supplied ?? (file ? `${file.action} ${file.name}` : "文件变更"), icon: "file" };
  }
  if (/read_file|readfile/.test(name)) return { description: supplied ?? "读取文件", icon: "file" };
  if (/search|find_files/.test(name)) return { description: supplied ?? "搜索内容", icon: "search" };
  if (/^(?:.*[./])?(?:exec|exec_command|commandexecution|shell)$/.test(name)) {
    let value = parsed(item.command ?? item.input);
    if (value && typeof value === 'object' && !Array.isArray(value)) value = (value as Record<string,unknown>).cmd ?? (value as Record<string,unknown>).command;
    let command = typeof value === "string" ? value.trim() : "";
    const shell = command.match(/^(?:\/[^\s]+\/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+['"]([\s\S]*)['"]$/);
    if (shell) command = shell[1].trim();
    let description = supplied;
    description ??= commandSummary(command);
    return { description, icon: "terminal" };
  }
  return { description: supplied, icon: "tool" };
}
