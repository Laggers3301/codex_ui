import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export type DocumentJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type DocumentEngine = "pdflatex" | "xelatex" | "lualatex";
export type DocumentJob = {
  id: string; projectId: string; userId: string; state: DocumentJobState; version: string;
  path: string; sourceHash?: string; pdfUrl?: string; outputPath?: string; log?: string; error?: string;
  createdAt: number; finishedAt?: number;
};
export type DocumentCompilerOptions = {
  tempRoot?: string; bwrapPath?: string; toolRoot?: string; latexmkPath?: string;
  pandocPath?: string; libreOfficePath?: string; synctexPath?: string; maxQueuedPerUser?: number;
  jobTtlMs?: number; wallTimeMs?: number; maxProjectBytes?: number; maxProjectFiles?: number;
  runner?: (command: string, args: string[], options: { cwd: string; timeoutMs: number; onSpawn?: (child: ChildProcess | undefined) => void }) => Promise<{ stdout: string; stderr: string }>;
};
type Request = { projectId: string; userId: string; projectRoot: string; path: string; version: string; engine?: DocumentEngine; to?: "docx" | "tex" | "pdf"; targetPath?: string; kind: "compile" | "convert" };
type InternalJob = DocumentJob & { projectRoot: string; jobDir: string; snapshotDir: string; outputDir: string; process?: ChildProcess; cancelRequested?: boolean; sourceFiles: Set<string>; sourceVersions: Map<string, string>; request: Request; kind: Request["kind"] };

