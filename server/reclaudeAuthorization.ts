import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AppError } from "./appErrors.js";
import type { ClaudeBindings, ClaudeIntegrationConfig } from "./claudeBindings.js";
import { ReclaudeLifecycle } from "./reclaudeLifecycle.js";
import { reclaudeAuthorizationPending, reclaudeAuthorizationUrl, type ReclaudeAuthorizationAction, type ReclaudeAuthorizationOperation, type ReclaudeAuthorizationStatus } from "../shared/reclaudeAuthorization.js";

interface Operation extends Omit<ReclaudeAuthorizationOperation, "owned"> { userId: string; }
const messages: Record<string, string> = {
  bind_failed: "组织绑定未完成，请确认组织编号、账号成员资格及设备授权。当前默认组织未切换。",
  switch_failed: "默认组织切换未完成，请刷新组织列表核对当前选择。",
  switch_unverified: "客户端未确认目标组织，未执行历史同步，请刷新核对默认组织。",
  sync_failed: "默认组织已切换，但历史同步未完成；请检查旧账号活跃进程及历史目录后重试。已有文件不会被覆盖。",
  logout_failed: "未能按组织退出登录，请检查 ReClaude 客户端版本后重试。",
  login_failed: "ReClaude 登录未完成，可重新发起认证。",
  client_start_failed: "ReClaude 登录程序未能启动。",
  invalid_configuration: "ReClaude 登录程序尚未正确配置。"
};

function organizationReadError(error: unknown): string {
  const failure = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean }
    : {};
  // Classify locally; command output can contain private device information.
  // Only fixed messages are returned to the browser.
  const detail = [failure.message, failure.stdout, failure.stderr]
    .filter((value): value is string => typeof value === "string").join("\n");
  if (/device_revoked|此设备已被解绑/i.test(detail)) {
    return "ReClaude 设备授权已失效，请选择“重新认证已有组织”，完成认证后再刷新列表。";
  }
  if (/\b401\b|unauthorized|not logged in|no device|未登录|尚未登录/i.test(detail)) {
    return "ReClaude 尚未登录或登录已失效，请先完成组织认证，再刷新列表。";
  }
  if (["ENOENT", "EACCES", "EPERM"].includes(String(failure.code))
    || /permission denied|operation not permitted|read-only file system/i.test(detail)) {
    return "ReClaude 客户端未能启动，请检查服务配置、命令路径和目录权限。";
  }
  if (failure.code === "ETIMEDOUT" || failure.killed && failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "读取 ReClaude 组织列表超时，请检查网络和客户端状态后重试。";
  }
  return "读取 ReClaude 组织列表失败，请检查客户端登录和网络后重试；也可输入组织编号进行绑定。";
}

