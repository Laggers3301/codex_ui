/** Index readiness may involve slow IO or a different thread's index writer.
 * Keep that wait outside the one-at-a-time memory-bounded history parser. */
export class HistoryReadScheduler {
  private queue: Promise<void> = Promise.resolve();

  async run<T>(prepare: () => Promise<void>, read: () => Promise<T>): Promise<T> {
    await prepare();
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    const queuedAt = Date.now();
    await previous;
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs >= 2000) console.warn('[history.page.queue_wait]', JSON.stringify({ waitedMs }));
    try { return await read(); } finally { release(); }
  }
}
