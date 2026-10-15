import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VirtualConversation, type VirtualConversationHandle } from "../src/VirtualConversation";

// Browser regression fixture: reuse the SAME component across cached threads.
// Remounting it between cases hides stale imperative handles and delayed scrolls.
function Fixture() {
  const [thread, setThread] = useState("A");
  const [first, setFirst] = useState(20);
  const [growth, setGrowth] = useState(0);
  const [toolGrowth, setToolGrowth] = useState(0);
  const ref = useRef<VirtualConversationHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => { ref.current?.scrollToEnd("auto"); }, [thread]);
  useLayoutEffect(() => {
    const sizer = container.current?.firstElementChild;
    if (!sizer) return;
    const observer = new ResizeObserver(() => { if (follow.current) ref.current?.scrollToEnd("auto"); });
    observer.observe(sizer);
    return () => observer.disconnect();
  }, [thread]);
  Object.assign(window, { scrollFixture: {
    switchThread(id: string) { follow.current = true; setThread(id); setFirst(20); setGrowth(0); setToolGrowth(0); },
    prepend() { follow.current = false; ref.current?.captureHistoryAnchor(); setFirst(n => n - 5); setToolGrowth(n => n + 500); },
    readTop() { follow.current = false; container.current!.scrollTop = 0; },
    bottom() { follow.current = true; ref.current?.scrollToEnd("smooth"); },
    grow() { setGrowth(n => n + 200); },
  } });
  return <>
    <style>{`
      * { box-sizing: border-box; } body { margin: 0; font: 14px sans-serif; }
      .messages { height: 500px; width: 700px; overflow: auto; padding: 0 0 150px; overflow-anchor: none; }
      .virtualConversationSizer { position: relative; width: 100%; }
      .virtualConversationRow { position: absolute; width: 100%; contain: layout style; }
      article { height: 130px; padding: 12px; border-bottom: 1px solid #ddd; }
    `}</style>
    <VirtualConversation ref={ref} containerRef={container} threadKey={thread} virtualize historyRevision={70 - first} shouldFollowEnd={() => follow.current} className="messages">
      <div key="history" style={{ height: 40 }}>History {thread}</div>
      {Array.from({ length: 70 - first }, (_, i) => first + i).map(i => <section key={`${thread}-${i}`} data-turn-id={`${thread}-${i}`}>
        {i === 20 && <div className="kind-tool" data-message-key={`${thread}-tools`} style={{ height: 30 + toolGrowth }}>Merged tool calls</div>}
        <article data-message-key={`${thread}-${i}`} style={{ height: 130 + (i === 65 ? growth : 0) }}>{thread} message {i}</article>
      </section>)}
    </VirtualConversation>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
