import type { SocketMessage } from "./types";

export class CodexSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelayMs = 1_000;
  private listeners = new Set<(message: SocketMessage) => void>();
  private statusListeners = new Set<(status: "connecting" | "open" | "closed") => void>();

  connect(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelayMs = 1_000;
      this.setStatus("open");
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data) as SocketMessage;
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
      if (this.socket === socket) {
        this.socket = null;
      }
      this.setStatus("closed");
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // Browsers do not always emit close promptly on a broken Wi-Fi route.
      // Explicitly close to start the normal reconnect path instead of requiring
      // a manual page refresh.
      socket.close();
    });
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
