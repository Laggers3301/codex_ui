import { useEffect, useState } from "react";
import { Cpu, Globe, HardDrive, MemoryStick, RefreshCcw } from "lucide-react";
import { readMemoryProcesses } from "./api";
import { ToolReveal } from './ToolReveal';
import { ChevronDown as MemoryChevron } from './PanelIcons';
import type { MemoryProcesses } from '../shared/hostResources';
import { NetworkProbeButton, RESOURCE_REFRESH_MS, percentage, useResources, volumeTitle } from "./HostResources";

// The right-workspace panel body, loaded on demand; provider/summary/hooks stay in HostResources.tsx.
const bytes = (value: number) => {
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${(value / 1024 ** power).toFixed(power ? 1 : 0)} ${["B", "KiB", "MiB", "GiB"][power]}`;
};
function Meter({ label, value }: { label: string; value: number | null }) {
  return value == null ? null : <div className={`hostResourceMeter${value >= 90 ? " high" : ""}`} role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value}%` }} /></div>;
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
