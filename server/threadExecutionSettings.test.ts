import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ProjectStore } from "./db.js";

it("persists execution settings only for the owner and survives reopening", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-settings-test-")), dbPath = path.join(dir, "db.sqlite");
  let store = new ProjectStore(dbPath);
  try {
    const project = store.createProject({ name: "permission test", rootPath: dir });
    store.registerThreadOwner({ threadId: "owned", userId: "admin", projectId: project.id, rootPath: dir });
    expect(store.getThreadExecutionSettings("owned", "admin")).toBeNull();
    store.setThreadExecutionSettings("owned", "admin", "danger-full-access", "never");
    expect(store.getThreadExecutionSettings("owned", "someone-else")).toBeNull();
    expect(() => store.setThreadExecutionSettings("owned", "someone-else", "danger-full-access", "never")).toThrow("belong");
    store.close(); store = new ProjectStore(dbPath);
    expect(store.getThreadExecutionSettings("owned", "admin")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
    store.setThreadExecutionSettings("owned", "admin", "read-only", "on-request");
    expect(store.getThreadExecutionSettings("owned", "admin")?.sandbox).toBe("read-only");
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
