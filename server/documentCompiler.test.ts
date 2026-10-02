import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { DocumentCompiler } from "./documentCompiler.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-compiler-test-"));
  const project = path.join(root, "project"); const tools = path.join(root, "tools"); const runtime = path.join(root, "runtime");
  await fs.mkdir(path.join(project, "chapters"), { recursive: true }); await fs.mkdir(path.join(tools, "bin"), { recursive: true });
  await fs.writeFile(path.join(project, "main.tex"), "\\input{chapters/intro}\n");
  await fs.writeFile(path.join(project, "chapters", "intro.tex"), "Hello\n");
  await fs.writeFile(path.join(project, ".env"), "DO_NOT_COPY=secret\n");
  await fs.writeFile(path.join(project, "credentials.json"), "secret\n");
  await fs.writeFile(path.join(tools, "bin", "latexmk"), "test tool"); await fs.writeFile(path.join(tools, "bin", "pandoc"), "test tool"); await fs.writeFile(path.join(tools, "bin", "libreoffice"), "test tool");
  for (const tool of ["pdflatex", "xelatex", "lualatex", "synctex"]) await fs.writeFile(path.join(tools, "bin", tool), "test tool");
  const bwrap = path.join(root, "bwrap"); await fs.writeFile(bwrap, "test sandbox");
  return { root, project, tools, runtime, bwrap };
}

