import { describe, expect, it, vi } from "vitest";
import { createPetImageCache, type PetImageSource } from "./petImageCache";

const source = (name: string): PetImageSource => ({ url: `/pets/${name}`, kind: "atlas", version: 2 });
const image = (name: string) => ({ src: name }) as HTMLImageElement;

describe("pet decoded image cache", () => {
  it("deduplicates prefetch and foreground loads and reuses decoded images", async () => {
    const loader = vi.fn(async (input: PetImageSource) => image(input.url));
    const cache = createPetImageCache(3, loader);
    cache.preload(source("a"));
    const first = cache.acquire(source("a"));
    const ready = await first.promise;
    first.release();
    const again = cache.acquire(source("a"));
    expect(await again.promise).toBe(ready);
    expect(loader).toHaveBeenCalledTimes(1);
    again.release(); cache.clear();
  });

  it("bounds recent entries without aborting a pinned visible request", async () => {
    const signals = new Map<string, AbortSignal>();
    const loader = vi.fn(async (input: PetImageSource, signal: AbortSignal) => {
      signals.set(input.url, signal); return image(input.url);
    });
    const cache = createPetImageCache(3, loader);
    const visible = cache.acquire(source("a")); await visible.promise;
    cache.preload(source("b")); cache.preload(source("c")); cache.preload(source("d"));
    expect(signals.get("/pets/b")?.aborted).toBe(true);
    expect(signals.get("/pets/a")?.aborted).toBe(false);
    const same = cache.acquire(source("a")); await same.promise;
    expect(loader).toHaveBeenCalledTimes(4);
    same.release(); visible.release(); cache.clear();
    expect([...signals.values()].every(signal => signal.aborted)).toBe(true);
  });

  it("evicts rejected entries so retry is not stuck on a failed promise", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(image("a"));
    const cache = createPetImageCache(3, loader);
    const first = cache.acquire(source("a"));
    await expect(first.promise).rejects.toThrow("offline"); first.release();
    const retry = cache.acquire(source("a"));
    await expect(retry.promise).resolves.toEqual(image("a"));
    expect(loader).toHaveBeenCalledTimes(2);
    retry.release(); cache.clear();
  });

  it("separates image kinds/versions and clears all data on a user change", async () => {
    const loader = vi.fn(async (input: PetImageSource) => image(input.kind));
    const cache = createPetImageCache(3, loader);
    const a = cache.acquire(source("a")); await a.promise; a.release();
    const laugh = cache.acquire({ ...source("a"), kind: "laugh" }); await laugh.promise; laugh.release();
    const v1 = cache.acquire({ ...source("a"), version: 1 }); await v1.promise; v1.release();
    expect(loader).toHaveBeenCalledTimes(3);
    cache.clear();
    const refreshed = cache.acquire(source("a")); await refreshed.promise;
    expect(loader).toHaveBeenCalledTimes(4);
    refreshed.release(); cache.clear();
  });

  it("does not duplicate prefetches or evict pinned foreground consumers", async () => {
    const loader = vi.fn(async (input: PetImageSource) => image(input.url));
    const cache = createPetImageCache(1, loader);
    const a = cache.acquire(source("a")); await a.promise;
    cache.preload(source("b"));
    expect(loader).toHaveBeenCalledTimes(1);
    a.release(); cache.preload(source("b"));
    expect(loader).toHaveBeenCalledTimes(2);
    cache.clear();
  });
});
