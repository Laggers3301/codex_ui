import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexBridge } from "./codexBridge.js";

const binary = path.resolve(process.cwd(), "../bin/codex-0.156.0/codex");
describe.skipIf(!((await fs.stat(binary).catch(() => null))?.isFile()))("native PTY terminal", () => {
  it("streams output and accepts input and resize in a temporary home", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-terminal-test-"));
    const home = path.join(temporary, "home");
    const cwd = path.join(temporary, "project");
    await fs.mkdir(home); await fs.mkdir(cwd);
    const bridge = new CodexBridge({ command: binary, args: ["app-server", "--listen", "stdio://"], env: { ...process.env, CODEX_HOME: home } });
    let output = "";
    try {
      await bridge.start();
      bridge.on("notification", (message: { method?: string; params?: { processId?: string; deltaBase64?: string } }) => {
        if (message.method === "command/exec/outputDelta" && message.params?.processId === "pty-test" && message.params.deltaBase64) {
          output += Buffer.from(message.params.deltaBase64, "base64").toString("utf8");
        }
      });
      const command = bridge.request("command/exec", {
        command: ["/bin/bash", "-lc", "printf READY; read -r answer; printf 'GOT:%s' \"$answer\""],
        processId: "pty-test", tty: true, streamStdin: true, streamStdoutStderr: true,
        cwd, size: { cols: 80, rows: 20 }, sandboxPolicy: { type: "dangerFullAccess" }, disableTimeout: true
      }, 30_000);
      await expect.poll(() => output, { timeout: 10_000 }).toContain("READY");
      await bridge.request("command/exec/resize", { processId: "pty-test", size: { cols: 90, rows: 25 } }, 10_000);
      await bridge.request("command/exec/write", { processId: "pty-test", deltaBase64: Buffer.from("hello\n").toString("base64") }, 10_000);
      await command;
      expect(output).toContain("GOT:hello");
    } finally { bridge.stop(); await new Promise(resolve => setTimeout(resolve, 150)); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 40_000);
});
