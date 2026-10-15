import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticatedUserFromHeaders } from "./auth.js";
import { DEFAULT_USER_ID, type ProjectStore } from "./db.js";
import type { DocumentCompiler as DocumentCompilerService, DocumentEngine } from "./documentCompiler.js";

const TEXT_EXT = new Set([".tex", ".bib", ".sty", ".cls"]);
const OPEN_EXT = new Set([".tex", ".docx"]);
const SKIP_DIRS = new Set([".git", ".codex", ".vscode", "node_modules", ".document-workbench-history"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DOCX_BYTES = 25 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_TREE_ENTRIES = 500;
const HISTORY_LIMIT = 5;
const fileSaveQueues = new Map<string, Promise<unknown>>();

export class DocumentWorkbenchError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = "DocumentWorkbenchError"; }
}

export type DocumentFile = { path: string; name: string; kind: "tex" | "docx" | "pdf"; version: string; size: number; content?: string; rawUrl: string };
export type DocumentEntry = { path: string; name: string; kind: "directory" | "tex" | "docx" | "asset"; size: number };
export interface DocumentWorkbenchOptions { compiler?: DocumentCompilerService; }

function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function inside(root: string, target: string): boolean { const rel = path.relative(root, target); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
function safeRelative(input: unknown): string {
  if (typeof input !== "string" || !input || input.includes("\\") || input.includes("\0") || path.isAbsolute(input)) throw new DocumentWorkbenchError(400, "A relative document path is required.");
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || SKIP_DIRS.has(part.toLowerCase()))) throw new DocumentWorkbenchError(400, "Document path is not allowed.");
  return parts.join(path.sep);
}
function allowedFile(file: string): "tex" | "docx" | "asset" {
  const ext = path.extname(file).toLowerCase();
  return TEXT_EXT.has(ext) ? "tex" : ext === ".docx" ? "docx" : "asset";
}
function validateDocx(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.subarray(0, 2).toString("ascii") !== "PK") throw new DocumentWorkbenchError(400, "DOCX must be a valid Office Open XML package.");
  const names = new Set<string>();
  // Inspect the ZIP central directory only; no decompression or external upload tooling.
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = bytes.readUInt16LE(i + 28), extraLen = bytes.readUInt16LE(i + 30), commentLen = bytes.readUInt16LE(i + 32);
    if (i + 46 + nameLen + extraLen + commentLen > bytes.length) throw new DocumentWorkbenchError(400, "Malformed DOCX ZIP directory.");
    names.add(bytes.subarray(i + 46, i + 46 + nameLen).toString("utf8"));
    i += 45 + nameLen + extraLen + commentLen;
  }
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) throw new DocumentWorkbenchError(400, "DOCX package is missing required Word document parts.");
}

