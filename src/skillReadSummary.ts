import type { ThreadItem } from "./types";

const skillLabels: Record<string, string> = {
  "openai-docs": "OpenAI Docs", "skill-creator": "Skill Creator", "skill-installer": "Skill Installer",
  "latex-word-authoring": "LaTeX / Word 写作"
};
const designLabels: Record<string, string> = {
  index: "入口", audit: "体验审查", research: "体验研究", "user-context": "上下文",
  ideate: "创意探索", "get-context": "设计需求", "image-to-code": "图转前端", "url-to-code": "网页复刻"
};

function commandText(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (Array.isArray(value)) return value.every(part => typeof part === "string") ? [value.join(" ")] : [];
  if (typeof value === "string") {
    if (value.length > 64_000) return [];
    if (value.trim().startsWith("{")) {
      try { return commandText(JSON.parse(value), depth + 1); } catch { return []; }
    }
    return [value];
  }
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return commandText(record.cmd ?? record.command ?? record.path ?? record.file_path, depth + 1);
}

function unwrappedCommand(command: string): string {
  const shell = command.trim().match(/^(?:(?:\/[\w.-]+)*\/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+([\s\S]+)$/);
  if (!shell) return command;
  const content = shell[1].trim();
  return content.length > 1 && ["\"", "'"].includes(content[0]) && content.at(-1) === content[0] ? content.slice(1, -1) : content;
}

/** Describe only a demonstrable file read, not adoption or arbitrary mentions. */
export function skillReadSummary(item: ThreadItem): string | undefined {
  const tool = String(item.tool ?? item.name ?? "").toLowerCase().split(/[./]/).pop() ?? "";
  const fileRead = ["read_file", "readfile", "file_read"].includes(tool);
  if (!fileRead && !["exec", "exec_command", "commandexecution", "shell"].includes(tool)) return undefined;
  const names = new Set<string>();
  for (const command of [...commandText(item.command), ...commandText(item.input)]) {
    for (const statement of unwrappedCommand(command).split(/\n|;|&&|\|\|/)) {
      const read = statement.trim();
      if (!fileRead && (!/^(?:(?:\/usr)?\/bin\/)?(?:cat|head|tail|sed)\b/.test(read) || /(?:^|\s)-[^\s]*i/.test(read) || /[<>]/.test(read))) continue;
      if (!fileRead && /^(?:(?:\/usr)?\/bin\/)?sed\b/.test(read) && !/(?:^|\s)-n(?:\s|$)/.test(read)) continue;
      for (const match of read.matchAll(/(["'])([^"'\r\n]*[\\/]SKILL\.md)\1|(?:^|\s)([^\s"'`;|]+[\\/]SKILL\.md)(?=\s|$)/gi)) {
        const path = (match[2] ?? match[3]).replace(/\\/g, "/");
        const name = path.split("/").at(-2)?.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 100);
        if (!name) continue;
        names.add(path.includes("/product-design/") && designLabels[name] ? `产品设计 · ${designLabels[name]}` : skillLabels[name] ?? name);
      }
    }
  }
  if (!names.size) return undefined;
  const labels = [...names];
  return labels.length > 3 ? `读取 ${labels.slice(0, 3).join("、")} 等 ${labels.length} 项技能` : `读取 ${labels.join("、")} 技能`;
}
