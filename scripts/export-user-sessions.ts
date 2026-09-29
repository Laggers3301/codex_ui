import { spawn } from "node:child_process";
import { ProjectStore } from "../server/db.js";
import { removeStagedUserHandoff, stageUserHandoffExport } from "../server/userHandoff.js";

async function main(): Promise<void> {
  const userId = process.argv[2] ?? "";
  const sourceLabel = process.env.CODEX_WEB_INSTANCE_LABEL ?? "source-host";
  const store = new ProjectStore();
  let staged: Awaited<ReturnType<typeof stageUserHandoffExport>> | null = null;
  try {
    staged = await stageUserHandoffExport(store, userId, sourceLabel);
    const child = spawn("tar", ["-C", staged.workDir, "-czf", "-", "manifest.json", "sessions"], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    child.stdout.pipe(process.stdout);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (exitCode !== 0) {
      throw new Error(`无法生成迁移包（tar exit ${exitCode ?? "unknown"}）。`);
    }
  } finally {
    store.close();
    if (staged) {
      await removeStagedUserHandoff(staged.workDir);
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
