import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import { ProjectStore } from "./db.js";
import { registerRoutes } from "./routes.js";
import * as fallback from "./threadFallback.js";
import {serverConfig} from "./config.js";
import {createSessionCookie} from "./auth.js";

vi.mock("./largeThreadFork.js", async () => ({ ...await vi.importActual<typeof import("./largeThreadFork.js")>("./largeThreadFork.js"), largeThreadForkBytes: 1 }));
vi.mock("./threadFallback.js", async () => ({ ...await vi.importActual<typeof import("./threadFallback.js")>("./threadFallback.js"), findThreadJsonlPathById: vi.fn(), threadJsonlSessionsRoot: vi.fn() }));

describe("large legacy branch route", () => {
  it("registers exact history under the selected target and resumes without native fork projection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-route-test-"));
    const homes = [path.join(root, "a"), path.join(root, "b")];
    for (const home of homes) fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    const sourcePath = path.join(homes[0], "sessions", "source.jsonl");
    const source = [{ type: "session_meta", payload: { id: "source", history_mode: "legacy" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "one" } },
      { type: "response_item", payload: { type: "message", role: "user", content: "原问题" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "one" } }].map(v => JSON.stringify(v)).join("\n") + "\n";
    fs.writeFileSync(sourcePath, source);
    vi.mocked(fallback.findThreadJsonlPathById).mockResolvedValue(sourcePath);
    vi.mocked(fallback.threadJsonlSessionsRoot).mockReturnValue(path.join(homes[0], "sessions"));
    const calls: Array<{ account: string; method: string; params: Record<string, unknown> }> = [];
    class Runtime extends EventEmitter {
      constructor(private readonly account: string) { super(); }
      async start() {} stop() {} getPendingServerRequests() { return []; } getMemoryHeadroom() { return 8e9; }
      async request(method: string, value: unknown) {
        const params = value as Record<string, unknown>;
        calls.push({ account: this.account, method, params });
        if (method === "thread/read") return { thread: { id: "source", name: "fixture", path: sourcePath } };
        if (method === "thread/resume") return { thread: { id: params.threadId, path: params.path, turns: [], status: { type: "idle" } } };
        return {};
      }
    }
    const pool = new AccountPoolBridge({ accounts: homes.map((home, i) => ({ id: String(i), label: `account-${i}`, codexHome: home })), stateFile: "state.json" }, root, (_home, id) => new Runtime(id) as unknown as CodexBridge);
    pool.assignThreadsToAccount(["source"], "0");
    vi.spyOn(pool, "getBranchRoutingDecision").mockReturnValue({ mode: "cross-account-native",
      sourceAccount: { id: "0", label: "account-0", codexHome: homes[0] }, targetAccount: { id: "1", label: "account-1", codexHome: homes[1] } });
    const store = new ProjectStore(path.join(root, "test.sqlite"));
    const project = store.createProject({ name: "test", rootPath: root });
    store.registerThreadOwner({ threadId: "source", userId: "admin", projectId: project.id, rootPath: root });
    const app = Fastify();
    const originalDataDir=serverConfig.dataDir;
    serverConfig.dataDir=path.join(root,"data");
    try {
      registerRoutes(app, pool as unknown as CodexBridge, store, { backgroundIndexing: false });
      const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/source/branch`, payload: { turnId: "one" } });
      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      // Large histories use the private archive automatically, without the
      // frontend opting in; ordinary records remain byte-for-byte unchanged.
      expect(data.branchMode).toBe("legacy-tool-archive");
      const autoMetadata=await app.inject({method:"GET",url:`/api/projects/${project.id}/threads/${data.thread.id}/tool-output-archive`});
      expect(autoMetadata.statusCode).toBe(200);
      expect(autoMetadata.json().data.archivedRecords).toBe(0);
      expect(data.targetAccount.id).toBe("1");
      expect(store.getThreadOwner(data.thread.id)?.userId).toBe("admin");
      expect(calls.some(call => call.method === "thread/fork")).toBe(false);
      expect(calls.find(call => call.method === "thread/resume")).toMatchObject({ account: "1", params: { threadId: data.thread.id, excludeTurns: true } });
      const copied = fs.readFileSync(data.thread.path, "utf8");
      expect(copied.slice(copied.indexOf("\n") + 1)).toBe(source.slice(source.indexOf("\n") + 1));
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(source);
      const denied = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/unowned/branch`, payload: { turnId: "one" } });
      expect(denied.statusCode).toBe(403);
      const archived=await app.inject({method:"POST",url:`/api/projects/${project.id}/threads/source/branch`,payload:{turnId:"one",archiveToolOutputs:true}});
      expect(archived.statusCode).toBe(200);
      const compact=archived.json().data;expect(compact.branchMode).toBe("legacy-tool-archive");
      const metadata=await app.inject({method:"GET",url:`/api/projects/${project.id}/threads/${compact.thread.id}/tool-output-archive`});
      expect(metadata.statusCode).toBe(200);expect(metadata.json().data.threadId).toBe(compact.thread.id);
      const download=await app.inject({method:"GET",url:`/api/projects/${project.id}/threads/${compact.thread.id}/tool-output-archive?download=1`});
      expect(download.statusCode).toBe(200);expect(download.headers["content-type"]).toContain("application/gzip");expect(download.headers["cache-control"]).toBe("private, no-store");
      const forbidden=await app.inject({method:"GET",url:`/api/projects/${project.id}/threads/${compact.thread.id}/tool-output-archive?download=1`,headers:{cookie:createSessionCookie("bob")}});
      expect(forbidden.statusCode).toBe(403);
    } finally { await app.close(); pool.stop(); store.close(); serverConfig.dataDir=originalDataDir;vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
