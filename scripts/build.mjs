import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { publishDist } from "./publish-dist.mjs";

// Prepare the large, lazy native editor separately, so Rollup need not retain
// its entire dependency AST alongside the main application. Build-only limits
// never relax the running backend or document compiler.
const prepare = fileURLToPath(new URL("./prepare-superdoc-vendor.mjs", import.meta.url));
const prepared = spawnSync(process.execPath, ["--max-old-space-size=1536", prepare], { stdio: "inherit", env: process.env });
if (prepared.error) throw prepared.error;
if (prepared.status !== 0) process.exit(prepared.status ?? 1);
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg === "--outDir" || arg.startsWith("--outDir="))) throw new Error("Use the safe default build destination; custom --outDir is unsupported");
const frontend = fileURLToPath(new URL("../", import.meta.url));
const staging = await mkdtemp(path.join(frontend, ".dist-staging-"));
try {
  const result = spawnSync(process.execPath, ["--max-old-space-size=3072", vite, "build", ...args, "--outDir", staging], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0) { await publishDist(staging, path.join(frontend, "dist")); console.log("Published frontend without removing the previous entry or hashed assets."); }
} finally { await rm(staging, { recursive: true, force: true }); }
