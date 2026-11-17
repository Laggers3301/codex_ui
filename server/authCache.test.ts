import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedUserFromHeaders, createSessionCookie, webUserDisplayNames, isDeletedWebUser } from "./auth.js";
import { serverConfig } from "./config.js";

const saved = { authUsersFile: serverConfig.authUsersFile, authMode: serverConfig.authMode };
let dir: string, usersFile: string;
const stored = (name: string) => { const salt = "fixture-only"; return { salt, hash: scryptSync("pw", salt, 64).toString("hex"), createdAt: "", updatedAt: "", displayName: name }; };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-cache-"));
  usersFile = path.join(dir, "members.json");
  serverConfig.authUsersFile = usersFile; serverConfig.authMode = "member";
  fs.writeFileSync(usersFile, JSON.stringify({ users: { alice: stored("Alice") } }));
});
afterEach(() => { Object.assign(serverConfig, saved); fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

it("serves repeated auth work from a single read, yet sees every rewrite immediately", () => {
  const cookie = createSessionCookie("alice").split(";")[0];
  const read = vi.spyOn(fs, "readFileSync");
  for (let i = 0; i < 20; i++) expect(authenticatedUserFromHeaders({ cookie })).toBe("alice");
  // One read for the secret and one for the user table, not one per call.
  const reads = read.mock.calls.filter(([file]) => String(file).startsWith(dir)).length;
  expect(reads).toBeLessThanOrEqual(2);
  // A local deletion rewrite (different size) takes effect on the next call, without restart.
  fs.writeFileSync(usersFile, JSON.stringify({ users: { alice: stored("Alice") }, deletedUsers: { alice: { deletedAt: new Date().toISOString() } } }));
  expect(isDeletedWebUser("alice")).toBe(true);
  expect(authenticatedUserFromHeaders({ cookie })).toBeNull();
  // Atomic replace (new inode, even identical size) is also noticed; a missing file reads as empty.
  const replacement = usersFile + ".new";
  fs.writeFileSync(replacement, JSON.stringify({ users: { bob: stored("Bob") } }));
  fs.renameSync(replacement, usersFile);
  expect(isDeletedWebUser("alice")).toBe(false);
  expect([...webUserDisplayNames().keys()]).toEqual(["bob"]);
  fs.rmSync(usersFile);
  expect([...webUserDisplayNames().keys()]).toEqual([]);
});
