import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { TransferReceipt } from "../src/TransferReceipt";
import { TRANSFER_RECEIPT_HOLD_MS } from "../src/transferReceipt";
import "../src/styles.css";

function Fixture() {
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [shown, setShown] = useState(true);
  const [renders, setRenders] = useState(0);
  return <main style={{ padding: 20, maxWidth: 760, margin: "auto", color: "var(--text)" }}>
    <nav style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 24 }}>
      <button onClick={() => setExpiresAt(Date.now() + TRANSFER_RECEIPT_HOLD_MS)}>模拟发送成功</button>
      <button onClick={() => setShown(value => !value)}>切换会话</button>
      <button onClick={() => setRenders(value => value + 1)}>重绘 {renders}</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>切换主题</button>
    </nav>
    <section data-testid="transcript">
      <p>已整理好，以下是文件链接。</p>
      {shown && expiresAt !== null ? <TransferReceipt key={expiresAt} expiresAt={expiresAt} onExpired={() => setExpiresAt(null)}>
        <article className="messageItem kind-tool"><div className="messageMeta">Codex Web · file transfer</div><p>已通过 SSH 发送到当前访问设备：report.md</p></article>
      </TransferReceipt> : null}
      <p data-testid="next-answer">这条模型回答不会被删除。</p>
      <article data-testid="failed-receipt" className="messageItem kind-tool"><div className="messageMeta">自动发送 report.md 失败：连接超时</div></article>
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
