import { createRoot } from "react-dom/client";
import { useState } from "react";
import { RollingToolCount, ToolArrivalList } from "../src/ToolActivityMotion";
import "../src/styles.css";

function Fixture() {
  const [count, setCount] = useState(1);
  const [tick, setTick] = useState(0);
  return <main style={{ padding: 24, color: "var(--ui-content)", maxWidth: 640 }}>
    <button onClick={() => setCount(value => value + 16)}>批量收到16条</button>
    <button onClick={() => setCount(10000)}>大量工具</button>
    <button onClick={() => setTick(value => value + 1)}>正文刷新 {tick}</button>
    <button onClick={() => setCount(1)}>切换历史</button>
    <div className="toolBundleTitleLabel" style={{ padding: "20px 0" }}>调用工具 · exec × <RollingToolCount count={count} /></div>
    <ToolArrivalList itemKeys={Array.from({ length: Math.min(count, 32) }, (_, index) => String(index))}>
      {Array.from({ length: Math.min(count, 32) }, (_, index) => <article key={index} data-tool-entry-key={index}>调用工具 · exec {index + 1}</article>)}
    </ToolArrivalList>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
