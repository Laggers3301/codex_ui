import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createSideChat, deleteSideChat, readSideChat, readThread, saveSideChatDraft } from "./api";
import { SideChatController, sideChatKey } from "./sideChats";

export function useBoundSideChats(userId: string, projectId: string | undefined, parentThreadId: string | undefined, onError: (error: string) => void) {
  const errorRef = useRef(onError); errorRef.current = onError;
  const [controller] = useState(() => new SideChatController({ read: readSideChat, create: createSideChat,
    remove: deleteSideChat, save: saveSideChatDraft,
    readThread: async (threadId, project) => (await readThread(threadId, project, { fresh: true, limit: 128 })).thread
  }, error => errorRef.current(error)));
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const key = parentThreadId && projectId ? sideChatKey(userId, parentThreadId) : null;
  controller.activeKey = key;
  useEffect(() => {
    if (projectId && parentThreadId) void controller.load(userId, projectId, parentThreadId);
    return () => { if (key) void controller.flush(key); };
  }, [controller, userId, projectId, parentThreadId, key]);
  useEffect(() => {
    const flush = () => controller.flushAll(true);
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [controller]);
  const session = parentThreadId && projectId ? controller.get(userId, parentThreadId) : null;
  return { controller, session: session?.record.projectId === projectId ? session : null };
}
