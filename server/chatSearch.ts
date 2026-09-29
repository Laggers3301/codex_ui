import path from "node:path";
import { Worker } from "node:worker_threads";
import { serverConfig } from "./config.js";
import type { ThreadOwner } from "./db.js";

export interface ChatSearchResponse {
  data: Array<Record<string, unknown>>;
  total: number;
  nextOffset: number | null;
  indexing: boolean;
  pendingThreads?: number;
  generation: number;
  indexError?: string | null;
}

export interface ChatThreadHitsResponse {
  data: Array<{ threadId: string; turnId: string; itemId: string; ordinal: number; query: string; snippet: string; cursor: string }>;
  total: number;
  indexing: boolean;
}

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

export function startChatSearch(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("./chatSearchWorker.mjs", import.meta.url), { workerData: {
    sourcePath: process.env.CODEX_THREAD_INDEX_DB ?? path.join(serverConfig.dataDir, "thread-events.sqlite"),
    searchPath: process.env.CODEX_CHAT_SEARCH_DB ?? path.join(serverConfig.dataDir, "chat-search.sqlite")
  } });
  worker = instance;
  instance.on("message", (message) => {
    if (message.warning) { console.warn("Chat search index:", message.warning); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  const failed = (error: Error) => {
    if (worker !== instance) return;
    worker = null;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  instance.on("error", failed);
  instance.on("exit", () => failed(new Error("Chat search worker stopped")));
  instance.unref();
  return instance;
}

export function searchChatThreads(owners: ThreadOwner[], query: string, options: { offset?: number; limit?: number } = {}, signal?: AbortSignal): Promise<ChatSearchResponse> {
  if (signal?.aborted) return Promise.reject(new Error("Search cancelled"));
  const instance = startChatSearch();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); pending.delete(id); };
    const abort = () => { finish(); reject(new Error("Search cancelled")); };
    const timer = setTimeout(() => { finish(); reject(new Error("Chat search timed out")); }, 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    pending.set(id, { resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); } });
    // The ownership boundary is resolved on the server, never supplied by clients.
    instance.postMessage({ id, owners: owners.map(({ threadId, projectId, rootPath, displayName, createdAt, updatedAt }) =>
      ({ threadId, projectId, rootPath, displayName, createdAt, updatedAt })), query, options });
  });
}

export function searchChatThreadHits(threadId: string, query: string, limit = 1000): Promise<ChatThreadHitsResponse> {
  const instance = startChatSearch();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Chat search timed out")); }, 15_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); pending.delete(id); resolve(value); },
      reject: error => { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    instance.postMessage({ id, type: "threadHits", threadId, query, limit });
  });
}
