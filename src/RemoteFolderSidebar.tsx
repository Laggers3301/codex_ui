import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Link, Plus, RefreshCcw, X } from "./PanelIcons";
import { closeRemoteFolder, reconnectRemoteFolder, listRemoteFolders, listRemoteFolderEntries, type RemoteFolder, type RemoteFolderEntry } from "./api";
import { RemoteFolderPicker } from "./RemoteFolderPicker";
import "./remoteFolders.css";

interface TreeProps {
  folder: RemoteFolder;
  threadId: string | null;
  relativePath: string;
  label: string;
  depth: number;
  showHidden: boolean;
  revision: number;
  visible: boolean;
  onReference: (path: string) => void;
  onRemove?: () => void;
  removing?: boolean;
  reconnecting: boolean;
  onReconnect: (folder: RemoteFolder) => void;
}

function DirectoryTree({ folder, threadId, relativePath, label, depth, showHidden, revision, visible, onReference, onRemove, removing, reconnecting, onReconnect }: TreeProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [entries, setEntries] = useState<RemoteFolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    if (!expanded || !visible || reconnecting) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    listRemoteFolderEntries(folder.id, relativePath, threadId, controller.signal).then(({ data }) => {
      if (controller.signal.aborted) return;
      setEntries(data.entries);
      setTruncated(data.truncated);
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "无法读取此目录。");
      setEntries([]);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [expanded, visible, reconnecting, folder.id, folder.mountPath, threadId, relativePath, revision]);
  const visibleEntries = entries.filter((entry) => showHidden || !entry.name.startsWith("."));
  return <div className={depth === 0 ? "remoteFolderRoot" : "remoteFolderBranch"}>
    <div className="remoteFolderRow" style={{ paddingLeft: 10 + depth * 14 }}>
      <button type="button" className="remoteFolderName" aria-expanded={expanded}
        title={relativePath || `${folder.host} ${folder.remotePath}`} onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{label}</span>
      </button>
      <button type="button" className="remoteFolderReference" title={`引用目录 ${label}`} aria-label={`引用目录 ${label}`}
        onClick={() => onReference(`${folder.mountPath}${relativePath ? `/${relativePath}` : ""}`)}><Link size={13} /></button>
      {depth === 0 && onRemove ? <button type="button" className="remoteFolderReference" disabled={removing} onClick={onRemove}
        title={`关闭目录 ${label}`} aria-label={`关闭目录 ${label}`}><X size={14} /></button> : null}
    </div>
    {depth === 0 ? <div className="remoteFolderOrigin" title={`${folder.host} ${folder.remotePath}`}>
      <span>{folder.host || "已连接目录"}</span><small>{folder.readOnly ? "只读" : "可写"}</small>
    </div> : null}
    {expanded ? <div>
      {loading ? <p className="remoteFolderNote" role="status">正在读取…</p> : null}
      {error ? <div className="remoteFolderError" role="alert"><span>{error}</span>
        <button type="button" disabled={reconnecting} onClick={() => onReconnect(folder)}>{reconnecting ? "正在重连…" : "重试"}</button></div> : null}
      {!loading && !error && visibleEntries.length === 0 ? <p className="remoteFolderNote">{entries.length ? "仅有隐藏文件" : "空目录"}</p> : null}
      {!loading && !error ? visibleEntries.map((entry) => entry.kind === "directory"
        ? <DirectoryTree key={entry.path} folder={folder} threadId={threadId} relativePath={entry.path} label={entry.name} depth={depth + 1}
            showHidden={showHidden} revision={revision} visible={visible} onReference={onReference} reconnecting={reconnecting} onReconnect={onReconnect} />
        : <div className="remoteFolderRow" key={entry.path} style={{ paddingLeft: 24 + (depth + 1) * 14 }}>
            <button type="button" className="remoteFolderName remoteFileName" disabled={entry.kind !== "file"}
              title={entry.kind === "file" ? `引用 ${entry.path}` : "链接和特殊文件不在此处展开"}
              aria-label={`引用文件 ${entry.name}`} onClick={() => onReference(`${folder.mountPath}/${entry.path}`)}>
              <FileText size={14} /><span>{entry.name}</span><Link size={12} className="remoteFileLink" />
            </button>
          </div>) : null}
      {!loading && !error && truncated ? <p className="remoteFolderNote">此目录仅显示前 1000 项，请进入子目录继续浏览。</p> : null}
    </div> : null}
  </div>;
}

