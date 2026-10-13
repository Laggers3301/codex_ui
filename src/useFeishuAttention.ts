import { useEffect, useState } from "react";

export function needsFeishuAuthorization(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  const identity = [record.tool, record.server, record.name].filter(value => typeof value === "string").join(" ");
  if (!/feishu_office|codex_feishu/.test(identity)) return false;
  // Never treat echoed prompts, shell commands or source code as an auth error.
  const text = JSON.stringify([record.error, record.result, record.output, record.aggregatedOutput, record.needsAuthorization === true ? { needsAuthorization: true } : null]);
  return /请先连接或重新授权自己的飞书账号|飞书授权未包含离线续期权限|需要重新授权|OAuth 申请范围并重新授权/.test(text)
    || /needsAuthorization(?:\\?"\s*:\s*)true/.test(text);
}

/** Small authenticated local query; never contacts Feishu or executes a write. */
export function useFeishuAttention(userId: string, threadId: string | undefined, onOpen: () => void) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!threadId) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, inFlight = false;
    const controller = new AbortController(), seen = new Set<string>();
    const refresh = async () => {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const response = await fetch("/api/feishu/proposals", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as { proposals?: { id: string; threadId: string; status: string }[] };
        if (disposed) return;
        const pending = (data.proposals ?? []).filter(p => p.threadId === threadId && ["pending", "uncertain"].includes(p.status));
        setCount(pending.length);
        const fresh = pending.filter(p => !seen.has(p.id));
        for (const proposal of fresh) seen.add(proposal.id);
        if (fresh.length) onOpen();
      } catch { /* A temporary disconnect must not interrupt the conversation. */ }
      finally { inFlight = false; }
    };
    const poll = async () => { await refresh(); if (!disposed) timer = setTimeout(poll, 5000); };
    const activate = () => void refresh();
    void poll(); window.addEventListener("focus", activate); document.addEventListener("visibilitychange", activate);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("focus", activate); document.removeEventListener("visibilitychange", activate); };
  }, [userId, threadId, onOpen]);
  return count;
}
