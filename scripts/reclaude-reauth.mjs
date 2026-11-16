import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function authorizationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["reclaude.ai", "www.recode.cat"].includes(url.hostname) || url.port || url.username || url.password
      || url.pathname !== "/cli/auth" || !url.searchParams.get("state")
      || [...url.searchParams.keys()].some(key => /token|secret|device_code|api.?key/i.test(key))) return null;
    return url.toString();
  } catch { return null; }
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const missingBinding = value => /(?:本机还没有绑定|未绑定组织|没有.*绑定|no (?:local )?binding|not bound|binding.*not found)/i.test(value);

/** Only the client handles credentials. Its raw stdout/stderr is never exposed
 * to the web application: this adapter emits phases and one validated URL. */
export async function reauthenticate({ client, home, orgId, signal, action = "reauthenticate" }, emit) {
  if (!path.isAbsolute(client) || !path.isAbsolute(home) || !/^[0-9]+$/.test(orgId) || !["reauthenticate", "bind"].includes(action)) throw new Error("invalid_configuration");
  await fs.access(client, fs.constants.X_OK);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reclaude-browser-"));
  const captureFile = path.join(temporary, "authorization-url");
  const helper = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --capture-browser-file ${quote(captureFile)} "$@"\n`;
  for (const name of ["xdg-open", "open"]) await fs.writeFile(path.join(temporary, name), helper, { mode: 0o700 });
  const env = { ...process.env, HOME: home, RECLAUDE_ORG: orgId, CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
    BROWSER: path.join(temporary, "xdg-open"), PATH: temporary + path.delimiter + (process.env.PATH ?? "") };
  delete env.CLAUDE_CONFIG_DIR;
  const seen = new Set();
  const publishUrl = value => {
    const url = authorizationUrl(value);
    if (url && !seen.has(url) && !signal?.aborted) { seen.add(url); emit({ type: "authorization", url }); }
  };
  const run = (args, login) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const child = spawn(client, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "", killTimer;
    // Native browser openers may discard the helper's stdout. A private file
    // also delivers the URL while the login client waits for device approval.
    const capture = () => { try { publishUrl(readFileSync(captureFile, "utf8").trim()); } catch { /* Not opened yet. */ } };
    const captureTimer = login ? setInterval(capture, 100) : undefined;
    captureTimer?.unref();
    const buffers = { stdout: "", stderr: "" };
    const abort = () => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); killTimer.unref(); };
    const receive = (chunk, stream) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, "");
      tail = (tail + text).slice(-65536);
      if (!login) return;
      buffers[stream] = (buffers[stream] + text).slice(-65536);
      const lines = buffers[stream].split(/[\r\n]/); buffers[stream] = lines.pop() ?? "";
      for (const line of lines) for (const raw of line.match(/https:\/\/(?:reclaude\.ai|www\.recode\.cat)\/cli\/auth\?[^\s<>"']+/g) ?? []) {
        publishUrl(raw.replace(/[),，。]+$/, ""));
      }
    };
    child.stdout.on("data", chunk => receive(chunk, "stdout")); child.stderr.on("data", chunk => receive(chunk, "stderr"));
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(killTimer); clearInterval(captureTimer); signal?.removeEventListener("abort", abort); };
    child.once("error", () => { cleanup(); reject(new Error("client_start_failed")); });
    child.once("close", code => {
      if (login) capture();
      cleanup();
      if (signal?.aborted) return reject(new Error("cancelled"));
      resolve({ ok: code === 0, missingBinding: missingBinding(tail) });
    });
  });
  try {
    if (action === "bind") {
      emit({ type: "phase", phase: "binding" });
      const binding = await run(["org", "bind", orgId], true);
      if (!binding.ok) throw new Error("bind_failed");
      emit({ type: "phase", phase: "verifying" });
      return;
    }
    emit({ type: "phase", phase: "logging_out" });
    const logout = await run(["logout", "--org", orgId], false);
    if (!logout.ok && !logout.missingBinding) throw new Error("logout_failed");
    emit({ type: "phase", phase: "waiting_authorization" });
    let login = await run(["login", "--org", orgId], true);
    // Some CLI releases remove the local organization entry on logout. Bind
    // that same organization via the documented device flow, never another.
    if (!login.ok && login.missingBinding) login = await run(["org", "bind", orgId], true);
    if (!login.ok) throw new Error("login_failed");
    emit({ type: "phase", phase: "verifying" });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (["--capture-browser", "--capture-browser-file"].includes(process.argv[2])) {
    const captureFile = process.argv[2] === "--capture-browser-file" ? process.argv[3] : null;
    const url = process.argv.slice(captureFile ? 4 : 3).map(authorizationUrl).find(Boolean);
    if (url) {
      if (captureFile) await fs.writeFile(captureFile, url + "\n", { mode: 0o600 });
      process.stdout.write(url + "\n");
    }
    else process.exitCode = 1;
  } else if (process.argv.includes("--help")) {
    process.stdout.write("node scripts/reclaude-reauth.mjs --client /absolute/reclaude --home /absolute/home --org ORGANIZATION_ID\n");
  } else {
    const read = key => process.argv[process.argv.indexOf(key) + 1];
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    const timeout = setTimeout(stop, 10 * 60_000);
    reauthenticate({ client: read("--client"), home: read("--home"), orgId: read("--org"), action: process.argv.includes("--action") ? read("--action") : "reauthenticate", signal: controller.signal },
      event => process.stdout.write(JSON.stringify(event) + "\n"))
      .then(() => process.stdout.write(JSON.stringify({ type: "complete" }) + "\n"))
      .catch(error => { process.stdout.write(JSON.stringify({ type: "failed", code: error.message }) + "\n"); process.exitCode = 1; })
      .finally(() => { clearTimeout(timeout); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); });
  }
}
