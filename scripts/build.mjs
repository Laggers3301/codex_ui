import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Prepare the large, lazy native editor separately, so Rollup need not retain
// its entire dependency AST alongside the main application. Build-only limits
// never relax the running backend or document compiler.
const prepare = fileURLToPath(new URL("./prepare-superdoc-vendor.mjs", import.meta.url));
const prepared = spawnSync(process.execPath, ["--max-old-space-size=1536", prepare], { stdio: "inherit", env: process.env });
if (prepared.error) throw prepared.error;
if (prepared.status !== 0) process.exit(prepared.status ?? 1);
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const result = spawnSync(process.execPath, ["--max-old-space-size=3072", vite, "build", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