export function fileReferenceText(filePath: string): string {
  const longest = Math.max(0, ...(filePath.match(/`+/g) ?? []).map((run) => run.length));
  const delimiter = "`".repeat(longest + 1);
  return `${delimiter} ${filePath} ${delimiter}`;
}

export function RemoteFolderSidebar({ threadId, visible, isDraft = false, onClose, onReference, onConnect, onFoldersChange, onBusyChange }: {
  userId?: string;
  threadId: string | null;
  visible: boolean;
  isDraft?: boolean;
  onClose: () => void;
  onReference: (path: string) => void;
  onConnect: () => void;
  onFoldersChange?: (folders: RemoteFolder[]) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [folders, setFolders] = useState<RemoteFolder[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [notice, setNotice] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectController = useRef<AbortController | null>(null);
  const callbacks = useRef({ onFoldersChange, onBusyChange });
  callbacks.current = { onFoldersChange, onBusyChange };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; reconnectController.current?.abort(); callbacks.current.onBusyChange?.(false); }; }, []);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    const refresh = () => {
      if (document.hidden || reconnectController.current) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      listRemoteFolders(threadId, controller.signal).then(({ data }) => {
        if (disposed || controller.signal.aborted) return;
        setFolders(data);
        callbacks.current.onFoldersChange?.(data);
        setError("");
      }).catch((caught) => {
        if (disposed || controller.signal.aborted) return;
        setFolders([]);
        callbacks.current.onFoldersChange?.([]);
        setError(caught instanceof Error ? caught.message : "读取失败");
      }).finally(() => { if (!disposed && !controller.signal.aborted) setLoading(false); });
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    window.addEventListener("codex:remote-folders-changed", refresh);
    return () => { disposed = true; controllerRef.current?.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("codex:remote-folders-changed", refresh); };
  }, [visible, threadId, revision]);
  async function refreshDirectories(folder?: RemoteFolder) {
    if (!threadId || reconnectController.current || removing || choosing) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    reconnectController.current = controller;
    setReconnecting(true);
    setLoading(true);
    setError("");
    setNotice("正在恢复当前对话的目录连接…");
    callbacks.current.onBusyChange?.(true);
    try {
      // Reload the saved selection first: never reconnect another conversation's
      // directories, or a directory closed in a different browser window.
      const { data } = await listRemoteFolders(threadId, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setFolders(data);
      callbacks.current.onFoldersChange?.(data);
      const selected = folder ? data.filter(entry => entry.id === folder.id) : data;
      const failures: string[] = [];
      for (const entry of selected) {
        if (controller.signal.aborted) return;
        try { await reconnectRemoteFolder(threadId, entry.id, controller.signal); }
        catch (caught) {
          if (controller.signal.aborted) return;
          failures.push(`${entry.name}：${caught instanceof Error ? caught.message : "连接失败"}`);
        }
      }
      if (!alive.current || controller.signal.aborted) return;
      setError(failures.join("；"));
      setNotice(failures.length ? "部分目录未连接，请检查电脑在线状态后重试" : selected.length ? "目录连接已恢复，正在刷新内容" : "当前对话没有已保存的目录");
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : "刷新目录失败。");
    } finally {
      if (reconnectController.current === controller) reconnectController.current = null;
      if (alive.current && !controller.signal.aborted) {
        setReconnecting(false);
        setLoading(false);
        setRevision(value => value + 1);
        callbacks.current.onBusyChange?.(false);
      }
    }
  }
  async function removeFolder(folder: RemoteFolder) {
    if (!threadId) return;
    controllerRef.current?.abort();
    setRemoving(folder.id);
    try {
      await closeRemoteFolder(threadId, folder.id);
      if (!alive.current) return;
      const remaining = folders.filter((entry) => entry.id !== folder.id);
      setFolders(remaining);
      callbacks.current.onFoldersChange?.(remaining);
      setRevision((value) => value + 1);
      setNotice(`已关闭 ${folder.name}`);
      setError("");
    } catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : "关闭目录失败。"); }
    finally { if (alive.current) setRemoving(null); }
  }
  function reference(filePath: string) {
    onReference(filePath);
    setNotice(`已引用 ${filePath.split("/").pop()}`);
    if (window.matchMedia("(max-width: 900px)").matches) onClose();
  }
  return <aside className={`remoteFoldersPanel${visible ? " visible" : ""}`} aria-label="远程文件" aria-hidden={!visible} inert={!visible}>
      <header className="remoteFoldersHeader"><strong><FolderOpen size={17} />远程文件</strong><div>
        <button type="button" disabled={reconnecting} onClick={() => setChoosing(true)} title="选择目录" aria-label="选择远程目录"><Plus size={16} /></button>
        <button type="button" disabled={reconnecting || choosing || removing !== null} aria-busy={reconnecting} onClick={() => void refreshDirectories()} title="刷新并恢复目录连接" aria-label="刷新远程目录"><RefreshCcw size={15} className={reconnecting ? "remoteFolderRefreshSpin" : undefined} /></button>
        <button type="button" onClick={onClose} title="关闭远程文件" aria-label="关闭远程文件"><X size={17} /></button>
      </div></header>
      <label className="remoteFoldersHidden"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />显示隐藏文件</label>
      <div className="remoteFoldersContent">
        {loading && !folders.length ? <p className="remoteFolderNote" role="status">正在读取已连接目录…</p> : null}
        {error ? <p className="remoteFolderError" role="alert">{error}</p> : null}
        {!loading && threadId && (choosing || !folders.length) ? <RemoteFolderPicker scopeId={threadId} isDraft={isDraft}
          onCancel={folders.length ? () => setChoosing(false) : undefined} onConnect={onConnect} onBusyChange={onBusyChange}
          onAttached={() => { setChoosing(false); setLoading(true); setNotice("目录已保存到当前对话"); setRevision((value) => value + 1); }} /> : null}
        {folders.map((folder) => <DirectoryTree key={folder.id} folder={folder} threadId={threadId} relativePath="" label={folder.name} depth={0}
          showHidden={showHidden} revision={revision} visible={visible} onReference={reference} onRemove={() => void removeFolder(folder)} removing={removing !== null || reconnecting}
          reconnecting={reconnecting} onReconnect={folder => void refreshDirectories(folder)} />)}
      </div>
      <footer className="remoteFoldersFooter" role="status">{notice || "目录按对话保存 · 点击文件即可引用"}</footer>
  </aside>;
}
