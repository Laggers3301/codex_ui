import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { observePhoneViewport } from "./phoneViewport";
import { installClientDiagnostics } from './clientDiagnostics';
import { RenderBoundary } from './RenderBoundary';
import "./styles.css";
import "./softCorners.css";
import "./mobileSidebar.css";
import "./panelTypography.css";
import "./mobileReading.css";
import "./imageViewerMotion.css";
import "./readingScale.css";
import "./toolTypography.css";
import "./globalDialogs.css";
import "./dialogControlScale.css";
import "./drawerMotion.css";
installClientDiagnostics();
observePhoneViewport();

// Installation is independent of opting into notifications. The existing
// push subscription flow reuses this same root-scoped worker.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => { void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {}); }, { once: true });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RenderBoundary scope="application">
      <App />
    </RenderBoundary>
  </React.StrictMode>
);
