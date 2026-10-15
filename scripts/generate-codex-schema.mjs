import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outDir = resolve("server/generated/codex-app-server");
mkdirSync(outDir, { recursive: true });

const result = spawnSync("codex", ["app-server", "generate-ts", "--experimental", "--out", outDir], {
  stdio: "inherit"
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
