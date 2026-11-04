import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const scripts=fileURLToPath(new URL("../scripts/",import.meta.url));
const run=promisify(execFile);

export async function offlineFork(sessionId: string, configRoot: string, title: string, cutoff?: string): Promise<string> {
  const result = await run("/usr/bin/python3", [path.join(scripts, "claude-offline-network-guard.py"), process.execPath,
    path.join(scripts, "claude-offline-fork.mjs"), sessionId, "", title, cutoff ?? ""],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot }, timeout: 120_000, maxBuffer: 1024 * 1024 });
  const id = JSON.parse(result.stdout.trim()).sessionId;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || id === sessionId) throw new Error("Invalid offline fork identity.");
  return id;
}