/** File-backed workbench operations. Project ownership must be checked by callers before construction. */
export class DocumentWorkbenchService {
  readonly root: string;
  constructor(rootPath: string) {
    try { this.root = fs.realpathSync(rootPath); }
    catch { throw new DocumentWorkbenchError(404, "Project directory does not exist."); }
    if (!fs.statSync(this.root).isDirectory()) throw new DocumentWorkbenchError(400, "Project root is not a directory.");
  }
  private resolve(relative: string, allowMissing = false): string {
    const rel = safeRelative(relative);
    const target = path.resolve(this.root, rel);
    if (!inside(this.root, target)) throw new DocumentWorkbenchError(400, "Document path must stay inside the project.");
    let cursor = this.root;
    for (const part of rel.split(path.sep)) {
      cursor = path.join(cursor, part);
      try {
        const st = fs.lstatSync(cursor);
        if (st.isSymbolicLink()) throw new DocumentWorkbenchError(400, "Symbolic links are not supported in the document workbench.");
        if (cursor !== target && !st.isDirectory()) throw new DocumentWorkbenchError(400, "A path component is not a directory.");
        if (!inside(this.root, fs.realpathSync(cursor))) throw new DocumentWorkbenchError(400, "Document path must stay inside the project.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) break;
        if (error instanceof DocumentWorkbenchError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DocumentWorkbenchError(404, "Document was not found.");
        throw error;
      }
    }
    return target;
  }
  private openChecked(relative: string): { target: string; fd: number; stat: fs.Stats } {
    const target = this.resolve(relative);
    let fd: number | undefined;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const actual = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (!inside(this.root, actual) || actual !== target) throw new DocumentWorkbenchError(400, "Document path changed or escaped the project root.");
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new DocumentWorkbenchError(400, "Document path is not a regular file.");
      return { target, fd, stat };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new DocumentWorkbenchError(400, "Symbolic links and non-directory paths are not supported in the document workbench.");
      throw error;
    }
  }
  private openDirectoryChecked(absolutePath: string): number {
    let fd: number | undefined;
    try {
      fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
      const actual = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (!inside(this.root, actual) || actual !== absolutePath) throw new DocumentWorkbenchError(400, "Document directory changed or escaped the project root.");
      if (!fs.fstatSync(fd).isDirectory()) throw new DocumentWorkbenchError(400, "Document parent is not a directory.");
      return fd;
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new DocumentWorkbenchError(400, "Symbolic links and non-directory paths are not supported in the document workbench.");
      throw error;
    }
  }
  tree(directory = "", pagination: { offset?: number; limit?: number } = {}): { directory: string; entries: DocumentEntry[]; nextOffset: number | null; capabilities: unknown } {
    const rel = directory ? safeRelative(directory) : "";
    const dir = rel ? this.resolve(rel) : this.root;
    if (!fs.statSync(dir).isDirectory()) throw new DocumentWorkbenchError(400, "Requested path is not a directory.");
    const entries: DocumentEntry[] = [];
    const allEntries = fs.readdirSync(dir, { withFileTypes: true }).filter((item) => item.name !== "." && !SKIP_DIRS.has(item.name.toLowerCase()));
    const offset = Math.max(0, Math.floor(pagination.offset ?? 0));
    const limit = Math.min(MAX_TREE_ENTRIES, Math.max(1, Math.floor(pagination.limit ?? MAX_TREE_ENTRIES)));
    for (const entry of allEntries) {
      if (entry.isSymbolicLink()) continue;
      const p = path.join(dir, entry.name), relative = path.relative(this.root, p).split(path.sep).join("/");
      try { if (!inside(this.root, fs.realpathSync(p))) continue; } catch { continue; }
      if (entry.isDirectory()) entries.push({ path: relative, name: entry.name, kind: "directory", size: 0 });
      else if (entry.isFile()) entries.push({ path: relative, name: entry.name, kind: allowedFile(p), size: fs.statSync(p).size });
    }
    entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    const page = entries.slice(offset, offset + limit);
    return { directory: rel.split(path.sep).join("/"), entries: page, nextOffset: offset + page.length < entries.length ? offset + page.length : null, capabilities: null };
  }
  open(relative: string): DocumentFile {
    const target = this.resolve(relative), kind = allowedFile(target);
    const ext = path.extname(target).toLowerCase();
    const pdf = ext === ".pdf";
    if ((!OPEN_EXT.has(ext) && !pdf) || (kind === "asset" && !pdf)) throw new DocumentWorkbenchError(415, "Only .tex, .docx, and PDF documents can be opened in the workbench.");
    const opened = this.openChecked(relative);
    const st = opened.stat;
    const max = pdf ? MAX_PDF_BYTES : kind === "docx" ? MAX_DOCX_BYTES : MAX_TEXT_BYTES;
    if (st.size > max) { fs.closeSync(opened.fd); throw new DocumentWorkbenchError(413, "Document exceeds the workbench size limit."); }
    let bytes: Buffer;
    try { bytes = fs.readFileSync(opened.fd); } finally { fs.closeSync(opened.fd); }
    if (bytes.length > max) throw new DocumentWorkbenchError(413, "Document exceeds the workbench size limit.");
    if (kind === "docx") validateDocx(bytes);
    if (pdf && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new DocumentWorkbenchError(415, "PDF preview requires a valid PDF file.");
    const data: DocumentFile = { path: path.relative(this.root, target).split(path.sep).join("/"), name: path.basename(target), kind: pdf ? "pdf" : kind === "asset" ? "pdf" : kind, version: sha(bytes), size: bytes.length, rawUrl: `/api/projects/DOCUMENT_PROJECT_ID/documents/raw?path=${encodeURIComponent(path.relative(this.root, target).split(path.sep).join("/"))}` };
    if (kind === "tex") { const text = bytes.toString("utf8"); if (Buffer.from(text, "utf8").compare(bytes) !== 0) throw new DocumentWorkbenchError(415, "Text document is not valid UTF-8."); data.content = text; }
    return data;
  }
  previewFile(relative: string): { filePath: string; fd: number; contentType: string; size: number } {
    const target = this.resolve(relative), kind = allowedFile(target);
    const ext = path.extname(target).toLowerCase();
    if (kind !== "docx" && ext !== ".pdf") throw new DocumentWorkbenchError(415, "Only in-project DOCX and PDF documents have a binary preview.");
    const opened = this.openChecked(relative), max = ext === ".pdf" ? MAX_PDF_BYTES : MAX_DOCX_BYTES;
    try {
      if (opened.stat.size > max) throw new DocumentWorkbenchError(413, "Preview exceeds the workbench size limit.");
      const head = Buffer.alloc(Math.min(opened.stat.size, ext === ".pdf" ? 5 : 2));
      fs.readSync(opened.fd, head, 0, head.length, 0);
      if (ext === ".pdf" && head.toString("ascii") !== "%PDF-") throw new DocumentWorkbenchError(415, "PDF preview requires a valid PDF file.");
      if (ext === ".docx") {
        const bytes = fs.readFileSync(opened.fd);
        if (bytes.length > max) throw new DocumentWorkbenchError(413, "Preview exceeds the workbench size limit.");
        validateDocx(bytes);
      }
      const size = fs.fstatSync(opened.fd).size;
      if (size > max) throw new DocumentWorkbenchError(413, "Preview exceeds the workbench size limit.");
      return { filePath: target, fd: opened.fd, contentType: ext === ".pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size };
    } catch (error) { fs.closeSync(opened.fd); throw error; }
  }
  async save(input: { path: string; baseVersion: string | null; content?: string; base64?: string; create?: boolean }): Promise<DocumentFile> {
    const rel = safeRelative(input.path), target = this.resolve(rel, true);
    const previous = fileSaveQueues.get(target) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    fileSaveQueues.set(target, queued);
    await previous;
    try { return this.saveLocked(rel, target, input); }
    finally { release(); if (fileSaveQueues.get(target) === queued) fileSaveQueues.delete(target); }
  }
  private saveLocked(rel: string, target: string, input: { path: string; baseVersion: string | null; content?: string; base64?: string; create?: boolean }): DocumentFile {
    if (this.resolve(rel, true) !== target) throw new DocumentWorkbenchError(409, "Document path changed while saving; reopen it and retry.");
    const ext = path.extname(target).toLowerCase(), text = TEXT_EXT.has(ext), docx = ext === ".docx";
    if (!text && !docx) throw new DocumentWorkbenchError(415, "Only .tex, .bib, .sty, .cls, and .docx files can be saved.");
    if (text !== (typeof input.content === "string") || docx !== (typeof input.base64 === "string")) throw new DocumentWorkbenchError(400, "Provide exactly one matching text or DOCX payload.");
    let bytes: Buffer;
    if (text) { bytes = Buffer.from(input.content!, "utf8"); if (bytes.toString("utf8") !== input.content || bytes.length > MAX_TEXT_BYTES) throw new DocumentWorkbenchError(bytes.length > MAX_TEXT_BYTES ? 413 : 400, "Invalid or oversized UTF-8 document."); }
    else { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64!) || input.base64!.length > Math.ceil(MAX_DOCX_BYTES * 4 / 3)) throw new DocumentWorkbenchError(413, "Invalid or oversized DOCX payload."); bytes = Buffer.from(input.base64!, "base64"); if (bytes.length > MAX_DOCX_BYTES) throw new DocumentWorkbenchError(413, "DOCX exceeds the workbench size limit."); validateDocx(bytes); }
    let exists = false, current: Buffer | null = null;
    try {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink() || !st.isFile()) throw new DocumentWorkbenchError(400, "Target must be a regular file.");
      const opened = this.openChecked(rel);
      try { exists = true; current = fs.readFileSync(opened.fd); } finally { fs.closeSync(opened.fd); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (input.create) { if (input.baseVersion !== null || exists) throw new DocumentWorkbenchError(409, "New document already exists or has an invalid base version."); }
    else if (!exists || !input.baseVersion || sha(current!) !== input.baseVersion) throw new DocumentWorkbenchError(409, "Document changed since it was opened.");
    if (!exists && !input.create) throw new DocumentWorkbenchError(404, "Document was not found.");
    const dir = path.dirname(target), basename = path.basename(target), tempName = `.document-tmp-${randomUUID()}`;
    const historyDir = path.join(this.root, ".document-workbench-history");
    let dirFd: number | undefined, historyFd: number | undefined, tempPath = "";
    try {
      if (current) {
        fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
        historyFd = this.openDirectoryChecked(historyDir);
        const historyPrefix = `${sha(Buffer.from(rel))}-`;
        const history = `/proc/self/fd/${historyFd}/${historyPrefix}${Date.now()}-${randomUUID()}.bak`;
        fs.writeFileSync(history, current, { flag: "wx", mode: 0o600 });
        const files = fs.readdirSync(`/proc/self/fd/${historyFd}`).filter((f) => f.startsWith(historyPrefix)).sort().reverse();
        files.slice(HISTORY_LIMIT).forEach((f) => fs.unlinkSync(`/proc/self/fd/${historyFd}/${f}`));
      }
      if (this.resolve(rel, true) !== target) throw new DocumentWorkbenchError(409, "Document path changed while saving; reopen it and retry.");
      dirFd = this.openDirectoryChecked(dir);
      tempPath = `/proc/self/fd/${dirFd}/${tempName}`;
      fs.writeFileSync(tempPath, bytes, { flag: "wx", mode: 0o600 });
      // Link-based create prevents a race from overwriting a file created between the check and install.
      if (this.resolve(rel, true) !== target) throw new DocumentWorkbenchError(409, "Document path changed while saving; reopen it and retry.");
      const anchoredTarget = `/proc/self/fd/${dirFd}/${basename}`;
      if (!exists) { try { fs.linkSync(tempPath, anchoredTarget); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new DocumentWorkbenchError(409, "Document already exists."); throw e; } fs.unlinkSync(tempPath); }
      else fs.renameSync(tempPath, anchoredTarget);
    } finally {
      if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
      if (historyFd !== undefined) fs.closeSync(historyFd);
      if (dirFd !== undefined) fs.closeSync(dirFd);
    }
    return { path: rel.split(path.sep).join("/"), name: path.basename(target), kind: docx ? "docx" : "tex", version: sha(bytes), size: bytes.length, ...(text ? { content: bytes.toString("utf8") } : {}), rawUrl: `/api/projects/DOCUMENT_PROJECT_ID/documents/raw?path=${encodeURIComponent(rel.split(path.sep).join("/"))}` };
  }
}

const saveSchema = z.object({ path: z.string().min(1), baseVersion: z.string().nullable(), content: z.string().optional(), base64: z.string().optional(), create: z.boolean().optional() }).strict();
const compileSchema = z.object({ path: z.string().min(1), version: z.string().min(1), engine: z.enum(["pdflatex", "xelatex", "lualatex"] satisfies [DocumentEngine, ...DocumentEngine[]]).optional() }).strict();
const convertSchema = z.object({ path: z.string().min(1), version: z.string().min(1), to: z.enum(["docx", "tex", "pdf"]), targetPath: z.string().optional() }).strict();
function sendError(reply: any, error: unknown): unknown {
  if (error instanceof DocumentWorkbenchError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid document workbench request." });
  throw error;
}

export function registerDocumentWorkbenchRoutes(app: FastifyInstance, store: ProjectStore, options: DocumentWorkbenchOptions = {}): void {
  const context = (request: FastifyRequest) => {
    const user = authenticatedUserFromHeaders(request.headers as any);
    if (!user) throw new DocumentWorkbenchError(401, "Authentication required.");
    const userId = user === "auth-disabled" ? DEFAULT_USER_ID : user;
    const projectId = (request.params as { id?: string }).id ?? "";
    const project = store.getProject(projectId, userId);
    if (!project) throw new DocumentWorkbenchError(404, "Project not found.");
    return { userId, projectId, project, service: new DocumentWorkbenchService(project.rootPath) };
  };
  const sendArtifact = (reply: any, artifact: { path: string; contentType: string; filename: string }): unknown => {
    const st = fs.statSync(artifact.path);
    if (!st.isFile() || st.size > MAX_ARTIFACT_BYTES) throw new DocumentWorkbenchError(st.isFile() ? 413 : 404, "Document artifact exceeds the download limit.");
    return reply.type(artifact.contentType).header("Content-Length", st.size).header("Cache-Control", "private, no-store").header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`).send(fs.createReadStream(artifact.path));
  };
  const compiler = options.compiler;
  app.get("/api/projects/:id/documents/tree", async (req, reply) => { try { const c = context(req); const q = z.object({ path: z.string().optional().default(""), offset: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().positive().max(MAX_TREE_ENTRIES).optional() }).parse(req.query); const tree = c.service.tree(q.path, q); tree.capabilities = compiler?.capabilities() ?? null; return { data: tree }; } catch (e) { return sendError(reply, e); } });
  app.get("/api/projects/:id/documents/open", async (req, reply) => { try { const c = context(req); const q = z.object({ path: z.string().min(1) }).parse(req.query); const data = c.service.open(q.path); data.rawUrl = data.rawUrl.replace("DOCUMENT_PROJECT_ID", c.projectId); return { data }; } catch (e) { return sendError(reply, e); } });
  app.put("/api/projects/:id/documents/save", { bodyLimit: MAX_DOCX_BYTES * 2 }, async (req, reply) => { try { const c = context(req); const input = saveSchema.parse(req.body); const data = await c.service.save(input); data.rawUrl = data.rawUrl.replace("DOCUMENT_PROJECT_ID", c.projectId); return { data }; } catch (e) { return sendError(reply, e); } });
  app.get("/api/projects/:id/documents/raw", async (req, reply) => { try { const c = context(req); const q = z.object({ path: z.string().min(1) }).parse(req.query); const preview = c.service.previewFile(q.path); return reply.type(preview.contentType).header("Content-Length", preview.size).header("Cache-Control", "private, no-store").send(fs.createReadStream(preview.filePath, { fd: preview.fd, start: 0, end: preview.size - 1, autoClose: true })); } catch (e) { return sendError(reply, e); } });
  app.post("/api/projects/:id/documents/compile", async (req, reply) => { try { const c = context(req); if (!compiler) throw new DocumentWorkbenchError(501, "Document compilation is unavailable."); const input = compileSchema.parse(req.body); const opened = c.service.open(input.path); if (opened.version !== input.version) throw new DocumentWorkbenchError(409, "Document changed since it was opened."); return { data: await compiler.startCompile({ projectId: c.projectId, userId: c.userId, projectRoot: c.project.rootPath, ...input }) }; } catch (e) { return sendError(reply, e); } });
  app.post("/api/projects/:id/documents/convert", async (req, reply) => { try { const c = context(req); if (!compiler) throw new DocumentWorkbenchError(501, "Document conversion is unavailable."); const input = convertSchema.parse(req.body); const opened = c.service.open(input.path); if (opened.version !== input.version) throw new DocumentWorkbenchError(409, "Document changed since it was opened."); return { data: await compiler.startConvert({ projectId: c.projectId, userId: c.userId, projectRoot: c.project.rootPath, ...input }) }; } catch (e) { return sendError(reply, e); } });
  app.get("/api/projects/:id/documents/jobs/:jobId", async (req, reply) => { try { const c = context(req); if (!compiler) throw new DocumentWorkbenchError(501, "Document jobs are unavailable."); const job = compiler.getJob((req.params as any).jobId, c.projectId, c.userId); if (!job) throw new DocumentWorkbenchError(404, "Document job was not found."); return { data: job }; } catch (e) { return sendError(reply, e); } });
  app.get("/api/projects/:id/documents/jobs/:jobId/artifact", async (req, reply) => { try { const c = context(req); if (!compiler) throw new DocumentWorkbenchError(404, "Document artifact was not found."); const artifact = compiler.getArtifact((req.params as any).jobId, c.projectId, c.userId); if (!artifact) throw new DocumentWorkbenchError(404, "Document artifact was not found."); return sendArtifact(reply, artifact); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "Document artifact was not found." }); return sendError(reply, e); } });
  // DocumentCompiler emits this URL in DocumentJob.pdfUrl. Search only the
  // authenticated user's projects, then let the compiler enforce both owner
  // and project equality before exposing the artifact.
  app.get("/api/documents/jobs/:jobId/artifact", async (req, reply) => { try { const user = authenticatedUserFromHeaders(req.headers as any); if (!user) throw new DocumentWorkbenchError(401, "Authentication required."); if (!compiler) throw new DocumentWorkbenchError(404, "Document artifact was not found."); const userId = user === "auth-disabled" ? DEFAULT_USER_ID : user; const jobId = (req.params as any).jobId as string; for (const project of store.listProjects(userId)) { const artifact = compiler.getArtifact(jobId, project.id, userId); if (artifact) return sendArtifact(reply, artifact); } throw new DocumentWorkbenchError(404, "Document artifact was not found."); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "Document artifact was not found." }); return sendError(reply, e); } });
  app.post("/api/projects/:id/documents/jobs/:jobId/cancel", async (req, reply) => { try { const c = context(req); if (!compiler) throw new DocumentWorkbenchError(501, "Document jobs are unavailable."); const cancelled = await compiler.cancelJob((req.params as any).jobId, c.projectId, c.userId); if (!cancelled) throw new DocumentWorkbenchError(404, "Document job was not found or cannot be cancelled."); return { data: { cancelled } }; } catch (e) { return sendError(reply, e); } });
  app.post("/api/projects/:id/documents/synctex", async (req, reply) => { try { const c = context(req); if (!compiler?.synctex) throw new DocumentWorkbenchError(501, "SyncTeX is unavailable."); const b = z.object({ jobId: z.string(), page: z.number().int().positive(), x: z.number().finite(), y: z.number().finite() }).strict().parse(req.body); return { data: await compiler.synctex({ projectId: c.projectId, userId: c.userId, ...b }) }; } catch (e) { return sendError(reply, e); } });
}
