import { toolDescription } from "../shared/toolDescription";
import type { ThreadItem } from "./types";

export type ToolIconKind = "web" | "file" | "search" | "agent" | "terminal" | "image" | "tool";
export function toolDisplayName(item:ThreadItem):string{
  const name=String(item.tool??'');
  return ({Bash:'exec',Read:'读取文件',Edit:'修改文件',Write:'写入文件',WebFetch:'访问网页',WebSearch:'联网搜索',ToolSearch:'查找工具',mcp__codex_web_history__search:'检索历史',mcp__codex_web_history__read:'读取历史',mcp__codex_documents__read_docx:'读取文档',mcp__codex_browser__browser_action:'浏览器',mcp__codex_feishu__feishu_office:'飞书办公',mcp__codex_schedules__scheduled_tasks:'定时任务',mcp__codex_communication__session_communication:'会话通信'} as Record<string,string>)[name]??name;
}

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
  const query = typeof data.query === "string" ? data.query : typeof data.pattern==='string'?data.pattern:first && typeof first === "object" ? (first as Record<string, unknown>).q : undefined;
  if (typeof query !== "string") return;
  const text = query.replace(/\s+/g, " ").trim();
  return text && text.length <= 100 ? text : undefined;
}

function changedFile(item: ThreadItem): { name: string; action: string } | undefined {
  const input = parsed(item.input ?? item.arguments ?? item.command ?? item.changes);
  let path: unknown;
  let action = "变更";
  if (typeof input === "string") {
    const match = input.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/m);
    path = match?.[2];
    action = match?.[1] === "Add" ? "新增" : match?.[1] === "Delete" ? "删除" : "修改";
  }
  else if (Array.isArray(input)) path = (input[0] as Record<string, unknown> | undefined)?.path;
  else if (input && typeof input === "object") path = (input as Record<string, unknown>).path ?? (input as Record<string, unknown>).file_path;
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
  const rawName = String(item.tool ?? item.type ?? "").toLowerCase();
  const name=({bash:'exec',read:'read_file',write:'write_file',edit:'edit_file',notebookedit:'edit_file',webfetch:'fetch_url',grep:'search',glob:'find_files'} as Record<string,string>)[rawName]??rawName;
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
  if (/read_file|readfile/.test(name)) { const file=changedFile(item);return { description: supplied ?? (file?`读取 ${file.name}`:"读取文件"), icon: "file" }; }
  if (/search|find_files/.test(name)) {const query=webQuery(item);return { description: supplied ?? (query?`搜索：${query}`:"搜索内容"), icon: "search" };}
  if (/^(?:.*[./])?(?:exec|exec_command|commandexecution|shell)$/.test(name)) {
    let value = parsed(item.command ?? item.input ?? item.arguments);
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
