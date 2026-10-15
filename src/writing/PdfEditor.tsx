import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from "react";
import { Plus, ReduceOne } from "@icon-park/svg";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { getApiUserId } from "../api";
import WritingIcon from "./Icon";
import type { WritingSelection } from "./types";

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

function Page({ pdf, pageNumber, width, onSelected }: { pdf: PdfDoc; pageNumber: number; width: number; onSelected(value: { text: string; page: number; x: number; y: number }): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pdfScale = useRef(1);
  const [height, setHeight] = useState(792);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "400px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | undefined;
    let textLayer: InstanceType<typeof TextLayer> | undefined;
    void pdf.getPage(pageNumber).then(async page => {
      if (cancelled || !canvasRef.current || !textLayerRef.current) return;
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, width / original.width);
      pdfScale.current = scale;
      const viewport = page.getViewport({ scale });
      setHeight(viewport.height);
      const content = await page.getTextContent();
      if (cancelled) return;
      const textHost = textLayerRef.current;
      textHost.replaceChildren();
      textHost.style.width = `${viewport.width}px`;
      textHost.style.height = `${viewport.height}px`;
      textLayer = new TextLayer({ textContentSource: content, container: textHost, viewport });
      await textLayer.render();
      if (cancelled) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(6_000_000 / (viewport.width * viewport.height)));
      const canvas = canvasRef.current;
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const rendering = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      task = rendering;
      await rendering.promise;
      page.cleanup();
    }).catch(caught => { if (!cancelled && (caught as { name?: string })?.name !== "RenderingCancelledException") setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { cancelled = true; task?.cancel(); textLayer?.cancel(); textLayerRef.current?.replaceChildren(); if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; } };
  }, [pdf, pageNumber, width, visible]);
  function selected(event: MouseEvent<HTMLElement> | TouchEvent<HTMLElement>) {
    const selection = window.getSelection();
    const text = selection?.toString() ?? "";
    const textLayer = textLayerRef.current;
    if (!selection?.anchorNode || !selection.focusNode || !textLayer?.contains(selection.anchorNode) || !textLayer.contains(selection.focusNode)) return;
    const root = pageRef.current?.querySelector(".writingPdfCanvasWrap") as HTMLDivElement | null;
    if (!text.trim() || !root) return;
    const rect = root.getBoundingClientRect();
    const scale = Math.max(.001, pdfScale.current);
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const x = Math.max(0, (point.clientX - rect.left) / scale);
    const y = Math.max(0, (point.clientY - rect.top) / scale);
    onSelected({ text, page: pageNumber, x, y });
  }
  return <article className="writingPdfPage" ref={pageRef} style={{ width: width + 16 }} onMouseUp={selected} onTouchEnd={selected}>
    <div className="writingPdfPageNumber">{pageNumber}</div>
    <div className="writingPdfCanvasWrap" style={{ height, width }}>
      <canvas ref={canvasRef} />
      <div className="textLayer writingPdfTextLayer" ref={textLayerRef} aria-label={`PDF 第 ${pageNumber} 页文本`} />
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </article>;
}

export default function PdfEditor({ url, jobId, version, path, onPick, onError }: {
  url: string;
  jobId: string;
  version: string;
  path: string;
  onPick(selection: WritingSelection): void;
  onError(error: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PdfDoc | null>(null);
  const [width, setWidth] = useState(640);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let loading: { destroy: () => void; promise: Promise<PdfDoc> } | undefined;
    void (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url")]);
        if (stopped) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const response = await fetch(url, { credentials: "same-origin", headers: { "x-codex-web-user-id": getApiUserId() } });
        if (!response.ok) throw new Error("PDF 预览读取失败。");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 80 * 1024 * 1024) throw new Error("PDF 超过 80 MB 预览上限。");
        loading = pdfjs.getDocument({ data: bytes, useSystemFonts: true, useWasm: false, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/" });
        const result = await loading.promise;
        if (!stopped) setPdf(result);
        else void loading.destroy();
      } catch (caught) { if (!stopped) { const message = caught instanceof Error ? caught.message : String(caught); setError(message); onError(message); } }
    })();
    return () => { stopped = true; loading?.destroy(); };
  }, [url, onError]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = () => setWidth(Math.max(280, element.clientWidth - 36) * zoom);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [zoom]);
  const select = (value: { text: string; page: number; x: number; y: number }) => onPick({ path, version, kind: "pdf", text: value.text, page: value.page, x: value.x, y: value.y, range: { from: 0, to: 0 } });
  return <div className="writingPdfViewer" ref={host}>
    {error ? <div className="writingErrorPane" role="alert">{error}</div> : pdf ? <div className="writingPdfPages">{pdf.numPages > 240 ? <p>仅显示前 240 页</p> : null}{Array.from({ length: Math.min(pdf.numPages, 240) }, (_, index) => <Page key={index} pdf={pdf} pageNumber={index + 1} width={width} onSelected={select} />)}</div> : <div className="writingEmpty">正在打开 PDF…</div>}
    <div className="writingPdfZoom"><button type="button" onClick={() => setZoom(value => Math.max(.5, value / 1.2))} aria-label="缩小 PDF"><WritingIcon glyph={ReduceOne} /></button><button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" onClick={() => setZoom(value => Math.min(2.5, value * 1.2))} aria-label="放大 PDF"><WritingIcon glyph={Plus} /></button></div>
  </div>;
}
