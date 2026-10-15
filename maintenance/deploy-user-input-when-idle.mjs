import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publishDist } from "../scripts/publish-dist.mjs";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const execute = promisify(execFile);
const WebSocket = createRequire(path.join(root, "package.json"))("ws");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function treeHash(directory, accept = () => true) {
  const hash = createHash("sha256");
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && accept(file)) hash.update(path.relative(directory, file)).update("\0").update(fs.readFileSync(file)).update("\0");
    }
  };
  walk(directory);
  return hash.digest("hex");
}

export function deploymentSourceHash() {
  const hash = createHash("sha256");
  hash.update(treeHash(path.join(root, "server"), file => file.endsWith(".ts") && !file.includes(".test.")));
  hash.update(treeHash(path.join(root, "src"), file => /\.(tsx?|css)$/.test(file) && !file.includes(".test.")));
  for (const file of [script, path.join(root, "scripts/publish-dist.mjs"), path.join(root, "scripts/publish-ui-update.cjs")]) hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

export function idleDecision(snapshots, health, pool, staleAllowance = 0) {
  const unknown = snapshots.filter(snapshot => !snapshot || snapshot.unknown).length;
  const active = snapshots.reduce((n, snapshot) => n + (snapshot?.active?.filter(turn => turn.status === "running").length ?? 0), 0);
  const visiblePending = snapshots.reduce((n, snapshot) => n + (snapshot?.pending?.length ?? 0), 0);
  const pendingRetries = snapshots.reduce((n, snapshot) => n + (snapshot?.recoveries?.filter(state => ["waiting", "running"].includes(state.job?.status)).length ?? 0), 0);
  const totalPending = health?.codexPendingApprovals;
  const inFlight = Array.isArray(pool?.accounts) ? pool.accounts.reduce((n, account) => n + (Number.isInteger(account.activeRequests) ? account.activeRequests : 1), 0) : 1;
  return { unknown, active, visiblePending, pendingRetries, totalPending, inFlight,
    idle: snapshots.length > 0 && unknown === 0 && active === 0 && visiblePending === 0 && pendingRetries === 0 && inFlight === 0
      && Number.isInteger(totalPending) && totalPending >= 0 && totalPending <= staleAllowance };
}

export async function waitForQuiet(observe, onState, { pause = sleep, now = Date.now, pollMs = 30_000, quietMs = 60_000 } = {}) {
  let quietSince = null;
  for (;;) {
    const state = await observe();
    if (!state.idle) quietSince = null;
    else quietSince ??= now();
    onState(state, quietSince === null ? "waiting_for_idle" : "verifying_quiet_window");
    if (quietSince !== null && now() - quietSince >= quietMs) {
      const confirmed = await observe();
      if (confirmed.idle) return confirmed;
      quietSince = null;
      onState(confirmed, "waiting_for_idle");
    }
    await pause(pollMs);
  }
}

function report(manifest, stage, details = {}) {
  let previous; try { previous = JSON.parse(fs.readFileSync(manifest.report, "utf8")); } catch { /* First report. */ }
  const value = { version: manifest.version, stage, at: new Date().toISOString(),
    ...(previous?.version === manifest.version && previous.deployed ? { deployed: true } : {}), ...details };
  const temporary = manifest.report + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, manifest.report);
  console.log(JSON.stringify(value));
}

function cookieFor(user) {
  const value = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 600_000 })).toString("base64url");
  const secret = fs.readFileSync(path.join(root, "data/auth/session-secret"), "utf8").trim();
  return `codex_remote_session_4575=${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`;
}

function socketRequest(user, request, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:4576/ws", { headers: { cookie: cookieFor(user) } });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("运行状态查询超时")), timeoutMs);
    socket.on("error", error => finish(error));
    socket.on("message", raw => {
      let message; try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === "hello") {
        if (!request) finish(null, { active: message.data?.liveState?.activeTurns ?? [], pending: message.data?.pendingServerRequests ?? [], recoveries: message.data?.turnRecoveries ?? [] });
        else socket.send(JSON.stringify(request));
      } else if (request && message.type === "ack" && message.requestId === request.requestId) {
        finish(message.ok ? null : new Error(message.error ?? "会话恢复请求未被接受"), message.data);
      }
    });
  });
}

