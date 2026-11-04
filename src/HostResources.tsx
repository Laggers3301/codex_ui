import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Cpu, Globe, HardDrive, MemoryStick, RefreshCcw } from "lucide-react";
import { checkHostNetwork, readHostResources, readMemoryProcesses } from "./api";
import { ToolReveal } from './ToolReveal';
import { ChevronDown as MemoryChevron } from './PanelIcons';
import type { MemoryProcesses } from '../shared/hostResources';
import { ComposerGlassMaterial } from "./ComposerGlassMaterial";
import type { HostNetworkProbeResult, HostResources } from "../shared/hostResources";
import "./hostResources.css";

const RESOURCE_REFRESH_MS = 10_000;
const NETWORK_SUMMARY_MS = 8_000;

export function useHostResources(userId: string) {
  const [data, setData] = useState<HostResources | null>(null);
  const [error, setError] = useState(false);
  const [fetching, setFetching] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true, timer = 0, controller: AbortController | null = null;
    setData(null); setError(false);
    const refresh = async () => {
      if (!active || document.hidden || controller) return;
      window.clearTimeout(timer);
      const request = new AbortController(); controller = request; setFetching(true);
      try {
        const result = await readHostResources(request.signal);
        if (!result.data || !Array.isArray(result.data.volumes) || !Array.isArray(result.data.disks) || !result.data.cpu || !result.data.memory) {
          throw new Error("Malformed host resource response");
        }
        if (active && controller === request && !request.signal.aborted) { setData(result.data); setError(false); }
      } catch {
        if (active && controller === request && !request.signal.aborted) setError(true);
      } finally {
        if (active && controller === request) {
          controller = null; setFetching(false);
          if (!document.hidden) timer = window.setTimeout(() => void refresh(), RESOURCE_REFRESH_MS);
        }
      }
    };
    const visibility = () => {
      window.clearTimeout(timer);
      if (document.hidden) { controller?.abort(); controller = null; setFetching(false); }
      else void refresh();
    };
    refreshRef.current = () => void refresh();
    document.addEventListener("visibilitychange", visibility); void refresh();
    return () => { active = false; window.clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [userId]);
  return { data, error, fetching, refresh: () => refreshRef.current() };
}
function useNetworkProbe(userId: string) {
  const [result, setResult] = useState<HostNetworkProbeResult | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setShowSummary(Boolean(result || error));
    if (!result && !error) return;
    const timer = window.setTimeout(() => setShowSummary(false), NETWORK_SUMMARY_MS);
    return () => window.clearTimeout(timer);
  }, [result, error]);
  useEffect(() => {
    controller.current?.abort(); controller.current = null; setResult(null); setError(""); setChecking(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [userId]);
  const check = async () => {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request;
    setChecking(true); setError(""); setResult(null);
    try {
      const response = await checkHostNetwork(request.signal);
      if (controller.current === request && !request.signal.aborted) setResult(response.data);
    } catch (caught) {
      if (controller.current === request && !request.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (controller.current === request) { controller.current = null; setChecking(false); }
    }
  };
  return { result, error, checking, showSummary, check };
}
export type HostResourceState = ReturnType<typeof useHostResources> & { network: ReturnType<typeof useNetworkProbe> };
const ResourceContext = createContext<HostResourceState | null>(null);
export function HostResourceProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const state = useHostResources(userId);
  const network = useNetworkProbe(userId);
  return <ResourceContext.Provider value={{ ...state, network }}>{children}</ResourceContext.Provider>;
}
function useResources() {
  const state = useContext(ResourceContext);
  if (!state) throw new Error("主机资源组件需要 HostResourceProvider。");
  return state;
}
const percentage = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(1)}%`;
const bytes = (value: number) => {
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${(value / 1024 ** power).toFixed(power ? 1 : 0)} ${["B", "KiB", "MiB", "GiB"][power]}`;
};
function Meter({ label, value }: { label: string; value: number | null }) {
  return value == null ? null : <div className={`hostResourceMeter${value >= 90 ? " high" : ""}`} role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value}%` }} /></div>;
}
const volumeTitle = (volume: HostResources["volumes"][number]) => [
  `挂载路径：${volume.mountPoints?.join("、") || "暂时无法读取"}`,
  ...(volume.paths ?? []).map(directory => `${directory.label}：${directory.path}`)
].join("\n");
function NetworkProbeButton({ compact = false, onOpen }: { compact?: boolean; onOpen?: () => void }) {
  const { network } = useResources();
  const result = network.result;
  const summary = network.error ? "检测失败" : result?.status === "reachable" ? `${result.durationMs} ms`
    : result ? ({ reachable: "已连通", timeout: "超时", dns_error: "DNS失败", proxy_unconfigured: "未配置", proxy_error: "代理失败", tls_error: "TLS失败", http_error: `HTTP ${result.httpStatus ?? "异常"}`, error: "检测失败" })[result.status] : "HTTPS";
  return <button type="button" className={`hostNetworkButton${compact ? " compact" : ""}`} aria-label="检测 Google HTTPS" disabled={network.checking}
    data-status={result?.status} title={network.checking ? "正在通过服务代理检测 Google HTTPS…" : network.error ? `${network.error} 点击重新检测。` : result ? `${result.message}${result.status === "reachable" ? ` 请求总耗时 ${result.durationMs} ms。` : ""} 点击重新检测。` : "通过服务配置的代理检测 www.google.com 的 HTTPS 连通性。"}
    onClick={() => { onOpen?.(); void network.check(); }}>
    <Globe size={14} />{compact ? <span aria-live="polite" aria-atomic="true">{network.checking ? "检测中" : network.showSummary ? summary : "HTTPS"}<small>Google</small></span> : <span>{network.checking ? "检测中…" : "检测 Google HTTPS"}</span>}
    {compact ? <ComposerGlassMaterial variant="topbar" /> : null}
  </button>;
}
function NetworkProbeResult() {
  const { network } = useResources(), result = network.result;
  if (!network.checking && !result && !network.error) return null;
  return <article className="hostNetworkResult" aria-label="主机网络检测">
    <h3><Globe size={16} />网络连通性</h3><p>服务主机 → 配置的代理 → www.google.com（HTTPS）</p>
    {network.checking ? <p role="status">正在通过服务代理发送 HTTPS 请求，最长约 10 秒…</p> : null}
    {network.error ? <p role="alert">{network.error}</p> : null}
    {result ? <>
      <p role="status">{result.message}</p>
      {result.httpStatus != null ? <p>目标响应 HTTP {result.httpStatus}</p> : null}
      <p>{new Date(result.startedAt).toLocaleTimeString()} · 请求总耗时 {result.durationMs} ms</p>
      {result.output ? <details open={result.status !== "reachable"}><summary>诊断输出</summary><pre>{result.output}</pre></details> : null}
    </> : null}
  </article>;
}
export function HostResourceSummary({ onOpen }: { onOpen: () => void }) {
  const state = useResources();
  const data = state.data, disk = data?.volumes[0]?.usagePercent;
  return <div className="hostResourceDock"><div className={`hostResourceSummary${state.error ? " stale" : ""}`}>
    <button type="button" className="hostResourceTile" onClick={onOpen} aria-label="查看主机资源"><span><Cpu size={12} /><small>CPU</small></span><b>{percentage(data?.cpu.usagePercent)}</b><ComposerGlassMaterial variant="topbar" /></button>
    <button type="button" className="hostResourceTile" onClick={onOpen} aria-label="查看内存资源"><span><MemoryStick size={12} /><small>内存</small></span><b>{percentage(data?.memory.usagePercent)}</b><ComposerGlassMaterial variant="topbar" /></button>
    <button type="button" className="hostResourceTile hostResourceDisk" onClick={onOpen} aria-label="查看磁盘资源" title={data?.volumes.map(volumeTitle).join("\n\n") || "正在读取挂载信息"}><span><HardDrive size={12} /><small>磁盘</small></span><b>{percentage(disk)}</b><ComposerGlassMaterial variant="topbar" /></button>
  </div><NetworkProbeButton compact onOpen={onOpen} /></div>;
}
function MemoryTopFive({open}:{open:boolean}) {
  const [data,setData]=useState<MemoryProcesses|null>(null), [error,setError]=useState(false), [loading,setLoading]=useState(false);
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController(); setLoading(true);setError(false);
    readMemoryProcesses(controller.signal).then(result=>{if(!controller.signal.aborted)setData(result.data);}).catch(()=>{if(!controller.signal.aborted)setError(true);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[open,refresh]);
  return <ToolReveal open={open}><div className="memoryTopFiveBody">
      <div className="memoryTopFiveToolbar"><span>{loading?'正在读取…':data?new Date(data.sampledAt).toLocaleTimeString():''}</span><button type="button" disabled={loading} onClick={()=>setRefresh(v=>v+1)} aria-label="刷新内存排行"><RefreshCcw size={14}/></button></div>
      {error?<p role="status">读取失败，请重试。</p>:null}
      {data?.processes.map(p=><section className="memoryProcess" key={p.pid}>
        <h4><span>{p.name}</span><strong>{bytes(p.rssBytes)}</strong></h4>
        <p>PID {p.pid} · 系统用户 {p.osUser}{p.ownerHint?` · 目录所属 ${p.ownerHint}`:''}</p>
        <dl><dt>目录</dt><dd>{p.cwd??'无法读取'}</dd><dt>程序</dt><dd>{p.executable??'无法读取'}</dd><dt>资源组</dt><dd>{p.resourceGroup??'无法读取'}</dd></dl>
      </section>)}
    </div></ToolReveal>;
}

export function HostResourcePanel() {
  const [memoryExpanded,setMemoryExpanded]=useState(false);
  const state = useResources();
  const { data, error, fetching, refresh } = state;
  return <section className="hostResourcesPanel" aria-label="主机资源">
    <header><div><h2>主机资源</h2><p>{data ? `${data.hostname} · ${data.platform}` : "正在读取服务主机状态"}</p></div><div className="hostResourceActions"><NetworkProbeButton /><button type="button" onClick={refresh} disabled={fetching} aria-label="刷新主机资源"><RefreshCcw size={16} /></button></div></header>
    <p className="hostResourceUpdate" role="status">{error ? "更新失败，保留上次数据；可点击刷新重试。" : data ? `每 ${RESOURCE_REFRESH_MS / 1000} 秒更新 · 最近采样 ${new Date(data.sampledAt).toLocaleTimeString()}` : "正在采样…"}</p>
    <NetworkProbeResult />
    {data ? <>
      <article><h3><Cpu size={16} />CPU <strong>{percentage(data.cpu.usagePercent)}</strong></h3><Meter label="CPU 使用率" value={data.cpu.usagePercent} /><p>{data.cpu.cores} 个逻辑核心 · {data.cpu.model}</p>
        {data.cpu.usagePercent == null ? <p>等待下一次采样计算使用率。</p> : null}
        {data.cpu.loadAverage ? <p>平均负载（1 / 5 / 15 分钟）：{data.cpu.loadAverage.map(value => value.toFixed(2)).join(" / ")}</p> : null}
      </article>
      <article><h3><MemoryStick size={16} />内存<strong>{percentage(data.memory.usagePercent)}</strong></h3><Meter label="内存使用率" value={data.memory.usagePercent} /><p>已用 {bytes(data.memory.usedBytes)} / {bytes(data.memory.totalBytes)}</p><p>可用 {bytes(data.memory.availableBytes)}</p>
        {data.memory.swapTotalBytes != null && data.memory.swapUsedBytes != null ? <p>Swap：{bytes(data.memory.swapUsedBytes)} / {bytes(data.memory.swapTotalBytes)}</p> : null}
        <button type="button" className="memoryTopFiveToggle" aria-label="内存占用 Top 5" aria-expanded={memoryExpanded} onClick={()=>setMemoryExpanded(v=>!v)}>内存占用 Top 5<MemoryChevron size={14} /></button>
        <MemoryTopFive open={memoryExpanded} />
      </article>
      <article><h3><HardDrive size={16} />磁盘空间</h3>{data.volumes.map(volume => <div className="hostResourceVolume" key={volume.labels.join("/")}><h4><span className="hostResourceDisk" title={volumeTitle(volume)}>{volume.labels.join(" / ")}</span><strong>{percentage(volume.usagePercent)}</strong></h4><Meter label={`${volume.labels.join("、")}磁盘占用率`} value={volume.usagePercent} /><p>已用 {bytes(volume.usedBytes)} / {bytes(volume.totalBytes)} · 可用 {bytes(volume.availableBytes)}</p></div>)}</article>
      <article><h3><HardDrive size={16} />磁盘 I/O</h3>{data.disks.map(disk => <div className="hostResourceVolume" key={disk.name}><h4><span className="hostResourceDisk" title={`挂载路径（含分区）：${disk.mountPoints?.join("、") || "暂时无法关联"}`}>{disk.name}</span><strong>{percentage(disk.busyPercent)}</strong></h4><Meter label={`${disk.name} I/O 繁忙时间占比`} value={disk.busyPercent} /><p>{disk.readBytesPerSecond == null ? "等待下一次采样计算读写速率。" : `读取 ${bytes(disk.readBytesPerSecond)}/s · 写入 ${bytes(disk.writeBytesPerSecond ?? 0)}/s`}</p></div>)}<p>I/O 百分比表示采样区间的繁忙时间；空间占用显示在上方。</p></article>
      {data.warnings.map(warning => <p className="hostResourceWarning" role="status" key={warning}>{warning}</p>)}
    </> : error ? <p>暂时无法读取主机资源。</p> : null}
  </section>;
}
