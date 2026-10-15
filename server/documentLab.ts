import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { authenticatedUserFromHeaders } from "./auth.js";
import { serverConfig } from "./config.js";
import { ProjectStore } from "./db.js";
import { DocumentCompiler } from "./documentCompiler.js";
import { registerDocumentWorkbenchRoutes } from "./documentWorkbench.js";

/** Standalone document-workbench lab: no Codex runtime, bridge, or production index imports. */
export async function startDocumentLab(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: true });
  const store = new ProjectStore(path.join(serverConfig.dataDir, "codex-web.sqlite"));
  const compiler = new DocumentCompiler();
  app.addHook("onRequest", async (request, reply) => {
    const user = authenticatedUserFromHeaders(request.headers);
    if (!user || user === "auth-disabled") return reply.code(401).send({ error: "Document Lab requires an authenticated session cookie." });
  });
  registerDocumentWorkbenchRoutes(app, store, { compiler });
  app.addHook("onClose", async () => { store.close(); });
  await app.listen({ host: "127.0.0.1", port: 4591 });
  return app;
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryUrl && import.meta.url === entryUrl) await startDocumentLab();
