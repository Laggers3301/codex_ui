import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import WebSocket from "ws";
import { expect, it } from "vitest";
import { createSessionCookie } from "./auth.js";
import { attachSocketServer } from "./socket.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { terminalSessionsFor } from "./terminalSessions.js";

function live(pid: number): boolean {
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(")")[1].trim()[0] !== "Z"; }
  catch { return false; }
}

for (const trigger of ["terminate", "disconnect", "invisible", "exec-failure"] as const) {
  it(`reaps detached terminal descendants after ${trigger} without touching another session`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-lifecycle-"));
    const store = new ProjectStore(path.join(root, "store.sqlite"));
    const project = store.createProject({ name: "terminal", rootPath: root });
    let process: ChildProcess | undefined, rejectExec: ((error: Error) => void) | undefined;
    const calls: string[] = [];
    const bridge = Object.assign(new EventEmitter(), {
      getPendingServerRequests: () => [],
      request: async (method: string, params: any) => {
        calls.push(method);
        if (method === "command/exec") return new Promise((resolve, reject) => {
          rejectExec = reject;
          process = spawn(params.command[0], params.command.slice(1), { detached: true, stdio: "ignore", cwd: params.cwd });
          process.once("error", reject); process.once("exit", () => resolve({ exitCode: 0 }));
        });
        if (method === "command/exec/terminate") process?.kill("SIGKILL");
        return {};
      }
    });
    const server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as any).port}/ws`;
    const connect = async () => {
      const ws = new WebSocket(url, { headers: { cookie: createSessionCookie("admin") } });
      const messages: any[] = [];
      ws.on("message", raw => messages.push(JSON.parse(String(raw))));
      await expect.poll(() => messages.some(message => message.type === "hello")).toBe(true);
      return { ws, messages };
    };
    const first = await connect(), other = await connect();
    const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const childFile = path.join(root, "detached-child");
    const command = ["/usr/bin/python3", "-c", `import os,signal,time\npid=os.fork()\nif pid==0:\n os.setsid()\n signal.signal(signal.SIGHUP,signal.SIG_IGN)\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n time.sleep(30)\nelse:\n open(${JSON.stringify(childFile)},'w').write(str(pid))\n time.sleep(30)`];
    let childPid = 0;
    try {
      first.ws.send(JSON.stringify({ type: "command.exec", requestId: "start", processId: "term-owned", projectId: project.id, command, disableTimeout: true }));
      await expect.poll(() => fs.existsSync(childFile)).toBe(true);
      childPid = Number(fs.readFileSync(childFile, "utf8"));
      other.ws.send(JSON.stringify({ type: "command.terminate", requestId: "foreign", processId: "term-owned" }));
      await expect.poll(() => other.messages.find(message => message.requestId === "foreign")?.ok).toBe(false);
      expect(live(childPid)).toBe(true);
      if (trigger === "disconnect") first.ws.terminate();
      else if (trigger === "exec-failure") rejectExec?.(new Error("fixture exec timeout"));
      else {
        if (trigger === "invisible") terminalSessionsFor(bridge).owners.delete("term-owned");
        first.ws.send(JSON.stringify({ type: trigger === "invisible" ? "command.write" : "command.terminate", requestId: "stop", processId: "term-owned", data: "ignored" }));
      }
      await expect.poll(() => live(childPid), { timeout: 7000 }).toBe(false);
      expect(calls).toContain("command/exec/terminate");
      expect(live(unrelated.pid!)).toBe(true);
    } finally {
      first.ws.terminate(); other.ws.terminate();
      await terminalSessionsFor(bridge).close();
      process?.kill("SIGKILL"); unrelated.kill("SIGKILL");
      if (childPid && live(childPid)) globalThis.process.kill(childPid, "SIGKILL");
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      store.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);
}
