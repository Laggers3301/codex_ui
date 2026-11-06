import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { delegationContextInstructions } from "../scripts/agent-delegation-policy.mjs";
import { responseStyleInstructions,responseLanguageInstructions } from "../scripts/agent-response-style.mjs";

const startMarker = "<!-- codex-web:response-language:start -->";
const endMarker = "<!-- codex-web:response-language:end -->";

export const defaultAgentLanguageInstructions = [
  responseLanguageInstructions,
  "",
  delegationContextInstructions,
  "",
  responseStyleInstructions
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
