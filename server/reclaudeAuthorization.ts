import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppError } from "./appErrors.js";
import type { ClaudeBindings, ClaudeIntegrationConfig } from "./claudeBindings.js";
import { ReclaudeLifecycle } from "./reclaudeLifecycle.js";
import { reclaudeAuthorizationPending, reclaudeAuthorizationUrl, type ReclaudeAuthorizationOperation, type ReclaudeAuthorizationStatus } from "../shared/reclaudeAuthorization.js";

interface Operation extends Omit<ReclaudeAuthorizationOperation, "owned"> { userId: string; }
const messages: Record<string, string> = {
  logout_failed: "未能按组织退出登录，请检查 ReClaude 客户端版本后重试。",
  login_failed: "ReClaude 登录未完成，可重新发起认证。",
  client_start_failed: "ReClaude 登录程序未能启动。",
  invalid_configuration: "ReClaude 登录程序尚未正确配置。"
};

export class ReclaudeAuthorization {
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
  status(userId: string): ReclaudeAuthorizationStatus {
    const bindings = this.bindings.list(userId), ids = this.bindings.orgIds(userId);
    const operation = this.operation;
    const visible = operation && ids.includes(operation.orgId);
    const owned = operation?.userId === userId;
    return {
      enabled: !!this.config.reclaudeExecutable,
      organizations: [...new Set(ids)].filter(id => /^[0-9]+$/.test(id)).map(orgId => {
        const binding = bindings.find(binding => binding.orgId === orgId);
        return { orgId, label: binding?.label ?? `组织 ${orgId}`, connected: !!binding };
      }),
      operation: visible ? { id: operation.id, orgId: operation.orgId, phase: operation.phase, startedAt: operation.startedAt,
        expiresAt: operation.expiresAt, owned, ...(owned && operation.authorizationUrl ? { authorizationUrl: operation.authorizationUrl } : {}),
        ...(operation.message ? { message: owned ? operation.message : "共享账号的认证状态已更新。" } : {}) } : null
    };
  }
  start(userId: string, orgId: string, requestId: string): ReclaudeAuthorizationStatus {
    if (this.closed) throw new AppError("runtime_not_connected", "ReClaude 正在关闭，请稍后重试。");
    if (!/^[0-9]+$/.test(orgId) || !this.bindings.orgIds(userId).includes(orgId)) throw new AppError("runtime_forbidden", "无法重新认证此组织。");
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new AppError("invalid_request", "重新认证请求缺少有效标识。");
    if (this.operation?.id === requestId) {
      if (this.operation.userId !== userId) throw new AppError("runtime_forbidden", "认证请求不属于当前用户。");
      return this.status(userId);
    }
    if (this.operation && reclaudeAuthorizationPending(this.operation.phase)) {
      if (this.operation.userId === userId && this.operation.orgId === orgId) return this.status(userId);
      throw new AppError("reclaude_reauth_in_progress", "共享账号已有认证正在进行，请等待完成。");
    }
    const client = this.config.reclaudeExecutable;
    if (!client || !path.isAbsolute(client)) throw new AppError("runtime_not_connected", "尚未启用 ReClaude 网页认证。");
    fs.accessSync(client, fs.constants.X_OK);
    const release = this.lifecycle.acquireAuthorization();
    try {
      this.snapshotHistory(orgId);
      const now = Date.now();
      this.operation = { id: requestId, orgId, userId, phase: "starting", startedAt: now, expiresAt: now + 10 * 60_000 };
      this.cancelRequested = false; this.release = release; this.save();
      const script = fileURLToPath(new URL("../scripts/reclaude-reauth.mjs", import.meta.url));
      const child = spawn(process.execPath, [script, "--client", client, "--home", this.config.home, "--org", orgId],
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
            if (event.type === "phase" && ["logging_out", "waiting_authorization", "verifying"].includes(event.phase)) this.operation.phase = event.phase;
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
      else if (this.cancelRequested) { this.operation.phase = "cancelled"; this.operation.message ??= "已取消认证，原会话记录仍保留。"; }
      else if (!success) { this.operation.phase = "failed"; this.operation.message = failure ?? "ReClaude 登录未完成，可重新发起认证。"; }
      else {
        this.operation.phase = "verifying"; this.save();
        await this.bindings.refreshOrganization(this.operation.userId, this.operation.orgId);
        if (this.closed || this.cancelRequested) { this.operation.phase = this.closed ? "interrupted" : "cancelled"; }
        else {
          this.bindings.invalidateModels();
          await this.bindings.refreshModels(this.operation.userId);
          if (this.closed || this.cancelRequested) { this.operation.phase = this.closed ? "interrupted" : "cancelled"; return; }
          this.operation.phase = "completed";
          this.operation.message = "认证完成，向原会话发送新内容时将自动接续。";
        }
      }
    } catch {
      this.operation.phase = "failed"; this.operation.message = "客户端登录结束，但新的组织或 Claude 身份尚未确认，请重试。";
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
