import { useCallback, useEffect, useRef, useState } from "react";
import { markUiUpdatesSeen, readUiUpdates } from "./api";
import "./AccountUpdateIndicator.css";

interface AccountUpdateIndicatorProps {
  userId: string;
  menuOpen: boolean;
  target?: "account" | "plugins" | "feishu";
  dismissOnRefresh?: boolean;
}

function seenStorageKey(userId: string, version: string): string {
  return `codex-web-ui-update-seen:${encodeURIComponent(userId)}:${encodeURIComponent(version)}`;
}

function wasSeenLocally(userId: string, version: string): boolean {
  try {
    return window.localStorage.getItem(seenStorageKey(userId, version)) === "1";
  } catch {
    return false;
  }
}

function rememberSeen(userId: string, version: string): void {
  try {
    window.localStorage.setItem(seenStorageKey(userId, version), "1");
  } catch {
    // The server remains authoritative when browser storage is unavailable.
  }
}

export function AccountUpdateIndicator({ userId: rawUserId, menuOpen, target = "account", dismissOnRefresh = false }: AccountUpdateIndicatorProps) {
  const userId = rawUserId;
  const localUserId = target === "account" ? userId : `${userId}:${target}`;
  const [visible, setVisible] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const dismissedRef = useRef(false);
  const hasUnseenRef = useRef(false);
  const acknowledgedRef = useRef(new Set<string>());
  const pendingControllersRef = useRef(new Set<AbortController>());

  const acknowledge = useCallback((nextVersion: string) => {
    if (acknowledgedRef.current.has(nextVersion)) return;
    acknowledgedRef.current.add(nextVersion);
    rememberSeen(localUserId, nextVersion);
    hasUnseenRef.current = false;
    setVisible(false);
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    void markUiUpdatesSeen(userId, nextVersion, controller.signal, target).then((state) => {
      if (controller.signal.aborted || state.version === nextVersion) return;
      // The server may have advanced while the ACK was in flight. Never let an
      // acknowledgement for the old version hide that newer update.
      setVersion(state.version);
      hasUnseenRef.current = state.hasUnseen;
      if (state.hasUnseen && wasSeenLocally(localUserId, state.version)) {
        acknowledge(state.version);
      } else {
        setVisible(state.hasUnseen);
        if (state.hasUnseen && dismissOnRefresh) {
          // Keep this display visible, but do not repeat it on the next refresh.
          rememberSeen(localUserId, state.version);
          void markUiUpdatesSeen(userId, state.version, controller.signal, target).catch(() => {});
        }
      }
    }).catch(() => {
      // Keep the optimistic local acknowledgement; a future GET can retry it.
    }).finally(() => pendingControllersRef.current.delete(controller));
  }, [userId, localUserId, target]);

  useEffect(() => {
    const controller = new AbortController();
    void readUiUpdates(userId, controller.signal, target).then((state) => {
      if (controller.signal.aborted) return;
      setVersion(state.version);
      hasUnseenRef.current = state.hasUnseen;
      const alreadySeen = wasSeenLocally(localUserId, state.version);
      if (state.hasUnseen && (alreadySeen || dismissedRef.current)) {
        acknowledge(state.version);
      } else {
        setVisible(state.hasUnseen);
        if (state.hasUnseen && dismissOnRefresh) {
          // This first display remains visible; a click or subsequent reload
          // must not show the same release at this entry again.
          rememberSeen(localUserId, state.version);
          void markUiUpdatesSeen(userId, state.version, controller.signal, target).catch(() => {});
        }
      }
    }).catch(() => {
      // The indicator is non-blocking and can retry on the next mount.
    });
    return () => controller.abort();
  }, [userId, localUserId, target, acknowledge, dismissOnRefresh]);

  useEffect(() => {
    if (!menuOpen) return;
    dismissedRef.current = true;
    if (version && hasUnseenRef.current) acknowledge(version);
  }, [menuOpen, version, acknowledge]);

  useEffect(() => () => {
    for (const controller of pendingControllersRef.current) controller.abort();
    pendingControllersRef.current.clear();
  }, []);

  return <span className="accountUpdateIndicator" aria-hidden="true" data-visible={visible ? "true" : "false"} />;
}
