import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Minus, Plus } from "lucide-react";
import { PreviewZoom } from "./PreviewZoom";

// Session-memory-only, content-addressed LRU: never serve an old rendering
// without first reading and hashing the currently authorized file contents.
type OfficeCacheEntry={html:string;bytes:Uint8Array|null;size:number};
const officeHtmlCache = new Map<string,OfficeCacheEntry>();
const officeHtmlCacheLimit = 24 * 1024 * 1024;
let officeHtmlCacheSize = 0;
async function officeCacheKey(bytes:Uint8Array,name:string) {
  if (!window.crypto?.subtle) return `bytes:${name}:${bytes.length}`;
  const digest = await window.crypto.subtle.digest("SHA-256",bytes.slice().buffer);
  return `${name}:${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}`;
}
function rememberOfficeHtml(key:string,html:string,bytes:Uint8Array) {
  const content=key.startsWith("bytes:")?bytes.slice():null;
  const size=html.length*2+(content?.length??0);
  if(!key || size>officeHtmlCacheLimit)return;
  const previous=officeHtmlCache.get(key);
  if(previous)officeHtmlCacheSize-=previous.size;
  officeHtmlCache.delete(key);officeHtmlCache.set(key,{html,bytes:content,size});officeHtmlCacheSize+=size;
  while(officeHtmlCacheSize>officeHtmlCacheLimit){const oldest=officeHtmlCache.keys().next().value!;officeHtmlCacheSize-=officeHtmlCache.get(oldest)!.size;officeHtmlCache.delete(oldest);}
}
function OfficeFrame({html,name}:{html:string;name:string}) {
  const [source,setSource]=useState("");
  useEffect(()=>{const url=URL.createObjectURL(new Blob([html],{type:"text/html"}));setSource(url);return()=>URL.revokeObjectURL(url);},[html]);
  return source?<iframe className="documentOfficeFrame" src={source} sandbox="" title={name}/>:<div className="documentPreviewStatus">正在打开文档…</div>;
}

function pdfFitScale(width: number, height: number, pageWidth: number, pageHeight: number) {
  return Math.min(1, Math.max(100, width - 40) / pageWidth, Math.max(100, height - 60) / pageHeight);
}

function PdfPage({ document, number, zoom, stage }: { document: PDFDocumentProxy; number: number; zoom: number; stage: { width: number; height: number } }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let sequence = 0;
    let task: { cancel: () => void } | undefined;
    const observer = new IntersectionObserver(entries => {
      const current = ++sequence;
      if (!entries.some(entry => entry.isIntersecting)) {
        task?.cancel();
        if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; }
        return;
      }
      void document.getPage(number).then(async page => {
        if (stopped || current !== sequence || !canvas.current || !root.current) return;
        const base = page.getViewport({ scale: 1 });
        const scale = pdfFitScale(stage.width, stage.height, base.width, base.height) * zoom;
        const viewport = page.getViewport({ scale });
        // Keep a zoomed page's backing bitmap bounded even on high-DPI phones.
        const ratio = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(6_000_000 / (viewport.width * viewport.height)));
        const element = canvas.current;
        element.width = Math.ceil(viewport.width * ratio);
        element.height = Math.ceil(viewport.height * ratio);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        const render = page.render({canvas:element, viewport, transform:[ratio,0,0,ratio,0,0]});
        task = render;
        await render.promise;
        page.cleanup();
      }).catch(error => { if (!stopped && current === sequence && error?.name !== "RenderingCancelledException") setError(String(error)); });
    }, { rootMargin: "300px" });
    if (root.current) observer.observe(root.current);
    return () => { stopped = true; observer.disconnect(); task?.cancel(); };
  }, [document, number, zoom, stage.width, stage.height]);
  return <div className="documentPdfPage" ref={root}><span>第 {number} 页</span>{error ? <p>{error}</p> : <canvas ref={canvas} />}</div>;
}

