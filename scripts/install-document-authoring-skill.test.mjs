import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installDocumentAuthoringSkill, skillName } from "./install-document-authoring-skill.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-authoring-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "SKILL.md"), "manifest");
  const homes = ["gpt", "provider"].map((name) => {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, "skills"), { recursive: true });
    fs.writeFileSync(path.join(home, "auth.json"), "credential-sentinel");
    return home;
  });
  const poolFile = path.join(root, "pool.json");
  fs.writeFileSync(poolFile, JSON.stringify({ accounts: homes.map((codexHome, index) => ({ id: String(index), codexHome })) }));
  return { root, source, homes, poolFile };
}

test("dry run checks destinations without installing or changing credentials", (t) => {
  const f = fixture(t);
  assert.equal(installDocumentAuthoringSkill({ ...f, dryRun: true }).length, 2);
  for (const home of f.homes) {
    assert.equal(fs.existsSync(path.join(home, "skills", skillName)), false);
    assert.equal(fs.readFileSync(path.join(home, "auth.json"), "utf8"), "credential-sentinel");
  }
});

test("installs idempotently to account and provider runtimes", (t) => {
  const f = fixture(t);
  installDocumentAuthoringSkill(f);
  assert.ok(installDocumentAuthoringSkill(f).every((item) => item.alreadyInstalled));
  for (const home of f.homes) assert.equal(fs.realpathSync(path.join(home, "skills", skillName)), f.source);
});

test("a conflict is detected before any new links are created", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.homes[1], "skills", skillName));
  assert.throws(() => installDocumentAuthoringSkill(f), /Refusing to replace/);
  assert.equal(fs.existsSync(path.join(f.homes[0], "skills", skillName)), false);
});

test("dangling user-owned links are not replaced", (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, "missing"), path.join(f.homes[1], "skills", skillName));
  assert.throws(() => installDocumentAuthoringSkill(f), /dangling/);
  assert.equal(fs.existsSync(path.join(f.homes[0], "skills", skillName)), false);
});
