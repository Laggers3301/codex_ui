import type { DatabaseSync } from "node:sqlite";

/** Bounded synchronous commits. Never keep a transaction open across await. */
export class HistoryWriteBatch<T> {
  private pending: T[] = [];
  private bytes = 0;
  constructor(private db: DatabaseSync, private write: (item: T) => void) {}
  add(item: T, bytes: number): number {
    let committed = this.pending.length && this.bytes + bytes > 1024 * 1024 ? this.flush() : 0;
    this.pending.push(item); this.bytes += bytes;
    if (this.pending.length >= 128 || this.bytes >= 1024 * 1024) committed += this.flush();
    return committed;
  }
  flush(): number {
    if (!this.pending.length) return 0;
    this.db.exec("SAVEPOINT history_write_batch");
    try {
      for (const item of this.pending) this.write(item);
      this.db.exec("RELEASE history_write_batch");
      const count = this.pending.length; this.pending = []; this.bytes = 0;
      return count;
    } catch (error) {
      this.db.exec("ROLLBACK TO history_write_batch; RELEASE history_write_batch");
      throw error;
    }
  }
}