describe("DocumentCompiler", () => {
  it("snapshots relative project inputs without credentials and binds compile output to source hash/version", async () => {
    const f = await fixture();
    const calls: string[][] = [];
    const compiler = new DocumentCompiler({ toolRoot: f.tools, tempRoot: f.runtime, bwrapPath: f.bwrap,
      runner: async (_command, args, options) => {
        calls.push(args);
        expect(await fs.readFile(path.join(options.cwd, "src", "chapters", "intro.tex"), "utf8")).toContain("Hello");
        await expect(fs.stat(path.join(options.cwd, "src", ".env"))).rejects.toMatchObject({ code: "ENOENT" });
        await fs.writeFile(path.join(options.cwd, "out", "main.pdf"), "%PDF-fake");
        return { stdout: "", stderr: "" };
      } });
    try {
      const queued = await compiler.startCompile({ projectId: "p1", userId: "u1", projectRoot: f.project, path: "main.tex", version: "v42", engine: "xelatex" });
      expect(["queued", "running"]).toContain(queued.state);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const done = compiler.getJob(queued.id, "p1", "u1");
      expect(done?.state).toBe("succeeded"); expect(done?.version).toBe("v42"); expect(done?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(done?.pdfUrl).toContain(queued.id);
      expect(compiler.getArtifact(queued.id, "wrong-project", "u1")).toBeUndefined();
      expect(compiler.getArtifact(queued.id, "p1", "u1")?.contentType).toBe("application/pdf");
      expect(calls[0]).toContain("--unshare-net"); expect(calls[0]).toContain("--unshare-pid"); expect(calls[0]).toContain("-norc"); expect(calls[0].some((arg) => arg.includes("-no-shell-escape"))).toBe(true);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it("fails closed without bubblewrap and rejects traversal and symlink inputs", async () => {
    const f = await fixture();
    const compiler = new DocumentCompiler({ toolRoot: f.tools, tempRoot: f.runtime, bwrapPath: path.join(f.root, "missing-bwrap") });
    try {
      await expect(compiler.startCompile({ projectId: "p", userId: "u", projectRoot: f.project, path: "main.tex", version: "1" })).rejects.toThrow("sandbox");
      await expect(compiler.startCompile({ projectId: "p", userId: "u", projectRoot: f.project, path: "../outside.tex", version: "1" })).rejects.toThrow("stay inside");
      await fs.writeFile(path.join(f.root, "outside.tex"), "outside"); await fs.symlink(path.join(f.root, "outside.tex"), path.join(f.project, "linked.tex"));
      const sandboxed = new DocumentCompiler({ toolRoot: f.tools, tempRoot: f.runtime, bwrapPath: f.bwrap });
      await expect(sandboxed.startCompile({ projectId: "p", userId: "u", projectRoot: f.project, path: "linked.tex", version: "1" })).rejects.toThrow();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it("does not advertise Word PDF conversion from an unverified or incomplete office tool path", async () => {
    const f = await fixture();
    const compiler = new DocumentCompiler({ toolRoot: f.tools, tempRoot: f.runtime, bwrapPath: f.bwrap });
    try {
      expect(compiler.capabilities().officePdf).toBe(false);
      await expect(compiler.startConvert({ projectId: "p", userId: "u", projectRoot: f.project, path: "main.tex", version: "1", to: "pdf" })).rejects.toThrow("unavailable");
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it("keeps traversal anchored when a captured directory is swapped for an outside symlink", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "intro.tex"), "OUTSIDE_SECRET_SENTINEL\n");
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (!swapped && String(file).endsWith("/chapters") && typeof flags === "number" && (flags & fs.constants.O_DIRECTORY)) {
        await fs.rename(path.join(f.project, "chapters"), path.join(f.project, "captured-chapters"));
        await fs.symlink(outside, path.join(f.project, "chapters"));
        swapped = true;
      }
      return handle;
    });
    const compiler = new DocumentCompiler({ toolRoot: f.tools, tempRoot: f.runtime, bwrapPath: f.bwrap,
      runner: async (_command, _args, options) => {
        const captured = await fs.readFile(path.join(options.cwd, "src", "chapters", "intro.tex"), "utf8");
        expect(captured).toContain("Hello");
        expect(captured).not.toContain("OUTSIDE_SECRET_SENTINEL");
        await fs.writeFile(path.join(options.cwd, "out", "main.pdf"), "%PDF-fake");
        return { stdout: "", stderr: "" };
      } });
    try {
      const queued = await compiler.startCompile({ projectId: "p-race", userId: "u-race", projectRoot: f.project, path: "main.tex", version: "race-v1", engine: "xelatex" });
      expect(swapped).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(compiler.getJob(queued.id, "p-race", "u-race")?.state).toBe("succeeded");
    } finally { openSpy.mockRestore(); await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it("fails closed when the canonical project root is substituted before its descriptor opens", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside-root");
    const displaced = path.join(f.root, "project-displaced");
    await fs.mkdir(outside);
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (!swapped && String(file) === f.project && typeof flags === "number" && (flags & fs.constants.O_DIRECTORY)) {
        await fs.rename(f.project, displaced);
        await fs.symlink(outside, f.project);
        swapped = true;
      }
      return handle;
    });
    const compiler = new DocumentCompiler({ toolRoot: f.tools, tempRoot: f.runtime, bwrapPath: f.bwrap });
    try {
      await expect(compiler.startCompile({ projectId: "p-root-race", userId: "u-root-race", projectRoot: f.project, path: "main.tex", version: "root-v1", engine: "xelatex" })).rejects.toThrow("Project root changed");
      expect(swapped).toBe(true);
    } finally { openSpy.mockRestore(); await fs.rm(f.root, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.env.DOCUMENT_COMPILER_REAL_TEST !== "1")("DocumentCompiler real toolchain integration", () => {
  it("compiles BibTeX and CJK with all three engines and maps SyncTeX to the captured version", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-compiler-real-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "main.tex"), String.raw`\documentclass{article}
\usepackage{iftex}
\ifPDFTeX
  \usepackage{CJKutf8}
  \newcommand{\TestCJK}[1]{\begin{CJK}{UTF8}{gbsn}#1\end{CJK}}
\else
  \usepackage[UTF8]{ctex}
  \newcommand{\TestCJK}[1]{#1}
\fi
\begin{document}
\section{\TestCJK{中文标题}}
An English sentence cites \cite{sample}.
\newpage
\input{chapters/chapter}
\bibliographystyle{plain}
\bibliography{references}
\end{document}
`);
    const chapterSource = String.raw`\section{Included chapter}
This text is from an included source file: \TestCJK{第二页内容}.
`;
    await fs.mkdir(path.join(project, "chapters"));
    await fs.writeFile(path.join(project, "chapters", "chapter.tex"), chapterSource);
    await fs.writeFile(path.join(project, "references.bib"), "@article{sample, author={Test Author}, title={A Reference}, journal={Example Journal}, year={2024}}\n");
    await fs.writeFile(path.join(project, "notes.md"), "# Conversion check\n\nPandoc keeps this **semantic** heading. The equation is $E = mc^2$.\n");
    const compiler = new DocumentCompiler({ toolRoot: process.env.DOCUMENT_TOOLS_ROOT, tempRoot: path.join(root, "jobs"), wallTimeMs: 120_000 });
    try {
      expect(compiler.capabilities().engines).toEqual(["pdflatex", "xelatex", "lualatex"]);
      expect(compiler.capabilities().officePdf).toBe(true);
      for (const engine of ["pdflatex", "xelatex", "lualatex"] as const) {
        const started = await compiler.startCompile({ projectId: "real-project", userId: "real-user", projectRoot: project, path: "main.tex", version: `source-${engine}`, engine });
        const deadline = Date.now() + 120_000;
        let job = compiler.getJob(started.id, "real-project", "real-user");
        while (job && !["succeeded", "failed", "cancelled"].includes(job.state) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          job = compiler.getJob(started.id, "real-project", "real-user");
        }
        expect(job?.state, `${engine}: ${job?.error ?? job?.log}`).toBe("succeeded");
        expect(job?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
        expect(job?.version).toBe(`source-${engine}`);
        const artifact = compiler.getArtifact(started.id, "real-project", "real-user");
        expect(artifact?.contentType).toBe("application/pdf");
        expect((await fs.stat(artifact!.path)).size).toBeGreaterThan(1000);
        if (engine === "xelatex" && process.env.DOCUMENT_COMPILER_PDF_DEST) {
          await fs.mkdir(path.dirname(process.env.DOCUMENT_COMPILER_PDF_DEST), { recursive: true });
          await fs.copyFile(artifact!.path, process.env.DOCUMENT_COMPILER_PDF_DEST);
        }
        if (engine === "xelatex") {
          const position = await compiler.synctex({ jobId: started.id, page: 2, x: 120, y: 120, projectId: "real-project", userId: "real-user" });
          expect(position?.path).toBe("chapters/chapter.tex");
          expect(position?.version).toBe(createHash("sha256").update(chapterSource).digest("hex"));
          expect(position?.line).toBeGreaterThan(0);
        }
      }
      const docxJob = await compiler.startConvert({ projectId: "real-project", userId: "real-user", projectRoot: project, path: "notes.md", version: "markdown-v1", to: "docx", targetPath: "converted.docx" });
      const waitForTerminal = async (id: string) => {
        const deadline = Date.now() + 30_000; let job = compiler.getJob(id, "real-project", "real-user");
        while (job && !["succeeded", "failed", "cancelled"].includes(job.state) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100)); job = compiler.getJob(id, "real-project", "real-user");
        }
        return job;
      };
      const docxDone = await waitForTerminal(docxJob.id);
      expect(docxDone?.state, docxDone?.error).toBe("succeeded"); expect(docxDone?.outputPath).toBe("converted.docx");
      const docx = compiler.getArtifact(docxJob.id, "real-project", "real-user");
      expect(docx?.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      await fs.copyFile(docx!.path, path.join(project, "roundtrip.docx"));
      const texJob = await compiler.startConvert({ projectId: "real-project", userId: "real-user", projectRoot: project, path: "roundtrip.docx", version: "docx-v1", to: "tex" });
      const texDone = await waitForTerminal(texJob.id);
      expect(texDone?.state, texDone?.error).toBe("succeeded");
      const tex = compiler.getArtifact(texJob.id, "real-project", "real-user");
      expect(tex?.filename).toBe("roundtrip.tex");
      expect(await fs.readFile(tex!.path, "utf8")).toContain("Conversion check");
      const pdfJob = await compiler.startConvert({ projectId: "real-project", userId: "real-user", projectRoot: project, path: "roundtrip.docx", version: "docx-pdf-v1", to: "pdf" });
      const pdfDone = await waitForTerminal(pdfJob.id);
      expect(pdfDone?.state, pdfDone?.error).toBe("succeeded");
      const pdf = compiler.getArtifact(pdfJob.id, "real-project", "real-user");
      expect(pdf?.contentType).toBe("application/pdf");
      expect((await fs.stat(pdf!.path)).size).toBeGreaterThan(1000);
      const pdfText = execFileSync("pdftotext", ["-layout", pdf!.path, "-"], { encoding: "utf8" });
      expect(pdfText).toMatch(/E\s*=\s*mc/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 300_000);
});
