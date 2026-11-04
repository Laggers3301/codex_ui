import { createRequire } from "node:module";

// Initialization/control messages only. Never submit a user message or persist
// a native session just to read the client's versioned model catalogue.
const require = createRequire(new URL("../integrations/claude-session-tools/package.json", import.meta.url));
const { query } = await import(require.resolve("@anthropic-ai/claude-agent-sdk"));
const controller = new AbortController();
let release;
const gate = new Promise(resolve => { release = resolve; });
const prompt = (async function* () { await gate; })();
const stream = query({ prompt, options: {
  cwd: process.argv[3], pathToClaudeCodeExecutable: process.argv[2],
  env: { ...process.env, CLAUDE_CODE_DISABLE_WORKFLOWS: "1" },
  persistSession: false, settingSources: [], tools: [], abortController: controller
} });
const timeout = setTimeout(() => controller.abort(), 25_000);
try { process.stdout.write(JSON.stringify(await stream.supportedModels()) + "\n"); }
finally { clearTimeout(timeout); release(); controller.abort(); await stream.return(undefined).catch(() => {}); }
