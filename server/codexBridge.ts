import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { serverConfig } from "./config.js";
import type { RpcEnvelope } from "./types.js";
import { AppError } from "./appErrors.js";
import {authDiagnostic} from "./authDiagnostics.js";

/**
 * The process used as the JSON-RPC transport for a Codex app-server.
 *
 * `command` and `args` are deliberately kept separate.  Callers that need a
 * remote app-server can therefore launch `ssh` without constructing a shell
 * command string.
 */
export interface CodexBridgeLaunchOptions {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  scope?: {
    unitPrefix: string;
    slice: string;
    memoryHigh: string;
    memoryMax: string;
    memorySwapMax: string;
  };
}

/** Keep agent tools outside the web backend's cgroup, with a per-account cap. */
export function codexProcessCommand(launch: CodexBridgeLaunchOptions, nonce = randomUUID().slice(0, 8)):
  { command: string; args: string[] } {
  if (!launch.scope) return { command: launch.command, args: [...launch.args] };
  const { unitPrefix, slice, memoryHigh, memoryMax, memorySwapMax } = launch.scope;
  if (!/^[A-Za-z0-9-]+$/.test(unitPrefix) || !/^[A-Za-z0-9-]+\.slice$/.test(slice)) {
    throw new Error("Invalid Codex resource scope name.");
  }
  return {
    command: "/usr/bin/systemd-run",
    args: [
      "--user", "--scope", "--collect", "--quiet",
      `--slice=${slice}`, `--unit=${unitPrefix}-${nonce}`,
      "-p", `MemoryHigh=${memoryHigh}`,
      "-p", `MemoryMax=${memoryMax}`,
      "-p", `MemorySwapMax=${memorySwapMax}`,
      "--", launch.command, ...launch.args
    ]
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

interface ServerRequestRecord {
  id: number | string;
  method: string;
  params: unknown;
  receivedAt: string;
}

export function classifyRpcEnvelope(message: RpcEnvelope): "response" | "serverRequest" | "notification" {
  if (message.id !== undefined && !message.method) {
    return "response";
  }
  if (message.id !== undefined && message.method) {
    return "serverRequest";
  }
  return "notification";
}

/** A reclaim/throttle watermark is not an allocation ceiling. Debounce transient
 * tool allocations before interrupting work, without disabling the hard cap. */
export function memoryPressureWindow(headroom: number | null, since: number | null, now: number):
  { since: number | null; pause: boolean } {
  if (headroom === null || headroom >= 256 * 1024 * 1024) return { since: null, pause: false };
  const started = since ?? now;
  return { since: started, pause: now - started >= 30_000 };
}

export class CodexBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private serverRequests = new Map<number | string, ServerRequestRecord>();
  private readyPromise: Promise<void> | null = null;
  private restarting = false;
  private stopped = false;
  private resourceMonitor: ReturnType<typeof setInterval> | null = null;
  private pressureReported = false;
  private lowMemorySince: number | null = null;

  constructor(private readonly launch: CodexBridgeLaunchOptions = {
    command: serverConfig.codexBin,
    args: ["app-server", "--listen", "stdio://"],
    env: process.env
  }) {
    super();
  }

  start(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.stopped = false;
    this.readyPromise = this.spawnServer();
    return this.readyPromise;
  }

  stop(): void {
    if (this.resourceMonitor) clearInterval(this.resourceMonitor);
    this.resourceMonitor = null;
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }

  /** Stop the owned app-server and wait until it can no longer write rollouts. */
  async stopAndWait(timeoutMs = 10_000): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.stop();
      return;
    }
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    this.stop();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Codex app-server did not stop before the rollback timeout.")), timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    await this.start();
    if (["turn/start", "thread/start", "thread/queue/start", "thread/queue/add"].includes(method)) {
      const headroom = this.getMemoryHeadroom();
      if (headroom !== null && headroom < 512 * 1024 * 1024) throw new AppError("memory_pressure", "运行资源不足，暂时无法开始新任务。", "memory_pressure: 运行时可用内存不足 512 MiB，已阻止新增任务。");
    }
    return this.sendRequest(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  respondToServerRequest(id: number | string, result: unknown): void {
    if (!this.serverRequests.has(id)) {
      throw new Error(`Unknown Codex server request: ${id}`);
    }
    this.write({ id, result });
    this.serverRequests.delete(id);
  }

  rejectServerRequest(id: number | string, message: string): void {
    if (!this.serverRequests.has(id)) {
      throw new Error(`Unknown Codex server request: ${id}`);
    }
    this.serverRequests.delete(id);
    this.write({ id, error: { code: -32000, message } });
  }

  getPendingServerRequests(): ServerRequestRecord[] {
    return Array.from(this.serverRequests.values());
  }

  /** Budget of the owned account scope, including its active tools/children. */
  getMemoryHeadroom(): number | null {
    if (!this.launch.scope || !this.proc?.pid) return null;
    try {
      const relative = fs.readFileSync(`/proc/${this.proc.pid}/cgroup`, "utf8")
        .split("\n").find(line => line.startsWith("0::"))?.slice(3);
      if (!relative || !relative.includes(`/${this.launch.scope.unitPrefix}-`)) return 0;
      const directory = path.join("/sys/fs/cgroup", relative);
      const budgets: number[] = [];
      for (const group of [directory, path.dirname(directory)]) {
        // memory.high throttles/reclaims; it is NOT the available-memory ceiling.
        // Counting it as a hard limit prematurely stops healthy tools while Linux
        // is still reclaiming cache, even with a full GiB left below memory.max.
        const limits = ["memory.max"].map(file => fs.readFileSync(path.join(group, file), "utf8").trim()).filter(value => value !== "max").map(Number);
        if (!limits.length) continue;
        const current = Number(fs.readFileSync(path.join(group, "memory.current"), "utf8").trim());
        const stats = fs.readFileSync(path.join(group, "memory.stat"), "utf8");
        const inactive = Number(stats.match(/^inactive_file (\d+)/m)?.[1] ?? 0);
        const dirty = Number(stats.match(/^file_dirty (\d+)/m)?.[1] ?? 0) + Number(stats.match(/^file_writeback (\d+)/m)?.[1] ?? 0);
        budgets.push(Math.max(0, Math.min(...limits) - current + Math.min(current, Math.max(0, inactive - dirty))));
      }
      return budgets.length ? Math.min(...budgets) : null;
    } catch { return 0; } // Fail closed instead of risking a shared runtime OOM.
  }

  private async spawnServer(): Promise<void> {
    const command = codexProcessCommand(this.launch);
    const runtimeEnvironment = { ...(this.launch.env ?? process.env) };
    // OAuth app credentials belong to the web backend, never to agent shells.
    for (const key of Object.keys(runtimeEnvironment)) if (key.startsWith("FEISHU_")) delete runtimeEnvironment[key];
    this.proc = spawn(command.command, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: runtimeEnvironment,
      shell: false
    });

    const proc = this.proc;
    const rl = readline.createInterface({ input: proc.stdout });

    rl.on("line", (line) => {
      this.handleLine(line);
    });

    proc.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    proc.on("error", (error) => {
      // An unavailable executable (or an SSH startup failure) must surface to
      // this bridge only.  In particular, it must never cause a caller to
      // switch to another bridge or terminate the Node process via an
      // unhandled ChildProcess error event.
      this.emit("errorEvent", error.message);
    });

    proc.on("exit", (code, signal) => {
      if (this.resourceMonitor) clearInterval(this.resourceMonitor);
      this.resourceMonitor = null;
      this.emit("status", { state: "exited", code, signal });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Codex app-server exited while waiting for ${pending.method}.`));
      }
      this.pending.clear();
      this.proc = null;
      this.readyPromise = null;
      if (!this.stopped) {
        this.scheduleRestart();
      }
    });

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "codex_web_console",
        title: "Codex Web Console",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized", {});
    this.emit("status", { state: "ready" });
    if (this.launch.scope) {
      this.pressureReported = false;
      this.lowMemorySince = null;
      this.resourceMonitor = setInterval(() => {
        const headroom = this.getMemoryHeadroom();
        const pressure = memoryPressureWindow(headroom, this.lowMemorySince, Date.now());
        this.lowMemorySince = pressure.since;
        if (pressure.pause && !this.pressureReported) {
          this.pressureReported = true;
          console.warn("[memory.pressure.pause]", JSON.stringify({ scope: this.launch.scope?.unitPrefix, headroomBytes: headroom, lowSince: this.lowMemorySince }));
          this.emit("status", { state: "resource_pressure", message: "memory_pressure: 任务内存硬限额余量持续 30 秒低于 256 MiB，正在请求安全暂停当前轮次。" });
        } else if (headroom === null || headroom > 512 * 1024 * 1024) this.pressureReported = false;
      }, 5000);
      this.resourceMonitor.unref?.();
    }
  }

  private scheduleRestart(): void {
    if (this.restarting) {
      return;
    }
    this.restarting = true;
    setTimeout(() => {
      this.restarting = false;
      void this.start().catch((error) => {
        this.emit("errorEvent", String(error instanceof Error ? error.message : error));
      });
    }, 1_000);
  }

  private sendRequest(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++;
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.reject(new Error(`Timed out waiting for Codex response to ${method}.`));
      }
    }, timeoutMs);

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, timer });
    });

    this.write({ id, method, params });
    return promise;
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: RpcEnvelope;
    try {
      message = JSON.parse(line) as RpcEnvelope;
    } catch {
      this.emit("stderr", `Non-JSON app-server output: ${line}`);
      return;
    }

    // Malformed provider/native envelopes are not process-fatal and must not
    // be interpreted as notifications or reflected into public error text.
    if (!message || typeof message !== "object" || Array.isArray(message)
      || (message.method !== undefined && typeof message.method !== "string")
      || (message.id !== undefined && typeof message.id !== "number" && typeof message.id !== "string")
      || (message.method === undefined && message.id === undefined)) {
      this.emit("stderr", "Ignored malformed app-server envelope");
      return;
    }

    const kind = classifyRpcEnvelope(message);

    if (kind === "response") {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) {
        this.emit("notification", { method: "unmatchedResponse", params: message });
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        const error=new Error(message.error.message);
        if(["account/read","account/rateLimits/read","account/usage/read","account/login/start"].includes(pending.method)){
          const safe=authDiagnostic("transport","health_verify","failure",message.error);
          // Retain only explicitly allowed error context, not data/headers/body.
          Object.defineProperties(error,{httpStatus:{value:safe.httpStatus},requestId:{value:safe.requestId},authCode:{value:safe.code}});
        }
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (kind === "serverRequest" && message.method !== undefined && message.id !== undefined) {
      const record: ServerRequestRecord = {
        id: message.id,
        method: message.method,
        params: message.params,
        receivedAt: new Date().toISOString()
      };
      this.serverRequests.set(message.id, record);
      this.emit("serverRequest", record);
      return;
    }

    if (message.method === "serverRequest/resolved") {
      const requestId = (message.params as { requestId?: number | string } | null)?.requestId;
      if (requestId !== undefined) this.serverRequests.delete(requestId);
    }
    this.emit("notification", message);
  }

  private write(message: RpcEnvelope): void {
    if (!this.proc?.stdin.writable) {
      throw new Error("Codex app-server is not running.");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
