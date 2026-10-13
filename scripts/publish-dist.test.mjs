import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { publishDist } from "./publish-dist.mjs";

test("publish retains old chunks and installs all new resources before the entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-publish-test-"));
  try {
    const dist = path.join(root, "dist"), staged = path.join(root, "staged");
    await mkdir(path.join(dist, "assets"), { recursive: true }); await mkdir(path.join(staged, "assets"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "old-entry"); await writeFile(path.join(dist, "assets/old.js"), "old-script");
    await writeFile(path.join(staged, "index.html"), "new-entry"); await writeFile(path.join(staged, "assets/new.js"), "new-script");
    await publishDist(staged, dist);
    assert.equal(await readFile(path.join(dist, "index.html"), "utf8"), "new-entry");
    assert.equal(await readFile(path.join(dist, "assets/new.js"), "utf8"), "new-script");
    assert.equal(await readFile(path.join(dist, "assets/old.js"), "utf8"), "old-script");
    await rm(path.join(staged, "index.html")); await assert.rejects(publishDist(staged, dist));
    assert.equal(await readFile(path.join(dist, "index.html"), "utf8"), "new-entry");
  } finally { await rm(root, { recursive: true, force: true }); }
});
