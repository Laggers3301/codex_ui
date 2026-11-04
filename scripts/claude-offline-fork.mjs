import { createRequire } from "node:module";
// Keep the modern filesystem-only SDK (Zod 4) isolated from the host's existing
// runtime dependencies (Zod 3). No model process is started by this worker.
const sessionRequire = createRequire(new URL("../integrations/claude-session-tools/package.json", import.meta.url));
const { forkSession } = await import(sessionRequire.resolve("@anthropic-ai/claude-agent-sdk"));
const [sessionId, cwd, title, upToMessageId] = process.argv.slice(2);
const result = await forkSession(sessionId, { ...(cwd ? { dir: cwd } : {}), ...(title ? { title } : {}), ...(upToMessageId ? { upToMessageId } : {}) });
process.stdout.write(JSON.stringify(result) + "\n");
