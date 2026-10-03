import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Folder, HardDrive, Monitor, X } from "./PanelIcons";
import { attachRemoteFolder, browseRemoteComputer, remoteFolderCatalog, type RemoteDirectoryPage, type RemoteFolderCatalog } from "./api";

export function RemoteFolderPicker({ scopeId, isDraft, onAttached, onCancel, onConnect, onBusyChange }: {
  scopeId: string;
  isDraft: boolean;
  onAttached: () => void;
  onCancel?: () => void;
  onConnect: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<RemoteFolderCatalog>({ hosts: [], recent: [] });
  const [hostId, setHostId] = useState("");
  const [directory, setDirectory] = useState<RemoteDirectoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    const abort = new AbortController();
    remoteFolderCatalog(abort.signal).then(({ data }) => {
      if (abort.signal.aborted) return;
      setCatalog(data);
      setHostId(data.hosts[0]?.id ?? "");
    }).catch((caught) => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "无法读取已连接电脑。"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); controller.current?.abort(); busyCallback.current?.(false); };
  }, []);

  async function browse(remotePath: string | null) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError("");
    try {
      const { data } = await browseRemoteComputer(hostId, remotePath, abort.signal);
      if (!abort.signal.aborted) setDirectory(data);
    } catch (caught) { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "无法读取目录。"); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }

  async function choose(targetHostId: string, remotePath: string) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setConnecting(true);
    setError("");
    busyCallback.current?.(true);
    try {
      await attachRemoteFolder(scopeId, targetHostId, remotePath, abort.signal);
      if (!abort.signal.aborted) onAttached();
    } catch (caught) { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "连接目录失败。"); }
    finally { busyCallback.current?.(false); if (!abort.signal.aborted) setConnecting(false); }
  }

  const host = catalog.hosts.find((item) => item.id === hostId);
  return <section className="remoteFolderPicker" aria-label="选择远程目录" aria-busy={connecting || loading}>
    <div className="remotePickerTitle"><strong>{isDraft ? "为新对话选择目录" : "选择远程目录"}</strong>
      {onCancel ? <button type="button" aria-label="取消选择目录" disabled={connecting} onClick={onCancel}><X size={15} /></button> : null}</div>
    <p className="remotePickerHint">{isDraft ? "选好的目录会随新对话保存。" : "打开后保存在当前对话，下次会自动恢复。"}</p>
    {catalog.hosts.length ? <>
      <label className="remoteComputerLabel"><Monitor size={15} /><select aria-label="远程电脑" value={hostId} disabled={loading || connecting}
        onChange={(event) => { controller.current?.abort(); setHostId(event.target.value); setDirectory(null); setError(""); }}>
        {catalog.hosts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button type="button" className="remoteBrowseDrives" disabled={loading || connecting} onClick={() => void browse(null)}><HardDrive size={15} />{host?.windows ? "浏览电脑盘符" : "浏览电脑目录"}</button>
    </> : null}
    {error ? <p className="remoteFolderError" role="alert">{error}</p> : null}
    {loading || connecting ? <p className="remotePickerHint" role="status">{connecting ? "正在打开目录…" : "正在读取…"}</p> : null}
    {directory ? <div className="remoteDirectoryChooser">
      <div className="remotePickerBreadcrumb"><button type="button" aria-label="返回上一级" disabled={loading || connecting || directory.path === null} onClick={() => void browse(directory.parent)}><ArrowLeft size={15} /></button>
        <span title={directory.displayPath}>{directory.displayPath}</span></div>
      <label className="remoteFoldersHidden"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />显示隐藏文件夹</label>
      <div className="remotePickerDirectories">
        {directory.directories.filter((entry) => showHidden || !entry.name.startsWith(".")).map((entry) => <button type="button" key={entry.path} disabled={loading || connecting} onClick={() => void browse(entry.path)} title={entry.path}>
          {directory.path === null ? <HardDrive size={15} /> : <Folder size={15} />}<span>{entry.name}</span><ChevronRight size={14} /></button>)}
        {!loading && !directory.directories.length ? <p className="remotePickerHint">没有子文件夹，可以直接打开此目录。</p> : null}
      </div>
      {directory.truncated ? <p className="remotePickerHint">目录内容较多，当前显示前 2000 项中的文件夹。</p> : null}
      {directory.path ? <button type="button" className="remotePickerOpen" disabled={loading || connecting} onClick={() => void choose(hostId, directory.path!)}>打开此目录</button> : null}
    </div> : !loading && catalog.recent.length ? <div className="remoteRecentFolders"><small>最近使用的目录</small>
      {catalog.recent.filter((entry) => entry.hostId === hostId).map((entry) => <button type="button" key={entry.id} disabled={connecting} title={entry.path} onClick={() => void choose(entry.hostId, entry.path)}><Folder size={15} /><span>{entry.name}<small>{entry.path}</small></span></button>)}
    </div> : null}
    {!loading && !catalog.hosts.length ? <p className="remotePickerHint">先连接你的远程电脑，之后就能在这里选择盘符和文件夹。</p> : null}
    <button className="remoteConnectOther" type="button" disabled={connecting} onClick={onConnect}>连接其他电脑</button>
  </section>;
}
