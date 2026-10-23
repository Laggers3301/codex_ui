import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Plus, Send } from "lucide-react";
import { VoiceInput } from "../src/VoiceInput";
import { ComposerAmbientGlow } from "../src/ambient/ComposerAmbientGlow";
import "../src/styles.css";
import "../src/softCorners.css";
import "./ambientGlow.preview.css";

function Fixture() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [desktop, setDesktop] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("尚未输入，光层隐藏");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState("");
  const [welcome, setWelcome] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const screen = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, [theme]);
  useEffect(() => {
    const error = (event: ErrorEvent) => setErrors(current => [...current, event.message]);
    const rejection = (event: PromiseRejectionEvent) => setErrors(current => [...current, String(event.reason)]);
    window.addEventListener("error", error); window.addEventListener("unhandledrejection", rejection);
    const timer = window.setInterval(() => {
      const layer = screen.current?.querySelector<HTMLElement>(".composerAmbientGlow");
      const host = screen.current?.querySelector<HTMLElement>(".composerAmbientGlowCanvas");
      const canvas = host?.querySelector("canvas");
      setStatus(`${layer?.dataset.active === "true" ? "输入中 · 光层渐入" : "空闲 · 光层淡出"} / ${host?.dataset.renderer ?? "未启动GPU"} / ${canvas ? `${canvas.width}×${canvas.height}像素 · ${host?.dataset.drawnFrames ?? 0}帧` : "无画布"}`);
    }, 500);
    return () => { clearInterval(timer); window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); };
  }, []);
  useEffect(() => {
    if (!running) return;
    input.current?.focus();
    // A long IME session is a genuine supported activity, not a forced always-on mode.
    input.current?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    return () => { input.current?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); };
  }, [running]);
  return <main className="ambientPreview">
    <header><h1>输入弥散光 · 隔离预览</h1><p>输入文字或中文预编辑时显示光效，清空文字或发送后淡出。不连接生产会话。</p></header>
    <nav aria-label="预览控制">
      <button onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}>切换白天／黑夜</button>
      <button onClick={() => setDesktop(value => !value)}>切换手机／桌面</button>
      <button onClick={() => setRunning(value => !value)}>{running ? "结束连续输入" : "预览连续输入"}</button>
      <button onClick={() => { setDraft(""); setRunning(false); setWelcome(value => !value); }}>{welcome ? "切到已有会话" : "打开新会话首页"}</button>
    </nav>
    <p className="ambientPreviewStatus" role="status">{status}</p>
    <div className={`ambientPreviewComparison${desktop ? " desktop" : ""}`}>

      <figure><figcaption>号池 · 保留现有排版和功能</figcaption><section className="conversation ambientPreviewScreen" ref={screen}>
        <div className="conversationContent hasComposerAmbientGlow"><ComposerAmbientGlow theme={theme} hasDraft={Boolean(draft.trim())} welcome={welcome} /><div className="messages"><p>{message || ""}</p></div></div>
        <div className="composer"><div className="composerBody"><div className="composerTools"><button type="button" className="iconTextButton v2FastModeButton">上下文 12%</button><button type="button" className="iconTextButton v2FastModeButton">Fast</button><button type="button" className="iconTextButton v2FastModeButton">gpt-6.1-sol</button></div><textarea ref={input} value={draft} onChange={event => setDraft(event.target.value)} aria-label="测试输入" placeholder="随心输入" rows={3} /></div><div className="composerSendActions"><VoiceInput onText={text => setDraft(value => value + text)} /><button className="iconButton sendButton primary" aria-label="发送测试消息" onClick={() => { setMessage(draft); setDraft(""); setWelcome(false); setRunning(false); }}><Send size={18} /></button></div><button className="ambientPreviewPlus iconButton" aria-label="添加附件"><Plus size={18} /></button></div>
      </section></figure>
    </div>
    <section className="ambientShapeExamples"><h2>共用圆角层级</h2><div className="rightWorkspaceOverviewCard">右栏卡片</div><div className="polishedSelectMenu">模型／功能菜单</div><div className="modalDialog">工作区／确认弹窗</div></section>
    <p>浏览器错误：{errors.length ? errors.join("；") : "未捕获到错误"}。本页不发送对话消息；语音测试需使用模拟麦克风并拦截识别请求。</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
