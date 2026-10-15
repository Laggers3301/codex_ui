import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { readRemoteFolders, listRemoteFolder, controlRemoteFolder, createRemoteFoldersHandler } from "./remote-folders.mjs";

async function registry(workspace, entries) {
  await mkdir(path.join(workspace, ".codex"), { recursive: true });
  await writeFile(path.join(workspace, ".codex/remote-folders.json"), JSON.stringify(entries));
}
const entry = (workspace, id) => ({ id, name: id, host: "example", remote_path: "/work", mount_path: path.join(workspace, "remote", id), read_only: true });

test("registries stay inside each user's workspace, including symbolic links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-folders-policy-"));
  try {
    const alice = path.join(root, "alice"), bob = path.join(root, "bob");
    await registry(alice, [{ ...entry(alice, "alpha"), thread_ids: ["thread-a"] }]);
    await registry(bob, [entry(bob, "beta")]);
    assert.deepEqual((await readRemoteFolders(alice, "thread-a")).map((folder) => folder.id), ["alpha"]);
    await registry(alice, [entry(bob, "beta")]);
    await assert.rejects(readRemoteFolders(alice), /无效路径/);
    await rm(path.join(alice, ".codex/remote-folders.json"));
    await symlink(path.join(bob, ".codex/remote-folders.json"), path.join(alice, ".codex/remote-folders.json"));
    await assert.rejects(readRemoteFolders(alice), /不属于/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("traversal is rejected and an unmounted directory is never presented as remote files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-folders-offline-"));
  try {
    const mountPath = path.join(root, "mount");
    await mkdir(mountPath);
    await writeFile(path.join(mountPath, "local-only.txt"), "must not be exposed as a remote file");
    const folder = { mountPath };
    await assert.rejects(listRemoteFolder(root, folder, "../elsewhere"), /必须位于/);
    await assert.rejects(listRemoteFolder(root, folder, "/etc"), /必须位于/);
    await assert.rejects(listRemoteFolder(root, folder), /已断开/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("conversations restore explicit selections and never inherit unbound legacy directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-folders-threads-"));
  try {
    await registry(root, [
      { ...entry(root, "alpha"), thread_ids: ["thread-a"] },
      { ...entry(root, "beta"), thread_ids: ["thread-b"] },
      { ...entry(root, "reused"), thread_ids: ["thread-a", "thread-b"] },
      entry(root, "legacy"),
      { ...entry(root, "shared"), thread_ids: null, shared: true }
    ]);
    const a = await readRemoteFolders(root, "thread-a");
    assert.deepEqual(a.map((folder) => folder.id), ["alpha", "reused", "shared"]);
    assert.deepEqual(a.map((folder) => folder.scope), ["conversation", "conversation", "account"]);
    assert.deepEqual((await readRemoteFolders(root, "thread-b")).map((folder) => folder.id), ["beta", "reused", "shared"]);
    assert.deepEqual(await readRemoteFolders(root), []);
    assert.deepEqual((await readRemoteFolders(root, "new-thread")).map((folder) => folder.id), ["shared"]);
    assert.deepEqual(await readRemoteFolders(root, "draft-empty"), []);
    await assert.rejects(readRemoteFolders(root, "../thread-a"), { statusCode: 400 });
    await registry(root, [{ ...entry(root, "invalid"), thread_ids: "thread-a" }]);
    await assert.rejects(readRemoteFolders(root, "thread-a"), /无效对话标识/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("HTTP endpoints isolate two accounts and reject stale or forged page identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-folders-auth-"));
  const upstream = http.createServer((request, response) => {
    const user = /^test-session=(alice|bob|alias)$/.exec(request.headers.cookie ?? "")?.[1];
    const signedIn = Boolean(user);
    response.writeHead(signedIn ? 200 : 401, { "Content-Type": "application/json" });
    response.end(JSON.stringify(signedIn ? { defaultUserId: user, lockedToLoginUser: true, data: [{ id: user }] } : { error: "login required" }));
  });
  let server;
  try {
    await registry(path.join(root, "alice"), [
      { ...entry(path.join(root, "alice"), "alpha"), host: "alice-computer", thread_ids: ["thread-a"] },
      { ...entry(path.join(root, "alice"), "gamma"), host: "alice-computer", thread_ids: ["thread-b"] }
    ]);
    await registry(path.join(root, "bob"), [{ ...entry(path.join(root, "bob"), "beta"), host: "bob-computer", thread_ids: ["thread-a"] }]);
    await symlink(path.join(root, "bob"), path.join(root, "alias"));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    server = http.createServer(createRemoteFoldersHandler({ upstreamHost: "127.0.0.1", upstreamPort: upstream.address().port, workspaceRoot: root }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/remote-folders`, { headers: { "x-codex-web-user-id": "bob" } })).status, 401);
    assert.equal((await fetch(`${base}/api/remote-folders?threadId=thread-a`, { headers: { cookie: "test-session=alice", "x-codex-web-user-id": "bob" } })).status, 403);
    assert.equal((await fetch(`${base}/api/remote-folders/catalog`, { headers: { cookie: "test-session=alias" } })).status, 403);
    const headers = { cookie: "test-session=alice", "x-codex-web-user-id": "alice" };
    const rootResponse = await fetch(`${base}/api/remote-folders?threadId=thread-a`, { headers });
    assert.match(rootResponse.headers.get("cache-control"), /private.*no-store/);
    assert.match(rootResponse.headers.get("vary"), /Cookie/);
    const roots = await rootResponse.json();
    assert.equal(roots.ownerUserId, "alice");
    assert.deepEqual(roots.data.map((folder) => folder.id), ["alpha"]);
    const bobHeaders = { cookie: "test-session=bob", "x-codex-web-user-id": "bob" };
    const bobRoots = await (await fetch(`${base}/api/remote-folders?threadId=thread-a`, { headers: bobHeaders })).json();
    assert.equal(bobRoots.ownerUserId, "bob");
    assert.deepEqual(bobRoots.data.map((folder) => folder.id), ["beta"]);
    assert.equal((await fetch(`${base}/api/remote-folders/alpha/entries?threadId=thread-a`, { headers: bobHeaders })).status, 404);
    const bobCatalog = await (await fetch(`${base}/api/remote-folders/catalog`, { headers: bobHeaders })).json();
    assert.deepEqual(bobCatalog.data.hosts.map(host => host.name), ["bob-computer"]);
    assert.deepEqual(bobCatalog.data.recent.map(folder => folder.id), ["beta"]);
    assert.equal((await fetch(`${base}/api/remote-folders/beta/entries`, { headers })).status, 404);
    assert.deepEqual((await (await fetch(`${base}/api/remote-folders`, { headers })).json()).data, []);
    assert.equal((await fetch(`${base}/api/remote-folders/alpha/entries?threadId=thread-b`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/remote-folders/gamma/entries?threadId=thread-a`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/remote-folders/alpha/entries`, { headers })).status, 404);
    const disconnected = await fetch(`${base}/api/remote-folders/alpha/entries?threadId=thread-a`, { headers });
    assert.equal(disconnected.status, 503);
    assert.match((await disconnected.json()).error, /已断开/);
    assert.equal((await fetch(`${base}/api/remote-folders?threadId=..%2Fthread-a`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/remote-folders`, { method: "POST", headers })).status, 405);
    assert.equal((await fetch(`${base}/api/remote-folders/alpha/close`, { method: "POST", headers, body: "threadId=thread-a" })).status, 415);
    const jsonHeaders = { ...headers, "content-type": "application/json" };
    for (const [id, threadId, accountHeaders] of [
      ["gamma", "thread-a", jsonHeaders],
      ["alpha", "thread-b", jsonHeaders],
      ["alpha", "thread-a", { ...bobHeaders, "content-type": "application/json" }]
    ]) {
      const restore = await fetch(`${base}/api/remote-folders/${id}/reconnect`, { method: "POST", headers: accountHeaders, body: JSON.stringify({ threadId }) });
      assert.equal(restore.status, 404, "manual restore must not open another conversation or user's directory");
    }
    assert.equal((await fetch(`${base}/api/remote-folders/alpha/close`, { method: "POST", headers: { ...jsonHeaders, origin: "https://another-site.example" }, body: JSON.stringify({ threadId: "thread-a" }) })).status, 403);
    assert.equal((await fetch(`${base}/api/remote-folders/alpha/close`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ threadId: "thread-a" }) })).status, 200);
    assert.deepEqual((await (await fetch(`${base}/api/remote-folders?threadId=thread-a`, { headers })).json()).data, []);
    assert.equal((await fetch(`${base}/api/remote-folders/alpha/reconnect`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ threadId: "thread-a" }) })).status, 404);
    await assert.rejects(controlRemoteFolder(path.join(root, "alice"), "reconnect", { threadId: "thread-a", folderId: "alpha" }), /未找到此对话/);
    assert.deepEqual((await (await fetch(`${base}/api/remote-folders?threadId=thread-b`, { headers })).json()).data.map((folder) => folder.id), ["gamma"]);
    const catalog = await (await fetch(`${base}/api/remote-folders/catalog`, { headers })).json();
    assert.deepEqual(catalog.data.recent.map((folder) => folder.id), ["alpha", "gamma"]);
    assert.deepEqual(catalog.data.hosts.map(host => host.name), ["alice-computer"]);
    const foreignHost = await fetch(`${base}/api/remote-folders/browse`, { method: "POST", headers: { ...bobHeaders, "content-type": "application/json" }, body: JSON.stringify({ hostId: catalog.data.hosts[0].id }) });
    assert.equal(foreignHost.status, 503);
    assert.match((await foreignHost.json()).error, /尚未在当前账号/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("directory selections survive reload, close independently, and transfer from a new conversation draft", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-folder-views-"));
  try {
    await registry(root, [
      { ...entry(root, "alpha"), thread_ids: ["thread-a", "thread-b", "draft-new"] },
      entry(root, "legacy")
    ]);
    assert.deepEqual(await readRemoteFolders(root, "draft-new"), []);
    await writeFile(path.join(root, ".codex/remote-folder-views.json"), JSON.stringify({ "draft-new": ["alpha"], "thread-a": ["alpha", "legacy"] }));
    await controlRemoteFolder(root, "transfer", { draftId: "draft-new", threadId: "new-real-thread" });
    assert.deepEqual((await readRemoteFolders(root, "new-real-thread")).map((folder) => folder.id), ["alpha"]);
    await controlRemoteFolder(root, "close", { threadId: "new-real-thread", folderId: "alpha" });
    assert.deepEqual(await readRemoteFolders(root, "new-real-thread"), []);
    assert.deepEqual((await readRemoteFolders(root, "thread-b")).map((folder) => folder.id), ["alpha"]);
    await controlRemoteFolder(root, "close", { threadId: "thread-a", folderId: "legacy" });
    assert.deepEqual((await readRemoteFolders(root, "thread-a")).map((folder) => folder.id), ["alpha"]);
    assert.equal((await controlRemoteFolder(root, "catalog")).recent.length, 2);
    await controlRemoteFolder(root, "transfer", { draftId: "draft-no-selection", threadId: "new-empty-thread" });
    assert.deepEqual(await readRemoteFolders(root, "new-empty-thread"), []);
    await assert.rejects(controlRemoteFolder(root, "browse", { hostId: "not-this-users-computer" }), /尚未在当前账号/);
    await assert.rejects(controlRemoteFolder(root, "transfer", { draftId: "thread-b", threadId: "thread-a" }), /绑定无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