export class ReclaudeAuthorization {
  private discovered: Array<{ orgId: string; label: string; bound: boolean; current: boolean }> = [];
  private organizationError?: string;
  private discovery?: Promise<void>;
  private operation: Operation | null = null;
  private child?: ChildProcess;
  private release?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private cancelRequested = false;
  private closed = false;
  private readonly file: string;
  constructor(private config: ClaudeIntegrationConfig, private bindings: ClaudeBindings,
    private lifecycle: ReclaudeLifecycle, private snapshotHistory: (orgId: string) => void) {
    this.file = path.join(config.storageDirectory, "authorization.json");
    try {
      this.operation = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (this.operation && reclaudeAuthorizationPending(this.operation.phase)) {
        this.operation.phase = "interrupted"; this.operation.message = "服务已重启，请重新发起认证。";
        delete this.operation.authorizationUrl; this.save();
      }
    } catch { this.operation = null; }
  }
  private save() {
    const temporary = this.file + ".partial";
    fs.writeFileSync(temporary, JSON.stringify(this.operation), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  async refreshOrganizations(userId: string): Promise<ReclaudeAuthorizationStatus> {
    if (!this.bindings.canManageOrganizations(userId)) throw new AppError("runtime_forbidden", "无权查看此共享账号的组织。");
    if (!this.config.reclaudeExecutable) return this.status(userId);
    this.discovery ??= (async () => {
      const release = this.lifecycle.acquireRun();
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.config.home, RECLAUDE_LANG: "en" };
        delete env.RECLAUDE_ORG; delete env.CLAUDE_CONFIG_DIR;
        const result = await promisify(execFile)(this.config.reclaudeExecutable!, ["org"], { env, timeout: 30_000, maxBuffer: 256 * 1024 });
        // rec org returns tab-separated rows. Never pass its raw output or
        // device files to the browser; only organization metadata is retained.
        const rows = result.stdout.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).flatMap(line => {
          const match = line.match(/^\s*(\*)?\s*(\d+)\t([^\t]*)\t[^\t]*\t[^\t]*\t(bound|not bound|已绑定|未绑定)\s*$/i);
          return match ? [{ orgId: match[2], label: match[3].trim().slice(0, 100) || `组织 ${match[2]}`, current: !!match[1], bound: /^(bound|已绑定)$/i.test(match[4]) }] : [];
        });
        if (!rows.length) {
          this.organizationError = /No organizations available\.|没有可用组织。/i.test(result.stdout)
            ? "当前账号没有可列出的组织，可输入组织编号进行绑定。"
            : "ReClaude 已返回结果，但未识别组织列表格式，请检查客户端版本；也可输入组织编号进行绑定。";
          return;
        }
        this.discovered = rows; this.organizationError = undefined;
      } catch (error) {
        this.organizationError = organizationReadError(error);
      } finally { release(); this.discovery = undefined; }
    })();
    try { await this.discovery; } finally { this.discovery = undefined; }
    return this.status(userId);
  }
  status(userId: string): ReclaudeAuthorizationStatus {
    const bindings = this.bindings.list(userId), ids = this.bindings.orgIds(userId);
    const operation = this.operation;
    const visible = operation && (ids.includes(operation.orgId) || operation.userId === userId);
    const owned = operation?.userId === userId;
    const current = this.bindings.currentOrganization();
    return {
      enabled: !!this.config.reclaudeExecutable && this.bindings.canManageOrganizations(userId),
      organizations: [...new Set([...ids, ...(this.bindings.canManageOrganizations(userId) ? this.discovered.map(row => row.orgId) : [])])].filter(id => /^[0-9]+$/.test(id)).map(orgId => {
        const binding = bindings.find(binding => binding.orgId === orgId);
        const discovered = this.discovered.find(row => row.orgId === orgId);
        return { orgId, label: binding?.label ?? discovered?.label ?? `组织 ${orgId}`, connected: !!binding, bound: discovered?.bound ?? !!binding, current: current ? current.orgId === orgId : discovered?.current ?? false };
      }),
      canSyncHistory: !!this.config.accountSyncExecutable && !!current && ids.includes(current.orgId),
      ...(this.organizationError ? { organizationError: this.organizationError } : {}),
      operation: visible ? { id: operation.id, orgId: operation.orgId, action: operation.action, syncHistory: operation.syncHistory, phase: operation.phase, startedAt: operation.startedAt,
        expiresAt: operation.expiresAt, owned, ...(owned && operation.authorizationUrl ? { authorizationUrl: operation.authorizationUrl } : {}),
        ...(operation.message ? { message: owned ? operation.message : "共享账号的认证状态已更新。" } : {}) } : null
    };
  }
  start(userId: string, orgId: string, requestId: string, action: ReclaudeAuthorizationAction = "reauthenticate", syncHistory = false): ReclaudeAuthorizationStatus {
    if (this.closed) throw new AppError("runtime_not_connected", "ReClaude 正在关闭，请稍后重试。");
    if (!["reauthenticate", "bind", "use"].includes(action) || syncHistory && action !== "use") throw new AppError("invalid_request", "组织操作无效。");
    if (!/^[0-9]{1,20}$/.test(orgId) || !this.bindings.canManageOrganizations(userId)
      || action !== "bind" && !this.bindings.orgIds(userId).includes(orgId)) throw new AppError("runtime_forbidden", "无权操作此组织。");
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new AppError("invalid_request", "重新认证请求缺少有效标识。");
    if (this.operation?.id === requestId) {
      if (this.operation.userId !== userId) throw new AppError("runtime_forbidden", "认证请求不属于当前用户。");
      if (this.operation.orgId !== orgId || (this.operation.action ?? "reauthenticate") !== action || !!this.operation.syncHistory !== syncHistory) throw new AppError("invalid_request", "请求标识已用于另一项组织操作。");
      return this.status(userId);
    }
    if (this.operation && reclaudeAuthorizationPending(this.operation.phase)) {
      if (this.operation.userId === userId && this.operation.orgId === orgId && (this.operation.action ?? "reauthenticate") === action && !!this.operation.syncHistory === syncHistory) return this.status(userId);
      throw new AppError("reclaude_reauth_in_progress", "共享账号已有认证正在进行，请等待完成。");
    }
    const client = this.config.reclaudeExecutable;
    if (!client || !path.isAbsolute(client)) throw new AppError("runtime_not_connected", "尚未启用 ReClaude 网页认证。");
    fs.accessSync(client, fs.constants.X_OK);
    if (action === "use" && this.bindings.list(userId).filter(binding => binding.orgId === orgId).length !== 1) throw new AppError("runtime_not_connected", "请先绑定并确认目标组织的 Claude 身份，再切换默认组织。");
    const release = this.lifecycle.acquireAuthorization();
    try {
      // Read the previous *device directory* while holding the machine lease;
      // claude-account-sync --from takes this id, not an organization id.
      const previous = this.bindings.currentOrganization();
      const syncClient = this.config.accountSyncExecutable;
      if (syncHistory) {
        if (!syncClient || !path.isAbsolute(syncClient) || !previous || !this.bindings.orgIds(userId).includes(previous.orgId)) throw new AppError("invalid_request", "未配置历史同步程序，或无法确认旧组织，请先完成配置。");
        fs.accessSync(syncClient, fs.constants.X_OK);
      }
      this.snapshotHistory(orgId);
      const now = Date.now();
      this.operation = { id: requestId, orgId, userId, action, syncHistory, phase: "starting", startedAt: now, expiresAt: now + 10 * 60_000 };
      this.cancelRequested = false; this.release = release; this.save();
      const script = fileURLToPath(new URL("../scripts/reclaude-reauth.mjs", import.meta.url));
      const child = spawn(process.execPath, [script, "--client", client, "--home", this.config.home, "--org", orgId, "--action", action,
        ...(syncHistory ? ["--account-sync", syncClient!, "--from-device", previous!.deviceId] : [])],
        { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      this.child = child;
      let buffer = "", failure: string | undefined;
      child.stdout?.on("data", chunk => {
        buffer = (buffer + chunk.toString()).slice(-16384);
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (!this.operation || this.operation.id !== requestId || this.cancelRequested || this.closed) continue;
            if (event.type === "phase" && ["binding", "switching", "syncing", "logging_out", "waiting_authorization", "verifying"].includes(event.phase)) this.operation.phase = event.phase;
            if (event.type === "authorization") {
              const url = typeof event.url === "string" ? reclaudeAuthorizationUrl(event.url) : null;
              if (url) { this.operation.authorizationUrl = url; this.operation.phase = "waiting_authorization"; }
            }
            if (event.type === "failed") failure = messages[event.code] ?? "ReClaude 认证未完成，请重试。";
            this.save();
          } catch { /* Never expose raw CLI output or credentials. */ }
        }
      });
      child.stderr?.resume();
      child.once("error", () => { void this.finish(requestId, false, "ReClaude 登录程序未能启动。").catch(() => {}); });
      child.once("close", code => { void this.finish(requestId, code === 0, failure).catch(() => {}); });
      this.timer = setTimeout(() => {
        if (this.operation?.id === requestId) { this.operation.message = "认证链接已超时，请重新发起认证。"; this.cancelRequested = true; this.stopChild(); }
      }, 10 * 60_000);
      this.timer.unref();
      return this.status(userId);
    } catch (error) { release(); this.release = undefined; throw error; }
  }
  private async finish(id: string, success: boolean, failure?: string) {
    if (!this.operation || this.operation.id !== id || !this.release) return;
    try {
      if (this.closed) { this.operation.phase = "interrupted"; this.operation.message = "服务已重启，请重新发起认证。"; }
      else if (this.cancelRequested) { this.operation.phase = "cancelled"; this.operation.message ??= this.operation.action === "use" ? "操作已取消，请刷新核对默认组织。已完成的切换或同步步骤不会回退。" : "已取消认证，原会话记录仍保留。"; }
      else if (!success) { this.operation.phase = "failed"; this.operation.message = failure ?? "ReClaude 登录未完成，可重新发起认证。"; }
      else {
        this.operation.phase = "verifying"; this.save();
        if (this.operation.action === "bind") this.bindings.addOrganization(this.operation.userId, this.operation.orgId);
        await this.bindings.refreshOrganization(this.operation.userId, this.operation.orgId);
        if (this.closed || this.cancelRequested) { this.operation.phase = this.closed ? "interrupted" : "cancelled"; }
        else {
          this.bindings.invalidateModels();
          await this.bindings.refreshModels(this.operation.userId);
          if (this.closed || this.cancelRequested) { this.operation.phase = this.closed ? "interrupted" : "cancelled"; return; }
          this.operation.phase = "completed";
          this.operation.message = this.operation.action === "use" ? `默认组织已切换${this.operation.syncHistory ? "，本机历史与记忆已同步" : ""}。已有网页会话继续沿用其原组织。` : this.operation.action === "bind" ? "组织绑定完成，可在模型菜单中选择。当前默认组织保持不变。" : "认证完成，向原会话发送新内容时将自动接续。";
          this.discovered = [];
        }
      }
    } catch (error) {
      this.operation.phase = "failed";
      // AppError messages are our fixed, public validation errors. Never
      // expose execFile errors, which include the client's raw output.
      this.operation.message = error instanceof AppError
        ? `组织 #${this.operation.orgId} 确认失败：${error.message}`
        : this.operation.action === "use" ? "客户端切换后，目标 Claude 身份尚未确认。请刷新核对当前默认组织后重试；已完成的切换或同步步骤不会回退。" : `客户端授权已结束，但目标组织 #${this.operation.orgId} 的 Claude 身份尚未确认，请刷新组织列表核对绑定后重试。`;
    } finally {
      delete this.operation.authorizationUrl;
      try { this.save(); } finally {
        clearTimeout(this.timer); clearTimeout(this.killTimer); this.child = undefined;
        this.release?.(); this.release = undefined;
      }
    }
  }
  private stopChild() {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const kill = (signal: NodeJS.Signals) => {
      try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid!, signal); } catch { /* Already exited. */ }
    };
    kill("SIGTERM");
    this.killTimer = setTimeout(() => kill("SIGKILL"), 5000); this.killTimer.unref();
  }
  cancel(userId: string, id: string): ReclaudeAuthorizationStatus {
    if (!this.operation || this.operation.id !== id || this.operation.userId !== userId) throw new AppError("runtime_forbidden", "认证请求不属于当前用户。");
    if (reclaudeAuthorizationPending(this.operation.phase)) { this.cancelRequested = true; this.stopChild(); }
    return this.status(userId);
  }
  close() {
    this.closed = true;
    if (this.release) this.stopChild();
  }
}
