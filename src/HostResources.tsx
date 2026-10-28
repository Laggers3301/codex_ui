import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Cpu, Globe, HardDrive, MemoryStick, RefreshCcw } from "lucide-react";
import { pingHostNetwork, readHostResources } from "./api";
import type { HostNetworkProbeResult, HostResources } from "../shared/hostResources";
import "./hostResources.css";

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
        if (active && controller === request && !request.signal.aborted) { setData(result.data); setError(false); }
      } catch {
        if (active && controller === request && !request.signal.aborted) setError(true);
      } finally {
        if (active && controller === request) {
          controller = null; setFetching(false);
          if (!document.hidden) timer = window.setTimeout(() => void refresh(), 2000);
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
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current?.abort(); controller.current = null; setResult(null); setError(""); setChecking(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [userId]);
  const check = async () => {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request;
    setChecking(true); setError(""); setResult(null);
    try {
      const response = await pingHostNetwork(request.signal);
      if (controller.current === request && !request.signal.aborted) setResult(response.data);
    } catch (caught) {
      if (controller.current === request && !request.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (controller.current === request) { controller.current = null; setChecking(false); }
    }
  };
  return { result, error, checking, check };
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
  return <button type="button" className={`hostNetworkButton${compact ? " compact" : ""}`} aria-label="ping google.com" disabled={network.checking}
    data-status={network.result?.status} title={network.checking ? "正在从服务主机检测 google.com…" : network.result ? `${network.result.message}${network.result.averageLatencyMs != null ? ` 平均 ${network.result.averageLatencyMs.toFixed(1)} ms。` : ""} 点击重新检测。` : "从当前服务主机 ping google.com，发送 3 次探测。"}
    onClick={() => { onOpen?.(); void network.check(); }}>
    <Globe size={14} />{compact ? <span>{network.checking ? "检测中" : "ping"}<small>google.com</small></span> : <span>{network.checking ? "检测中…" : "ping google.com"}</span>}
  </button>;
}
function NetworkProbeResult() {
  const { network } = useResources(), result = network.result;
  if (!network.checking && !result && !network.error) return null;
  return <article className="hostNetworkResult" aria-label="主机网络检测">
    <h3><Globe size={16} />网络连通性</h3><p>服务主机 → google.com</p>
    {network.checking ? <p role="status">正在发送 3 次 ICMP 探测，最长约 10 秒…</p> : null}
    {network.error ? <p role="alert">{network.error}</p> : null}
    {result ? <>
      <p role="status">{result.message}</p>
      {result.averageLatencyMs != null ? <p>平均延迟 {result.averageLatencyMs.toFixed(1)} ms{result.packetLossPercent != null ? ` · 丢包 ${result.packetLossPercent}%` : ""}</p> : null}
      {result.packetsTransmitted != null ? <p>发送 {result.packetsTransmitted} · 收到 {result.packetsReceived ?? 0}{result.averageLatencyMs == null && result.packetLossPercent != null ? ` · 丢包 ${result.packetLossPercent}%` : ""}</p> : null}
      <p>{result.address ? `${result.address} · ` : ""}{new Date(result.startedAt).toLocaleTimeString()} · 用时 {(result.durationMs / 1000).toFixed(1)} 秒</p>
      {result.status !== "reachable" ? <p>这是 ICMP 探测结果；未收到应答时，还需结合代理、防火墙和其他连接测试判断。</p> : null}
      {result.output ? <details open={result.status !== "reachable"}><summary>诊断输出</summary><pre>{result.output}</pre></details> : null}
    </> : null}
  </article>;
}
export function HostResourceSummary({ onOpen }: { onOpen: () => void }) {
  const state = useResources();
  const data = state.data, disk = data?.volumes[0]?.usagePercent;
  return <div className="hostResourceDock"><button type="button" className={`hostResourceSummary${state.error ? " stale" : ""}`} onClick={onOpen} aria-label="查看主机资源" title={state.error ? "资源状态更新失败，点击查看" : "服务主机的 CPU、内存、磁盘状态"}>
    <span><Cpu size={12} /><small>CPU</small><b>{percentage(data?.cpu.usagePercent)}</b></span>
    <span><MemoryStick size={12} /><small>内存</small><b>{percentage(data?.memory.usagePercent)}</b></span>
    <span className="hostResourceDisk" title={data?.volumes.map(volumeTitle).join("\n\n") || "正在读取挂载信息"}><HardDrive size={12} /><small>磁盘</small><b>{percentage(disk)}</b></span>
  </button><NetworkProbeButton compact onOpen={onOpen} /></div>;
}
export function HostResourcePanel() {
  const state = useResources();
  const { data, error, fetching, refresh } = state;
  return <section className="hostResourcesPanel" aria-label="主机资源">
    <header><div><h2>主机资源</h2><p>{data ? `${data.hostname} · ${data.platform}` : "正在读取服务主机状态"}</p></div><div className="hostResourceActions"><NetworkProbeButton /><button type="button" onClick={refresh} disabled={fetching} aria-label="刷新主机资源"><RefreshCcw size={16} /></button></div></header>
    <p className="hostResourceUpdate" role="status">{error ? "更新失败，保留上次数据；可点击刷新重试。" : data ? `每 2 秒更新 · 最近采样 ${new Date(data.sampledAt).toLocaleTimeString()}` : "正在采样…"}</p>
    <NetworkProbeResult />
    {data ? <>
      <article><h3><Cpu size={16} />CPU <strong>{percentage(data.cpu.usagePercent)}</strong></h3><Meter label="CPU 使用率" value={data.cpu.usagePercent} /><p>{data.cpu.cores} 个逻辑核心 · {data.cpu.model}</p>
        {data.cpu.usagePercent == null ? <p>等待下一次采样计算使用率。</p> : null}
        {data.cpu.loadAverage ? <p>平均负载（1 / 5 / 15 分钟）：{data.cpu.loadAverage.map(value => value.toFixed(2)).join(" / ")}</p> : null}
      </article>
      <article><h3><MemoryStick size={16} />内存 <strong>{percentage(data.memory.usagePercent)}</strong></h3><Meter label="内存使用率" value={data.memory.usagePercent} /><p>已用 {bytes(data.memory.usedBytes)} / {bytes(data.memory.totalBytes)}</p><p>可用 {bytes(data.memory.availableBytes)}</p>
        {data.memory.swapTotalBytes != null && data.memory.swapUsedBytes != null ? <p>Swap：{bytes(data.memory.swapUsedBytes)} / {bytes(data.memory.swapTotalBytes)}</p> : null}
      </article>
      <article><h3><HardDrive size={16} />磁盘空间</h3>{data.volumes.map(volume => <div className="hostResourceVolume" key={volume.labels.join("/")}><h4><span className="hostResourceDisk" title={volumeTitle(volume)}>{volume.labels.join(" / ")}</span><strong>{percentage(volume.usagePercent)}</strong></h4><Meter label={`${volume.labels.join("、")}磁盘占用率`} value={volume.usagePercent} /><p>已用 {bytes(volume.usedBytes)} / {bytes(volume.totalBytes)} · 可用 {bytes(volume.availableBytes)}</p></div>)}</article>
      <article><h3><HardDrive size={16} />磁盘 I/O</h3>{data.disks.map(disk => <div className="hostResourceVolume" key={disk.name}><h4><span className="hostResourceDisk" title={`挂载路径（含分区）：${disk.mountPoints?.join("、") || "暂时无法关联"}`}>{disk.name}</span><strong>{percentage(disk.busyPercent)}</strong></h4><Meter label={`${disk.name} I/O 繁忙时间占比`} value={disk.busyPercent} /><p>{disk.readBytesPerSecond == null ? "等待下一次采样计算读写速率。" : `读取 ${bytes(disk.readBytesPerSecond)}/s · 写入 ${bytes(disk.writeBytesPerSecond ?? 0)}/s`}</p></div>)}<p>I/O 百分比表示采样区间的繁忙时间；空间占用显示在上方。</p></article>
      {data.warnings.map(warning => <p className="hostResourceWarning" role="status" key={warning}>{warning}</p>)}
    </> : error ? <p>暂时无法读取主机资源。</p> : null}
  </section>;
}
