import type { SocketMessage } from "./types";

export class CodexSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelayMs = 1_000;
  private connectDeadline: number | null = null;
  private heartbeatTimer: number | null = null;
  private awaitingHeartbeatAt = 0;
  private wakeListenersInstalled = false;
  private listeners = new Set<(message: SocketMessage) => void>();
  private statusListeners = new Set<(status: "connecting" | "open" | "closed") => void>();

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (!this.wakeListenersInstalled) {
      this.wakeListenersInstalled = true;
      const wake = () => { if (document.visibilityState === "hidden") return; if (this.socket?.readyState === WebSocket.OPEN) this.probe(); else this.connect(); };
      window.addEventListener("online", wake);
      window.addEventListener("focus", wake);
      document.addEventListener("visibilitychange", wake);
    }
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.socket = socket;
    this.clearConnectionTimers();
    this.connectDeadline = window.setTimeout(() => { if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) this.recover(socket); }, 10_000);

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectDelayMs = 1_000;
      if (this.connectDeadline !== null) window.clearTimeout(this.connectDeadline);
      this.connectDeadline = null;
      this.heartbeatTimer = window.setInterval(() => this.probe(), 5_000);
      this.setStatus("open");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data) as SocketMessage;
        if (message.type === "transport.pong") { this.awaitingHeartbeatAt = 0; return; }
        for (const listener of this.listeners) {
          listener(message);
        }
      } catch {
        for (const listener of this.listeners) {
          listener({ type: "error", ok: false, error: "Invalid socket payload." });
        }
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearConnectionTimers();
      this.setStatus("closed");
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      // Browsers do not always emit close promptly on a broken Wi-Fi route.
      // Explicitly close to start the normal reconnect path instead of requiring
      // a manual page refresh.
      this.recover(socket);
    });
  }

  private clearConnectionTimers(): void {
    if (this.connectDeadline !== null) window.clearTimeout(this.connectDeadline);
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.connectDeadline = this.heartbeatTimer = null;
    this.awaitingHeartbeatAt = 0;
  }

  private recover(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null; this.clearConnectionTimers();
    // A stalled browser close handshake must not block the next connection.
    try { socket.close(); } catch { /* reconnect below */ }
    this.setStatus("closed"); this.scheduleReconnect();
  }

  private probe(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (this.awaitingHeartbeatAt) {
      if (Date.now() - this.awaitingHeartbeatAt >= 10_000) this.recover(socket);
      return;
    }
    this.awaitingHeartbeatAt = Date.now();
    try { socket.send(JSON.stringify({ type: "transport.ping" })); } catch { this.recover(socket); }
  }

  send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected.");
    }
    this.socket.send(JSON.stringify(message));
  }

  subscribe(listener: (message: SocketMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: (status: "connecting" | "open" | "closed") => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 8_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: "connecting" | "open" | "closed"): void {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

export const codexSocket = new CodexSocket();
