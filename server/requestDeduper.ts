/**
 * Coalesces retries for an idempotent client request.
 *
 * A request id must identify one logical operation for one user. Calls with
 * the same `{ userId, requestId }` receive the same promise, including its
 * eventual error. Completed promises remain available for `ttlMs`, which also
 * protects against a retry that arrives just after the first call completed.
 *
 * There are deliberately no timers: expired entries are discarded on the next
 * call to `run()` or `prune()`. This keeps the helper cheap when it is idle.
 */

export interface RequestDedupeKey {
  /** Stable authenticated user identifier, not a display name. */
  userId: string;
  /** Client-generated id which is unique for this user's logical request. */
  requestId: string;
}

export interface RequestDeduperOptions {
  /** How long a completed success or failure can be replayed. Defaults to 15 seconds. */
  ttlMs?: number;
  /** Maximum number of pending and completed requests retained. Defaults to 512. */
  maxEntries?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RunDedupedOptions {
  /**
   * Optional queue key for operations which must not overlap. It is scoped to
   * the user automatically, so equal values from separate users never block
   * one another. Requests with distinct request ids still run in order.
   */
  serializeKey?: string;
}

export interface RequestDeduperStats {
  entries: number;
  pending: number;
  settled: number;
  serialQueues: number;
}

export class RequestDeduperCapacityError extends Error {
  constructor(maxEntries: number) {
    super(`Request deduper is at its ${maxEntries}-request in-flight capacity.`);
    this.name = "RequestDeduperCapacityError";
  }
}

type EntryState = "pending" | "settled";

interface Entry {
  promise: Promise<unknown>;
  state: EntryState;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_MAX_ENTRIES = 512;

/**
 * In-memory idempotency helper for socket or HTTP request handlers.
 *
 * Example:
 *
 * ```ts
 * const result = await turnDeduper.run(
 *   { userId: session.userId, requestId: message.requestId },
 *   () => bridge.request("turn/start", params),
 *   { serializeKey: project.id }
 * );
 * ```
 */
export class RequestDeduper {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly serialTails = new Map<string, Promise<void>>();

  constructor(options: RequestDeduperOptions = {}) {
    this.ttlMs = readNonNegativeFinite(options.ttlMs, DEFAULT_TTL_MS, "ttlMs");
    this.maxEntries = readPositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
    this.now = options.now ?? Date.now;
  }

  /**
   * Runs `operation` once for this user's request id and returns the shared
   * promise to all duplicate callers. A cached failure is intentionally
   * replayed as well, preventing a network retry from issuing a second call.
   *
   * If every retained entry is still pending at capacity, a new distinct
   * request is rejected rather than evicting an in-flight operation and losing
   * its idempotency guarantee.
   */
  run<T>(
    key: RequestDedupeKey,
    operation: () => Promise<T> | T,
    options: RunDedupedOptions = {}
  ): Promise<T> {
    const entryKey = requestEntryKey(key);
    const now = this.now();
    this.prune(now);

    const existing = this.entries.get(entryKey);
    if (existing) {
      this.touch(entryKey, existing);
      return existing.promise as Promise<T>;
    }

    try {
      this.makeRoom();
    } catch (error) {
      // Keep `run()` consistently promise-based for normal request failures.
      return Promise.reject(error);
    }

    const entry: Entry = {
      // Replaced synchronously below before it can be observed by callers.
      promise: Promise.resolve(undefined),
      state: "pending",
      expiresAt: Number.POSITIVE_INFINITY
    };
    this.entries.set(entryKey, entry);

    const serialKey = options.serializeKey === undefined
      ? undefined
      : serializationKey(key.userId, options.serializeKey);
    const promise = serialKey
      ? this.enqueue(serialKey, operation)
      : Promise.resolve().then(operation);

    entry.promise = promise;
    promise.then(
      () => this.markSettled(entryKey, entry),
      () => this.markSettled(entryKey, entry)
    );
    return promise;
  }

  /** Removes completed entries whose TTL has elapsed and returns their count. */
  prune(now = this.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.state === "settled" && entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Returns a small snapshot suitable for diagnostics or a health endpoint. */
  stats(): RequestDeduperStats {
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "pending") {
        pending += 1;
      }
    }
    return {
      entries: this.entries.size,
      pending,
      settled: this.entries.size - pending,
      serialQueues: this.serialTails.size
    };
  }

  private markSettled(entryKey: string, entry: Entry): void {
    // The entry may already have been evicted after its TTL, so never restore it.
    if (this.entries.get(entryKey) !== entry) {
      return;
    }
    entry.state = "settled";
    entry.expiresAt = this.now() + this.ttlMs;
  }

  private makeRoom(): void {
    while (this.entries.size >= this.maxEntries) {
      const settledKey = this.oldestSettledKey();
      if (!settledKey) {
        throw new RequestDeduperCapacityError(this.maxEntries);
      }
      this.entries.delete(settledKey);
    }
  }

  private oldestSettledKey(): string | undefined {
    for (const [key, entry] of this.entries) {
      if (entry.state === "settled") {
        return key;
      }
    }
    return undefined;
  }

  private touch(entryKey: string, entry: Entry): void {
    // Map insertion order doubles as an inexpensive LRU order for capacity trims.
    this.entries.delete(entryKey);
    this.entries.set(entryKey, entry);
  }

  private enqueue<T>(serialKey: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.serialTails.get(serialKey) ?? Promise.resolve();
    // `serialTails` normally stores fulfilled promises, but absorb a rejection
    // defensively so one failed request never blocks the rest of its queue.
    const promise = previous.then(
      () => operation(),
      () => operation()
    );
    const tail = promise.then(
      () => undefined,
      () => undefined
    );
    this.serialTails.set(serialKey, tail);
    tail.then(() => {
      if (this.serialTails.get(serialKey) === tail) {
        this.serialTails.delete(serialKey);
      }
    });
    return promise;
  }
}

function requestEntryKey(key: RequestDedupeKey): string {
  return JSON.stringify([
    requireNonEmptyString(key.userId, "userId"),
    requireNonEmptyString(key.requestId, "requestId")
  ]);
}

function serializationKey(userId: string, value: string): string {
  return JSON.stringify([
    requireNonEmptyString(userId, "userId"),
    requireNonEmptyString(value, "serializeKey")
  ]);
}

function requireNonEmptyString(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function readNonNegativeFinite(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a finite number greater than or equal to zero.`);
  }
  return resolved;
}

function readPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}
