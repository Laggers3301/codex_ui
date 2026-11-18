import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ProjectStore } from "./db.js";

it("keeps the speed tier per conversation, isolated from others and across restarts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "thread-tier-")), file = path.join(root, "store.sqlite");
  let store = new ProjectStore(file);
  const tier = (threadId: string) => store.getThreadPresentation("admin", [threadId]).get(threadId)?.serviceTier;
  try {
    store.ensureUser("other", "other");
    const project = store.createProject({ name: "tier", rootPath: root });
    for (const threadId of ["a", "b"]) store.registerThreadOwner({ threadId, userId: "admin", projectId: project.id, rootPath: root });
    expect(tier("a")).toBeNull();
    expect(store.setThreadServiceTier("a", "admin", "fast")?.serviceTier).toBe("fast");
    expect(tier("b")).toBeNull();
    store.setThreadServiceTier("b", "admin", "ultrafast");
    store.setThreadServiceTier("a", "admin", null);
    expect(tier("a")).toBeNull();
    expect(tier("b")).toBe("ultrafast");
    // Another account cannot change this conversation's tier.
    expect(store.setThreadServiceTier("b", "other", "fast")).toBeNull();
    store.close(); store = new ProjectStore(file);
    expect(tier("b")).toBe("ultrafast");
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