function PdfViewer({ document }: { document: PDFDocumentProxy }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [firstPage, setFirstPage] = useState({ width: 612, height: 792 });
  useEffect(() => {
    let cancelled = false;
    void document.getPage(1).then(page => { if (!cancelled) { const size = page.getViewport({ scale: 1 }); setFirstPage({width:size.width,height:size.height}); } });
    const element = stageRef.current;
    if (!element) return;
    const sync = () => setStage({width:element.clientWidth,height:element.clientHeight});
    sync();
    const observer = new ResizeObserver(sync); observer.observe(element);
    return () => { cancelled = true; observer.disconnect(); };
  }, [document]);
  const scale = pdfFitScale(stage.width,stage.height,firstPage.width,firstPage.height) * zoom;
  return <div className="documentPdfViewer">
    <div className="documentPdfStage" ref={stageRef}><div className="documentPdfPages">
      {document.numPages > 200 ? <p>预览前 200 页；完整文件请下载查看。</p> : null}
      {stage.width && stage.height ? Array.from({length:Math.min(document.numPages,200)},(_,i)=><PdfPage key={i} document={document} number={i+1} zoom={zoom} stage={stage}/>) : null}
    </div></div>
    <div className="imageViewerZoomControls" role="group" aria-label="PDF 缩放">
      <button type="button" aria-label="缩小 PDF" title="缩小" onClick={()=>setZoom(value=>Math.max(.25,value/1.25))}><Minus size={17}/></button>
      <button type="button" className="imageViewerZoomValue" title="重置为适应窗口" onClick={()=>setZoom(1)}>{Math.round(scale*100)}%</button>
      <button type="button" aria-label="放大 PDF" title="放大" onClick={()=>setZoom(value=>Math.min(8,value*1.25))}><Plus size={17}/></button>
    </div>
  </div>;
}

function ArchivePreview({ bytes, entries, depth }: { bytes: Uint8Array; entries: {name:string;size:number}[]; depth: number }) {
  const [selected,setSelected]=useState<{url:string;name:string}|null>(null);
  const [error,setError]=useState("");
  const [opening,setOpening]=useState(false);
  const generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  useEffect(()=>()=>{if(selected) URL.revokeObjectURL(selected.url);},[selected]);
  async function open(entry:{name:string;size:number}) {
    if(entry.name.endsWith("/") || opening) return;
    setError("");
    if(entry.size>25*1024*1024 || depth>=3) {setError("该文件过大或嵌套层级过深，请下载压缩包到本机打开。");return;}
    setOpening(true);const current=++generation.current;
    try {
      const {unzip}=await import("fflate");
      const extracted=await new Promise<Uint8Array>((resolve,reject)=>{
        unzip(bytes,{filter:file=>file.name===entry.name && file.originalSize<=25*1024*1024},(error,files)=>{
          if(error)reject(error);else if(!files[entry.name])reject(new Error("该条目无法解压，可能加密或损坏。"));else resolve(files[entry.name]);
        });
      });
      if(current!==generation.current)return;
      if(extracted.byteLength>25*1024*1024)throw new Error("解压后的文件超过预览上限。");
      setSelected({name:entry.name,url:URL.createObjectURL(new Blob([extracted.slice().buffer]))});
    } catch(error) {if(current===generation.current)setError(error instanceof Error?error.message:String(error));}
    finally {if(current===generation.current)setOpening(false);}
  }
  if(selected)return <div className="documentArchiveSelected"><div className="documentArchiveNavigation"><button type="button" onClick={()=>setSelected(null)}>← 返回压缩包</button><span title={selected.name}>{selected.name}</span></div><DocumentPreview url={selected.url} name={selected.name} depth={depth+1}/></div>;
  return <div className="documentArchive"><p>压缩包目录 · {entries.length} 项 · 点击文件在浏览器内解压预览，不写入主机磁盘</p>{error?<p role="alert">{error}</p>:null}{opening?<p role="status">正在打开包内文件…</p>:null}<table><thead><tr><th>文件路径</th><th>原始大小</th></tr></thead><tbody>{entries.map((entry,i)=><tr key={i}><td>{entry.name.endsWith("/")?entry.name:<button type="button" disabled={opening} onClick={()=>void open(entry)}>{entry.name}</button>}</td><td>{Math.ceil(entry.size/1024)} KB</td></tr>)}</tbody></table></div>;
}

