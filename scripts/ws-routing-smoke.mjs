#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("../../codex-web-v2/node_modules/ws");

const baseUrl = new URL(process.env.CODEX_WS_BASE_URL || "http://127.0.0.1:4575");
const webdriverUrl = (process.env.CODEX_WEBDRIVER_URL || "http://127.0.0.1:4466").replace(/\/$/, "");
const webdriverSession = process.env.CODEX_WEBDRIVER_SESSION;
const projectId = process.env.CODEX_WS_PROJECT_ID || "42e05b53-4f4b-4515-8897-6a1e86bb4954";
const stateFile = new URL("../data/account-pool-state.json", import.meta.url);
const poolFile = new URL("../account-pool.json", import.meta.url);
const timeoutMs = Number.parseInt(process.env.CODEX_WS_TIMEOUT_MS || "180000", 10);
const killAccount = process.env.CODEX_WS_KILL_ACCOUNT || "";
const expectedAccount = process.env.CODEX_WS_EXPECT_ACCOUNT || "";
const existingThreadId = process.env.CODEX_WS_EXISTING_THREAD || "";
let socketForCleanup = null;

if (!webdriverSession) {
  console.error("Set CODEX_WEBDRIVER_SESSION to an already authenticated browser session.");
  process.exit(2);
}

async function webdriverCookies() {
  const response = await fetch(`${webdriverUrl}/session/${encodeURIComponent(webdriverSession)}/cookie`);
  if (!response.ok) throw new Error(`WebDriver cookie lookup failed with HTTP ${response.status}`);
  const payload = await response.json();
  const cookies = Array.isArray(payload.value) ? payload.value : [];
  const header = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  if (!header) throw new Error("The browser session has no cookies.");
  return header;
}

function mappedAccount(threadId) {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  return state.threadAccounts?.[threadId] || null;
}

function accountProcessIds(accountId) {
  const pool = JSON.parse(fs.readFileSync(poolFile, "utf8"));
  const codexHome = pool.accounts?.find((account) => account.id === accountId)?.codexHome;
  if (!codexHome) throw new Error(`Unknown account id ${accountId}.`);
  const matches = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ");
      if (!command.includes("codex app-server")) continue;
      const environment = fs.readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      if (environment.includes(`CODEX_HOME=${codexHome}`)) matches.push(Number(entry));
    } catch {
      // Processes can exit while /proc is being inspected.
    }
  }
  return matches;
}

async function poolSnapshot(cookie) {
  const response = await fetch(new URL("/api/codex/account-pool", baseUrl), { headers: { Cookie: cookie } });
  if (!response.ok) throw new Error(`Account-pool lookup failed with HTTP ${response.status}.`);
  return (await response.json()).data;
}

