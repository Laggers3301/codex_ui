import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "./PanelIcons";
import { readUiUpdates } from "./api";
import "./FeishuOffice.css";

export function FeatureUpdateNotice({ userId }: { userId: string }) {
  const [text, setText] = useState(""), [closing, setClosing] = useState(false);
  useEffect(() => {
    setText(""); setClosing(false);
    const c = new AbortController();
    void readUiUpdates(userId, c.signal, "plugins").then(state => {
      if (!state.notice || c.signal.aborted) return;
      const key = `codex-feature-notice:${encodeURIComponent(userId)}:${state.version}`;
      try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { return; }
      // Mark on first display, not on close: another refresh must not repeat it.
      setText(state.notice);
    }).catch(() => {});
    return () => c.abort();
  }, [userId]);
  useEffect(() => { if (!closing) return; const timer = setTimeout(() => setText(""), 240); return () => clearTimeout(timer); }, [closing]);
  return text ? createPortal(<div className={`featureUpdateNotice${closing ? " closing" : ""}`} role="status"><span>{text}</span><button aria-label="关闭更新提示" onClick={() => setClosing(true)}><X size={15} /></button></div>, document.body) : null;
}
