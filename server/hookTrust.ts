import fs from "node:fs";
import path from "node:path";
import type { CodexBridge } from "./codexBridge.js";
import { isAccountPoolBridge } from "./accountPoolBridge.js";
import type { ProjectStore } from "./db.js";
import type { Project } from "./types.js";

export interface ListedHook {
  key?: string;
  currentHash?: string;
  sourcePath?: string;
  eventName?: string;
  handlerType?: string;
  command?: string;
  trustStatus?: string;
  [key: string]: unknown;
}

export function isProjectLocalHook(root: string, sourcePath: unknown): boolean {
  if (typeof sourcePath !== "string") return false;
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(sourcePath));
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}

export async function listHooksForProject(bridge: CodexBridge, project: Project, threadId?: string): Promise<{
  hooks: ListedHook[]; warnings: string[]; errors: Array<{ message?: string }>;
}> {
  const params = { cwds: [project.rootPath] };
  const result = await (threadId && isAccountPoolBridge(bridge)
    ? bridge.requestOnThreadAccount(threadId, "hooks/list", params, 30_000)
    : bridge.request("hooks/list", params, 30_000)) as {
    data?: Array<{ hooks?: ListedHook[]; warnings?: string[]; errors?: Array<{ message?: string }> }>;
  };
  const entry = result.data?.find(item => true);
  return { hooks: entry?.hooks ?? [], warnings: entry?.warnings ?? [], errors: entry?.errors ?? [] };
}

export async function scopedHookTrustConfig(
  bridge: CodexBridge, store: ProjectStore, userId: string, project: Project, threadId?: string
): Promise<Record<string, unknown>> {
  const grants = store.getProjectHookTrust(userId, project.id);
  if (!grants.size) return {};
  try {
    const listed = await listHooksForProject(bridge, project, threadId);
    const state: Record<string, { trusted_hash: string }> = {};
    for (const hook of listed.hooks) {
      if (hook.key && hook.currentHash && grants.get(hook.key) === hook.currentHash
        && isProjectLocalHook(project.rootPath, hook.sourcePath)) {
        state[hook.key] = { trusted_hash: hook.currentHash };
      }
    }
    return Object.keys(state).length ? { "hooks.state": state } : {};
  } catch { return {}; }
}
