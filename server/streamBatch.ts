/** Coalesce replaceable snapshots only; ordered deltas themselves are never dropped. */
export class LatestTaskQueue {
  private pending = new Map<string, () => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly delayMs: number, private readonly onError: (error: unknown) => void = console.warn) {}
  enqueue(key: string, task: () => void, immediate = false): void {
    this.pending.set(key, task);
    if (immediate) { this.flush(key); return; }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.delayMs);
      this.timer.unref();
    }
  }
  flush(key?: string): void {
    const tasks = key === undefined ? [...this.pending.entries()] : this.pending.has(key) ? [[key, this.pending.get(key)!] as const] : [];
    for (const [id, task] of tasks) {
      this.pending.delete(id);
      try { task(); } catch (error) { this.onError(error); }
    }
    if (this.pending.size === 0 && this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }
  flushPrefix(prefix: string): void {
    for (const key of [...this.pending.keys()]) if (key.startsWith(prefix)) this.flush(key);
  }
}
