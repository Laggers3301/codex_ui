import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import { codexSocket } from "./codexSocket";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

export function TerminalPanel({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 10);
    return () => window.clearTimeout(timer);
  }, []);
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
    const send = (type: string, payload: Record<string, unknown> = {}) => {
      try { codexSocket.send({ type, requestId: `${processId}-${crypto.randomUUID()}`, processId, ...payload }); }
      catch { if (!disconnectedNoticeShown) { term.write("\r\n[连接断开，请关闭并重新打开终端]\r\n"); disconnectedNoticeShown = true; } }
    };
    const unsubscribe = codexSocket.subscribe(message => {
      if (message.type === "terminal.output") {
        const data = message.data as { processId?: string; text?: string } | undefined;
        if (data?.processId === processId && data.text) term.write(data.text);
      }
      if (message.type === "ack" && message.requestId?.startsWith(processId) && !message.ok) {
        term.write(`\r\n[${message.error ?? "命令失败"}]\r\n`);
      }
    });
    const flushInput = () => {
      inputTimer = null;
      if (started && pendingInput) send("command.write", { data: pendingInput });
      pendingInput = "";
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
          send("command.resize", { size: { cols: term.cols, rows: term.rows } });
        }
      }, 90);
    });
    resize.observe(host.current);
    const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const start = () => {
      if (started) return;
      try {
        codexSocket.send({ type: "command.exec", requestId: `${processId}-start`, processId,
          projectId, command: ["/bin/bash", "-i"], tty: true, disableTimeout: true,
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
    term.focus();
    return () => { themeObserver.disconnect(); resize.disconnect(); if (inputTimer !== null) window.clearTimeout(inputTimer); if (resizeTimer !== null) window.clearTimeout(resizeTimer); input.dispose(); unsubscribe(); unsubscribeStatus(); if (started) send("command.terminate"); term.dispose(); };
  }, [projectId]);
  return <aside className={`webTerminalPanel uiGlassSurface${visible ? " open" : ""}`} role="dialog" aria-label={`${projectName} 交互终端`}>
    <header><strong>终端 · {projectName}</strong><button type="button" onClick={() => { setVisible(false); onClose(); }} aria-label="关闭终端"><X size={17} /></button></header>
    <div ref={host} className="webTerminalCanvas" />
  </aside>;
}