async function waitUntil(check, label, limitMs = 10_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function waitFor(socket, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}.`));
    }, timeoutMs);
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`WebSocket closed (${code} ${reason.toString("utf8")}).`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

async function sendAndWait(socket, payload) {
  const ack = waitFor(socket, (message) => message.type === "ack" && message.requestId === payload.requestId, `${payload.type} acknowledgement`);
  socket.send(JSON.stringify(payload));
  const result = await ack;
  if (!result.ok) throw new Error(`${payload.type} failed: ${result.error || "unknown error"}`);
  return result;
}

function completionForThread(socket, threadId) {
  return waitFor(socket, (message) => {
    if (message.type !== "codex.notification" || message.data?.method !== "turn/completed") return false;
    const params = message.data?.params || {};
    return params.threadId === threadId || params.turn?.threadId === threadId || params.thread?.id === threadId;
  }, `turn completion for ${threadId}`);
}

async function main() {
  const cookie = await webdriverCookies();
  const wsUrl = new URL("/ws", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  socketForCleanup = socket;
  const hello = waitFor(socket, (message) => message.type === "hello" && message.ok, "authenticated hello");
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await hello;

  if (existingThreadId) {
    const firstAccount = mappedAccount(existingThreadId);
    if (!firstAccount) throw new Error(`Existing thread ${existingThreadId} has no persisted account mapping.`);
    const completion = completionForThread(socket, existingThreadId);
    await sendAndWait(socket, {
      type: "turn.start",
      requestId: `restart-sticky-smoke-${Date.now()}`,
      userId: "ignored-client-value",
      projectId,
      threadId: existingThreadId,
      prompt: "这是后端重启后的会话粘性回归。请只回复 RESTART_STICKY_OK，不要调用工具。",
      sandbox: "danger-full-access",
      approvalPolicy: "never"
    });
    await completion;
    const secondAccount = mappedAccount(existingThreadId);
    socket.close(1000, "test complete");
    const result = {
      passed: firstAccount === secondAccount && (!expectedAccount || firstAccount === expectedAccount),
      threadId: existingThreadId,
      firstAccount,
      secondAccount,
      sticky: firstAccount === secondAccount,
      expectedAccount: expectedAccount || null,
      resumedAfterBackendRestart: true
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }

  let killedPid = null;
  let degradedObserved = false;
  if (killAccount) {
    const candidates = accountProcessIds(killAccount);
    if (candidates.length !== 1) throw new Error(`Expected one ${killAccount} app-server, found ${candidates.length}.`);
    killedPid = candidates[0];
    const exitStatus = waitFor(socket, (message) => message.type === "codex.status"
      && message.data?.accountId === killAccount
      && message.data?.state === "exited", `${killAccount} exited status`);
    process.kill(killedPid, "SIGTERM");
    await Promise.all([
      exitStatus,
      waitUntil(() => !fs.existsSync(`/proc/${killedPid}`), `${killAccount} app-server exit`)
    ]);
    // The exited event is emitted only after AccountPoolBridge marks the
    // runtime degraded. Do not call the quota endpoint here: a forced account
    // read can legitimately start the child again and would change the state
    // this test is trying to observe.
    degradedObserved = true;
  }

  const firstRequestId = `routing-smoke-${Date.now()}`;
  const firstAck = await sendAndWait(socket, {
    type: "thread.start",
    requestId: firstRequestId,
    userId: "ignored-client-value",
    projectId,
    prompt: "这是账号池路由冒烟测试。请只回复 ROUTE_OK，不要调用工具。",
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });
  const threadId = firstAck.data?.thread?.thread?.id;
  if (!threadId) throw new Error("thread.start acknowledgement did not contain a thread id.");
  const firstAccount = mappedAccount(threadId);
  await completionForThread(socket, threadId);

  const secondCompletion = completionForThread(socket, threadId);
  await sendAndWait(socket, {
    type: "turn.start",
    requestId: `${firstRequestId}-followup`,
    userId: "ignored-client-value",
    projectId,
    threadId,
    prompt: "请只回复 STICKY_OK，不要调用工具。",
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });
  await secondCompletion;
  const secondAccount = mappedAccount(threadId);

  let recoveredPid = null;
  if (killAccount) {
    recoveredPid = await waitUntil(() => accountProcessIds(killAccount).find((pid) => pid !== killedPid) || null, `${killAccount} replacement process`);
    await waitUntil(async () => {
      const pool = await poolSnapshot(cookie);
      return pool.accounts?.find((account) => account.id === killAccount)?.health === "ready";
    }, `${killAccount} ready state`);
  }
  socket.close(1000, "test complete");

  const result = {
    passed: Boolean(firstAccount)
      && firstAccount === secondAccount
      && (!expectedAccount || firstAccount === expectedAccount)
      && (!killAccount || Boolean(recoveredPid)),
    threadId,
    firstAccount,
    secondAccount,
    sticky: firstAccount === secondAccount,
    expectedAccount: expectedAccount || null,
    killedAccount: killAccount || null,
    killedPid,
    degradedObserved,
    recoveredPid,
    recovered: !killAccount || Boolean(recoveredPid)
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  socketForCleanup?.terminate();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
