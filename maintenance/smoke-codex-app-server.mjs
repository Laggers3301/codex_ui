#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [codexBinInput, codexHomeInput, model = "gpt-6-astra", configMode = "legacy-null"] = process.argv.slice(2);
if (!codexBinInput || !codexHomeInput) {
  console.error("Usage: smoke-codex-app-server.mjs CODEX_BIN CODEX_HOME [MODEL] [legacy-null|override|omit]");
  process.exit(64);
}

const codexBin = path.resolve(codexBinInput);
const codexHome = path.resolve(codexHomeInput);
if (!fs.statSync(codexBin).isFile() || !fs.statSync(codexHome).isDirectory()) {
  throw new Error("CODEX_BIN must be a file and CODEX_HOME must be a directory.");
}
if (configMode !== "legacy-null" && configMode !== "override" && configMode !== "omit") {
  throw new Error("Config mode must be legacy-null, override, or omit.");
}

const child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
  cwd: "/tmp",
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
const turnWaiters = new Map();
let stderr = "";

child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
});
child.on("exit", (code, signal) => {
  const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}). ${stderr}`);
  for (const entry of pending.values()) entry.reject(error);
  for (const entry of turnWaiters.values()) entry.reject(error);
});

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}.`));
    }, timeoutMs);
    pending.set(id, { method, resolve, reject, timer });
    write({ id, method, params });
  });
}

function waitForTurn(turnId, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      turnWaiters.delete(turnId);
      reject(new Error("Timed out waiting for turn/completed."));
    }, timeoutMs);
    turnWaiters.set(turnId, { resolve, reject, timer });
  });
}

lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    stderr = `${stderr}\nNon-JSON stdout: ${line}`.slice(-8_000);
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const entry = pending.get(Number(message.id));
    if (!entry) return;
    pending.delete(Number(message.id));
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === "turn/completed") {
    const turn = message.params?.turn;
    const turnId = turn?.id;
    const entry = turnWaiters.get(turnId);
    if (!entry) return;
    turnWaiters.delete(turnId);
    clearTimeout(entry.timer);
    if (turn?.status === "failed") entry.reject(new Error(`Turn failed: ${JSON.stringify(turn.error ?? {})}`));
    else entry.resolve(turn);
  }
});

try {
  await request("initialize", {
    clientInfo: { name: "codex_pool_upgrade_smoke", title: "Codex Pool Upgrade Smoke", version: "1.0.0" },
    capabilities: { experimentalApi: true }
  });
  write({ method: "initialized", params: {} });

  const modelList = await request("model/list", {});
  const advertised = Array.isArray(modelList?.data)
    ? modelList.data.some((entry) => entry?.id === model || entry?.model === model || entry?.slug === model)
    : false;
  const threadResult = await request("thread/start", {
    cwd: "/tmp",
    model,
    approvalPolicy: "never",
    sandbox: "read-only",
    threadSource: "user",
    config: {}
  });
  const threadId = threadResult?.thread?.id;
  if (!threadId) throw new Error("thread/start did not return a thread id.");

  const turnParams = {
    threadId,
    input: [{ type: "text", text: "Reply with exactly APP_SERVER_ASTRA_OK and nothing else.", text_elements: [] }],
    cwd: "/tmp",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    model,
    effort: "low"
  };
  if (configMode === "legacy-null") {
    turnParams.config = {
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: "total"
    };
  } else if (configMode === "override") {
    turnParams.config = {
      model_context_window: 64_000,
      model_auto_compact_token_limit: 50_000,
      model_auto_compact_token_limit_scope: "total"
    };
  }
  const turnResult = await request("turn/start", turnParams);
  const turnId = turnResult?.turn?.id;
  if (!turnId) throw new Error("turn/start did not return a turn id.");
  const completed = await waitForTurn(turnId);
  console.log(JSON.stringify({
    versionCompatible: true,
    model,
    advertised,
    configMode,
    threadId,
    turnId,
    status: completed?.status ?? "completed"
  }, null, 2));
} finally {
  child.kill("SIGINT");
}
