import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";

it("reroutes only a memory-constrained GPT branch, retaining model and explicit account restrictions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-memory-route-"));
  const budgets = new Map<string, number | null>([["preferred", 500], ["other", 2000], ["wrong-model", 9000], ["provider", 9000]]);
  class Runtime extends EventEmitter {
    constructor(readonly id: string) { super(); }
    async start() {} stop() {} getPendingServerRequests() { return []; }
    getMemoryHeadroom() { return budgets.get(this.id) ?? null; }
    async request(method: string) {
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: this.id === "preferred" ? 10 : 20 } } };
      return {};
    }
  }
  const accounts = [...budgets.keys()].map(id => {
    const home = path.join(root, id); fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "model-catalog-gpt-5.6-sol-long-context.json"), JSON.stringify({ models: [{ slug: id === "wrong-model" ? "different-model" : "gpt-fixture", visibility: "list" }] }));
    return { id, label: id, codexHome: home, ...(id === "provider" ? { kind: "api-provider" as const } : {}) };
  });
  const pool = new AccountPoolBridge({ accounts, stateFile: "state.json" }, root, (_home, id) => new Runtime(id) as unknown as CodexBridge);
  try {
    await pool.start(); pool.assignThreadsToAccount(["source"], "preferred");
    expect(pool.getBranchRoutingDecision("source", "gpt-fixture").targetAccount.id).toBe("preferred");
    const route = pool.getBranchRoutingDecision("source", "gpt-fixture", undefined, 1000);
    expect(route.targetAccount.id).toBe("other"); expect(route.sourceAccount?.id).toBe("preferred");
    expect(route.mode).toBe("cross-account-native");
    expect(() => pool.getBranchRoutingDecision("source", "gpt-fixture", "preferred", 1000)).toThrow(/没有.*内存/);
    budgets.set("preferred", 1000);
    expect(pool.getBranchRoutingDecision("source", "gpt-fixture", undefined, 1000).targetAccount.id).toBe("preferred");
    budgets.set("preferred", null); budgets.set("other", null);
    expect(() => pool.getBranchRoutingDecision("source", "gpt-fixture", undefined, 1000)).toThrow(/没有.*内存/);
  } finally { pool.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