const IGNORE_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".cache", ".codex", ".ssh", ".aws", ".config"]);
const SECRET_NAME = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?|authorized_keys|known_hosts)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|token|secret)$/i;
const SOURCE_EXT = new Set([".tex", ".sty", ".cls", ".bib", ".bst", ".def", ".cfg", ".fd", ".clo", ".bbx", ".cbx", ".lbx", ".dtx", ".ins", ".tikz", ".pgf", ".asy", ".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".ps", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".md", ".markdown", ".docx", ".odt", ".rtf", ".txt", ".csv", ".tsv", ".dat", ".xml"]);
const LOG_LIMIT = 48_000;
const terminal = new Set<DocumentJobState>(["succeeded", "failed", "cancelled"]);
const PROC_FD = "/proc/self/fd";

function sameDirectory(a: fs.Stats, b: fs.Stats): boolean { return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino; }
function isRaceSkip(error: unknown): boolean { return !!error && typeof error === "object" && ["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); }

function safeRelative(input: string): string {
  if (typeof input !== "string" || !input || input.includes("\0") || path.isAbsolute(input) || input.includes("\\")) throw new Error("Invalid project-relative document path.");
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error("Document path must stay inside the project.");
  return normalized;
}
function within(parent: string, child: string): boolean { return child === parent || child.startsWith(parent + path.sep); }
function appendLimited(prior: string, next: string): string { return (prior + next).slice(-LOG_LIMIT); }
function fileHash(parts: Array<[string, Buffer]>): string {
  const hash = createHash("sha256");
  for (const [name, content] of parts.sort(([a], [b]) => a.localeCompare(b))) { hash.update(name); hash.update("\0"); hash.update(content); hash.update("\0"); }
  return hash.digest("hex");
}

/**
 * Sandboxed document compilation/conversion. Source is copied to an immutable per-job snapshot;
 * tools never receive the host project or user home as a writable mount.
 */
export class DocumentCompiler {
  private jobs = new Map<string, InternalJob>();
  private queue: InternalJob[] = [];
  private preparingByUser = new Map<string, number>();
  private active?: InternalJob;
  private timer?: NodeJS.Timeout;
  private readonly opts: Required<Pick<DocumentCompilerOptions, "tempRoot" | "bwrapPath" | "maxQueuedPerUser" | "jobTtlMs" | "wallTimeMs" | "maxProjectBytes" | "maxProjectFiles">> & DocumentCompilerOptions;
  constructor(options: DocumentCompilerOptions = {}) {
    const env = process.env;
    this.opts = {
      ...options,
      tempRoot: options.tempRoot ?? env.DOCUMENT_TOOLS_RUNTIME ?? path.join(os.tmpdir(), "codex-document-jobs"),
      bwrapPath: options.bwrapPath ?? env.DOCUMENT_BWRAP ?? "/usr/bin/bwrap",
      maxQueuedPerUser: options.maxQueuedPerUser ?? 3,
      jobTtlMs: options.jobTtlMs ?? 60 * 60 * 1000,
      wallTimeMs: options.wallTimeMs ?? 120_000,
      maxProjectBytes: options.maxProjectBytes ?? 120 * 1024 * 1024,
      maxProjectFiles: options.maxProjectFiles ?? 12_000,
    };
  }

  capabilities(): { latex: boolean; engines: DocumentEngine[]; pandoc: boolean; officePdf: boolean } {
    const latexmk = this.tool("latexmk", this.opts.latexmkPath ?? process.env.DOCUMENT_LATEXMK);
    const pandoc = this.tool("pandoc", this.opts.pandocPath ?? process.env.DOCUMENT_PANDOC);
    const office = this.officeTool();
    const sandbox = fs.existsSync(this.opts.bwrapPath);
    const engines = (["pdflatex", "xelatex", "lualatex"] as const).filter((engine) => {
      const binary = this.tool(engine, process.env[`DOCUMENT_${engine.toUpperCase()}`]);
      return !!binary && this.toolIsMounted(binary) && fs.existsSync(binary);
    });
    const latex = sandbox && !!latexmk && this.toolIsMounted(latexmk) && fs.existsSync(latexmk) && engines.length > 0;
    return { latex, engines: latex ? [...engines] : [], pandoc: sandbox && !!pandoc && this.toolIsMounted(pandoc) && fs.existsSync(pandoc), officePdf: sandbox && !!office && this.toolIsMounted(office) && this.officePdfRuntimeReady(office) };
  }

  startCompile(input: Omit<Request, "kind" | "to"> & { engine?: DocumentEngine }): Promise<DocumentJob> {
    return this.enqueue({ ...input, kind: "compile" });
  }
  startConvert(input: Omit<Request, "kind" | "engine"> & { to: "docx" | "tex" | "pdf" }): Promise<DocumentJob> {
    return this.enqueue({ ...input, kind: "convert" });
  }
  getJob(id: string, projectId: string, userId: string): DocumentJob | undefined {
    const job = this.jobs.get(id);
    return job && job.projectId === projectId && job.userId === userId ? this.publicJob(job) : undefined;
  }
  getArtifact(id: string, projectId: string, userId: string): { path: string; contentType: string; filename: string } | undefined {
    const job = this.jobs.get(id);
    if (!job || job.projectId !== projectId || job.userId !== userId || job.state !== "succeeded") return undefined;
    const artifact = job.kind === "compile" ? path.join(job.outputDir, `${path.basename(job.path, path.extname(job.path))}.pdf`) : job.outputPath ? path.join(job.outputDir, job.outputPath) : undefined;
    if (!artifact || !within(job.outputDir, artifact) || !fs.existsSync(artifact)) return undefined;
    try { if (fs.lstatSync(artifact).isSymbolicLink() || !within(job.outputDir, fs.realpathSync(artifact))) return undefined; } catch { return undefined; }
    const ext = path.extname(artifact).toLowerCase();
    return { path: artifact, filename: path.basename(artifact), contentType: ext === ".pdf" ? "application/pdf" : ext === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/x-tex" };
  }
  async cancelJob(id: string, projectId: string, userId: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.projectId !== projectId || job.userId !== userId || terminal.has(job.state)) return false;
    job.cancelRequested = true;
    if (job.state === "queued") {
      this.queue = this.queue.filter((item) => item.id !== id);
      job.state = "cancelled"; job.finishedAt = Date.now();
      await this.removeJobFiles(job);
    } else if (job.process?.pid) this.killProcess(job.process.pid);
    return true;
  }
  async synctex(input: { jobId: string; page: number; x: number; y: number; projectId: string; userId: string }): Promise<{ path: string; line: number; column?: number; version: string } | undefined> {
    const job = this.jobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId || job.userId !== input.userId || job.state !== "succeeded" || !Number.isInteger(input.page) || input.page < 1 || !Number.isFinite(input.x) || !Number.isFinite(input.y) || Math.abs(input.x) > 100_000 || Math.abs(input.y) > 100_000) return undefined;
    const artifact = this.getArtifact(job.id, job.projectId, job.userId);
    if (!artifact || !artifact.filename.endsWith(".pdf")) return undefined;
    const synctex = this.tool("synctex", this.opts.synctexPath ?? process.env.DOCUMENT_SYNCTEX);
    if (!synctex || !fs.existsSync(synctex)) return undefined;
    try {
      const { stdout } = await this.runSandbox(job, synctex, ["edit", "-o", `${input.page}:${input.x}:${input.y}:${artifact.path}`], 10_000);
      const sourceLine = stdout.split(/\r?\n/).find((line) => line.startsWith("Input:"))?.slice(6).trim();
      const line = Number(stdout.match(/(?:^|\n)Line:\s*(\d+)/)?.[1]);
      if (!sourceLine || !Number.isInteger(line) || line < 1) return undefined;
      const mountedPath = sourceLine.replace(/^\/work\//, "").replace(/^\.\//, "");
      const relative = safeRelative(path.relative(job.snapshotDir, path.resolve(job.snapshotDir, mountedPath)));
      if (!job.sourceFiles.has(relative)) return undefined;
      const column = Number(stdout.match(/(?:^|\n)Column:\s*(\d+)/)?.[1]);
      const version = job.sourceVersions.get(relative);
      if (!version) return undefined;
      return { path: relative, line, ...(Number.isInteger(column) && column > 0 ? { column } : {}), version };
    } catch { return undefined; }
  }

  private tool(name: string, configured?: string): string | undefined {
    const root = this.opts.toolRoot ?? process.env.DOCUMENT_TOOLS_ROOT;
    const candidate = configured ?? (root ? path.join(root, "bin", name) : undefined);
    return candidate ?? (configured === "" ? undefined : undefined);
  }
  private officeTool(): string | undefined {
    const root = this.opts.toolRoot ?? process.env.DOCUMENT_TOOLS_ROOT;
    const configured = this.opts.libreOfficePath ?? process.env.DOCUMENT_LIBREOFFICE;
    return this.tool("libreoffice", configured ?? (root ? path.join(root, "libreoffice-7.3", "usr", "bin", "libreoffice") : undefined));
  }
  private officePdfRuntimeReady(office: string): boolean {
    // Only advertise the exact package build that was exercised in the isolated conversion
    // integration test. Other LibreOffice trees remain disabled until separately verified.
    const installDir = this.officeInstallDir(office);
    if (!installDir || !fs.existsSync(office)) return false;
    try {
      const bootstrap = fs.readFileSync(path.join(installDir, "program", "bootstraprc"), "utf8");
      const registry = path.join(installDir, "share", ".registry", "main.xcd");
      const mathRegistry = path.join(installDir, "share", ".registry", "math.xcd");
      const mathComponent = path.join(installDir, "program", "libsmlo.so");
      const packageRoot = path.resolve(installDir, "../../..");
      return /^ProductKey=LibreOffice 7\.3$/m.test(bootstrap)
        && fs.statSync(registry).isFile()
        && fs.statSync(mathRegistry).isFile()
        && fs.statSync(mathComponent).isFile()
        && fs.existsSync(path.join(packageRoot, "etc", "libreoffice", "sofficerc"));
    } catch {
      return false;
    }
  }
  private toolIsMounted(candidate: string): boolean {
    const toolRoot = this.opts.toolRoot ?? process.env.DOCUMENT_TOOLS_ROOT;
    const resolved = path.resolve(candidate);
    return within("/usr", resolved) || (!!toolRoot && within(path.resolve(toolRoot), resolved));
  }
  private async enqueue(request: Request): Promise<DocumentJob> {
    const preparing = this.preparingByUser.get(request.userId) ?? 0;
    if (this.queue.filter((job) => job.userId === request.userId).length + preparing >= this.opts.maxQueuedPerUser) throw new Error("Document job queue is full for this user.");
    this.preparingByUser.set(request.userId, preparing + 1);
    let reserved = true;
    const releaseReservation = (): void => {
      if (!reserved) return; reserved = false;
      const count = (this.preparingByUser.get(request.userId) ?? 1) - 1;
      if (count > 0) this.preparingByUser.set(request.userId, count); else this.preparingByUser.delete(request.userId);
    };
    try {
    const requestedRootStat = await fsp.stat(request.projectRoot);
    if (!requestedRootStat.isDirectory()) throw new Error("Project root must be a directory.");
    const root = await fsp.realpath(request.projectRoot);
    const canonicalRootStat = await fsp.stat(root);
    if (!sameDirectory(requestedRootStat, canonicalRootStat)) throw new Error("Project root changed while the job was being prepared.");
    const relative = safeRelative(request.path);
    const caps = this.capabilities();
    if (!fs.existsSync(this.opts.bwrapPath)) throw new Error("Document tools are unavailable: sandbox (bubblewrap) is required.");
    if (request.kind === "compile" && (!caps.latex || !caps.engines.includes(request.engine ?? "pdflatex"))) throw new Error("LaTeX compilation is unavailable or the engine is invalid.");
    if (request.kind === "convert" && (!request.to || !(request.to === "pdf" ? caps.officePdf : caps.pandoc))) throw new Error("Requested document conversion is unavailable.");
    const source = path.resolve(root, relative);
    if (!within(root, source)) throw new Error("Document path must stay inside the project.");
    const inputExt = path.extname(relative).toLowerCase();
    if (request.kind === "compile" && inputExt !== ".tex") throw new Error("LaTeX compilation requires a .tex source file.");
    if (request.kind === "convert" && request.to === "pdf" && ![".docx", ".odt", ".rtf"].includes(inputExt)) throw new Error("Office PDF conversion requires a Word/Office document.");
    if (request.kind === "convert" && request.to === "docx" && ![".tex", ".md", ".markdown"].includes(inputExt)) throw new Error("DOCX conversion supports LaTeX or Markdown source files.");
    if (request.kind === "convert" && request.to === "tex" && inputExt !== ".docx") throw new Error("LaTeX conversion requires a DOCX source file.");
    const tempRoot = path.resolve(this.opts.tempRoot);
    await fsp.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const jobDir = await fsp.mkdtemp(path.join(tempRoot, "job-"));
    await fsp.chmod(jobDir, 0o700);
    const job: InternalJob = {
      id: randomUUID(), projectId: request.projectId, userId: request.userId, state: "queued", version: String(request.version ?? ""),
      path: relative, createdAt: Date.now(), projectRoot: root, jobDir, snapshotDir: path.join(jobDir, "src"), outputDir: path.join(jobDir, "out"),
      sourceFiles: new Set(), sourceVersions: new Map(), kind: request.kind, request,
    };
    try {
      const copied = await this.snapshot(root, canonicalRootStat, job.snapshotDir);
      if (!copied.files.has(relative)) throw new Error("Document input is excluded from safe compilation.");
      job.sourceFiles = copied.files; job.sourceVersions = copied.versions; job.sourceHash = copied.hash;
      await fsp.mkdir(job.outputDir, { mode: 0o700 });
      releaseReservation(); this.jobs.set(job.id, job); this.queue.push(job); this.pump(); this.ensureCleanupTimer();
      return this.publicJob(job);
    } catch (error) { await fsp.rm(jobDir, { recursive: true, force: true }); throw error; }
    } catch (error) { releaseReservation(); throw error; }
  }
  private async snapshot(root: string, expectedRoot: fs.Stats, destination: string): Promise<{ files: Set<string>; versions: Map<string, string>; hash: string }> {
    await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
    const buffers: Array<[string, Buffer]> = []; const files = new Set<string>(); const versions = new Map<string, string>(); let total = 0;
    const rootHandle = await fsp.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const openedRoot = await rootHandle.stat();
      if (!sameDirectory(openedRoot, expectedRoot) || !sameDirectory(openedRoot, await fsp.stat(root))) throw new Error("Project root changed while the snapshot was being opened.");
      const readBounded = async (handle: fsp.FileHandle, maxBytes: number): Promise<Buffer> => {
        const chunks: Buffer[] = []; let bytes = 0;
        while (true) {
          // Read one byte beyond the remaining budget to detect a file that grew after fstat.
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytes + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > maxBytes) throw new Error("Project snapshot exceeds the safe compilation limit.");
          chunks.push(buffer.subarray(0, bytesRead));
        }
        return Buffer.concat(chunks, bytes);
      };
      const visit = async (directory: fsp.FileHandle, rel: string): Promise<void> => {
        const listing = await fsp.opendir(`${PROC_FD}/${directory.fd}`, { bufferSize: 128 });
        try {
          while (true) {
            const entry = await listing.read();
            if (!entry) break;
            if (entry.isSymbolicLink()) continue;
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (SECRET_NAME.test(entry.name) || SECRET_EXT.test(entry.name)) continue;
            const entryPath = `${PROC_FD}/${directory.fd}/${entry.name}`;
            if (entry.isDirectory()) {
              if (IGNORE_DIRS.has(entry.name)) continue;
              let child: fsp.FileHandle;
              try { child = await fsp.open(entryPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
              catch (error) { if (isRaceSkip(error)) continue; throw error; }
              try {
                await fsp.mkdir(path.join(destination, ...childRel.split("/")), { recursive: true, mode: 0o700 });
                await visit(child, childRel);
              } finally { await child.close(); }
            } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) {
              if (files.size >= this.opts.maxProjectFiles) throw new Error("Project snapshot exceeds the safe compilation limit.");
              let file: fsp.FileHandle;
              try { file = await fsp.open(entryPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
              catch (error) { if (isRaceSkip(error)) continue; throw error; }
              let content: Buffer;
              try {
                const stat = await file.stat();
                if (!stat.isFile()) continue;
                const remaining = this.opts.maxProjectBytes - total;
                if (stat.size > remaining) throw new Error("Project snapshot exceeds the safe compilation limit.");
                content = await readBounded(file, remaining);
              } finally { await file.close(); }
              total += content.length;
              const dest = path.join(destination, ...childRel.split("/"));
              await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
              await fsp.writeFile(dest, content, { mode: 0o600 });
              files.add(childRel); versions.set(childRel, createHash("sha256").update(content).digest("hex")); buffers.push([childRel, content]);
            }
          }
        } finally { await listing.close(); }
      };
      await visit(rootHandle, "");
      return { files, versions, hash: fileHash(buffers) };
    } finally { await rootHandle.close(); }
  }
  private pump(): void { if (this.active || !this.queue.length) return; const job = this.queue.shift()!; this.active = job; void this.execute(job).finally(() => { if (this.active === job) this.active = undefined; this.pump(); }); }
  private async execute(job: InternalJob): Promise<void> {
    if (job.cancelRequested) return;
    job.state = "running";
    try {
      const req = (job as any).request as Request;
      if (req.kind === "compile") await this.compile(job, req);
      else await this.convert(job, req);
      if (job.cancelRequested) { job.state = "cancelled"; await this.removeJobFiles(job); }
      else job.state = "succeeded";
    } catch (error) {
      if (job.cancelRequested) { job.state = "cancelled"; await this.removeJobFiles(job); }
      else { job.state = "failed"; job.error = error instanceof Error ? error.message : String(error); }
    } finally { job.process = undefined; job.finishedAt = Date.now(); }
  }
  private async compile(job: InternalJob, req: Request): Promise<void> {
    const latexmk = this.tool("latexmk", this.opts.latexmkPath ?? process.env.DOCUMENT_LATEXMK)!;
    const pdf = path.join(job.outputDir, `${path.basename(job.path, path.extname(job.path))}.pdf`);
    const engine = req.engine ?? "pdflatex";
    const engineArgs: Record<DocumentEngine, string[]> = {
      pdflatex: ["-pdf", "-pdflatex=pdflatex -no-shell-escape %O %S"],
      xelatex: ["-pdfxe", "-xelatex=xelatex -no-shell-escape %O %S"],
      lualatex: ["-pdflua", "-lualatex=lualatex -no-shell-escape %O %S"],
    };
    const args = ["-norc", ...engineArgs[engine], "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", `-outdir=${job.outputDir}`, job.path];
    await this.runSandbox(job, latexmk, args, this.opts.wallTimeMs);
    if (!fs.existsSync(pdf)) throw new Error("LaTeX completed without producing a PDF.");
    job.pdfUrl = `/api/documents/jobs/${job.id}/artifact`;
  }
  private async convert(job: InternalJob, req: Request): Promise<void> {
    const defaultExt = req.to === "pdf" ? ".pdf" : req.to === "tex" ? ".tex" : ".docx";
    const target = req.targetPath ? safeRelative(req.targetPath) : `${path.basename(req.path, path.extname(req.path))}${defaultExt}`;
    const targetName = path.posix.basename(target);
    if (path.extname(targetName).toLowerCase() !== defaultExt) throw new Error(`Conversion target must use the ${defaultExt} extension.`);
    if (req.to === "pdf") {
      const office = this.officeTool()!;
      await this.runSandbox(job, office, ["--headless", "-env:UserInstallation=file:///tmp/lo-profile", "--convert-to", "pdf", "--outdir", job.outputDir, req.path], this.opts.wallTimeMs, this.officeRuntimeEnv(office));
      const generated = path.join(job.outputDir, `${path.basename(req.path, path.extname(req.path))}.pdf`);
      if (targetName !== path.basename(generated)) await fsp.rename(generated, path.join(job.outputDir, targetName));
      job.outputPath = targetName;
    } else {
      const pandoc = this.tool("pandoc", this.opts.pandocPath ?? process.env.DOCUMENT_PANDOC)!;
      const output = path.join(job.outputDir, targetName);
      // Explicitly avoid user-controlled filters/templates and use the source's semantic format.
      const sourceExt = path.extname(req.path).toLowerCase();
      const from = sourceExt === ".tex" ? "latex" : sourceExt === ".md" || sourceExt === ".markdown" ? "markdown" : "docx";
      const to = req.to === "tex" ? "latex" : "docx";
      await this.runSandbox(job, pandoc, ["--from", from, "--to", to, "--output", output, req.path], this.opts.wallTimeMs);
      job.outputPath = targetName;
    }
    if (!job.outputPath || !fs.existsSync(path.join(job.outputDir, job.outputPath))) throw new Error("Conversion completed without producing the requested output.");
    job.pdfUrl = job.outputPath.endsWith(".pdf") ? `/api/documents/jobs/${job.id}/artifact` : undefined;
  }
  private officeRuntimeEnv(office: string): Record<string, string> {
    // Extracted Debian LibreOffice packages keep their private/multiarch runtime libraries
    // beside the program tree. Do not expose the host's ambient loader configuration.
    const root = this.opts.toolRoot ?? process.env.DOCUMENT_TOOLS_ROOT;
    if (!root) return {};
    try {
      const realRoot = fs.realpathSync(root);
      const programDir = path.dirname(fs.realpathSync(office));
      const relativeProgramDir = path.relative(realRoot, programDir);
      if (relativeProgramDir.startsWith("..") || path.isAbsolute(relativeProgramDir)) return {};
      const multiarchDir = path.resolve(programDir, "../../x86_64-linux-gnu");
      const relativeMultiarchDir = path.relative(realRoot, multiarchDir);
      // Prefer LO's direct program-directory copies of UNO libraries: multiarch symlink
      // resolution can make LibreOffice search for unorc beside the symlink instead.
      const libraryDirs = [programDir, multiarchDir].filter((directory) => {
        const relative = path.relative(realRoot, directory);
        return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(directory);
      });
      return libraryDirs.length ? {
        LD_LIBRARY_PATH: libraryDirs.join(":"),
        URE_BOOTSTRAP: "file:///usr/lib/libreoffice/program/fundamentalrc",
        SAL_USE_VCLPLUGIN: "svp",
        LANG: "C.UTF-8",
        USER: "sandbox",
        LOGNAME: "sandbox",
      } : {};
    } catch {
      return {};
    }
  }

  private officeInstallDir(office: string): string | undefined {
    const root = this.opts.toolRoot ?? process.env.DOCUMENT_TOOLS_ROOT;
    if (!root) return undefined;
    try {
      const realRoot = fs.realpathSync(root);
      const programDir = path.dirname(fs.realpathSync(office));
      const installDir = path.dirname(programDir);
      const relative = path.relative(realRoot, installDir);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(path.join(installDir, "program", "fundamentalrc"))) return undefined;
      return installDir;
    } catch {
      return undefined;
    }
  }

  private async runSandbox(job: InternalJob, command: string, args: string[], timeoutMs: number, sandboxEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
    const toolRoot = this.opts.toolRoot ?? process.env.DOCUMENT_TOOLS_ROOT;
    if (!fs.existsSync(this.opts.bwrapPath)) throw new Error("Sandbox unavailable; refusing to execute document tools without isolation.");
    const toolCandidates = [this.tool("latexmk", this.opts.latexmkPath ?? process.env.DOCUMENT_LATEXMK), this.tool("pandoc", this.opts.pandocPath ?? process.env.DOCUMENT_PANDOC), this.officeTool(), this.tool("synctex", this.opts.synctexPath ?? process.env.DOCUMENT_SYNCTEX)].filter((value): value is string => !!value && this.toolIsMounted(value));
    const realToolDirs = toolCandidates.flatMap((value) => { try { return [path.dirname(fs.realpathSync(value))]; } catch { return []; } });
    const toolDirs = [...new Set([...toolCandidates.map((value) => path.dirname(value)), ...realToolDirs, ...(toolRoot ? [path.join(toolRoot, "bin")] : [])])];
    const pathEntries = [...new Set(["/usr/bin", "/bin", ...toolDirs])];
    const mounts = ["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--ro-bind", "/usr", "/usr"];
    mounts.push("--ro-bind", "/usr/bin", "/bin");
    const officeInstallDir = this.officeInstallDir(command);
    if (officeInstallDir) {
      // Debian's extracted LibreOffice assumes /usr/lib/libreoffice. Build a private /usr/lib
      // overlay, restore only the system multiarch library directory, then bind the configured
      // LibreOffice tree at its expected path. This avoids writing to or altering host /usr.
      mounts.push("--tmpfs", "/usr/lib", "--dir", "/usr/lib/x86_64-linux-gnu", "--dir", "/usr/lib/libreoffice");
      if (fs.existsSync("/usr/lib/x86_64-linux-gnu")) mounts.push("--ro-bind", "/usr/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu");
      if (fs.existsSync("/usr/lib/locale")) mounts.push("--dir", "/usr/lib/locale", "--ro-bind", "/usr/lib/locale", "/usr/lib/locale");
      mounts.push("--ro-bind", officeInstallDir, "/usr/lib/libreoffice");
      const officeEtc = path.resolve(officeInstallDir, "../../../etc/libreoffice");
      const officeRegistry = path.join(officeInstallDir, "share", ".registry");
      if (fs.existsSync(path.join(officeEtc, "sofficerc"))) {
        mounts.push("--ro-bind", officeEtc, "/etc/libreoffice");
        // The Debian post-install step publishes this generated registry into /etc. The
        // extracted, non-root runtime has not run that step, so bind the packaged source.
        if (fs.existsSync(path.join(officeRegistry, "main.xcd"))) mounts.push("--ro-bind", officeRegistry, "/etc/libreoffice/registry");
      }
    }
    for (const hostPath of ["/lib", "/lib64", "/etc/fonts", "/etc/alternatives"]) if (fs.existsSync(hostPath)) mounts.push("--ro-bind", hostPath, hostPath);
    mounts.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/tmp/texmf", "--dir", "/tmp/texmf-var", "--dir", "/tmp/texmf-config", "--dir", "/tmp/.cache", "--dir", "/home", "--dir", "/home/sandbox", "--setenv", "HOME", "/home/sandbox", "--setenv", "TMPDIR", "/tmp", "--setenv", "XDG_CACHE_HOME", "/tmp/.cache", "--setenv", "PATH", pathEntries.join(":"), "--setenv", "TEXMFHOME", "/tmp/texmf", "--setenv", "TEXMFVAR", "/tmp/texmf-var", "--setenv", "TEXMFCONFIG", "/tmp/texmf-config");
    for (const [key, value] of Object.entries(sandboxEnv)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("Invalid isolated tool environment.");
      mounts.push("--setenv", key, value);
    }
    mounts.push("--ro-bind", job.snapshotDir, "/work", "--bind", job.outputDir, "/out");
    if (toolRoot && fs.existsSync(toolRoot)) {
      let current = path.posix.dirname(path.posix.resolve(toolRoot)); const dirs: string[] = [];
      while (current !== "/") { dirs.unshift(current); current = path.posix.dirname(current); }
      for (const directory of dirs) mounts.push("--dir", directory);
      mounts.push("--ro-bind", toolRoot, toolRoot);
    }
    mounts.push("--chdir", "/work", "/usr/bin/prlimit", "--nproc=32", command, ...args.map((arg) => arg.replaceAll(job.snapshotDir, "/work").replaceAll(job.outputDir, "/out")));
    // Apply nproc only after the private user/pid namespaces exist. Lowering the host uid's
    // RLIMIT_NPROC first can prevent bubblewrap itself from creating its namespaces.
    const wrappedArgs = ["--as=1073741824", "--cpu=180", "--fsize=536870912", this.opts.bwrapPath, ...mounts];
    const result = await (this.opts.runner ?? this.defaultRunner.bind(this))("/usr/bin/prlimit", wrappedArgs, { cwd: job.jobDir, timeoutMs, onSpawn: (child) => { job.process = child; } });
    job.log = appendLimited(job.log ?? "", result.stdout + result.stderr);
    return result;
  }
  private defaultRunner(command: string, args: string[], options: { cwd: string; timeoutMs: number; onSpawn?: (child: ChildProcess | undefined) => void }): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, env: { PATH: "/usr/bin:/bin" }, detached: true, stdio: ["ignore", "pipe", "pipe"] }); options.onSpawn?.(child);
      let stdout = ""; let stderr = ""; child.stdout?.on("data", (chunk: Buffer) => { stdout = appendLimited(stdout, chunk.toString()); }); child.stderr?.on("data", (chunk: Buffer) => { stderr = appendLimited(stderr, chunk.toString()); });
      const timeout = setTimeout(() => { if (child.pid) this.killProcess(child.pid); }, options.timeoutMs); timeout.unref();
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timeout); options.onSpawn?.(undefined as unknown as ChildProcess); if (code === 0) resolve({ stdout, stderr }); else reject(new Error(appendLimited(`${stdout}\n${stderr}`, `\nDocument tool exited ${signal ?? code}.`))); });
    });
  }
  private killProcess(pid: number): void { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } } setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ } }, 1500).unref(); }
  private publicJob(job: InternalJob): DocumentJob { const { projectRoot: _a, jobDir: _b, snapshotDir: _c, outputDir: _d, sourceFiles: _e, sourceVersions: _f, process: _g, cancelRequested: _h, request: _i, kind: _j, ...result } = job; return { ...result }; }
  private async removeJobFiles(job: InternalJob): Promise<void> { if (this.active !== job && job.state === "queued") await fsp.rm(job.jobDir, { recursive: true, force: true }); else if (job.state === "cancelled") await fsp.rm(job.jobDir, { recursive: true, force: true }); }
  private ensureCleanupTimer(): void { if (this.timer) return; this.timer = setInterval(() => { void this.cleanupExpired(); }, Math.min(this.opts.jobTtlMs, 10 * 60_000)); this.timer.unref(); }
  private async cleanupExpired(): Promise<void> { const cutoff = Date.now() - this.opts.jobTtlMs; for (const [id, job] of this.jobs) { if (terminal.has(job.state) && (job.finishedAt ?? job.createdAt) < cutoff) { await fsp.rm(job.jobDir, { recursive: true, force: true }); this.jobs.delete(id); } } if (!this.jobs.size && this.timer) { clearInterval(this.timer); this.timer = undefined; } }
}
