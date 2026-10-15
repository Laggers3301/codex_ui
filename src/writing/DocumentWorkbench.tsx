import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ArrowLeft as ArrowLeftIcon, ArrowRight, BookOpen, Close, Down, FileAddition, FileText, FolderOpen, MenuFold, MenuUnfold, Message, Refresh, Save, Upload } from "@icon-park/svg";
import { fetchProjectFileBlob, uploadProjectFiles } from "../api";
import { ToolReveal } from "../ToolReveal";
import { cancelJob, compileDocument, convertDocument, openDocument, readJob, readJobArtifact, readTree, saveDocument, synctex } from "./api";
import WritingIcon from "./Icon";
import type { DocxEditorHandle } from "./DocxEditor";
import type { DocumentJob, OpenedDocument, TreeEntry, WorkbenchProps, WritingSelection } from "./types";
import "./writing.css";

const LatexEditor = lazy(() => import("./LatexEditor"));
const DocxEditor = lazy(() => import("./DocxEditor"));
const PdfEditor = lazy(() => import("./PdfEditor"));
const AssetPreview = lazy(() => import("./AssetPreview"));

type MobileTab = "files" | "editor" | "preview";
const fileIcon = (kind: TreeEntry["kind"]) => kind === "directory" ? <WritingIcon glyph={FolderOpen} /> : <WritingIcon glyph={FileText} />;
const delay = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

