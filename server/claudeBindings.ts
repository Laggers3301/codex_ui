import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AppError } from "./appErrors.js";
import type { VerifiedClaudeBinding } from "./claudeRuntime.js";
import type {ClaudeEffort} from "../shared/agentRuntime.js";
import {ensureClaudeResponseStyle} from '../scripts/agent-response-style.mjs';

const run = promisify(execFile);
export interface ClaudeIntegrationConfig {
  home: string; executable: string; storageDirectory: string;
  /** ReClaude CLI itself, not the Claude process wrapper. Enables web reauth. */
  reclaudeExecutable?: string;
  /** Legacy bindings used only when a shared pool is not configured. */
  users?: Record<string, { workspaceRoot: string; orgIds: string[] }>;
  /** One account pool for every web user, with separate user workspaces. */
  sharedUsers?: { workspaceDirectory: string; orgIds: string[] };
  /** Trusted shared-pool switch: existing model ids follow this organization
   * mapping only when work is actually submitted, without rewriting history. */
  organizationRedirects?: Record<string, string>;
  /** Optional local cache exported by a trusted ReClaude cache reader. Never
   * a Claude OAuth usage URL, shell command, or browser-provided file path. */
  usageCacheFile?: string;
}
export interface ClaudeBinding extends VerifiedClaudeBinding { deviceId: string; configRoot: string; accountKey: string; label: string; }
const read = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(file, "utf8"));
export function claudeModelEntries(value: unknown): Array<{key:string;nativeId:string;label:string;supportedEffortLevels:ClaudeEffort[]}> {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap(row => {
    if (!row || typeof row !== "object" || typeof row.value !== "string" || row.value === "default") return [];
    const nativeId = row.resolvedModel ?? row.value;
    if (!/^claude-[a-z0-9-]*[0-9][a-z0-9-]*$/.test(nativeId) || typeof row.displayName !== "string") return [];
    const key = row.value.replace(/^claude-/, "");
    if (!/^[a-z][a-z0-9-]*$/.test(key) || seen.has(nativeId)) return [];
    seen.add(nativeId);
    const supportedEffortLevels:ClaudeEffort[]=row.supportsEffort===true&&Array.isArray(row.supportedEffortLevels)?[...new Set<ClaudeEffort>(row.supportedEffortLevels.filter((e:unknown)=>typeof e==="string"&&["low","medium","high","xhigh","max"].includes(e)))]:[];
    return [{key, nativeId, label:`Claude ${row.displayName.replace(/^Claude\s+/i, "").slice(0,100)}`,supportedEffortLevels}];
  });
}

