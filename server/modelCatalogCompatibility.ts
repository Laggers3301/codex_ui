import fs from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Codex 0.159.2's bundled gpt-6.1-sol lite path closes streams for some legacy
 * histories. The ordinary Responses path preserves the same model, messages,
 * tools and history. Keep the source catalog untouched and derive at launch so
 * an upstream catalog refresh cannot silently re-enable the failing path.
 */
export function responsesCompatibleModelCatalog(sourcePath: string): string {
  if (process.env.CODEX_WEB_GPT61_RESPONSES_LITE_COMPAT === "0") return sourcePath;
  const source = fs.readFileSync(sourcePath, "utf8");
  const catalog = JSON.parse(source) as { models?: Array<{ slug?: string; use_responses_lite?: boolean }> };
  const model = catalog.models?.find(entry => entry.slug === "gpt-6.1-sol");
  if (model?.use_responses_lite !== true) return sourcePath;
  model.use_responses_lite = false;
  const destination = `${sourcePath}.responses-compatible.json`;
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  if (fs.existsSync(destination) && fs.readFileSync(destination, "utf8") === content) return destination;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return destination;
}
