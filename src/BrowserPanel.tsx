import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Browser, Check, ChevronDown, LoaderCircle, MousePointer2, Pause, Play, Plus, RotateCw, X } from "./PanelIcons";
import { getApiUserId } from "./api";
import "./BrowserPanel.css";

type BrowserState = {
  id: string; threadId: string; url: string; title: string;
  tabs?: { id: string; url: string; title: string }[]; activeTabId?: string; revision?: number;
  status: "starting" | "ready" | "running" | "paused" | "error" | "closed";
  mode: "agent" | "human"; frameVersion: number; viewport: { width: number; height: number };
  cursor?: { x: number; y: number }; activity?: string; error?: string;
  pendingApproval?: { id: string; kind: "navigate" | "action"; message: string; url?: string };
};

const apiHeaders = () => ({ "x-codex-web-user-id": getApiUserId(), "Content-Type": "application/json" });

export function BrowserPanel({ projectId, threadId, visible, navigation, pauseOnHide = true, onClose }: { projectId: string; threadId: string | null; visible: boolean; navigation?: { id: string; url: string }; pauseOnHide?: boolean; onClose: () => void }) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [url, setUrl] = useState("");
  const [frame, setFrame] = useState("");
  const [loading, setLoading] = useState(false);
  const [interactionError, setInteractionError] = useState("");
  const [pollError, setPollError] = useState("");
  const [text, setText] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agentCue, setAgentCue] = useState(false);
  const [closingTabs, setClosingTabs] = useState<string[]>([]);
  const panelRef = useRef<HTMLElement>(null);
  const exitAnimation = useRef<Animation | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const addressVersion = useRef(0);
  const addressDirty = useRef(false);
  const stateRef = useRef<BrowserState | null>(null);
  const frameRef = useRef("");
  const appliedFrameKey = useRef("");
  const loadingFrameKey = useRef("");
  const frameLoadToken = useRef(0);
  const interactionVersion = useRef(0);
  const mutations = useRef(0);
  const tabList = useRef<HTMLDivElement>(null);
  const tabCloseTimers = useRef(new Set<number>());
  const wheelRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const wheelTimer = useRef<number | null>(null);
  const prefix = threadId ? `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/browser` : "";
  stateRef.current = state;
  frameRef.current = frame;
  const clearFrame = useCallback(() => {
    frameLoadToken.current++;
    appliedFrameKey.current = ""; loadingFrameKey.current = "";
    if (frameRef.current) URL.revokeObjectURL(frameRef.current);
    frameRef.current = ""; setFrame("");
  }, []);
  const commitState = useCallback((next: BrowserState | null) => {
    if (next && next.threadId !== threadId) return;
    const previous = stateRef.current;
    if (next && previous?.id === next.id && (next.revision ?? 0) < (previous.revision ?? 0)) return;
    if (next?.status === "closed") next = null;
    if (previous?.id !== next?.id || previous?.activeTabId !== next?.activeTabId) clearFrame();
    stateRef.current = next; setState(next);
  }, [threadId, clearFrame]);
  useEffect(() => { if (visible) { exitAnimation.current?.cancel(); exitAnimation.current = null; } }, [visible]);
  useEffect(() => () => { exitAnimation.current?.cancel(); }, []);
  const closePanel = () => {
    // Start on the compositor immediately, before the large conversation tree
    // finishes rendering its sidebar-width change.
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      exitAnimation.current?.cancel();
      exitAnimation.current = panelRef.current?.animate([
        { opacity: 1, transform: "translateX(0) scale(1)" },
        { opacity: 0, transform: "translateX(22px) scale(.985)" }
      ], { duration: 380, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }) ?? null;
    }
    onClose();
  };
  useEffect(() => {
    const update = (event: Event) => {
      const incoming = (event as CustomEvent<{ threadId: string; state: BrowserState }>).detail;
      if (!visible || incoming?.threadId !== threadId) return;
      interactionVersion.current += 1;
      commitState(incoming.state);
    };
    window.addEventListener("codex:browser-state", update);
    return () => window.removeEventListener("codex:browser-state", update);
  }, [visible, threadId, commitState]);
  useEffect(() => {
    if (state?.mode !== "agent" || !visible || state.status === "closed" || state.pendingApproval) { setAgentCue(false); return; }
    if (state.status === "running") { setAgentCue(true); return; }
    // A short fade after a real operation keeps quick clicks visible without
    // claiming the agent is still running. The status label uses actual state.
    const timer = window.setTimeout(() => setAgentCue(false), 420);
    return () => window.clearTimeout(timer);
  }, [state?.status, state?.mode, state?.pendingApproval, visible]);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    if (!prefix) throw new Error("请先选择一个对话，再打开浏览器。");
    const mutating = Boolean(init?.method && init.method !== "GET");
    if (mutating) { interactionVersion.current++; mutations.current++; }
    try {
      const response = await fetch(`${prefix}${path}`, { credentials: "same-origin", cache: "no-store", ...init, headers: { ...apiHeaders(), ...(init?.headers ?? {}) } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || `请求失败（${response.status}）`);
      return body;
    } finally {
      // Invalidate polls started DURING navigation as well as ones started
      // before it; otherwise a slow old-page response can restore its URL.
      if (mutating) { mutations.current--; interactionVersion.current++; }
    }
  }, [prefix]);

  useEffect(() => {
    commitState(null);
    addressDirty.current = false; addressVersion.current++;
    setUrl("");
    setInteractionError("");
    setPollError("");
    if (frameRef.current) URL.revokeObjectURL(frameRef.current);
    frameRef.current = "";
    appliedFrameKey.current = "";
    loadingFrameKey.current = "";
    frameLoadToken.current += 1;
    setFrame("");
  }, [projectId, threadId]);

  const sendAction = useCallback(async (action: string, details: Record<string, unknown> = {}) => {
    setInteractionError("");
    try {
      if (stateRef.current?.mode !== "human") {
        const takeover = await request("/control", { method: "POST", body: JSON.stringify({ mode: "human" }) });
        if (takeover.data) commitState(takeover.data as BrowserState);
      }
      const result = await request("/action", { method: "POST", body: JSON.stringify({ action, tabId: stateRef.current?.activeTabId, ...details }) });
      if (result.data?.state) commitState(result.data.state as BrowserState);
      return true;
    } catch (caught) { setInteractionError(caught instanceof Error ? caught.message : String(caught)); return false; }
  }, [request, commitState]);

  useEffect(() => {
    if (!visible || !threadId) return;
    let active = true;
    let timer = 0;
    let controller: AbortController | null = null;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      if (mutations.current) { timer = window.setTimeout(poll, 300); return; }
      if (document.hidden) { timer = window.setTimeout(poll, 2000); return; }
      polling = true;
      controller = new AbortController();
      const pollController = controller;
      const pollInteractionVersion = interactionVersion.current;
      const timeout = window.setTimeout(() => pollController.abort(), 6000);
      try {
        const result = await request("", { signal: pollController.signal });
        if (!active || mutations.current || pollInteractionVersion !== interactionVersion.current) return;
        const next = result.data as BrowserState | null;
        const currentState = next?.status === "closed" ? null : next;
        if (currentState && stateRef.current?.id === currentState.id && (currentState.revision ?? 0) < (stateRef.current.revision ?? 0)) return;
        commitState(currentState);
        if (!currentState) {
          if (frameRef.current) URL.revokeObjectURL(frameRef.current);
          frameRef.current = "";
          appliedFrameKey.current = "";
          loadingFrameKey.current = "";
          frameLoadToken.current += 1;
          setFrame("");
        }
        const frameKey = currentState ? `${currentState.threadId}:${currentState.id}:${currentState.activeTabId}:${currentState.frameVersion}` : "";
        let frameIssue = "";
        if (currentState && currentState.frameVersion > 0 && frameKey !== appliedFrameKey.current && frameKey !== loadingFrameKey.current) {
          loadingFrameKey.current = frameKey;
          const token = ++frameLoadToken.current;
          try {
            const imageResponse = await fetch(`${prefix}/frame?v=${encodeURIComponent(String(currentState.frameVersion))}${currentState.activeTabId ? `&tabId=${encodeURIComponent(currentState.activeTabId)}` : ""}`, { credentials: "same-origin", cache: "no-store", signal: pollController.signal, headers: { "x-codex-web-user-id": getApiUserId() } });
            if (!imageResponse.ok) throw new Error(`截图暂不可用（${imageResponse.status}）`);
            const blobUrl = URL.createObjectURL(await imageResponse.blob());
            const probe = new Image();
            const imageTimeout = window.setTimeout(() => {
              URL.revokeObjectURL(blobUrl);
              if (frameLoadToken.current === token) frameLoadToken.current += 1;
              if (loadingFrameKey.current === frameKey) loadingFrameKey.current = "";
            }, 6000);
            probe.onload = () => {
              window.clearTimeout(imageTimeout);
              const current = stateRef.current;
              const stillCurrent = active && token === frameLoadToken.current && current?.threadId === currentState.threadId && current.id === currentState.id && current.activeTabId === currentState.activeTabId && current.frameVersion === currentState.frameVersion;
              if (stillCurrent) {
                appliedFrameKey.current = frameKey;
                setFrame(previous => { if (previous && previous !== blobUrl) URL.revokeObjectURL(previous); return blobUrl; });
              } else URL.revokeObjectURL(blobUrl);
              if (loadingFrameKey.current === frameKey) loadingFrameKey.current = "";
            };
            probe.onerror = () => { window.clearTimeout(imageTimeout); URL.revokeObjectURL(blobUrl); if (loadingFrameKey.current === frameKey) loadingFrameKey.current = ""; };
            probe.src = blobUrl;
          } catch (caught) {
            if (loadingFrameKey.current === frameKey) loadingFrameKey.current = "";
            if (active && !(caught instanceof DOMException && caught.name === "AbortError")) frameIssue = caught instanceof Error ? caught.message : String(caught);
          }
        }
        if (currentState?.error) setPollError(currentState.error);
        else if (frameIssue) setPollError(frameIssue);
        else setPollError("");
      } catch (caught) { if (active && pollInteractionVersion === interactionVersion.current && !(caught instanceof DOMException && caught.name === "AbortError")) setPollError(caught instanceof Error ? caught.message : String(caught)); }
      finally { window.clearTimeout(timeout); if (controller === pollController) controller = null; polling = false; if (active) timer = window.setTimeout(poll, 800); }
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); controller?.abort(); };
  }, [visible, threadId, prefix, request, commitState]);

  useEffect(() => () => { if (frameRef.current) URL.revokeObjectURL(frameRef.current); }, []);

  useEffect(() => {
    if (state?.url && !loading && !addressDirty.current && document.activeElement !== addressRef.current) setUrl(state.url === "about:blank" ? "" : state.url);
  }, [state?.url, state?.activeTabId, loading]);
  useEffect(() => {
    if (!state?.activeTabId) return;
    const list = tabList.current, selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const group = selected.parentElement!;
    if (group.offsetLeft < list.scrollLeft) list.scrollLeft = group.offsetLeft;
    else if (group.offsetLeft + group.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = group.offsetLeft + group.offsetWidth - list.clientWidth;
  }, [state?.activeTabId, state?.tabs?.length]);
  useEffect(() => () => { for (const timer of tabCloseTimers.current) window.clearTimeout(timer); tabCloseTimers.current.clear(); }, []);

  useEffect(() => {
    if (visible || !pauseOnHide || !threadId || !stateRef.current || stateRef.current.threadId !== threadId || stateRef.current.mode !== "agent") return;
    void request("/control", { method: "POST", body: JSON.stringify({ mode: "human" }) }).catch(() => undefined);
  }, [visible, pauseOnHide, request]);

  const navigate = async (event?: React.FormEvent, requestedUrl?: string, newTab = false) => {
    event?.preventDefault();
    let target = (requestedUrl ?? url).trim();
    if (!target && !newTab) return;
    if (target && !/^[a-z][a-z\d+.-]*:/i.test(target)) target = `https://${target}`;
    const editedAtStart = addressVersion.current;
    if (newTab && !target) { setUrl(""); addressDirty.current = false; }
    setLoading(true); setInteractionError("");
    try {
      if (stateRef.current?.mode === "agent") {
        const takeover = await request("/control", { method: "POST", body: JSON.stringify({ mode: "human" }) });
        if (takeover.data) commitState(takeover.data as BrowserState);
      }
      const result = await request("/open", { method: "POST", body: JSON.stringify({ url: target || undefined, newTab }) });
      if (result.data) {
        commitState(result.data as BrowserState);
        if (editedAtStart === addressVersion.current) { addressDirty.current = false; setUrl(result.data.url === "about:blank" ? "" : result.data.url); }
      }
      if (newTab && !target) { addressRef.current?.focus({ preventScroll: true }); addressRef.current?.select(); }
    }
    catch (caught) { setInteractionError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  };
  const appliedNavigation = useRef("");
  useEffect(() => {
    if (!navigation || appliedNavigation.current === navigation.id) return;
    appliedNavigation.current = navigation.id;
    setUrl(navigation.url);
    void navigate(undefined, navigation.url, true);
  }, [navigation?.id]);

  const control = async (mode: "human" | "agent") => {
    setBusy(true); setInteractionError("");
    try { const result = await request("/control", { method: "POST", body: JSON.stringify({ mode }) }); if (result.data) commitState(result.data as BrowserState); }
    catch (caught) { setInteractionError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true); setInteractionError("");
    try {
      await request("", { method: "DELETE" });
      commitState(null);
      setUrl("");
      appliedFrameKey.current = "";
      loadingFrameKey.current = "";
      frameLoadToken.current += 1;
      if (frameRef.current) URL.revokeObjectURL(frameRef.current);
      frameRef.current = "";
      setFrame("");
    }
    catch (caught) { setInteractionError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const approval = async (approved: boolean) => {
    if (!state?.pendingApproval) return;
    setInteractionError("");
    try { const result = await request("/approval", { method: "POST", body: JSON.stringify({ id: state.pendingApproval.id, approved }) }); if (result.data?.state) commitState(result.data.state as BrowserState); }
    catch (caught) { setInteractionError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const clickFrame = (event: React.MouseEvent<HTMLImageElement>) => {
    if (state?.mode !== "human" || !state.viewport.width || !state.viewport.height) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / state.viewport.width, rect.height / state.viewport.height);
    const renderedW = state.viewport.width * scale, renderedH = state.viewport.height * scale;
    const x = (event.clientX - rect.left - (rect.width - renderedW) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - renderedH) / 2) / scale;
    if (x >= 0 && y >= 0 && x < state.viewport.width && y < state.viewport.height) void sendAction("click", { x: Math.round(x), y: Math.round(y) });
  };

  const queueWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (state?.mode !== "human") return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = state.viewport.width ? Math.min(rect.width / state.viewport.width, rect.height / state.viewport.height) : 1;
    const cur = wheelRef.current ?? { x: state.cursor?.x ?? state.viewport.width / 2, y: state.cursor?.y ?? state.viewport.height / 2, dx: 0, dy: 0 };
    cur.x = Math.max(0, Math.min(state.viewport.width - 1, cur.x));
    cur.y = Math.max(0, Math.min(state.viewport.height - 1, cur.y));
    cur.dx = Math.max(-3000, Math.min(3000, cur.dx + event.deltaX / scale));
    cur.dy = Math.max(-3000, Math.min(3000, cur.dy + event.deltaY / scale));
    wheelRef.current = cur;
    if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => { const point = wheelRef.current; wheelRef.current = null; if (point) void sendAction("scroll", { x: point.x, y: point.y, deltaX: Math.round(point.dx), deltaY: Math.round(point.dy) }); }, 100);
  };
  useEffect(() => () => { if (wheelTimer.current) window.clearTimeout(wheelTimer.current); wheelRef.current = null; }, [prefix, visible]);

  const submitText = (event: React.FormEvent) => { event.preventDefault(); if (!text) return; const submitted = text; void sendAction("type", { text: submitted }).then(ok => { if (ok) setText(current => current === submitted ? "" : current); }); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!visible || (stateRef.current && stateRef.current.threadId !== threadId)) return;
      if (event.key === "Escape" && stateRef.current?.mode === "agent") { event.preventDefault(); void control("human"); return; }
      if (!panelRef.current?.contains(event.target as Node)) return;
      if (stateRef.current?.mode !== "human" || event.key === "Escape") return;
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "r") { event.preventDefault(); void sendAction("reload"); }
      else if (key === "l") { event.preventDefault(); addressRef.current?.focus(); addressRef.current?.select(); }
      else if (key === "Enter") { event.preventDefault(); void navigate(); }
      else if (key === "w") event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, threadId, prefix, state?.mode, sendAction, url]);

  const active = state?.status === "running" && state.mode === "agent";
  const switchTab = async (id: string) => {
    if (id === stateRef.current?.activeTabId || busy || loading) return;
    addressDirty.current = false;
    setBusy(true);
    try { await sendAction("switch_tab", { tabId: id }); }
    finally { setBusy(false); }
  };
  const closeTab = (id: string) => {
    if (busy || loading || closingTabs.includes(id)) return;
    setBusy(true); setClosingTabs(current => [...current, id]);
    const timer = window.setTimeout(() => {
      tabCloseTimers.current.delete(timer);
      void sendAction("close_tab", { tabId: id }).finally(() => { setClosingTabs(current => current.filter(value => value !== id)); setBusy(false); });
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220);
    tabCloseTimers.current.add(timer);
  };
  const manual = state?.mode === "human";
  const panelError = interactionError || pollError || state?.error || "";
  const viewportBounds = panelRef.current?.querySelector(".browserViewport")?.getBoundingClientRect();
  const imageScale = state && viewportBounds?.width && viewportBounds.height ? Math.min(viewportBounds.width / state.viewport.width, viewportBounds.height / state.viewport.height) : 1;
  const cursorStyle = agentCue && state?.cursor && viewportBounds ? {
    left: `${(viewportBounds.width - state.viewport.width * imageScale) / 2 + state.cursor.x * imageScale}px`,
    top: `${(viewportBounds.height - state.viewport.height * imageScale) / 2 + state.cursor.y * imageScale}px`
  } : undefined;
  return <aside ref={panelRef} className={`browserPanel${visible ? " open" : ""}`} role="dialog" aria-label="浏览器" aria-hidden={!visible} inert={!visible}>
    <header className="browserPanelHeader">
      <span className={`browserPanelStatus${active ? " active" : ""}`}><Browser className="browserPanelGlyph" />{active ? "代理正在浏览" : manual ? "手动控制中" : state?.status === "starting" ? "正在连接…" : "浏览器"}</span>
      <span className="browserPanelHeaderActions">
        {state && !manual && <button type="button" title="切换为手动控制" onClick={() => void control("human")} disabled={busy}><MousePointer2 size={15} />手动控制</button>}
        {state && manual && <button type="button" title="将控制权交还给代理" onClick={() => void control("agent")} disabled={busy}><Play size={15} />交还代理</button>}
        {state && <button className="browserPanelStop" type="button" onClick={() => void stop()} disabled={busy} title="关闭浏览器会话"><Pause size={15} />停止</button>}
        <button className="browserPanelClose" type="button" onClick={closePanel} title="隐藏浏览器" aria-label="关闭"><X size={17} /></button>
      </span>
    </header>
    <div className="browserTabBar">
      <div className="browserTabs" ref={tabList} role="tablist" aria-label="网页标签">
        {state?.tabs?.map((tab, index) => <div key={tab.id} className={`browserTab${tab.id === state.activeTabId ? " selected" : ""}${closingTabs.includes(tab.id) ? " closing" : ""}`}>
          <button type="button" role="tab" aria-selected={tab.id === state.activeTabId} tabIndex={tab.id === state.activeTabId ? 0 : -1} title={tab.url === "about:blank" ? "新标签页" : `${tab.title}\n${tab.url}`} onClick={() => void switchTab(tab.id)} onKeyDown={event => {
            const tabs = state.tabs!; const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1;
            if (next >= 0) { event.preventDefault(); void switchTab(tabs[next].id); tabList.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus({ preventScroll: true }); }
          }}><Browser size={13} /><span>{tab.title || "新标签页"}</span></button>
          <button type="button" className="browserTabClose" aria-label={`关闭网页 ${tab.title || "新标签页"}`} title="关闭此网页" disabled={busy || loading} onClick={() => closeTab(tab.id)}><X size={12} /></button>
        </div>)}
      </div>
      <button type="button" className="browserNewTab" title="新建网页标签" aria-label="新建网页标签" disabled={busy || loading || !threadId} onClick={() => void navigate(undefined, "", true)}><Plus size={15} /></button>
    </div>
    <form className="browserAddress" onSubmit={event => void navigate(event)}>
      <button type="button" title="后退" aria-label="后退" disabled={!state} onClick={() => void sendAction("back")}><ArrowLeft size={15} /></button>
      <button type="button" title="前进" aria-label="前进" disabled={!state} onClick={() => void sendAction("forward")}><ArrowRight size={15} /></button>
      <button type="button" title="刷新" aria-label="刷新" disabled={!state} onClick={() => void sendAction("reload")}><RotateCw size={14} /></button>
      <input ref={addressRef} aria-label="网址" value={url} onChange={event => { addressVersion.current++; addressDirty.current = true; setUrl(event.target.value); }} placeholder="输入网址…" dir="ltr" />
      <button type="submit" className="browserGo" disabled={loading || !threadId}>{loading ? <LoaderCircle className="browserSpin" size={15} /> : "打开"}</button>
    </form>
    {state?.pendingApproval && <section className="browserApproval" role="alert"><strong>需要授权</strong><span>{state.pendingApproval.message}{state.pendingApproval.url ? ` · ${state.pendingApproval.url}` : ""}</span><div><button type="button" onClick={() => void approval(false)}>拒绝</button><button type="button" onClick={() => void approval(true)}><Check size={14} />允许</button></div></section>}
    <div className={`browserViewport${agentCue ? " agentActive" : ""}${manual ? " manual" : ""}`} onWheel={queueWheel}>
      {frame && state?.url !== "about:blank" ? <img src={frame} alt={state?.title || "浏览器页面预览"} onClick={clickFrame} draggable={false} /> : <div className="browserEmpty">{!threadId ? "请选择一个对话以使用浏览器" : state?.status === "starting" ? <><LoaderCircle className="browserSpin" size={20} />正在连接浏览器…</> : panelError ? "无法显示页面" : state?.url && state.url !== "about:blank" ? <LoaderCircle className="browserSpin" size={20} /> : "输入网址以开始浏览"}</div>}
      {agentCue && state?.cursor && <span className="browserCursor" style={cursorStyle}><MousePointer2 size={20} fill="currentColor" /></span>}
      {loading && <span className="browserLoadingOverlay"><LoaderCircle className="browserSpin" size={19} /></span>}
    </div>
    {(state?.activity || panelError) && <div className={`browserActivity${panelError ? " error" : ""}`}>{panelError || state?.activity}</div>}
    {manual && <div className="browserManualControls"><form onSubmit={submitText}><input value={text} onChange={event => setText(event.target.value)} placeholder="输入要在网页中键入的文字…" aria-label="要键入的文字" /><button type="submit" disabled={!text}>发送</button></form><div className="browserKeys"><button type="button" onClick={() => setShowKeys(value => !value)}>按键 <ChevronDown size={13} /></button>{showKeys && <span>{["Enter", "Tab", "Backspace", "Escape", "ArrowDown"].map(key => <button type="button" key={key} onClick={() => void sendAction("press", { key })}>{key}</button>)}</span>}</div><small>点击页面进行操作 · 使用滚轮滚动 · 按 Esc 暂停代理</small></div>}
  </aside>;
}
