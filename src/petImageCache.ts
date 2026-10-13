import { isValidAtlasSize, isValidLaughStripSize } from "./petSprite";

export type PetImageSource = { url: string; kind: "atlas" | "laugh"; version: 1 | 2 };
type Loader = (source: PetImageSource, signal: AbortSignal) => Promise<HTMLImageElement>;
type Entry = { source: PetImageSource; controller: AbortController; promise: Promise<HTMLImageElement>; pins: number };

function loadDecodedImage(source: PetImageSource, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      image.onload = image.onerror = null;
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(image);
    };
    const abort = () => { finish(new DOMException("Pet image request cancelled", "AbortError")); image.src = ""; };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    image.onerror = () => finish(new Error("宠物动画加载失败，请重新选择或稍后重试。"));
    image.onload = () => {
      const valid = source.kind === "laugh"
        ? isValidLaughStripSize(image.naturalWidth, image.naturalHeight)
        : isValidAtlasSize(image.naturalWidth, image.naturalHeight, source.version);
      if (!valid) { finish(new Error("宠物动画图集尺寸不正确。")); return; }
      // Decode off the paint path: a successful download alone does not mean
      // the multi-megapixel atlas is ready for the first canvas frame.
      void image.decode().then(() => finish(), () => finish(new Error("宠物动画解码失败，请稍后重试。")));
    };
    image.src = source.url;
  });
}

/** Instance-scoped LRU: no decoded image survives a login/user change. */
export function createPetImageCache(limit = 3, loader: Loader = loadDecodedImage) {
  const entries = new Map<string, Entry>();
  const keyFor = (source: PetImageSource) => `${source.kind}:${source.version}:${source.url}`;
  const trim = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= limit) break;
      if (entry.pins) continue;
      entries.delete(key);
      entry.controller.abort();
    }
  };
  const entryFor = (source: PetImageSource, pin: boolean) => {
    const key = keyFor(source);
    let entry = entries.get(key);
    if (entry) entries.delete(key);
    else {
      const controller = new AbortController();
      entry = { source, controller, pins: 0, promise: loader(source, controller.signal) };
      const created = entry;
      void entry.promise.catch(() => { if (entries.get(key) === created) entries.delete(key); });
    }
    if (pin) entry.pins++;
    entries.set(key, entry);
    trim();
    return entry;
  };
  return {
    acquire(source: PetImageSource) {
      const entry = entryFor(source, true);
      let released = false;
      return { promise: entry.promise, release: () => { if (released) return; released = true; entry.pins--; trim(); } };
    },
    preload(source: PetImageSource) {
      // Never evict a visible/pending foreground request just to prefetch.
      if (entries.size >= limit && [...entries.values()].every(entry => entry.pins)) return;
      void entryFor(source, false).promise.catch(() => {});
    },
    clear() { for (const entry of entries.values()) entry.controller.abort(); entries.clear(); },
  };
}

export type PetImageCache = ReturnType<typeof createPetImageCache>;
