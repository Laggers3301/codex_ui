import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { AppError } from "./appErrors.js";

type AccountKind = "codex-account" | "api-provider";
const maxConfigBytes = 1024 * 1024;
const parseConfig = (text: string) => parse(text, { integersAsBigInt: true });
const configurationError = () => new AppError("native_model_config", "无法安全迁移 Codex 模型配置，原配置已保留。请检查服务私有 config.toml，或设置 CODEX_WEB_CODEX_MODEL_DISCOVERY=legacy 保留原方式。");

function readConfiguration(home: string): string | null {
  const file = path.join(home, "config.toml");
  try {
    if (fs.statSync(file).size > maxConfigBytes) throw configurationError();
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw configurationError();
  }
}

/** Provider catalogs belong to the UI/provider registry; only ordinary Codex
 * accounts opt into native discovery. No catalog file is removed or rewritten. */
export function nativeModelDiscoveryEnabled(home: string, kind: AccountKind = "codex-account", env: NodeJS.ProcessEnv = process.env): boolean {
  if (kind === "api-provider" || env.CODEX_WEB_CODEX_MODEL_DISCOVERY === "legacy") return false;
  const text = readConfiguration(home);
  if (text === null) return true;
  try {
    const config = parseConfig(text);
    const profiles = config.profiles;
    const selected = typeof config.profile === "string" && profiles && typeof profiles === "object" && !Array.isArray(profiles)
      ? (profiles as Record<string, unknown>)[config.profile] : undefined;
    const provider = selected && typeof selected === "object" && !Array.isArray(selected)
      ? (selected as Record<string, unknown>).model_provider ?? config.model_provider : config.model_provider;
    return provider === undefined || provider === "openai";
  } catch { throw configurationError(); }
}

/** Preserve comments, ordering, numeric types and every unrelated setting.
 * Parsing the candidate also prevents removing text inside a multiline string
 * or a similarly named key in a provider table. */
export function withoutPinnedModelCatalog(text: string): string {
  try {
    const expected = parseConfig(text);
    if (!Object.hasOwn(expected, "model_catalog_json")) return text;
    delete expected.model_catalog_json;
    const matches = text.matchAll(/^[\t ]*(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')[\t ]*=/gm);
    for (const match of matches) {
      const start = match.index!;
      let end = start;
      for (let lines = 0; lines < 32 && end < text.length; lines++) {
        const newline = text.indexOf("\n", end);
        end = newline < 0 ? text.length : newline + 1;
        const candidate = text.slice(0, start) + text.slice(end);
        try {
          if (isDeepStrictEqual(parseConfig(candidate), expected)) return candidate;
        } catch { /* This was not the complete root-level value. */ }
      }
    }
  } catch { throw configurationError(); }
  throw configurationError();
}

/** A one-time, reversible migration of this runtime's private config only.
 * Credentials, native caches, UI catalogs and database paths remain in place. */
export function prepareNativeModelDiscovery(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const original = readConfiguration(home);
  if (original === null) return;
  const replacement = withoutPinnedModelCatalog(original);
  if (replacement === original) return;
  const file = path.join(home, "config.toml");
  const digest = createHash("sha256").update(original).digest("hex").slice(0, 16);
  const backup = `${file}.before-native-model-discovery.${digest}.bak`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    try { fs.writeFileSync(backup, original, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || fs.readFileSync(backup, "utf8") !== original) throw error;
    }
    fs.writeFileSync(temporary, replacement, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Refuse to overwrite a concurrent administrator edit.
    if (fs.readFileSync(file, "utf8") !== original) throw configurationError();
    fs.renameSync(temporary, file);
  } catch { throw configurationError(); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function nativeModelDiscoveryArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  // Codex Web passes the explicit project cwd on start/resume. Restrict config
  // discovery to that project instead of an unrelated enclosing home Git repo.
  const args = ["-c", "project_root_markers=[]"];
  if (!["0", "false"].includes(env.CODEX_WEB_DEFAULT_MODE_REQUEST_USER_INPUT ?? "")) {
    args.push("-c", "features.default_mode_request_user_input=true");
  }
  return args;
}
