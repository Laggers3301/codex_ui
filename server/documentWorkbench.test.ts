import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionCookie } from "./auth.js";
import { ProjectStore } from "./db.js";
import { DocumentCompiler } from "./documentCompiler.js";
import { DocumentWorkbenchError, DocumentWorkbenchService, registerDocumentWorkbenchRoutes } from "./documentWorkbench.js";

describe("document workbench", () => {
  it("scopes routes to the logged-in project owner and rejects traversal", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-workbench-"));
    const root = path.join(tmp, "project"); fs.mkdirSync(root);
    const store = new ProjectStore(path.join(tmp, "db.sqlite"));
    const alice = store.createUser("alice"), bob = store.createUser("bob");
    const owned = store.createProject({ name: "owned", rootPath: root, userId: alice.id });
    const foreign = store.createProject({ name: "foreign", rootPath: root, userId: bob.id });
    const app = Fastify();
    try {
      registerDocumentWorkbenchRoutes(app, store);
      const cookie = createSessionCookie(alice.id).split(";")[0];
      expect((await app.inject({ method: "GET", url: `/api/projects/${foreign.id}/documents/tree`, headers: { cookie } })).statusCode).toBe(404);
      const tree = await app.inject({ method: "GET", url: `/api/projects/${owned.id}/documents/tree`, headers: { cookie } });
      expect(tree.statusCode).toBe(200);
      const traversal = await app.inject({ method: "GET", url: `/api/projects/${owned.id}/documents/open?path=..%2Foutside.tex`, headers: { cookie } });
      expect(traversal.statusCode).toBe(400);
    } finally { await app.close(); store.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("blocks symlink escapes, serializes CAS saves, and keeps an original backup", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-workbench-"));
    const root = path.join(tmp, "project"); fs.mkdirSync(root);
    const secret = path.join(tmp, "secret.tex"); fs.writeFileSync(secret, "outside"); fs.symlinkSync(secret, path.join(root, "escape.tex"));
    const file = path.join(root, "main.tex"); fs.writeFileSync(file, "original");
    const service = new DocumentWorkbenchService(root);
    const independentService = new DocumentWorkbenchService(root);
    try {
      expect(() => service.open("escape.tex")).toThrow(DocumentWorkbenchError);
      const version = service.open("main.tex").version;
      const results = await Promise.allSettled([
        service.save({ path: "main.tex", baseVersion: version, content: "first" }),
        independentService.save({ path: "main.tex", baseVersion: version, content: "second" })
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(fs.readFileSync(file, "utf8")).not.toBe("original");
      const history = path.join(root, ".document-workbench-history");
      expect(fs.readdirSync(history).length).toBe(1);
      expect(fs.readFileSync(path.join(history, fs.readdirSync(history)[0]), "utf8")).toBe("original");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("refuses a history-directory symlink instead of writing a backup outside the project", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-workbench-history-"));
    const root = path.join(tmp, "project"), outside = path.join(tmp, "outside");
    fs.mkdirSync(root); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "main.tex"), "original");
    fs.symlinkSync(outside, path.join(root, ".document-workbench-history"));
    const service = new DocumentWorkbenchService(root);
    try {
      const version = service.open("main.tex").version;
      await expect(service.save({ path: "main.tex", baseVersion: version, content: "updated" })).rejects.toMatchObject({ statusCode: 400 });
      expect(fs.readFileSync(path.join(root, "main.tex"), "utf8")).toBe("original");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("requires explicit creation and rejects oversized text", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-workbench-"));
    const service = new DocumentWorkbenchService(tmp);
    try {
      expect(() => service.open("new.tex")).toThrow();
      const created = await service.save({ path: "new.tex", baseVersion: null, content: "hello", create: true });
      expect(created.content).toBe("hello");
      await expect(service.save({ path: "new.tex", baseVersion: created.version, content: "overwrite", create: true })).rejects.toThrow(/already exists/);
      await expect(service.save({ path: "large.tex", baseVersion: null, content: "x".repeat(2 * 1024 * 1024 + 1), create: true })).rejects.toMatchObject({ statusCode: 413 });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("uses the concrete compiler projectRoot/job bindings and gates streamed artifacts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-workbench-compiler-"));
    const root = path.join(tmp, "project"); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "main.tex"), "\\documentclass{article}\\begin{document}ok\\end{document}\n");
    fs.writeFileSync(path.join(root, "inline.pdf"), "%PDF-1.7\ninline\n%%EOF\n");
    const tools = path.join(tmp, "tools"); fs.mkdirSync(path.join(tools, "bin"), { recursive: true });
    for (const name of ["latexmk", "pdflatex"]) fs.writeFileSync(path.join(tools, "bin", name), "stub");
    const store = new ProjectStore(path.join(tmp, "db.sqlite"));
    const alice = store.createUser("compiler-user"), bob = store.createUser("other-user");
    const project = store.createProject({ name: "compiler", rootPath: root, userId: alice.id });
    const foreignRoot = path.join(tmp, "foreign"); fs.mkdirSync(foreignRoot);
    const foreign = store.createProject({ name: "foreign", rootPath: foreignRoot, userId: bob.id });
    const runner = async (_command: string, args: string[]) => {
      const bindAt = args.findIndex((arg, index) => arg === "--bind" && args[index + 2] === "/out");
      if (bindAt < 0) throw new Error("compiler did not mount its job output directory");
      const outDir = args[bindAt + 1];
      fs.writeFileSync(path.join(outDir, "main.pdf"), "%PDF-1.7\ncompiled\n%%EOF\n");
      return { stdout: "", stderr: "" };
    };
    const compiler = new DocumentCompiler({ toolRoot: tools, tempRoot: path.join(tmp, "jobs"), runner, jobTtlMs: 60_000 });
    const app = Fastify();
    try {
      registerDocumentWorkbenchRoutes(app, store, { compiler });
      const aliceCookie = createSessionCookie(alice.id).split(";")[0];
      const bobCookie = createSessionCookie(bob.id).split(";")[0];
      const opened = await app.inject({ method: "GET", url: `/api/projects/${project.id}/documents/open?path=main.tex`, headers: { cookie: aliceCookie } });
      expect(opened.statusCode).toBe(200);
      const tree = await app.inject({ method: "GET", url: `/api/projects/${project.id}/documents/tree`, headers: { cookie: aliceCookie } });
      expect(tree.json().data.capabilities).toMatchObject({ latex: true, engines: ["pdflatex"] });
      const started = await app.inject({ method: "POST", url: `/api/projects/${project.id}/documents/compile`, headers: { cookie: aliceCookie }, payload: { path: "main.tex", version: opened.json().data.version, engine: "pdflatex" } });
      expect(started.statusCode).toBe(200);
      const jobId = started.json().data.id as string;
      let job = compiler.getJob(jobId, project.id, alice.id);
      for (let tries = 0; tries < 100; tries += 1) {
        if (!job || (job.state !== "queued" && job.state !== "running")) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
        job = compiler.getJob(jobId, project.id, alice.id);
      }
      expect(job?.state).toBe("succeeded");
      const fetched = await app.inject({ method: "GET", url: `/api/projects/${project.id}/documents/jobs/${jobId}`, headers: { cookie: aliceCookie } });
      expect(fetched.statusCode).toBe(200);
      const artifact = await app.inject({ method: "GET", url: `/api/projects/${project.id}/documents/jobs/${jobId}/artifact`, headers: { cookie: aliceCookie } });
      expect(artifact.statusCode).toBe(200);
      expect(artifact.headers["content-type"]).toContain("application/pdf");
      expect(artifact.body).toContain("%PDF-");
      const compilerArtifactUrl = await app.inject({ method: "GET", url: `/api/documents/jobs/${jobId}/artifact`, headers: { cookie: aliceCookie } });
      expect(compilerArtifactUrl.statusCode).toBe(200);
      expect(compilerArtifactUrl.headers["content-type"]).toContain("application/pdf");
      const foreignArtifact = await app.inject({ method: "GET", url: `/api/projects/${foreign.id}/documents/jobs/${jobId}/artifact`, headers: { cookie: bobCookie } });
      expect(foreignArtifact.statusCode).toBe(404);
      const foreignCompilerArtifactUrl = await app.inject({ method: "GET", url: `/api/documents/jobs/${jobId}/artifact`, headers: { cookie: bobCookie } });
      expect(foreignCompilerArtifactUrl.statusCode).toBe(404);
      const pdfOpen = await app.inject({ method: "GET", url: `/api/projects/${project.id}/documents/open?path=inline.pdf`, headers: { cookie: aliceCookie } });
      expect(pdfOpen.statusCode).toBe(200);
      expect(pdfOpen.json().data).toMatchObject({ kind: "pdf", path: "inline.pdf" });
      const pdf = await app.inject({ method: "GET", url: `/api/projects/${project.id}/documents/raw?path=inline.pdf`, headers: { cookie: aliceCookie } });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      expect(pdf.body).toContain("%PDF-");
    } finally { await app.close(); store.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
