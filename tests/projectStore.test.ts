import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_USER_ID, ProjectStore } from "../server/db.js";

const stores: ProjectStore[] = [];

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-db-"));
  const store = new ProjectStore(path.join(dir, "test.sqlite"));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

describe("ProjectStore", () => {
  it("creates the admin user by default", () => {
    const store = createStore();

    expect(store.getUser(ADMIN_USER_ID)?.name).toBe("admin");
    expect(store.listUsers().some((user) => user.id === ADMIN_USER_ID)).toBe(true);
  });

  it("creates and lists projects", () => {
    const store = createStore();
    const project = store.createProject({
      name: "Demo",
      rootPath: "/Volumes/DevDrive/program/demo"
    });

    expect(project.id).toBeTruthy();
    expect(project.defaultModel).toBe("gpt-5.6-sol");
    expect(project.defaultReasoningEffort).toBe("xhigh");
    expect(project.defaultSandbox).toBe("danger-full-access");
    expect(project.defaultApprovalPolicy).toBe("never");
    expect(store.listProjects()).toHaveLength(1);
    expect(store.getProject(project.id)?.name).toBe("Demo");
  });

  it("updates and deletes projects", () => {
    const store = createStore();
    const project = store.createProject({
      name: "Demo",
      rootPath: "/Volumes/DevDrive/program/demo"
    });

    expect(store.updateProject(project.id, { name: "Renamed" })?.name).toBe("Renamed");
    expect(store.deleteProject(project.id)).toBe(true);
    expect(store.getProject(project.id)).toBeNull();
  });

  it("migrates the previous GPT-5.5 project default to GPT-5.6 Sol", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-db-migration-"));
    const dbPath = path.join(dir, "test.sqlite");
    const initialStore = new ProjectStore(dbPath);
    const project = initialStore.createProject({
      name: "Legacy",
      rootPath: "/Volumes/DevDrive/program/legacy"
    });
    initialStore.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE projects SET default_model = 'gpt-5.5' WHERE id = ?").run(project.id);
    db.close();

    const migratedStore = new ProjectStore(dbPath);
    stores.push(migratedStore);
    expect(migratedStore.getProject(project.id)?.defaultModel).toBe("gpt-5.6-sol");
    expect(migratedStore.getProject(project.id)?.defaultReasoningEffort).toBe("xhigh");
  });

  it("deletes non-admin user metadata and keeps admin", () => {
    const store = createStore();
    const user = store.createUser("Temporary");
    const project = store.createProject({
      userId: user.id,
      name: "Temporary Project",
      rootPath: "/Volumes/DevDrive/program/temp"
    });

    expect(store.deleteUser(ADMIN_USER_ID)).toBe(false);
    expect(store.getUser(ADMIN_USER_ID)).not.toBeNull();
    expect(store.deleteUser(user.id)).toBe(true);
    expect(store.getUser(user.id)).toBeNull();
    expect(store.getProject(project.id, user.id)).toBeNull();
  });

  it("finds projects by root path within one user", () => {
    const store = createStore();
    const alice = store.createUser("Alice");
    const bob = store.createUser("Bob");
    const rootPath = "/Volumes/DevDrive/program/demo";

    const aliceProject = store.createProject({
      userId: alice.id,
      name: "Alice Demo",
      rootPath
    });
    const bobProject = store.createProject({
      userId: bob.id,
      name: "Bob Demo",
      rootPath
    });

    expect(store.getProjectByRootPath(rootPath, alice.id)?.id).toBe(aliceProject.id);
    expect(store.getProjectByRootPath(rootPath, bob.id)?.id).toBe(bobProject.id);
    expect(store.getProjectByRootPath(rootPath)).toBeNull();
  });

  it("scopes project visibility by user", () => {
    const store = createStore();
    const alice = store.createUser("Alice");
    const bob = store.createUser("Bob");

    const aliceProject = store.createProject({
      userId: alice.id,
      name: "Shared Path",
      rootPath: "/Volumes/DevDrive/program/shared"
    });
    const bobProject = store.createProject({
      userId: bob.id,
      name: "Shared Path",
      rootPath: "/Volumes/DevDrive/program/shared"
    });

    expect(store.listProjects(alice.id).map((project) => project.id)).toEqual([aliceProject.id]);
    expect(store.listProjects(bob.id).map((project) => project.id)).toEqual([bobProject.id]);
    expect(store.getProject(bobProject.id, alice.id)).toBeNull();
  });

  it("stores pin, order and model presentation per owned thread", () => {
    const store = createStore();
    const alice = store.createUser("Alice");
    const bob = store.createUser("Bob");
    const aliceProject = store.createProject({ userId: alice.id, name: "Alice", rootPath: "/workspace/alice" });
    const bobProject = store.createProject({ userId: bob.id, name: "Bob", rootPath: "/workspace/bob" });

    store.registerThreadOwner({
      threadId: "alice-first",
      userId: alice.id,
      projectId: aliceProject.id,
      rootPath: aliceProject.rootPath,
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh"
    });
    store.registerThreadOwner({
      threadId: "alice-second",
      userId: alice.id,
      projectId: aliceProject.id,
      rootPath: aliceProject.rootPath
    });
    store.registerThreadOwner({
      threadId: "bob-thread",
      userId: bob.id,
      projectId: bobProject.id,
      rootPath: bobProject.rootPath
    });

    expect(store.setThreadPinned("alice-second", alice.id, true)).toMatchObject({
      threadId: "alice-second",
      pinned: true
    });
    expect(store.setThreadModelConfig("alice-second", alice.id, "gpt-5.6-terra", "high")).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "high"
    });
    store.setThreadOrder(alice.id, ["alice-first", "alice-second"]);

    const alicePresentation = store.getThreadPresentation(alice.id, ["alice-first", "alice-second", "bob-thread"]);
    expect(alicePresentation.get("alice-first")?.manualOrder).toBe(0);
    expect(alicePresentation.get("alice-second")).toMatchObject({
      pinned: true,
      manualOrder: 1,
      model: "gpt-5.6-terra",
      reasoningEffort: "high"
    });
    expect(alicePresentation.has("bob-thread")).toBe(false);
  });
});