export class ClaudeBindings {
  private modelRefreshes = new Map<string, Promise<void>>();
  private modelCheckedAt = new Map<string, number>();
  constructor(readonly config: ClaudeIntegrationConfig) {}
  private catalogFile(key: string) { return path.join(this.config.storageDirectory,"model-catalog",`${key}.json`); }
  private models(key: string) {
    try { const models=claudeModelEntries(read(this.catalogFile(key)));if(models.length)return models; } catch { /* Metadata unavailable; do not invent a version. */ }
    return ["sonnet","opus","haiku"].map(family=>({key:family,nativeId:family,label:`Claude ${family[0].toUpperCase()+family.slice(1)}（版本待确认）`,supportedEffortLevels:[] as ClaudeEffort[]}));
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
  private owner(userId: string) {
    const shared = this.config.sharedUsers;
    // Shared pool membership never depends on legacy per-user organization lists.
    let owner = shared ? undefined : this.config.users?.[userId];
    if (shared && /^[a-zA-Z0-9_-]+$/.test(userId)) {
      try {
        const root = fs.realpathSync(shared.workspaceDirectory);
        const workspaceRoot = fs.realpathSync(path.join(root, userId));
        if (workspaceRoot === path.join(root, userId) && fs.statSync(workspaceRoot).isDirectory()) {
          owner = { workspaceRoot, orgIds: shared.orgIds };
        }
      } catch { /* No existing private workspace; do not grant a broad root. */ }
    }
    return owner;
  }
  orgIds(userId: string): string[] { return this.owner(userId)?.orgIds ?? []; }
  effectiveModel(userId: string, model: string): string {
    const match = model.match(/^(reclaude-[a-z][a-z0-9-]*)@([0-9]+)$/);
    if (!match) return model;
    const allowed = this.orgIds(userId), seen = new Set<string>();
    let orgId = match[2];
    while (this.config.organizationRedirects?.[orgId] !== undefined) {
      if (seen.has(orgId) || !allowed.includes(orgId)) throw new AppError("runtime_forbidden", "组织切换映射无效，原会话未修改。");
      seen.add(orgId);
      const next = this.config.organizationRedirects[orgId];
      if (!/^[0-9]+$/.test(next) || !allowed.includes(next)) throw new AppError("runtime_forbidden", "目标组织不属于共享账号池，原会话未修改。");
      orgId = next;
    }
    return `${match[1]}@${orgId}`;
  }
  invalidateModels() { this.modelCheckedAt.clear(); }
  list(userId: string): ClaudeBinding[] {
    const owner = this.owner(userId);
    if (!owner) return [];
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
    model = this.effectiveModel(userId, model);
    const orgId = model.match(/^reclaude-[a-z][a-z0-9-]*@([0-9]+)$/)?.[1];
    const matches = this.list(userId).filter(binding => binding.orgId === orgId);
    if (matches.length !== 1) throw new AppError("runtime_not_connected", matches.length ? "此组织有多个本地绑定，需先明确有效绑定。" : "该组织尚未授权，或实际 Claude 账号信息尚未就绪。");
    if(!Object.hasOwn(matches[0].verifiedModels,model))throw new AppError("unsupported_model","客户端尚未确认所选 Claude 模型版本，请刷新模型列表。");
    ensureClaudeResponseStyle(matches[0].configRoot);
    return matches[0];
  }
  async refresh(userId: string, model: string): Promise<ClaudeBinding> {
    const binding = this.resolve(userId, model);
    await this.refreshOrganization(userId, binding.orgId);
    return this.resolve(userId, model);
  }
  async refreshOrganization(userId: string, orgId: string): Promise<ClaudeBinding> {
    if (!/^[0-9]+$/.test(orgId) || !this.orgIds(userId).includes(orgId)) throw new AppError("runtime_forbidden", "组织不属于当前共享账号池。");
    // auth status refreshes the wrapper's selected account/config without
    // creating a conversation. It also bootstraps a newly created device root
    // before any account UUID or model catalog is assumed to be available.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.config.home, RECLAUDE_ORG: orgId };
    delete env.CLAUDE_CONFIG_DIR;
    const result = await run(this.config.executable, ["auth", "status"], { env, timeout: 60_000, maxBuffer: 256 * 1024 });
    let status: Record<string, unknown>;
    try { status = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))); } catch { throw new AppError("claude_identity_unverified", "Claude 登录状态无法确认，未启动会话。"); }
    if (status.loggedIn !== true) throw new AppError("authentication_failed", "Claude 账号尚未登录，未启动会话。");
    const matches = this.list(userId).filter(binding => binding.orgId === orgId);
    if (matches.length !== 1) throw new AppError("claude_identity_unverified", "新登录的 Claude 身份尚未确认，未启动会话。");
    const refreshed = matches[0];
    if (typeof status.configDirectory !== "string" || fs.realpathSync(status.configDirectory) !== fs.realpathSync(refreshed.configRoot)) {
      throw new AppError("claude_identity_unverified", "客户端选择的 Claude 目录与账号绑定不一致，未启动会话。");
    }
    return refreshed;
  }
  profiles(userId: string) {
    return this.list(userId).flatMap(binding => this.models(binding.accountKey).flatMap((entry, index) => (entry.supportedEffortLevels.length?entry.supportedEffortLevels:["medium" as const]).map(effort=>({
      id: `reclaude-${entry.key}@${binding.orgId}:${effort}`, model:`reclaude-${entry.key}@${binding.orgId}`, label: `${entry.label} · ${binding.label}`,
      displayName: `${entry.label} · ${binding.label}`,
      nativeModelId:entry.nativeId,
      effort,supportedEffortLevels:entry.supportedEffortLevels, priority: 1000 + index, runtime: "claude-code" as const,
      availability: "ready" as const, workflow: false
    }))));
  }
  effort(userId:string,model:string,value:unknown):ClaudeEffort|undefined {
    model=this.effectiveModel(userId,model);
    const profiles=this.profiles(userId).filter(p=>p.model===model),levels=profiles[0]?.supportedEffortLevels??[];
    if(!levels.length){if(value!==undefined&&value!=="medium")throw new AppError("unsupported_model","此 Claude 模型未声明支持所选推理级别。");return undefined;}
    const selected=value??(levels.includes("medium")?"medium":levels[0]);
    if(typeof selected!=="string"||!levels.includes(selected as ClaudeEffort))throw new AppError("unsupported_model","此 Claude 模型不支持所选推理级别。");
    return selected as ClaudeEffort;
  }
}
