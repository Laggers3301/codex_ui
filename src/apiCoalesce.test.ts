// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type * as Api from "./api";

// Node 25 ships its own incomplete localStorage global; give api.ts a plain one before it loads.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
const { listModels, readReclaudeUsage, savePushSubscription } = await import("./api") as typeof Api;

afterEach(() => vi.unstubAllGlobals());
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

it("shares one request between identical concurrent reads and hands every caller an independent copy", async () => {
  const fetchMock = vi.fn(async () => { await new Promise(r => setTimeout(r, 5)); return response({ data: [{ id: "m" }] }); });
  vi.stubGlobal("fetch", fetchMock);
  const [a, b, c] = await Promise.all([listModels(), listModels(), listModels()]) as any[];
  expect(fetchMock).toHaveBeenCalledTimes(1);
  a.data[0].id = "mutated";
  expect(b.data[0].id).toBe("m"); expect(c.data[0].id).toBe("m");
  // Once settled, the next read is a fresh request.
  await listModels(); expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps abort semantics per caller and cancels the shared request only when nobody is left", async () => {
  let seen: AbortSignal | undefined;
  const fetchMock = vi.fn((_: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    seen = init.signal as AbortSignal;
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    setTimeout(() => resolve(response({ data: { ok: true } })), 30);
  }));
  vi.stubGlobal("fetch", fetchMock);
  const first = new AbortController(), second = new AbortController();
  const p1 = readReclaudeUsage(first.signal), p2 = readReclaudeUsage(second.signal);
  first.abort();
  await expect(p1).rejects.toMatchObject({ name: "AbortError" });
  expect(seen?.aborted).toBe(false);
  await expect(p2).resolves.toEqual({ data: { ok: true } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const third = new AbortController(), fourth = new AbortController();
  const p3 = readReclaudeUsage(third.signal), p4 = readReclaudeUsage(fourth.signal);
  third.abort(); fourth.abort();
  await expect(p3).rejects.toMatchObject({ name: "AbortError" }); await expect(p4).rejects.toMatchObject({ name: "AbortError" });
  expect(seen?.aborted).toBe(true);
});

it("never merges writes, and propagates HTTP errors to every sharer", async () => {
  const post = vi.fn(async () => response({ ok: true }));
  vi.stubGlobal("fetch", post);
  await Promise.all([savePushSubscription({ endpoint: "e", keys: { p256dh: "a", auth: "b" } }), savePushSubscription({ endpoint: "e", keys: { p256dh: "a", auth: "b" } })]);
  expect(post).toHaveBeenCalledTimes(2);
  const failing = vi.fn(async () => response({ error: "boom" }, 500));
  vi.stubGlobal("fetch", failing);
  const results = await Promise.allSettled([listModels(), listModels()]);
  expect(failing).toHaveBeenCalledTimes(1);
  expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
  expect((results[1] as PromiseRejectedResult).reason.message).toBe("boom");
});
