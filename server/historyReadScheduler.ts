import { getHeapStatistics } from 'node:v8';
import { AppError } from './appErrors.js';

/** Reserve room for buffers, decoded strings, parsed objects and responses.
 * Admission affects reads only; never retry/replay a model turn to free memory. */
export function assertHistoryHeapHeadroom(estimatedBytes = 32 * 1024 * 1024, heap = getHeapStatistics()): void {
  if (heap.heap_size_limit - heap.used_heap_size < 64 * 1024 * 1024 + estimatedBytes * 4) {
    throw new AppError('memory_pressure', '历史读取暂时繁忙，请稍后重试。', '后端堆内存余量不足，本次未读取重历史；对话记录未修改。', false, 'resource');
  }
}

/** Index readiness may involve slow IO or a different thread's index writer.
 * Keep that wait outside the one-at-a-time memory-bounded history parser. */
export class HistoryReadScheduler {
  private queue: Promise<void> = Promise.resolve();

  async run<T>(prepare: () => Promise<void>, read: () => Promise<T>): Promise<T> {
    assertHistoryHeapHeadroom();
    await prepare();
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    const queuedAt = Date.now();
    await previous;
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs >= 2000) console.warn('[history.page.queue_wait]', JSON.stringify({ waitedMs }));
    try { assertHistoryHeapHeadroom(); return await read(); } finally { release(); }
  }
}
