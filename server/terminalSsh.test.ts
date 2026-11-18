import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { expect, it } from "vitest";
import { terminalCommand } from "./terminalSessions.js";

const sshd = "/usr/sbin/sshd";
function live(pid: number) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(")")[1].trim()[0] !== "Z"; }
  catch { return false; }
}

it.skipIf(!fs.existsSync(sshd))("disconnects an isolated SSH session and kills its remote detached child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-ssh-"));
  const key = path.join(root, "fixture-key"), pidFile = path.join(root, "remote-child");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const config = path.join(root, "sshd.conf");
  fs.writeFileSync(config, `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${key}\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${os.userInfo().username}\nLogLevel ERROR\n`);
  const server = spawn(sshd, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; server.stderr.on("data", chunk => { errors += chunk; });
  const child = "import os,signal,time; pid=os.fork(); " + `open(${JSON.stringify(pidFile)},'w').write(str(pid)) if pid else None; ` + "os.setsid() if not pid else None; signal.signal(signal.SIGHUP,signal.SIG_IGN); signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)";
  const remoteCommand = `/usr/bin/python3 -c '${child.replaceAll("'", "'\\''")}'`;
  const command = terminalCommand(["ssh", "-T", "-F", "/dev/null", "-i", key, "-p", String(port), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", `${os.userInfo().username}@127.0.0.1`, remoteCommand]);
  let terminal: ReturnType<typeof spawn> | undefined, childPid = 0;
  try {
    await expect.poll(async () => {
      if (server.exitCode !== null) throw new Error(errors);
      return new Promise<boolean>(resolve => { const socket = net.connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); });
    }).toBe(true);
    terminal = spawn(command[0], command.slice(1), { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    terminal.stderr?.on("data", chunk => { errors += chunk; });
    await expect.poll(() => { if (terminal?.exitCode !== null) throw new Error(errors); return fs.existsSync(pidFile); }, { timeout: 6000 }).toBe(true);
    childPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(live(childPid)).toBe(true);
    terminal.kill("SIGKILL");
    await expect.poll(() => live(childPid), { timeout: 7000 }).toBe(false);
  } finally {
    terminal?.kill("SIGKILL"); server.kill("SIGTERM");
    if (childPid && live(childPid)) process.kill(childPid, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
