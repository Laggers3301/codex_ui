#!/usr/bin/env node
// Install only this public skill. Never read or modify runtime credentials.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const skillName = "latex-word-authoring";
const appRoot = fileURLToPath(new URL("../", import.meta.url));

export function installDocumentAuthoringSkill({ poolFile, source, dryRun = false }) {
  const skillRoot = fs.realpathSync(source);
  if (!fs.statSync(path.join(skillRoot, "SKILL.md")).isFile()) throw new Error("Skill manifest missing");
  const pool = JSON.parse(fs.readFileSync(poolFile, "utf8"));
  if (!Array.isArray(pool.accounts)) throw new Error("Account pool must contain accounts");
  const targets = [];
  const seen = new Set();
  for (const account of pool.accounts.filter((item) => item.enabled !== false)) {
    if (typeof account.codexHome !== "string" || !path.isAbsolute(account.codexHome)) throw new Error("Runtime home must be absolute");
    const home = fs.realpathSync(account.codexHome);
    const parent = path.join(home, "skills");
    if (!fs.statSync(parent).isDirectory()) throw new Error("Runtime skills directory missing");
    const canonicalParent = fs.realpathSync(parent);
    const destination = path.join(canonicalParent, skillName);
    if (seen.has(destination)) continue;
    seen.add(destination);
    let alreadyInstalled = false;
    try {
      fs.lstatSync(destination);
      alreadyInstalled = fs.realpathSync(destination) === skillRoot;
      if (!alreadyInstalled) throw new Error(`Refusing to replace an existing skill: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A dangling symlink is still an existing user-owned destination.
      try { fs.lstatSync(destination); throw new Error(`Refusing to replace a dangling skill link: ${destination}`); }
      catch (nested) { if (nested.code !== "ENOENT") throw nested; }
    }
    targets.push({ id: String(account.id), destination, alreadyInstalled });
  }
  // Check every destination before installing anything; no overwrites.
  if (!dryRun) for (const target of targets) {
    if (!target.alreadyInstalled) fs.symlinkSync(skillRoot, target.destination, "dir");
  }
  return targets;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: node scripts/install-document-authoring-skill.mjs [--dry-run]");
    const targets = installDocumentAuthoringSkill({
      poolFile: process.env.CODEX_WEB_ACCOUNT_POOL_FILE || path.join(appRoot, "account-pool.json"),
      source: path.join(appRoot, "skills", skillName),
      dryRun: args.includes("--dry-run")
    });
    console.log(JSON.stringify({ skill: skillName, dryRun: args.includes("--dry-run"), runtimes: targets }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
