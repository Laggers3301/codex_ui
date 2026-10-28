import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Cpu, HardDrive, MemoryStick, RefreshCcw } from "lucide-react";
import { readHostResources } from "./api";
import type { HostResources } from "../shared/hostResources";
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
export type HostResourceState = ReturnType<typeof useHostResources>;
const ResourceContext = createContext<HostResourceState | null>(null);
export function HostResourceProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const state = useHostResources(userId);
  return <ResourceContext.Provider value={state}>{children}</ResourceContext.Provider>;
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
export function HostResourceSummary({ onOpen }: { onOpen: () => void }) {
  const state = useResources();
  const data = state.data, disk = data?.volumes[0]?.usagePercent;
  return <button type="button" className={`hostResourceSummary${state.error ? " stale" : ""}`} onClick={onOpen} aria-label="查看主机资源" title={state.error ? "资源状态更新失败，点击查看" : "服务主机的 CPU、内存、磁盘状态"}>
    <span><Cpu size={12} /><small>CPU</small><b>{percentage(data?.cpu.usagePercent)}</b></span>
    <span><MemoryStick size={12} /><small>内存</small><b>{percentage(data?.memory.usagePercent)}</b></span>
    <span><HardDrive size={12} /><small>磁盘</small><b>{percentage(disk)}</b></span>
  </button>;
}
export function HostResourcePanel() {
  const state = useResources();
  const { data, error, fetching, refresh } = state;
  return <section className="hostResourcesPanel" aria-label="主机资源">
    <header><div><h2>主机资源</h2><p>{data ? `${data.hostname} · ${data.platform}` : "正在读取服务主机状态"}</p></div><button type="button" onClick={refresh} disabled={fetching} aria-label="刷新主机资源"><RefreshCcw size={16} /></button></header>
    <p className="hostResourceUpdate" role="status">{error ? "更新失败，保留上次数据；可点击刷新重试。" : data ? `每 2 秒更新 · 最近采样 ${new Date(data.sampledAt).toLocaleTimeString()}` : "正在采样…"}</p>
    {data ? <>
      <article><h3><Cpu size={16} />CPU <strong>{percentage(data.cpu.usagePercent)}</strong></h3><Meter label="CPU 使用率" value={data.cpu.usagePercent} /><p>{data.cpu.cores} 个逻辑核心 · {data.cpu.model}</p>
        {data.cpu.usagePercent == null ? <p>等待下一次采样计算使用率。</p> : null}
        {data.cpu.loadAverage ? <p>平均负载（1 / 5 / 15 分钟）：{data.cpu.loadAverage.map(value => value.toFixed(2)).join(" / ")}</p> : null}
      </article>
      <article><h3><MemoryStick size={16} />内存 <strong>{percentage(data.memory.usagePercent)}</strong></h3><Meter label="内存使用率" value={data.memory.usagePercent} /><p>已用 {bytes(data.memory.usedBytes)} / {bytes(data.memory.totalBytes)}</p><p>可用 {bytes(data.memory.availableBytes)}</p>
        {data.memory.swapTotalBytes != null && data.memory.swapUsedBytes != null ? <p>Swap：{bytes(data.memory.swapUsedBytes)} / {bytes(data.memory.swapTotalBytes)}</p> : null}
      </article>
      <article><h3><HardDrive size={16} />磁盘空间</h3>{data.volumes.map(volume => <div className="hostResourceVolume" key={volume.labels.join("/")}><h4>{volume.labels.join(" / ")}<strong>{percentage(volume.usagePercent)}</strong></h4><Meter label={`${volume.labels.join("、")}磁盘占用率`} value={volume.usagePercent} /><p>已用 {bytes(volume.usedBytes)} / {bytes(volume.totalBytes)} · 可用 {bytes(volume.availableBytes)}</p></div>)}</article>
      <article><h3><HardDrive size={16} />磁盘 I/O</h3>{data.disks.map(disk => <div className="hostResourceVolume" key={disk.name}><h4>{disk.name}<strong>{percentage(disk.busyPercent)}</strong></h4><Meter label={`${disk.name} I/O 繁忙时间占比`} value={disk.busyPercent} /><p>{disk.readBytesPerSecond == null ? "等待下一次采样计算读写速率。" : `读取 ${bytes(disk.readBytesPerSecond)}/s · 写入 ${bytes(disk.writeBytesPerSecond ?? 0)}/s`}</p></div>)}<p>I/O 百分比表示采样区间的繁忙时间；空间占用显示在上方。</p></article>
      {data.warnings.map(warning => <p className="hostResourceWarning" role="status" key={warning}>{warning}</p>)}
    </> : error ? <p>暂时无法读取主机资源。</p> : null}
  </section>;
}
