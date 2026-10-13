import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const startMarker = "<!-- codex-web:response-language:start -->";
const endMarker = "<!-- codex-web:response-language:end -->";

export const defaultAgentLanguageInstructions = [
  "## 默认回复语言 / Default response language",
  "",
  "- 主代理及所有层级的子代理默认以简体中文撰写用户可见的说明、进度、结论、任务汇报和协作消息；不因模型、子任务描述或参考资料使用英文而切换回复语言。",
  "- 创建子代理或交接任务时，应携带此语言约定，包括不继承父会话历史的子代理。",
  "- 用户明确指定其他语言时按用户要求；代码、命令、路径、标识符、模型名、必要英文术语、原文引用和原始工具日志保留原样，不为统一语言改写它们。",
  "- This applies to the root agent and every subagent, including fresh/no-history forks: use Simplified Chinese for explanations, progress, summaries and collaboration messages by default. An English task description is not a request for an English reply. Honor an explicit user language request and preserve code, identifiers, essential terms and raw logs."
].join("\n");

/** Use Codex's native global instructions, not a visible user-message prelude.
 * Prepend our small managed block so the project-doc byte cap cannot drop it;
 * leave every existing instruction and per-project override intact. */
export function ensureDefaultAgentLanguage(codexHome: string): { path: string; changed: boolean } {
  const read = (file: string): string => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Runtime global instructions must be a regular file of at most 256 KiB.");
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  };
  const overridePath = path.join(codexHome, "AGENTS.override.md");
  const override = read(overridePath);
  const file = override.trim() ? overridePath : path.join(codexHome, "AGENTS.md");
  const existing = override.trim() ? override : read(file);
  if (existing.includes(startMarker) !== existing.includes(endMarker)) throw new Error("Incomplete managed response-language instructions; refusing to overwrite.");
  const managed = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}(?:\\r?\\n){0,2}`, "g");
  const body = existing.replace(managed, "");
  const next = `${startMarker}\n${defaultAgentLanguageInstructions}\n${endMarker}\n\n${body}`;
  if (next === existing) return { path: file, changed: false };
  const temporary = `${file}.language-${randomUUID()}`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  try {
    fs.writeFileSync(temporary, next, { flag: "wx", mode });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { path: file, changed: true };
}
