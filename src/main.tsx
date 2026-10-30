import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./softCorners.css";
import "./mobileSidebar.css";
import "./panelTypography.css";
import "./mobileReading.css";
import "./imageViewerMotion.css";

// Installation is independent of opting into notifications. The existing
// push subscription flow reuses this same root-scoped worker.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => { void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {}); }, { once: true });
}

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Codex Web V2 render failed", error);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <main className="appRenderFallback" role="alert">
        <h1>会话内容渲染失败</h1>
        <p>页面没有被清空。刷新后可继续使用，异常内容会被安全处理。</p>
        <pre>{this.state.error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </main>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