async function readApi(user, route) {
  const response = await fetch(`http://127.0.0.1:4576${route}`, { headers: { cookie: cookieFor(user) }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`运行状态接口 HTTP ${response.status}`);
  return response.json();
}

function targetRevision(manifest) {
  const db = new DatabaseSync(manifest.target.stateDb, { readOnly: true });
  try { return db.prepare("SELECT updated_at_ms,archived FROM threads WHERE id=?").get(manifest.target.threadId); }
  finally { db.close(); }
}

async function observe(manifest) {
  if (deploymentSourceHash() !== manifest.sourceHash) throw new Error("待上线源码已改变，本次更新暂缓；没有重启服务。");
  const db = new DatabaseSync(path.join(root, "data/backend/codex-web.sqlite"), { readOnly: true });
  let users; try { users = db.prepare("SELECT id FROM users").all().map(user => user.id); } finally { db.close(); }
  const snapshots = await Promise.all(users.map(user => socketRequest(user).catch(() => ({ unknown: true }))));
  const [health, pool] = await Promise.all([readApi(manifest.target.userId, "/api/health").catch(() => null), readApi(manifest.target.userId, "/api/codex/account-pool").catch(() => null)]);
  return idleDecision(snapshots, health, pool?.data, manifest.staleAllowance);
}

async function apply(manifest) {
  const final = await observe(manifest);
  if (!final.idle) { report(manifest, "waiting_for_idle", final); return 75; }
  if (treeHash(manifest.build) !== manifest.artifactHash) throw new Error("待上线网页构建已改变，未重启服务。");
  report(manifest, "restarting_idle_backend", final);
  await execute("systemctl", ["--user", "restart", "codex-account-pool-4576.service"], { timeout: 60_000 });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await socketRequest(manifest.target.userId); ready = true; break; } catch { await sleep(1_000); }
  }
  if (!ready) throw new Error("后端重启后未恢复连接；原会话记录仍保留。");
  await publishDist(manifest.build, path.join(root, "dist"));
  await execute(process.execPath, [path.join(root, "scripts/publish-ui-update.cjs"), manifest.version, "questions,plan,threads,runtime"], { timeout: 10_000 });
  report(manifest, "deployed_restoring_question", { deployed: true });
  const owners = new DatabaseSync(path.join(root, "data/backend/codex-web.sqlite"), { readOnly: true });
  let owner;
  try { owner = owners.prepare("SELECT user_id,project_id,is_archived_local FROM thread_owners WHERE thread_id=?").get(manifest.target.threadId); }
  finally { owners.close(); }
  const revision = targetRevision(manifest);
  const state = await socketRequest(manifest.target.userId);
  if (!owner || owner.user_id !== manifest.target.userId || owner.is_archived_local || !revision || revision.archived
    || revision.updated_at_ms !== manifest.target.updatedAtMs || state.active.some(turn => turn.threadId === manifest.target.threadId)) {
    report(manifest, "complete", { recovery: "conversation_changed_or_already_running", restartedOnIdleSnapshot: true });
    return 0;
  }
  const prompt = "网页问答故障已经修复，现在恢复上一轮被中断的等待状态。请继续原自动标定服务整理和容器打包方案任务，沿用已有检查结果和此前的范围约定，不再重新检查文件。请直接用 request_user_input 重新展示以下原来的三个问题，保持问题、编号与选项不变并等待用户回答。不替用户选择默认答案，不开始实施，仍先提出方案、经用户批准后再实施。\n\n" + JSON.stringify(manifest.questions);
  await socketRequest(manifest.target.userId, { type: "turn.start", requestId: `question-recovery-${randomUUID()}`, projectId: manifest.target.projectId,
    threadId: manifest.target.threadId, collaborationMode: "plan", prompt }, 120_000);
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(10_000);
    const restored = await socketRequest(manifest.target.userId);
    const pending = restored.pending.find(request => request.method === "item/tool/requestUserInput" && request.params?.threadId === manifest.target.threadId);
    if (pending) {
      report(manifest, "complete", { recovery: "waiting_for_user_answers", threadId: manifest.target.threadId, questionCount: pending.params?.questions?.length, restartedOnIdleSnapshot: true });
      return 0;
    }
    if (!restored.active.some(turn => turn.threadId === manifest.target.threadId)) break;
  }
  report(manifest, "deployed", { recovery: "resume_accepted_question_not_yet_confirmed", threadId: manifest.target.threadId });
  return 0;
}

async function main() {
  const manifestPath = process.argv[2];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  try {
    if (process.argv.includes("--check")) { report(manifest, "checked_waiting_for_idle", await observe(manifest)); return; }
    if (process.argv.includes("--apply")) { process.exitCode = await apply(manifest); return; }
    for (;;) {
      await waitForQuiet(() => observe(manifest), (state, stage) => report(manifest, stage, state));
      try {
        const result = await execute("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "--no-fork",
          path.join(root, "data/backend/deployment.lock"), process.execPath, script, manifestPath, "--apply"], { timeout: 15 * 60_000, maxBuffer: 1_048_576 });
        if (result.stdout) process.stdout.write(result.stdout);
        return;
      } catch (error) {
        if (error.code !== 75) throw error;
        report(manifest, "waiting_for_idle_or_deployment_lock");
        await sleep(30_000);
      }
    }
  } catch (error) {
    let state; try { state = JSON.parse(fs.readFileSync(manifest.report, "utf8")); } catch { /* No report yet. */ }
    report(manifest, state?.deployed ? "deployed_recovery_failed" : "deferred", { error: error.message }); process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) await main();
