import { StrictMode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";
import { createRevealPass, emptyRevealSnapshot, StreamRevealSpan } from "../src/streamReveal";
import { normalizeGfmTableBoundaries } from "../src/markdown";

function Fixture() {
  const [source, setSource] = useState("初始快照");
  const committed = useRef(emptyRevealSnapshot());
  const markdown = normalizeGfmTableBoundaries(remend(source, { linkMode: "text-only" }));
  const pass = useMemo(() => createRevealPass(committed.current, source, performance.now(), markdown), [source, markdown]);
  useLayoutEffect(() => { committed.current = pass.snapshot; }, [pass]);
  Object.assign(window, { setMarkdown: setSource });
  return <ReactMarkdown components={{ span: StreamRevealSpan }} remarkPlugins={[remarkGfm]} rehypePlugins={[pass.plugin]}>{markdown}</ReactMarkdown>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
