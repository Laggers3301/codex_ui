import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const wrapper = fileURLToPath(new URL("../scripts/run-account-runtime.mjs", import.meta.url));
function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
}
describe("account runtime credential lease", () => {
  it("blocks a second owner, forwards shutdown, and releases the lease even with a surviving tool", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-lease-"));
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "SECRET-FIXTURE" }, last_refresh: "2026-10-01T00:00:00Z" }));
    const launch = () => spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--no-fork", "--conflict-exit-code", "75",
      path.join(home, ".web-runtime.lock"), process.execPath, wrapper, process.execPath, "-e",
      `const child=require('child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'}); console.log(child.pid); process.stdin.resume(); process.on('SIGTERM',()=>process.exit(0));`],
      { env: { ...process.env, CODEX_HOME: home } });
    let first: ChildProcess | undefined, third: ChildProcess | undefined;
    const tools: number[] = [];
    let diagnostics = "";
    const started = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", chunk => { tools.push(Number(String(chunk).trim())); resolve(); });
      child.once("error", reject);
    });
    try {
      first = launch(); first.stderr!.on("data", chunk => { diagnostics += chunk; });
      await started(first);
      const second = launch();
      expect(await exited(second)).toBe(75);
      fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "NEW-SECRET-FIXTURE" }, last_refresh: "2026-10-01T00:01:00Z" }));
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(diagnostics).toContain("credentials_changed");
      expect(diagnostics).not.toContain("SECRET-FIXTURE");
      const stopped = exited(first); first.kill("SIGTERM");
      expect(await stopped).toBe(0);
      // The orphaned tool is still alive; it must not retain the OAuth lease.
      expect(() => process.kill(tools[0], 0)).not.toThrow();
      third = launch(); await started(third);
      const finished = exited(third); third.kill("SIGTERM"); await finished;
    } finally {
      first?.kill("SIGKILL"); third?.kill("SIGKILL");
      for (const pid of tools) { if (Number.isInteger(pid) && pid > 1) try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