export default function DocumentPreview({ url, name, depth=0 }: { url: string; name: string; depth?:number }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [html, setHtml] = useState("");
  const [entries, setEntries] = useState<{ name: string; size: number }[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [archiveBytes,setArchiveBytes]=useState<Uint8Array|null>(null);
  const [plainText,setPlainText]=useState<string|null>(null);
  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    let dispose = () => {};
    setReady(false); setError(""); setDocument(null); setHtml(""); setEntries([]);setArchiveBytes(null);setPlainText(null);
    void (async () => {
      const extension = name.split(".").at(-1)?.toLowerCase();
      const [bytes,tools,docx,pdfAssets]=await Promise.all([
        (async()=>{const response=await fetch(url,{signal:abort.signal});
          if(!response.ok)throw new Error("文件读取失败，请重试。");
          if(Number(response.headers.get("content-length"))>25*1024*1024){abort.abort();throw new Error("文件超过 25 MB 预览上限，请下载到本机打开。");}
          return new Uint8Array(await response.arrayBuffer());})(),
        /^(docx|xlsx|pptx|zip)$/.test(extension??"")?import("./officePreview"):null,
        extension==="docx"?import("docx-preview"):null,
        extension==="pdf"?Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"),import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url")]):null
      ]);
      if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("文件超过 25 MB 预览上限，请下载到本机打开。");
      if (stopped) return;
      if (pdfAssets) {
        const [pdf,worker]=pdfAssets;
        pdf.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdf.getDocument({data:bytes, useSystemFonts:true, useWasm:false, cMapUrl:"/pdfjs/cmaps/", cMapPacked:true, standardFontDataUrl:"/pdfjs/standard_fonts/"});
        dispose = () => { void task.destroy(); };
        const result = await task.promise;
        if (stopped) { dispose(); return; }
        setDocument(result);
      } else if (tools) {
        const key=extension!=="zip"?await officeCacheKey(bytes,name):"";
        if(stopped)return;
        const cached=key?officeHtmlCache.get(key):undefined;
        // HTTP LAN pages lack WebCrypto: compare every byte instead of trusting
        // file size/name, so same-size edits also invalidate the cached view.
        if(cached && (!cached.bytes || cached.bytes.every((value,index)=>value===bytes[index]))){officeHtmlCache.delete(key);officeHtmlCache.set(key,cached);setHtml(cached.html);setReady(true);return;}
        const list = tools.inspectArchive(bytes, extension === "zip");
        if (stopped) return;
        if (extension === "zip") {setEntries(list);setArchiveBytes(bytes);}
        else if (extension === "xlsx") {const html=tools.renderSpreadsheet(bytes);rememberOfficeHtml(key,html,bytes);setHtml(html);}
        else if (extension === "pptx") {const html=tools.renderPresentation(bytes);rememberOfficeHtml(key,html,bytes);setHtml(html);}
        else if (docx) {
          const body = window.document.createElement("div");
          const style = window.document.createElement("div");
          await docx.renderAsync(bytes, body, style, {inWrapper:true, useBase64URL:true, renderAltChunks:false, renderComments:false, renderEndnotes:true, renderFootnotes:true});
          if (stopped) return;
          // Render only the library-generated view in a script-free, opaque-origin frame.
          body.querySelectorAll("script,iframe,object,embed").forEach(el => el.remove());
          body.querySelectorAll("a").forEach(el => el.removeAttribute("href"));
          const html=tools.documentFrame(`${style.innerHTML}${body.innerHTML}`);
          rememberOfficeHtml(key,html,bytes);setHtml(html);
        }
      } else if (/^(txt|md|json|csv|log|py|js|ts|css|html|xml|yaml|yml|sh)$/.test(extension ?? "")) setPlainText(new TextDecoder().decode(bytes));
      else if (!/^(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mp3|wav|ogg|m4a)$/.test(extension ?? "")) throw new Error("暂不支持此格式的在线预览，请下载压缩包后在本机打开。");
      if (!stopped) setReady(true);
    })().catch(error => { if (!stopped) { setError(error instanceof Error ? error.message : String(error)); setReady(true); } });
    return () => { stopped = true; abort.abort(); dispose(); };
  }, [url, name]);
  if (!ready) return <div className="documentPreviewStatus" role="status">正在渲染文件…</div>;
  if (error) return <div className="documentPreviewStatus" role="alert">{error}</div>;
  if (document) return <PdfViewer document={document}/>;
  if (html) return <PreviewZoom frame><OfficeFrame html={html} name={name}/></PreviewZoom>;
  if (archiveBytes) return <ArchivePreview bytes={archiveBytes} entries={entries} depth={depth}/>;
  if(plainText!==null)return <PreviewZoom><pre className="fileTextPreview">{plainText}</pre></PreviewZoom>;
  if(/\.(mp4|webm)$/i.test(name))return <PreviewZoom><video className="fileVideoPreview" controls src={url}/></PreviewZoom>;
  if(/\.(mp3|wav|ogg|m4a)$/i.test(name))return <audio controls src={url}/>;
  return <PreviewZoom><img className="fileImagePreview" src={url} alt={name}/></PreviewZoom>;
}
