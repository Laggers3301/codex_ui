import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

interface Transport { request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>; }
interface Session { id: string; userId: string; socket: WebSocket; stopping?: Promise<unknown>; cleanupFailed?: boolean; finished?: boolean; }
const reaper = fs.readFileSync(new URL("../scripts/terminal-session.py", import.meta.url), "utf8");
const sshProxy = `REAPER_SOURCE = ${JSON.stringify(reaper)}\n${fs.readFileSync(new URL("../scripts/terminal-ssh.py", import.meta.url), "utf8")}`;

export function terminalCommand(command: string[]): string[] {
  return ["/usr/bin/python3", "-c", reaper, randomUUID(), sshProxy, ...command];
}

/** Keep cleanup authority until termination is attempted, even if the long
 * command/exec promise fails or its browser-facing ownership entry is lost. */
export class TerminalSessions {
  readonly owners = new Map<string, string>();
  private sessions = new Map<string, Session>();
  constructor(private bridge: Transport) {}

  async execute(id: string, userId: string, socket: WebSocket, params: Record<string, unknown>, timeout: number): Promise<unknown> {
    if (this.sessions.has(id)) throw new Error("终端标识已被使用，请重新打开终端。");
    const session: Session = { id, userId, socket };
    this.sessions.set(id, session);
    this.owners.set(id, userId);
    try { return await this.bridge.request("command/exec", params, timeout); }
    catch (error) { await this.stop(session); throw error; }
    finally {
      // stop() may still be waiting for its native acknowledgement after exec
      // settles. Do not let a duplicate id replace this cleanup operation.
      if (session.stopping) await session.stopping.catch(() => {});
      session.finished = true;
      if (!session.cleanupFailed) this.forget(session);
    }
  }

  private owned(id: string, userId: string, socket: WebSocket): Session {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId || session.socket !== socket) throw new Error("Process is not visible for this logged-in user.");
    return session;
  }

  async control(id: string, userId: string, socket: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
    const session = this.owned(id, userId, socket);
    if (this.owners.get(id) !== userId || session.stopping) {
      await this.stop(session);
      throw new Error("终端已失去控制，已请求停止其子进程，请重新打开终端。");
    }
    try { return await this.bridge.request(method, { ...params, processId: id }, 10_000); }
    catch (error) { await this.stop(session); throw error; }
  }

  async terminate(id: string, userId: string, socket: WebSocket): Promise<unknown> {
    if (!this.sessions.has(id)) return { alreadyStopped: true };
    return this.stop(this.owned(id, userId, socket));
  }

  private stop(session: Session): Promise<unknown> {
    session.cleanupFailed = false;
    return session.stopping ??= this.bridge.request("command/exec/terminate", { processId: session.id }, 10_000)
      .then(result => { if (session.finished) this.forget(session); return result; })
      .catch(error => {
        // The independent reaper still owns descendants if the native runtime
        // itself exited. Never reroute a lost process id to another account.
        console.warn("Terminal cleanup acknowledgement unavailable", { processId: session.id });
        session.cleanupFailed = true;
        session.stopping = undefined;
        throw error;
      });
  }

  private forget(session: Session): void {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id); this.owners.delete(session.id);
  }

  sweep(userDeleted: (userId: string) => boolean = () => false): void {
    for (const session of this.sessions.values()) {
      if (session.cleanupFailed || session.socket.readyState !== session.socket.OPEN || this.owners.get(session.id) !== session.userId || userDeleted(session.userId)) {
        void this.stop(session).catch(() => {});
      }
    }
  }
  closeSocket(socket: WebSocket): void {
    for (const session of this.sessions.values()) if (session.socket === socket) void this.stop(session).catch(() => {});
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map(session => this.stop(session)));
  }
}

const registries = new WeakMap<object, TerminalSessions>();
export function terminalSessionsFor(bridge: Transport): TerminalSessions {
  let registry = registries.get(bridge);
  if (!registry) { registry = new TerminalSessions(bridge); registries.set(bridge, registry); }
  return registry;
}