export default function DocumentWorkbench({ project, initialPath, onReference, onClose, onToggleChat, chatVisible = true, closing = false, revision }: WorkbenchProps) {
  const [treePath, setTreePath] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [nextTreeOffset, setNextTreeOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [opened, setOpened] = useState<OpenedDocument | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [officePdfAvailable, setOfficePdfAvailable] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<"pdflatex" | "xelatex" | "lualatex">("xelatex");
  const [job, setJob] = useState<DocumentJob | null>(null);
  const [lastGoodJob, setLastGoodJob] = useState<DocumentJob | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [assetLocalUrl, setAssetLocalUrl] = useState("");
  const [sourceSelection, setSourceSelection] = useState({ text: "", from: 0, to: 0, lineStart: 0, lineEnd: 0 });
  const [docxHandle, setDocxHandle] = useState<DocxEditorHandle | null>(null);
  const [docxSourceVersion, setDocxSourceVersion] = useState("");
  const [leftWidth, setLeftWidth] = useState(230);
  const [editorWidth, setEditorWidth] = useState(52);
  const [mobileTab, setMobileTab] = useState<MobileTab>(initialPath?.toLowerCase().endsWith(".pdf") ? "preview" : "editor");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  const treeGeneration = useRef(0);
  const revisionGeneration = useRef(0);
  const lastRevision = useRef(revision);
  const openedRef = useRef(opened);
  const dirtyRef = useRef(false);
  const savedVersion = useRef("");
  const workbenchRef = useRef<HTMLDivElement>(null);
  const editorPaneRef = useRef<HTMLElement>(null);
  const pdfRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"tree" | "split" | null>(null);
  const visibleEntries = useMemo(() => [...entries].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1), [entries]);
  const isPdf = opened?.kind === "pdf";
  const isAsset = opened?.kind === "asset";

  function setDocumentDirty(value: boolean) {
    dirtyRef.current = value;
    setDirty(value);
  }

  useEffect(() => { openedRef.current = opened; }, [opened]);

  const refreshTree = useCallback(async (path: string) => {
    const token = ++treeGeneration.current;
    try {
      const tree = await readTree(project.id, path);
      if (token === treeGeneration.current) { setEntries(tree.entries); setTreePath(tree.directory); setNextTreeOffset(tree.nextOffset); setLoadingMore(false); setOfficePdfAvailable(Boolean(tree.capabilities?.officePdf)); }
    } catch (caught) { if (token === treeGeneration.current) setError(caught instanceof Error ? caught.message : String(caught)); }
  }, [project.id]);

  async function loadMoreTree() {
    if (nextTreeOffset === null || loadingMore) return;
    const token = treeGeneration.current;
    const path = treePath;
    const offset = nextTreeOffset;
    setLoadingMore(true);
    try {
      const page = await readTree(project.id, path, offset);
      if (token === treeGeneration.current && page.directory === path) {
        setEntries(current => [...current, ...page.entries]);
        setNextTreeOffset(page.nextOffset);
      }
    } catch (caught) { if (token === treeGeneration.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (token === treeGeneration.current) setLoadingMore(false); }
  }

  useEffect(() => { void refreshTree(""); }, [refreshTree]);
  useEffect(() => { setExportOpen(false); }, [opened?.path]);
  useEffect(() => {
    if (!exportOpen) return;
    const outside = (event: globalThis.PointerEvent) => { if (!exportRef.current?.contains(event.target as Node)) setExportOpen(false); };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [exportOpen]);
  useEffect(() => {
    if (!pdfUrl.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(pdfUrl);
  }, [pdfUrl]);
  useEffect(() => {
    if (!initialPath) return;
    void openPath(initialPath);
    // The initial selection is intentionally read once when the workbench opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (revision === undefined || Object.is(lastRevision.current, revision)) return;
    if (busy) return;
    lastRevision.current = revision;
    // Refresh the current directory once per completed chat turn so model-created
    // files appear without interrupting the document currently being edited.
    void refreshTree(treePath);
    const target = opened;
    if (!target || target.kind === "asset" || target.version.startsWith("local:")) return;
    if (dirtyRef.current) {
      setNotice("聊天操作已完成；本地未保存内容已保留，保存时会校验项目版本，不会覆盖远端修改。");
      return;
    }
    const token = ++revisionGeneration.current;
    setNotice("正在检查项目文档更新…");
    void openDocument(project.id, target.path).then(latest => {
      const current = openedRef.current;
      if (token !== revisionGeneration.current || !current || current.path !== target.path || current.version !== target.version) return;
      if (dirtyRef.current) {
        setNotice("项目文档已更新；本地未保存内容已保留，保存时会安全检查版本。");
        return;
      }
      if (latest.version === target.version) {
        if (lastGoodJob && latest.kind === "tex" && lastGoodJob.version !== latest.version) setNotice("保留的 PDF 对应较早的源码版本；请重新编译后再从 PDF 引用。");
        else setNotice("");
        return;
      }
      setOpened(latest);
      setDocxSourceVersion(latest.version);
      savedVersion.current = latest.version;
      setDocumentDirty(false);
      setDocxHandle(null);
      setText(latest.kind === "tex" ? latest.content ?? "" : "");
      if (latest.kind === "pdf") setPdfUrl(latest.rawUrl ?? `/api/projects/${encodeURIComponent(project.id)}/documents/raw?path=${encodeURIComponent(latest.path)}`);
      setSourceSelection({ text: "", from: 0, to: 0, lineStart: 0, lineEnd: 0 });
      if (lastGoodJob && latest.kind === "tex" && lastGoodJob.version !== latest.version) setNotice("已载入最新源码；保留的 PDF 是旧版本，请重新编译后再从 PDF 引用。");
      else setNotice("已载入项目中的最新文档版本。");
    }).catch(caught => {
      if (token === revisionGeneration.current) setNotice(`检查最新文档失败，当前内容未更改：${caught instanceof Error ? caught.message : String(caught)}`);
    });
  }, [revision, opened, busy, dirty, project.id, lastGoodJob, refreshTree, treePath]);

  async function openPath(path: string) {
    revisionGeneration.current++;
    if (opened && dirty && !window.confirm("当前文档有未保存修改。放弃修改并打开另一个文件吗？")) return;
    const token = ++generation.current;
    setBusy(true); setError(""); setJob(null); setLastGoodJob(null); setPdfUrl(""); setAssetLocalUrl(""); setDocxHandle(null); setSourceSelection({ text: "", from: 0, to: 0, lineStart: 0, lineEnd: 0 }); setMobileTab(path.toLowerCase().endsWith(".pdf") ? "preview" : "editor");
    try {
      const extension = path.toLowerCase().split(".").at(-1);
      if (extension === "pdf") {
        const file = await openDocument(project.id, path);
        if (token !== generation.current) return;
        setOpened(file); setText(""); setDocumentDirty(false); savedVersion.current = file.version;
        setPdfUrl(file.rawUrl ?? `/api/projects/${encodeURIComponent(project.id)}/documents/raw?path=${encodeURIComponent(path)}`);
        return;
      }
      if (extension !== "tex" && extension !== "docx") {
        const entry = entries.find(item => item.path === path);
        setOpened({ path, name: path.split("/").at(-1) ?? path, kind: "asset", version: "readonly", size: entry?.size ?? 0 });
        setText(""); setDocumentDirty(false); savedVersion.current = "";
        return;
      }
      const file = await openDocument(project.id, path);
      if (token !== generation.current) return;
      setOpened(file); setDocxSourceVersion(`${file.version}:open:${token}`); setText(file.kind === "tex" ? file.content ?? "" : ""); setDocumentDirty(false); savedVersion.current = file.version; setDocxHandle(null);
    } catch (caught) { if (token === generation.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (token === generation.current) setBusy(false); }
  }

  async function saveCurrent(docxBlob?: Blob): Promise<OpenedDocument | null> {
    if (!opened || isPdf) return opened;
    if (!dirty) return opened;
    setBusy(true); setError("");
    try {
      const payload: { path: string; baseVersion: string; content?: string; base64?: string } = { path: opened.path, baseVersion: savedVersion.current };
      if (opened.kind === "tex") payload.content = text;
      else {
        const blob = docxBlob ?? await docxHandle?.getInstance()?.export({ triggerDownload: false });
        if (!blob) throw new Error("DOCX 尚未就绪，无法安全保存。");
        payload.base64 = await blobToBase64(blob);
      }
      const next = await saveDocument(project.id, payload);
      savedVersion.current = next.version; setOpened(next); setDocumentDirty(false);
      return next;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message.includes("409") || message.toLowerCase().includes("version") ? `${message} 文件未覆盖；请重新打开最新版本后再继续。` : message);
      return null;
    } finally { setBusy(false); }
  }

  async function compile() {
    if (!opened || opened.kind !== "tex") return;
    const saved = dirty ? await saveCurrent() : opened;
    if (!saved) return;
    setBusy(true); setError("");
    const token = ++generation.current;
    let current: DocumentJob | null = null;
    try {
      current = await compileDocument(project.id, { path: saved.path, version: saved.version, engine });
      if (token !== generation.current) return;
      setJob(current);
      while (current.state === "queued" || current.state === "running") {
        await delay(1400);
        const next = await readJob(project.id, current.id);
        if (token !== generation.current) return;
        current = next; setJob(next);
      }
      if (current.state === "succeeded") {
        setPdfUrl(`/api/projects/${encodeURIComponent(project.id)}/documents/jobs/${encodeURIComponent(current.id)}/artifact`);
        setLastGoodJob(current); setMobileTab("preview");
      } else if (current.state === "failed") setError(current.error || current.log || "LaTeX 编译失败。上次成功的 PDF 预览仍然保留。");
    } catch (caught) { if (token === generation.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (token === generation.current) setBusy(false); }
  }

  async function reference(selection: WritingSelection) {
    if (!opened) return;
    if (selection.kind === "pdf" && isPdf) {
      if (opened.version.startsWith("local:")) {
        setError("本地临时 PDF 尚未成为项目文件，无法创建可追溯引用。");
        return;
      }
      try {
        const latest = await openDocument(project.id, opened.path);
        if (latest.version !== opened.version) {
          setError("项目中的 PDF 已更新；请重新打开最新版本后再引用。");
          return;
        }
        onReference({ ...selection, path: latest.path, version: latest.version });
      } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
      return;
    }
    if (selection.kind === "pdf") {
      if (!lastGoodJob?.id || !opened) { setError("请先成功编译当前 LaTeX 源文件，再从 PDF 引用。"); return; }
      if (dirty) {
        const saved = await saveCurrent();
        if (!saved) return;
        if (saved.version !== lastGoodJob.version) {
          setError("源文件已保存；为避免引用过期 PDF，请重新编译后再选取文字。");
          return;
        }
      } else {
        try {
          const latest = await openDocument(project.id, opened.path);
          if (latest.version !== lastGoodJob.version) {
            setError("项目中的源文件版本已变化；请重新打开并编译后，再引用这份 PDF。");
            return;
          }
        } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return; }
      }
      try {
        const source = await synctex(project.id, { jobId: lastGoodJob.id, page: selection.page ?? 1, x: selection.x ?? 0, y: selection.y ?? 0 });
        onReference({ ...selection, path: source.path, version: source.version, kind: "tex", range: { ...selection.range, from: 0, to: 0, lineStart: source.line, lineEnd: source.line } });
      } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
      return;
    }
    if (dirty) {
      const saved = await saveCurrent();
      if (!saved) return;
      selection.version = saved.version;
    } else {
      try {
        const latest = await openDocument(project.id, opened.path);
        if (latest.version !== opened.version) {
          setError("项目中的文档已由其他编辑器更新；请重新打开最新版本后再引用。");
          return;
        }
      } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return; }
    }
    onReference(selection);
  }

  async function createNew(kind: "tex" | "docx") {
    revisionGeneration.current++;
    const extension = kind === "tex" ? "tex" : "docx";
    const baseName = "untitled";
    const usedPaths = new Set(entries.map(entry => entry.path));
    const prefix = treePath ? `${treePath.replace(/\/$/, "")}/` : "";
    let name = `${baseName}.${extension}`;
    let suffix = 2;
    while (usedPaths.has(`${prefix}${name}`)) name = `${baseName}-${suffix++}.${extension}`;
    const content = kind === "tex" ? "\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n" : undefined;
    setBusy(true); setError("");
    try {
      const created = await saveDocument(project.id, { path: `${prefix}${name}`, baseVersion: null, create: true, ...(content ? { content } : {}), ...(kind === "docx" ? { base64: await blankDocxBase64() } : {}) });
      setOpened(created); setDocxSourceVersion(created.version); setText(created.content ?? content ?? ""); setDocumentDirty(false); savedVersion.current = created.version; setJob(null); setLastGoodJob(null); setPdfUrl(""); setMobileTab("editor"); await refreshTree(treePath);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  async function importFile(file: File) {
    if (opened && dirty && !window.confirm("当前文档有未保存修改。放弃修改并导入另一个文件吗？")) return;
    revisionGeneration.current++;
    setBusy(true); setError("");
    try {
      const uploaded = await uploadProjectFiles(project.id, [file]);
      if (!uploaded.data[0]) throw new Error("上传失败，没有收到文件记录。");
      const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
      const safeName = (file.name.split(/[\\/]/).at(-1) ?? "imported-file").replace(/[<>:"|?*\x00-\x1f]/g, "_").trim() || "imported-file";
      const targetPath = treePath ? `${treePath.replace(/\/$/, "")}/${safeName}` : safeName;
      if (extension === "tex") {
        if (file.size > 2 * 1024 * 1024) throw new Error("TeX 文件超过 2 MB 导入上限。");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
        const created = await saveDocument(project.id, { path: targetPath, baseVersion: null, content, create: true });
        setOpened(created); setText(created.content ?? content); setDocumentDirty(false); savedVersion.current = created.version;
        setDocxHandle(null); setJob(null); setLastGoodJob(null); setPdfUrl(""); setAssetLocalUrl(""); setMobileTab("editor");
      } else if (extension === "docx") {
        if (file.size > 25 * 1024 * 1024) throw new Error("DOCX 文件超过 25 MB 导入上限。");
        const created = await saveDocument(project.id, { path: targetPath, baseVersion: null, base64: await blobToBase64(file), create: true });
        setOpened(created); setDocxSourceVersion(created.version); setText(""); setDocumentDirty(false); savedVersion.current = created.version;
        setDocxHandle(null); setJob(null); setLastGoodJob(null); setPdfUrl(""); setAssetLocalUrl(""); setMobileTab("editor");
      } else if (extension === "pdf") {
        if (file.size > 50 * 1024 * 1024) throw new Error("PDF 文件超过 50 MB 预览上限。");
        setOpened({ path: safeName, name: safeName, kind: "pdf", version: `local:${file.size}:${file.lastModified}`, size: file.size });
        setPdfUrl(URL.createObjectURL(file)); setAssetLocalUrl(""); setText(""); setDocumentDirty(false); savedVersion.current = "";
        setJob(null); setLastGoodJob(null); setMobileTab("preview");
      } else {
        const localUrl = URL.createObjectURL(file);
        setOpened({ path: safeName, name: safeName, kind: "asset", version: `local:${file.size}:${file.lastModified}`, size: file.size });
        setAssetLocalUrl(localUrl); setPdfUrl(""); setText(""); setDocumentDirty(false); savedVersion.current = "";
        setJob(null); setLastGoodJob(null); setMobileTab("preview");
      }
      await refreshTree(treePath);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  async function convertCurrent(to: "docx" | "tex" | "pdf") {
    if (!opened || dirty || isPdf) return;
    setExportOpen(false);
    setBusy(true); setError("");
    const token = ++generation.current;
    try {
      let current = await convertDocument(project.id, { path: opened.path, version: opened.version, to });
      while (current.state === "queued" || current.state === "running") {
        await delay(1400);
        const next = await readJob(project.id, current.id);
        if (token !== generation.current) return;
        current = next;
      }
      if (token !== generation.current) return;
      if (current.state !== "succeeded") throw new Error(current.error || current.log || "文档转换失败。");
      const blob = await readJobArtifact(project.id, current.id);
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = current.outputPath?.split("/").at(-1) ?? `${opened.name.replace(/\.[^.]+$/, "")}.${to}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("转换完成，已下载文件；转换结果不会覆盖项目文件。");
    } catch (caught) { if (token === generation.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (token === generation.current) setBusy(false); }
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging.current) return;
    if (dragging.current === "tree") {
      const rect = event.currentTarget.getBoundingClientRect();
      setLeftWidth(Math.max(170, Math.min(380, event.clientX - rect.left)));
    }
    else {
      const editorRect = editorPaneRef.current?.getBoundingClientRect();
      const previewRect = pdfRef.current?.getBoundingClientRect();
      const contentWidth = (editorRect?.width ?? 0) + (previewRect?.width ?? 0);
      if (editorRect && contentWidth > 0) setEditorWidth(Math.max(28, Math.min(72, ((event.clientX - editorRect.left) / contentWidth) * 100)));
    }
  }
  function onPointerUp() { dragging.current = null; }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !workbenchRef.current?.contains(target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveCurrent(); }
      if (event.key === "Escape" && exportOpen) { event.preventDefault(); setExportOpen(false); return; }
      if (event.key === "Escape" && !busy) void close();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  async function close() {
    if (dirty && !window.confirm("有未保存的修改。确定关闭并放弃这些修改吗？")) return;
    if (job && (job.state === "queued" || job.state === "running")) { try { await cancelJob(project.id, job.id); } catch { /* closing remains safe */ } }
    generation.current++; revisionGeneration.current++; onClose();
  }

  const modeClass = opened?.kind === "docx" ? "writingModeDocx" : opened?.kind === "pdf" ? "writingModePdf" : opened?.kind === "asset" ? "writingModeAsset" : "writingModeTex";
  const mobileTabs: [MobileTab, string][] = opened?.kind === "docx"
    ? [["files", "文件"], ["editor", "文档"]]
    : opened?.kind === "pdf" || opened?.kind === "asset"
      ? [["files", "文件"], ["preview", "预览"]]
      : [["files", "文件"], ["editor", "编辑"], ["preview", "预览"]];

  return <div ref={workbenchRef} className={`writingWorkbench ${modeClass}${closing ? " writingClosing" : ""}`} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
    <header className="writingHeader">
      <button type="button" className="writingIconButton writingBack" onClick={() => void close()} title="返回聊天" aria-label="返回聊天"><WritingIcon glyph={ArrowLeftIcon} size={17} /></button>
      <div className="writingHeading"><strong>写作</strong><span>{project.name} · {opened?.name ?? "选择或新建文档"}</span>{dirty ? <span className="writingDirtyDot" aria-label="有未保存修改">未保存</span> : null}</div>
      <div className="writingActions">
        <button type="button" className="writingButton" disabled={!opened || !dirty || busy || isPdf || isAsset} onClick={() => void saveCurrent()}><WritingIcon glyph={Save} />保存</button>
        {opened?.kind === "tex" && !isPdf ? <><select aria-label="LaTeX 引擎" value={engine} onChange={event => setEngine(event.target.value as typeof engine)}><option value="xelatex">XeLaTeX</option><option value="pdflatex">pdfLaTeX</option><option value="lualatex">LuaLaTeX</option></select><button className="writingButton writingPrimary" disabled={busy} onClick={() => void compile()}><WritingIcon glyph={Refresh} className={busy ? "writingSpin" : ""} />编译</button></> : null}
        {opened && (opened.kind === "tex" || opened.kind === "docx") ? <div className="writingExport" ref={exportRef}>
          <button type="button" className="writingButton" aria-expanded={exportOpen} aria-haspopup="menu" onClick={() => setExportOpen(value => !value)} disabled={dirty || busy}>导出<WritingIcon glyph={Down} size={12} /></button>
          <ToolReveal open={exportOpen} className="writingExportReveal"><div className="uiGlassSurface writingExportMenu" role="menu" aria-label="文档导出格式">
            {opened.kind === "tex" ? <button type="button" role="menuitem" onClick={() => void convertCurrent("docx")}>转换为 Word (.docx)</button> : <>
              {officePdfAvailable ? <button type="button" role="menuitem" onClick={() => void convertCurrent("pdf")}>导出 PDF (.pdf)</button> : null}
              <button type="button" role="menuitem" onClick={() => void convertCurrent("tex")}>转换为 LaTeX (.tex)</button>
            </>}
          </div></ToolReveal>
        </div> : null}
        {onToggleChat ? <button type="button" className="writingIconButton writingChatToggle" onClick={onToggleChat} title={chatVisible ? "隐藏聊天" : "显示聊天"} aria-label={chatVisible ? "隐藏聊天" : "显示聊天"}><WritingIcon glyph={Message} size={17} /></button> : null}
        <button type="button" className="writingIconButton" onClick={() => void close()} title="关闭写作" aria-label="关闭写作"><WritingIcon glyph={Close} size={17} /></button>
      </div>
    </header>

    <nav className="writingMobileTabs" aria-label="写作视图">
      {mobileTabs.map(([tab, label]) => <button key={tab} type="button" className={mobileTab === tab ? "active" : ""} onClick={() => setMobileTab(tab)}>{label}</button>)}
    </nav>

    <div className="writingLayout">
      {leftWidth < 40 ? <button className="writingExpandFiles" type="button" onClick={() => setLeftWidth(230)} title="展开项目文件" aria-label="展开项目文件"><WritingIcon glyph={MenuUnfold} /></button> : null}
      <aside className={`writingFiles ${mobileTab === "files" ? "mobileActive" : ""}`} style={{ width: leftWidth }}>
        <div className="writingFilesHeader"><span>项目文件</span><button type="button" title="折叠文件区" aria-label="折叠文件区" onClick={() => setLeftWidth(value => value < 40 ? 230 : 0)}><WritingIcon glyph={MenuFold} /></button></div>
        <div className="writingPath">{treePath || project.rootPath}</div>
        {treePath ? <button type="button" className="writingTreeEntry writingUp" onClick={() => void refreshTree(treePath.split("/").slice(0, -1).join("/"))}><WritingIcon glyph={Down} />上一级</button> : null}
        <div className="writingTree" role="tree">
          {visibleEntries.map(entry => <button type="button" role="treeitem" key={entry.path} className={`writingTreeEntry ${opened?.path === entry.path ? "selected" : ""}`} title={entry.path} onClick={() => entry.kind === "directory" ? (setExpanded(value => ({ ...value, [entry.path]: !value[entry.path] })), void refreshTree(entry.path)) : void openPath(entry.path)}>
            {entry.kind === "directory" ? (expanded[entry.path] ? <WritingIcon glyph={Down} /> : <WritingIcon glyph={ArrowRight} />) : fileIcon(entry.kind)}<span className="writingTreeName">{entry.name}</span>{entry.kind !== "directory" ? <small>{Math.max(1, Math.ceil(entry.size / 1024))} KB</small> : null}
          </button>)}
          {nextTreeOffset !== null ? <button type="button" className="writingLoadMore" disabled={loadingMore} onClick={() => void loadMoreTree()}>{loadingMore ? "正在加载…" : "加载更多文件"}</button> : null}
          {!entries.length ? <div className="writingEmpty">此目录暂无文档</div> : null}
        </div>
        <div className="writingFileActions"><button type="button" onClick={() => void createNew("tex")}><WritingIcon glyph={FileAddition} />新建 TeX</button><button type="button" onClick={() => void createNew("docx")}><WritingIcon glyph={FileAddition} />新建 DOCX</button><label><WritingIcon glyph={Upload} />导入<input type="file" accept=".tex,.docx,.pdf,.bib,.sty,.cls" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void importFile(file); event.currentTarget.value = ""; }} /></label></div>
      </aside>
      <div className="writingResizeHandle treeHandle" role="separator" aria-orientation="vertical" aria-label="调整文件栏宽度" onPointerDown={event => { dragging.current = "tree"; event.currentTarget.setPointerCapture(event.pointerId); }} />

      <main ref={editorPaneRef} className={`writingEditorPane ${mobileTab === "editor" ? "mobileActive" : ""}`} style={{ flex: opened?.kind === "docx" ? "1 1 auto" : `${editorWidth} 1 0`, width: "auto" }}>
        {!opened ? <div className="writingEmpty writingWelcome"><WritingIcon glyph={FileText} size={28} /><strong>打开一个项目文档</strong><span>选择左侧 TeX 或 DOCX 文件，或创建新文档。</span></div> : isPdf ? <div className="writingEmpty">已打开 PDF：选择左侧 TeX 文档查看源文件与编译预览。</div> : isAsset ? <div className="writingEmpty">此项目文件仅支持只读预览。</div> : <>
          <div className="writingPaneTitle"><span>{opened.name}</span><small>{opened.kind === "tex" ? "LaTeX 源码" : "原生 DOCX 编辑"}</small><button type="button" className="writingReferenceButton" disabled={!sourceSelection.text.trim() || opened.kind !== "tex"} onClick={() => void reference({ path: opened.path, version: opened.version, kind: "tex", text: sourceSelection.text, range: { from: sourceSelection.from, to: sourceSelection.to, lineStart: sourceSelection.lineStart, lineEnd: sourceSelection.lineEnd } })}>引用选区</button></div>
          <div className="writingEditorSurface">
            {opened.kind === "tex" ? <Suspense fallback={<div className="writingEmpty">正在加载源码编辑器…</div>}><LatexEditor value={text} onChange={value => { setText(value); setDocumentDirty(true); }} onSelection={setSourceSelection} /></Suspense> : <Suspense fallback={<div className="writingEmpty">正在加载 DOCX 编辑器…</div>}><DocxEditor projectId={project.id} document={opened} sourceVersion={docxSourceVersion} sourceUrl={opened.rawUrl ?? `/api/projects/${encodeURIComponent(project.id)}/documents/raw?path=${encodeURIComponent(opened.path)}`} onDirty={() => setDocumentDirty(true)} onReady={setDocxHandle} onReference={selection => void reference(selection)} /></Suspense>}
          </div>
        </>}
      </main>

      <div className="writingResizeHandle splitHandle" role="separator" aria-orientation="vertical" aria-label="调整编辑器与预览宽度" onPointerDown={event => { dragging.current = "split"; event.currentTarget.setPointerCapture(event.pointerId); }} />
      <section className={`writingPreviewPane ${mobileTab === "preview" ? "mobileActive" : ""}`} style={{ flex: opened?.kind === "pdf" || opened?.kind === "asset" ? "1 1 auto" : `${100 - editorWidth} 1 0` }} ref={pdfRef}>
        <div className="writingPaneTitle"><span>编译预览</span>{job ? <small className={`writingJobState ${job.state}`}>{job.state === "running" || job.state === "queued" ? "编译中" : job.state === "succeeded" ? "最新 PDF" : job.state === "failed" ? "编译失败" : "已取消"}</small> : null}<button type="button" className="writingIconButton" onClick={() => void compile()} disabled={!opened || opened.kind !== "tex" || isPdf || busy} title="重新编译" aria-label="重新编译"><WritingIcon glyph={Refresh} /></button></div>
        <div className="writingPreviewSurface">
          {isAsset && opened ? <Suspense fallback={<div className="writingEmpty">正在加载只读预览…</div>}><AssetPreview projectId={project.id} path={opened.path} name={opened.name} localUrl={assetLocalUrl || undefined} /></Suspense> : pdfUrl && (isPdf || lastGoodJob?.state === "succeeded") ? <Suspense fallback={<div className="writingEmpty">正在加载 PDF…</div>}><PdfEditor url={pdfUrl} jobId={lastGoodJob?.id ?? ""} version={lastGoodJob?.version ?? opened?.version ?? ""} path={lastGoodJob?.path ?? opened?.path ?? ""} onPick={selection => void reference(selection)} onError={setError} /></Suspense> : <div className="writingEmpty"><WritingIcon glyph={BookOpen} size={24} /><span>{opened?.kind === "tex" ? "编译后在此查看 PDF。" : "选择一个已编译的 TeX 项目查看 PDF."}</span></div>}
        </div>
      </section>
    </div>
    {error ? <div className="writingErrorToast" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="关闭错误"><WritingIcon glyph={Close} /></button></div> : null}
    {notice ? <div className="writingNoticeToast" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="关闭通知"><WritingIcon glyph={Close} /></button></div> : null}
    {busy ? <div className="writingBusyStatus" role="status"><WritingIcon glyph={Refresh} className="writingSpin" size={14} />处理中…</div> : null}
  </div>;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

async function blankDocxBase64(): Promise<string> {
  // SuperDoc's own public blank-document path supplies the complete OOXML package,
  // including its relationships, styles, settings, and renderer metadata.
  const { SuperDoc } = await import("superdoc");
  const host = window.document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, { position: "fixed", left: "-12000px", top: "0", width: "800px", height: "1000px", overflow: "hidden" });
  window.document.body.appendChild(host);
  let instance: InstanceType<typeof SuperDoc> | null = null;
  try {
    instance = await new Promise<InstanceType<typeof SuperDoc>>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else if (instance) resolve(instance);
        else reject(new Error("SuperDoc did not initialize its blank document."));
      };
      const timer = window.setTimeout(() => finish(new Error("Creating a blank DOCX timed out.")), 30000);
      try {
        instance = new SuperDoc({ selector: host, onReady: event => { instance = event.superdoc; finish(); }, onContentError: event => finish(event.error), onException: event => finish(event.error) });
      } catch (error) { finish(error); }
    });
    const exported = await instance.export({ triggerDownload: false });
    if (!(exported instanceof Blob)) throw new Error("SuperDoc did not return a DOCX package for the blank document.");
    return await blobToBase64(exported);
  } finally {
    instance?.destroy();
    host.remove();
  }
}
