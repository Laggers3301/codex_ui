import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AppError } from "./appErrors.js";
import type { VerifiedClaudeBinding } from "./claudeRuntime.js";

const run = promisify(execFile);
export interface ClaudeIntegrationConfig {
  home: string; executable: string; storageDirectory: string;
  users: Record<string, { workspaceRoot: string; orgIds: string[] }>;
  /** Optional local cache exported by a trusted ReClaude cache reader. Never
   * a Claude OAuth usage URL, shell command, or browser-provided file path. */
  usageCacheFile?: string;
}
export interface ClaudeBinding extends VerifiedClaudeBinding { deviceId: string; configRoot: string; accountKey: string; label: string; }
const read = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(file, "utf8"));
export function claudeModelEntries(value: unknown): Array<{key:string;nativeId:string;label:string}> {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap(row => {
    if (!row || typeof row !== "object" || typeof row.value !== "string" || row.value === "default") return [];
    const nativeId = row.resolvedModel ?? row.value;
    if (!/^claude-[a-z0-9-]*[0-9][a-z0-9-]*$/.test(nativeId) || typeof row.displayName !== "string") return [];
    const key = row.value.replace(/^claude-/, "");
    if (!/^[a-z][a-z0-9-]*$/.test(key) || seen.has(nativeId)) return [];
    seen.add(nativeId);
    return [{key, nativeId, label:`Claude ${row.displayName.replace(/^Claude\s+/i, "").slice(0,100)}`}];
  });
}

export class ClaudeBindings {
  private modelRefreshes = new Map<string, Promise<void>>();
  private modelCheckedAt = new Map<string, number>();
  constructor(readonly config: ClaudeIntegrationConfig) {}
  private catalogFile(key: string) { return path.join(this.config.storageDirectory,"model-catalog",`${key}.json`); }
  private models(key: string) {
    try { const models=claudeModelEntries(read(this.catalogFile(key)));if(models.length)return models; } catch { /* Metadata unavailable; do not invent a version. */ }
    return ["sonnet","opus","haiku"].map(family=>({key:family,nativeId:family,label:`Claude ${family[0].toUpperCase()+family.slice(1)}（版本待确认）`}));
  }
  async refreshModels(userId: string): Promise<void> {
    for (const binding of this.list(userId)) {
      const key=binding.accountKey;
      const pending=this.modelRefreshes.get(key);if(pending){await pending;continue;}
      if(Date.now()-(this.modelCheckedAt.get(key)??0)<15*60_000)continue;
      const promise=(async()=>{
        try {
          const result=await run(process.execPath,[fileURLToPath(new URL("../scripts/claude-model-catalog.mjs",import.meta.url)),binding.executable,binding.workspaceRoot],
            {env:{...process.env,RECLAUDE_ORG:binding.orgId,CLAUDE_CONFIG_DIR:binding.configRoot},timeout:30_000,maxBuffer:256*1024});
          const raw=JSON.parse(result.stdout.trim());if(!claudeModelEntries(raw).length)throw new Error("Empty model catalogue");
          const file=this.catalogFile(key);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
          const partial=`${file}.${process.pid}.partial`;
          fs.writeFileSync(partial,JSON.stringify(raw),{mode:0o600});fs.renameSync(partial,file);
        } catch { /* Retain the last known catalogue without model inference. */ }
        finally { this.modelCheckedAt.set(key,Date.now());this.modelRefreshes.delete(key); }
      })();
      this.modelRefreshes.set(key,promise);await promise;
    }
  }
  list(userId: string): ClaudeBinding[] {
    const owner = this.config.users[userId]; if (!owner) return [];
    const directory = path.join(this.config.home, ".rec", "claude", "accounts");
    if (!fs.existsSync(directory)) return [];
    const bindings: ClaudeBinding[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
      const base = path.join(directory, entry.name), configRoot = path.join(base, "config");
      try {
        if (!fs.realpathSync(configRoot).startsWith(`${fs.realpathSync(base)}${path.sep}`)) continue;
        const device = read(path.join(base, "device.json"));
        if (typeof device.sk !== "string" || !device.sk || !owner.orgIds.includes(String(device.org_id))) continue;
        const native = read(path.join(configRoot, ".claude.json"));
        const uuid = native.oauthAccount?.accountUuid;
        // ReClaude user_email/org_id/device_id are NOT Claude account identity.
        if (typeof uuid !== "string" || !uuid) continue;
        const accountKey=createHash("sha256").update(uuid).digest("hex");
        bindings.push({ userId, orgId: String(device.org_id), deviceId: entry.name, configRoot,
          accountKey, label: String(device.org_name || device.org_id),
          executable: this.config.executable, workspaceRoot: owner.workspaceRoot,
          verifiedModels: Object.fromEntries(this.models(accountKey).map(model=>[`reclaude-${model.key}@${device.org_id}`,model.nativeId])) });
      } catch { /* A logged-out/incomplete binding is not usable. */ }
    }
    return bindings;
  }
  resolve(userId: string, model: string): ClaudeBinding {
    const orgId = model.match(/^reclaude-[a-z][a-z0-9-]*@([0-9]+)$/)?.[1];
    const matches = this.list(userId).filter(binding => binding.orgId === orgId);
    if (matches.length !== 1) throw new AppError("runtime_not_connected", matches.length ? "此组织有多个本地绑定，需先明确有效绑定。" : "该组织尚未授权，或实际 Claude 账号信息尚未就绪。");
    if(!Object.hasOwn(matches[0].verifiedModels,model))throw new AppError("unsupported_model","客户端尚未确认所选 Claude 模型版本，请刷新模型列表。");
    return matches[0];
  }
  async refresh(userId: string, model: string): Promise<ClaudeBinding> {
    const binding = this.resolve(userId, model);
    // auth status refreshes the wrapper's selected account/config without
    // creating a conversation or sending a model message.
    const result = await run(binding.executable, ["auth", "status"], { env: { ...process.env, RECLAUDE_ORG: binding.orgId }, timeout: 60_000, maxBuffer: 256 * 1024 });
    let status: Record<string, unknown>;
    try { status = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))); } catch { throw new AppError("claude_identity_unverified", "Claude 登录状态无法确认，未启动会话。"); }
    if (status.loggedIn !== true) throw new AppError("authentication_failed", "Claude 账号尚未登录，未启动会话。");
    const refreshed = this.resolve(userId, model);
    if (typeof status.configDirectory !== "string" || fs.realpathSync(status.configDirectory) !== fs.realpathSync(refreshed.configRoot)) {
      throw new AppError("claude_identity_unverified", "客户端选择的 Claude 目录与账号绑定不一致，未启动会话。");
    }
    return refreshed;
  }
  profiles(userId: string) {
    return this.list(userId).flatMap(binding => this.models(binding.accountKey).map((entry, index) => ({
      id: `reclaude-${entry.key}@${binding.orgId}:medium`, model:`reclaude-${entry.key}@${binding.orgId}`, label: `${entry.label} · ${binding.label}`,
      displayName: `${entry.label} · ${binding.label}`,
      nativeModelId:entry.nativeId,
      effort: "medium" as const, priority: 1000 + index, runtime: "claude-code" as const,
      availability: "ready" as const, workflow: false
    })));
  }
}
