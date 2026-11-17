import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Cpu, Globe, HardDrive, MemoryStick } from "lucide-react";
import { checkHostNetwork, readHostResources } from "./api";
import { ComposerGlassMaterial } from "./ComposerGlassMaterial";
import type { HostNetworkProbeResult, HostResources } from "../shared/hostResources";
import "./hostResources.css";

export const RESOURCE_REFRESH_MS = 10_000;
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
export function useResources() {
  const state = useContext(ResourceContext);
  if (!state) throw new Error("主机资源组件需要 HostResourceProvider。");
  return state;
}
export const percentage = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(1)}%`;
export const volumeTitle = (volume: HostResources["volumes"][number]) => [
  `挂载路径：${volume.mountPoints?.join("、") || "暂时无法读取"}`,
  ...(volume.paths ?? []).map(directory => `${directory.label}：${directory.path}`)
].join("\n");
export function NetworkProbeButton({ compact = false, onOpen }: { compact?: boolean; onOpen?: () => void }) {
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
export function HostResourceSummary({ onOpen }: { onOpen: () => void }) {
  const state = useResources();
  const data = state.data, disk = data?.volumes[0]?.usagePercent;
  return <div className="hostResourceDock"><div className={`hostResourceSummary${state.error ? " stale" : ""}`}>
    <button type="button" className="hostResourceTile" onClick={onOpen} aria-label="查看主机资源"><span><Cpu size={12} /><small>CPU</small></span><b>{percentage(data?.cpu.usagePercent)}</b><ComposerGlassMaterial variant="topbar" /></button>
    <button type="button" className="hostResourceTile" onClick={onOpen} aria-label="查看内存资源"><span><MemoryStick size={12} /><small>内存</small></span><b>{percentage(data?.memory.usagePercent)}</b><ComposerGlassMaterial variant="topbar" /></button>
    <button type="button" className="hostResourceTile hostResourceDisk" onClick={onOpen} aria-label="查看磁盘资源" title={data?.volumes.map(volumeTitle).join("\n\n") || "正在读取挂载信息"}><span><HardDrive size={12} /><small>磁盘</small></span><b>{percentage(disk)}</b><ComposerGlassMaterial variant="topbar" /></button>
  </div><NetworkProbeButton compact onOpen={onOpen} /></div>;
}
