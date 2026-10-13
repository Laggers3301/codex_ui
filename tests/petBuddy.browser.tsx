import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PetBuddy } from "../src/PetBuddy";

function PetBuddyHarness() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [status, setStatus] = useState<"idle" | "running">("idle");
  return <div className="qaShell" data-theme={theme}>
    <style>{`
      * { box-sizing: border-box; }
      html, body, #root { margin: 0; min-width: 320px; min-height: 100%; height: 100%; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { overflow: hidden; }
      .qaShell { --panel:#1e211f; --panel-strong:#252a27; --line:#454b46; --text:#eef1ed; --muted:#a7afa8; --teal:#58b9ac; --red:#ed8780; position:relative; width:100%; height:100dvh; overflow:hidden; color:var(--text); background:#171a18; }
      .qaShell[data-theme="light"] { --panel:#fbfaf6; --panel-strong:#fff; --line:#d8d5cc; --text:#232625; --muted:#6e716d; --teal:#207f78; --red:#b54444; color:var(--text); background:#f4f2ed; }
      .petPicker.uiGlassSurface { background: color-mix(in srgb, var(--panel-strong) 88%, transparent); box-shadow: 0 24px 80px rgba(0,0,0,.3); }
      .qaHeader { height:58px; display:flex; align-items:center; gap:9px; padding:0 18px; border-bottom:1px solid var(--line); }
      .qaHeader button { border:1px solid var(--line); border-radius:9px; padding:7px 10px; color:var(--text); background:var(--panel); }
      .qaHeader strong { margin-right:auto; font-size:14px; }
      .qaConversation { width:min(760px, calc(100% - 36px)); margin:54px auto; }
      .qaConversation p { color:var(--muted); line-height:1.7; }
      .qaComposer { position:absolute; inset:auto 0 0; min-height:174px; padding:18px max(18px, calc((100% - 760px)/2)); border-top:1px solid var(--line); background:var(--panel); }
      .qaComposerBox { height:112px; border:1px solid var(--line); border-radius:18px; padding:14px; color:var(--muted); }
    `}</style>
    <header className="qaHeader">
      <strong>隔离的 Codex 页面验收</strong>
      <button type="button" className="qaPetTrigger" onClick={() => window.dispatchEvent(new Event("codex:open-pets"))}>账号菜单 · 我的宠物</button>
      <button type="button" className="qaThemeToggle" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}>切换明暗主题</button>
      <button type="button" className="qaStatusToggle" onClick={() => setStatus((value) => value === "idle" ? "running" : "idle")}>切换任务状态</button>
    </header>
    <main className="qaConversation">
      <h1>当前会话</h1>
      <p>这是仅供 Playwright 使用的独立 UI 舞台。没有连接真实会话、模型或生产宠物收藏。</p>
      <p>底部输入框为遮挡边界；拖动角色时应始终停在其上方。</p>
    </main>
    <div className="qaComposer composer"><div className="qaComposerBox">输入消息… · QA 不会向模型发送任何内容</div></div>
    <PetBuddy status={status} />
  </div>;
}

createRoot(document.getElementById("root")!).render(<PetBuddyHarness />);
