import { useEffect, useRef, useState } from "react";
import { SuperDocEditor, type SuperDocRef } from "@superdoc-dev/react";
import "@superdoc-dev/react/style.css";
import { readDocumentBlob } from "./api";
import type { OpenedDocument, WritingSelection } from "./types";

type EditorHandle = SuperDocRef;

export default function DocxEditor({ projectId, document, sourceVersion, sourceUrl, onDirty, onReady, onReference, readOnly = false }: {
  projectId: string;
  document: OpenedDocument;
  sourceVersion: string;
  sourceUrl: string;
  onDirty(): void;
  onReady(handle: EditorHandle | null): void;
  onReference(selection: WritingSelection): void;
  readOnly?: boolean;
}) {
  const editorRef = useRef<EditorHandle | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const preferredZoom = useRef<number | null>(null);
  const lastFitZoom = useRef<number | null>(null);
  const automaticFit = useRef(true);
  const [error, setError] = useState("");
  const [authorizedFile, setAuthorizedFile] = useState<File | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    setAuthorizedFile(null); setError(""); setReady(false);
    preferredZoom.current = null; lastFitZoom.current = null; automaticFit.current = true;
    void readDocumentBlob(projectId, document.path, document.rawUrl || sourceUrl).then(blob => {
      if (disposed) return;
      setAuthorizedFile(new File([blob], document.name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    }).catch(caught => { if (!disposed) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { disposed = true; };
  // A local export/save updates CAS metadata but the native editor already
  // contains that document. Re-import only an open/import or external revision;
  // otherwise slower networks reset the user's cursor/zoom after a saved edit.
  }, [projectId, document.path, document.name, sourceVersion, document.rawUrl, sourceUrl]);
  useEffect(() => () => onReady(null), [onReady]);
  useEffect(() => {
    if (!ready) return;
    const host = hostRef.current;
    const instance = editorRef.current?.getInstance();
    if (!host || !instance) return;
    let frame = 0;
    let observedPage: HTMLElement | null = null;
    const fitPage = () => {
      const page = host.querySelector<HTMLElement>(".presentation-editor__viewport");
      const pageWidth = page?.getBoundingClientRect().width ?? 0;
      const availableWidth = host.clientWidth;
      if (!pageWidth || !availableWidth) return;
      const currentZoom = instance.getZoom();
      // An explicit toolbar zoom belongs to the user: keep it and allow
      // scrolling, rather than immediately undoing it with another fit.
      if (lastFitZoom.current !== null && Math.abs(currentZoom - lastFitZoom.current) >= 1) automaticFit.current = false;
      if (!automaticFit.current) return;
      const wantedZoom = preferredZoom.current ?? currentZoom;
      const fitZoom = Math.max(30, Math.min(wantedZoom, Math.floor(currentZoom * (availableWidth - 20) / pageWidth)));
      lastFitZoom.current = fitZoom;
      if (Math.abs(fitZoom - currentZoom) >= 1) instance.setZoom(fitZoom);
    };
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitPage);
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    // onReady can precede the presentation page's first layout. Watching only
    // the fixed-size host misses that layout and leaves a new narrow pane at
    // 100%. Observe the actual page when the native renderer mounts it.
    const observePage = () => {
      const page = host.querySelector<HTMLElement>(".presentation-editor__viewport");
      if (page === observedPage) return;
      if (observedPage) observer.unobserve(observedPage);
      observedPage = page;
      if (page) { observer.observe(page); scheduleFit(); }
    };
    const mutations = new MutationObserver(observePage);
    mutations.observe(host, { childList: true, subtree: true });
    observePage();
    scheduleFit();
    return () => { mutations.disconnect(); observer.disconnect(); cancelAnimationFrame(frame); };
  }, [ready, document.path, sourceVersion]);
  return <div className="writingDocxEditor" ref={hostRef} onInput={onDirty}>
    {error ? <div className="writingInlineError" role="alert">{error}</div> : null}
    {authorizedFile ? <SuperDocEditor
      ref={editorRef}
      document={authorizedFile}
      documentMode={readOnly ? "viewing" : "editing"}
      contained
      style={{ height: "100%", minHeight: 0 }}
      onReady={() => {
        setError("");
        preferredZoom.current = editorRef.current?.getInstance()?.getZoom() ?? 100;
        lastFitZoom.current = preferredZoom.current;
        setReady(true); onReady(editorRef.current);
      }}
      onEditorUpdate={onDirty}
      onContentError={({ error: caught }: { error: unknown }) => setError(caught instanceof Error ? caught.message : String(caught))}
      onException={({ error: caught }: { error: unknown }) => setError(caught instanceof Error ? caught.message : String(caught))}
    /> : <div className="writingEmpty">正在安全读取 DOCX…</div>}
    <button className="writingReferenceFloat" type="button" onMouseDown={event => event.preventDefault()} onClick={() => void pickSelection()} title="引用所选文字">引用所选文字</button>
  </div>;

  async function pickSelection() {
    try {
      const doc = editorRef.current?.getInstance()?.activeEditor?.doc;
      if (!doc?.selection?.current) throw new Error("文档尚未就绪。请稍候重试。");
      const selection = await doc.selection.current({ includeText: true });
      const text = typeof selection.text === "string" ? selection.text : "";
      if (!text.trim()) throw new Error("请先在文档中选择要引用的文字。");
      const target = selection.target;
      if (!target || target.kind !== "text" || !target.segments.length) throw new Error("当前选区没有可用的文档范围。");
      const first = target.segments[0];
      const last = target.segments[target.segments.length - 1];
      const event: WritingSelection = {
        path: document.path,
        version: document.version,
        kind: "docx",
        text,
        range: {
          from: first.range.start,
          to: last.range.end,
          blockId: first.blockId,
          endBlockId: last.blockId,
          segments: target.segments
        }
      };
      onReference(event);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }
}

export type DocxEditorHandle = EditorHandle;
