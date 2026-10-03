import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "./PanelIcons";
import { codexSocket } from "./codexSocket";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

const splitStorageKey = "codex-web-terminal-split-percent";

export function TerminalPanel({ projectId, projectName, split, onClose }: { projectId: string; projectName: string; split: boolean; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const resizing = useRef(false);
  const previousBodyStyle = useRef({ cursor: "", userSelect: "" });
  const [splitPercent, setSplitPercent] = useState(() => {
    const stored = Number(window.localStorage.getItem(splitStorageKey));
    return Number.isFinite(stored) && stored >= 20 && stored <= 75 ? stored : 42;
  });
  const commandInput = useRef<HTMLInputElement>(null);
  const submitLine = useRef<(line: string) => Promise<boolean>>(async () => false);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const submitting = useRef(false);
  const [line, setLine] = useState("");
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 10);
    commandInput.current?.focus();
    return () => {
      window.clearTimeout(timer);
      if (resizing.current) {
        document.body.style.cursor = previousBodyStyle.current.cursor;
        document.body.style.userSelect = previousBodyStyle.current.userSelect;
      }
    };
  }, []);
  const resizeTo = (clientY: number) => {
    const bounds = panel.current?.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.height < 100) return;
    const minimum = Math.min(180, bounds.height * .35);
    const height = Math.max(minimum, Math.min(bounds.height - minimum - 9, bounds.bottom - clientY));
    const next = Math.round(height / bounds.height * 1000) / 10;
    setSplitPercent(next);
    window.localStorage.setItem(splitStorageKey, String(next));
  };
  const finishResize = () => {
    if (!resizing.current) return;
    resizing.current = false;
    document.body.style.cursor = previousBodyStyle.current.cursor;
    document.body.style.userSelect = previousBodyStyle.current.userSelect;
  };
  useEffect(() => {
    if (!host.current) return;
    const processId = `term-${crypto.randomUUID()}`;
    const terminalTheme = () => document.documentElement.dataset.theme === "light"
      ? { background: "#f5f7f4", foreground: "#26312a", cursor: "#26312a", selectionBackground: "#b1d9c2" }
      : { background: "#171d1a", foreground: "#e8ede8", cursor: "#e8ede8", selectionBackground: "#52705d" };
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Consolas, "Cascadia Code", monospace', theme: terminalTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    let disconnectedNoticeShown = false;
    let started = false;
    let pendingInput = "";
    let inputTimer: number | null = null;
    let resizeTimer: number | null = null;
    let appliedSize = "";
    let pendingResize: { key: string; promise: Promise<boolean> } | null = null;
    const resizeRequests = new Map<string, (ok: boolean) => void>();
    const send = (type: string, payload: Record<string, unknown> = {}): boolean => {
      try { codexSocket.send({ type, requestId: `${processId}-${crypto.randomUUID()}`, processId, ...payload }); return true; }
      catch { if (!disconnectedNoticeShown) { term.write("\r\n[连接断开，请关闭并重新打开终端]\r\n"); disconnectedNoticeShown = true; } return false; }
    };
    const unsubscribe = codexSocket.subscribe(message => {
      if (message.type === "ack" && message.requestId) {
        resizeRequests.get(message.requestId)?.(Boolean(message.ok));
      }
      if (message.type === "terminal.output") {
        const data = message.data as { processId?: string; text?: string } | undefined;
        if (data?.processId === processId && data.text) term.write(data.text);
      }
      if (message.type === "ack" && message.requestId?.startsWith(processId) && !message.ok) {
        term.write(`\r\n[${message.error ?? "命令失败"}]\r\n`);
      }
    });
    const flushInput = () => {
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      inputTimer = null;
      if (started && pendingInput) send("command.write", { data: pendingInput });
      pendingInput = "";
    };
    const syncSize = async (): Promise<boolean> => {
      fit.fit();
      if (!started || term.cols < 20 || term.rows < 5) return false;
      const key = `${term.cols}:${term.rows}`;
      if (pendingResize) {
        const pending = pendingResize;
        const ok = await pending.promise;
        if (!ok) return false;
        if (pending.key === key) return true;
        return syncSize();
      }
      if (appliedSize === key) return true;
      const requestId = `${processId}-resize-${crypto.randomUUID()}`;
      const promise = new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => finish(false), 3000);
        const finish = (ok: boolean) => {
          window.clearTimeout(timer);
          resizeRequests.delete(requestId);
          if (ok) appliedSize = key;
          resolve(ok);
        };
        resizeRequests.set(requestId, finish);
        try { codexSocket.send({ type: "command.resize", requestId, processId, size: { cols: term.cols, rows: term.rows } }); }
        catch { finish(false); }
      });
      pendingResize = { key, promise };
      const ok = await promise;
      pendingResize = null;
      return ok;
    };
    submitLine.current = async (value: string) => {
      if (!started) return false;
      if (resizeTimer !== null) { window.clearTimeout(resizeTimer); resizeTimer = null; }
      // Resize must be acknowledged by the PTY before Readline receives the line.
      if (!await syncSize()) return false;
      if (pendingInput) flushInput();
      return send("command.write", { data: `${value}\r` });
    };
    const input = term.onData(data => {
      pendingInput += data;
      // One short write per typing burst avoids a round trip for each byte.
      if (data.includes("\r") || data.includes("\n")) flushInput();
      else if (inputTimer === null) inputTimer = window.setTimeout(flushInput, 12);
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (started && term.cols >= 20 && term.rows >= 5) {
          void syncSize();
        }
      }, 16);
    });
    resize.observe(host.current);
    const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const start = () => {
      if (started) return;
      try {
        fit.fit();
        codexSocket.send({ type: "command.exec", requestId: `${processId}-start`, processId,
          projectId, command: ["/usr/bin/env", "TERM=xterm-256color", "/bin/bash", "-i"], tty: true, disableTimeout: true,
          size: { cols: term.cols, rows: term.rows } });
        started = true;
      } catch { /* Wait for the socket's open event. */ }
    };
    const unsubscribeStatus = codexSocket.subscribeStatus(status => {
      if (status === "open") start();
      if (status === "closed" && started && !disconnectedNoticeShown) {
        term.write("\r\n[连接断开，请关闭并重新打开终端]\r\n");
        disconnectedNoticeShown = true;
      }
    });
    start();
    return () => { submitLine.current = async () => false; themeObserver.disconnect(); resize.disconnect(); if (inputTimer !== null) window.clearTimeout(inputTimer); if (resizeTimer !== null) window.clearTimeout(resizeTimer); for (const finish of resizeRequests.values()) finish(false); input.dispose(); unsubscribe(); unsubscribeStatus(); if (started) send("command.terminate"); term.dispose(); };
  }, [projectId]);
  return <aside ref={panel} className={`webTerminalPanel uiGlassSurface${visible ? " open" : ""}${resizing.current ? " resizing" : ""}`} style={split ? { flexBasis: `${splitPercent}%` } : undefined} role="dialog" aria-label={`${projectName} 交互终端`}>
    {split ? <div className="webTerminalSplitHandle" role="separator" aria-orientation="horizontal" aria-label="拖动调整终端与文件变更区域高度" aria-valuemin={20} aria-valuemax={75} aria-valuenow={Math.round(splitPercent)} tabIndex={0} onPointerDown={event => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      previousBodyStyle.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      resizing.current = true;
      resizeTo(event.clientY);
    }} onPointerMove={event => { if (resizing.current) resizeTo(event.clientY); }} onPointerUp={finishResize} onPointerCancel={finishResize} onKeyDown={event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      setSplitPercent(current => {
        const next = Math.max(20, Math.min(75, current + (event.key === "ArrowUp" ? 5 : -5)));
        window.localStorage.setItem(splitStorageKey, String(next));
        return next;
      });
    }} /> : null}
    <header><strong>终端 · {projectName}</strong><button type="button" onClick={() => { setVisible(false); onClose(); }} aria-label="关闭终端"><X size={17} /></button></header>
    <div ref={host} className="webTerminalCanvas" />
    <form className="webTerminalCommandLine" onSubmit={async event => {
      event.preventDefault();
      if (submitting.current) return;
      submitting.current = true;
      const submitted = line;
      try {
        if (!await submitLine.current(submitted)) return;
        if (submitted.trim()) history.current.push(submitted);
        historyIndex.current = -1;
        setLine(current => current === submitted ? "" : current);
      } finally { submitting.current = false; }
    }}>
      <span aria-hidden="true">›</span>
      <input ref={commandInput} aria-label="即时输入终端命令" title="本地即时输入，Enter 发送；交互程序可直接点击上方终端" autoComplete="off" autoCapitalize="off" spellCheck={false} value={line} onChange={event => { setLine(event.target.value); historyIndex.current = -1; }} onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        if (!history.current.length) return;
        event.preventDefault();
        historyIndex.current = event.key === "ArrowUp"
          ? Math.min(history.current.length - 1, historyIndex.current + 1)
          : Math.max(-1, historyIndex.current - 1);
        setLine(historyIndex.current < 0 ? "" : history.current[history.current.length - 1 - historyIndex.current]);
      }} placeholder="输入命令，Enter 发送" />
    </form>
  </aside>;
}
