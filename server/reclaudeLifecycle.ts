import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./appErrors.js";

interface Lease { pid: number; start: string; nonce: string; }
function processStart(pid: number): string {
  try { const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]; }
  catch { return ""; }
}
function live(lease: Lease): boolean {
  if (!Number.isInteger(lease.pid) || lease.pid < 1 || typeof lease.nonce !== "string") return true;
  try { process.kill(lease.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  return !lease.start || !processStart(lease.pid) || processStart(lease.pid) === lease.start;
}

/** A machine-wide handshake: auth takes the exclusive lock before checking
 * runtime leases; new work checks that lock before and after taking a lease. */
export class ReclaudeLifecycle {
  readonly directory: string;
  private readonly authFile: string;
  private readonly runs: string;
  constructor(home: string) {
    this.directory = path.join(home, ".rec", "codex-web-lifecycle");
    this.runs = path.join(this.directory, "runs");
    this.authFile = path.join(this.directory, "authorization.json");
    fs.mkdirSync(this.runs, { recursive: true, mode: 0o700 });
  }
  private read(file: string): Lease | null {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Lease;
      if (live(value)) return value;
      fs.unlinkSync(file); return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError("reclaude_lifecycle_unavailable", "ReClaude 的登录协调记录暂不可读，请稍后重试。");
    }
  }
  assertAvailable(): void {
    if (this.read(this.authFile)) throw new AppError("reclaude_reauth_in_progress", "ReClaude 正在重新认证，完成后可继续原会话。");
  }
  private acquire(file: string): () => void {
    const lease = { pid: process.pid, start: processStart(process.pid), nonce: randomUUID() };
    fs.writeFileSync(file, JSON.stringify(lease), { flag: "wx", mode: 0o600 });
    return () => {
      try { if (JSON.parse(fs.readFileSync(file, "utf8")).nonce === lease.nonce) fs.unlinkSync(file); }
      catch { /* A release must not erase a different owner's lease. */ }
    };
  }
  acquireRun(): () => void {
    this.assertAvailable();
    const release = this.acquire(path.join(this.runs, `${process.pid}-${randomUUID()}.json`));
    try { this.assertAvailable(); return release; } catch (error) { release(); throw error; }
  }
  acquireAuthorization(): () => void {
    this.assertAvailable();
    let release: () => void;
    try { release = this.acquire(this.authFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AppError("reclaude_reauth_in_progress", "已有 ReClaude 认证正在进行。");
      throw error;
    }
    try {
      if (fs.readdirSync(this.runs).some(name => this.read(path.join(this.runs, name)))) {
        throw new AppError("reclaude_account_busy", "有 Claude 会话正在执行或迁移，请在任务结束后重新认证。");
      }
      return release;
    } catch (error) { release(); throw error; }
  }
}
