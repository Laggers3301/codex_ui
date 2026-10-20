import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { LiveAgentStreamMessage } from "../src/App";
import "../src/styles.css";

function Fixture() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("projectId") ?? "fixture-project";
  const assetBasePath = params.get("assetBasePath") ?? "/workspace/nailong";
  const [text, setText] = useState("初始内容");
  Object.assign(window as Window & { setFixtureText?: typeof setText }, { setFixtureText: setText });
  return <>
    <LiveAgentStreamMessage text={text} projectId={projectId} assetBasePath={assetBasePath} onOpenFileLink={(target, gallery) => {
      Object.assign(window, { lastFixtureImageOpen: { target, gallery } });
    }} />
    {!params.has("projectId") ? <LiveAgentStreamMessage text="![normal](relative.png)" projectId="fixture-project" /> : null}
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
