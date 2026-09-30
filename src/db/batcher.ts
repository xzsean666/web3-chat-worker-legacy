import { chunkArray, D1_SAFE_BATCH_CHUNK } from './chunker';

export interface AutoBatchConfig {
  /**
   * Maximum number of write statements to accumulate before triggering an immediate batch flush.
   * Default: 100.
   */
  maxBatchSize?: number;

  /**
   * Maximum milliseconds to wait before flushing accumulated writes if maxBatchSize is not reached.
   * Default: 100ms.
   */
  maxWaitMs?: number;

  /**
   * Optional Cloudflare ExecutionContext to register background flushes with ctx.waitUntil().
   */
  ctx?: ExecutionContext;

  /**
   * Whether auto-batch is active.
   * Default: true.
   */
  enabled?: boolean;
}

export interface QueuedD1Statement {
  stmt: D1PreparedStatement;
  sql: string;
  resolve: (res: D1Result<any>) => void;
  reject: (err: unknown) => void;
}

const UNWRAPPED_STMT = Symbol('UNWRAPPED_STMT');

export function unwrapStatement(stmt: D1PreparedStatement): D1PreparedStatement {
  if (stmt && typeof stmt === 'object' && UNWRAPPED_STMT in stmt) {
    return (stmt as any)[UNWRAPPED_STMT];
  }
  return stmt;
}

/**
 * In-Memory Aggregating Micro-Batch Write Buffer for Cloudflare D1.
 *
 * Automatically coalesces concurrent discrete write operations (stmt.run())
 * occurring within the same Worker isolate and debounce window into atomic
 * db.batch() calls. Strict Read-Your-Own-Writes consistency is guaranteed by
 * automatically flushing pending writes before any subsequent read operation.
 */
export class D1WriteBatcher {
  private pending: QueuedD1Statement[] = [];
  private timer: any = null;
  private readonly maxBatchSize: number;
  private readonly maxWaitMs: number;
  private readonly ctx?: ExecutionContext;
  private isFlushing = false;
  private activeFlushPromise?: Promise<void>;

  constructor(
    private readonly rawDb: D1Database,
    config?: AutoBatchConfig
  ) {
    this.maxBatchSize = config?.maxBatchSize ?? 100;
    this.maxWaitMs = config?.maxWaitMs ?? 20;
    this.ctx = config?.ctx;
  }

  /**
   * Enqueues a write statement into the micro-batch buffer.
   * Returns a promise that resolves with the D1Result once the batch commits.
   */
  async enqueue<T = Record<string, unknown>>(
    stmt: D1PreparedStatement,
    sql: string
  ): Promise<D1Result<T>> {
    return new Promise<D1Result<T>>((resolve, reject) => {
      this.pending.push({
        stmt: unwrapStatement(stmt),
        sql,
        resolve: resolve as (res: D1Result<any>) => void,
        reject,
      });

      this.checkFlushConditions();
    });
  }

  private checkFlushConditions(): void {
    if (this.pending.length >= this.maxBatchSize) {
      void this.triggerFlush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.triggerFlush();
      }, this.maxWaitMs);

      // In Cloudflare Worker, register background flush promise with ctx.waitUntil
      if (this.ctx && typeof this.ctx.waitUntil === 'function') {
        this.ctx.waitUntil(this.waitForPendingDrain());
      }
    }
  }

  private async waitForPendingDrain(): Promise<void> {
    while (this.pending.length > 0 || this.isFlushing) {
      if (this.activeFlushPromise) {
        try {
          await this.activeFlushPromise;
        } catch {
          // Handled per individual statement
        }
      } else {
        await new Promise((r) => setTimeout(r, this.maxWaitMs));
      }
    }
  }

  private async triggerFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /**
   * Immediately flushes all queued writes to D1 in batch.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // 1. If currently flushing, wait for active flush to complete first
    if (this.isFlushing && this.activeFlushPromise) {
      await this.activeFlushPromise;
    }

    // 2. If nothing is pending after waiting, return cleanly
    if (this.pending.length === 0) {
      return;
    }

    this.isFlushing = true;
    const snapshot = this.pending;
    this.pending = [];

    this.activeFlushPromise = (async () => {
      try {
        const rawStatements = snapshot.map((item) => item.stmt);
        // Chunk statements to stay within safe D1 batch boundaries
        const chunks = chunkArray(rawStatements, D1_SAFE_BATCH_CHUNK);
        const allResults: D1Result<any>[] = [];

        for (const chunk of chunks) {
          const chunkResults = await this.rawDb.batch(chunk);
          allResults.push(...chunkResults);
        }

        for (let i = 0; i < snapshot.length; i++) {
          const item = snapshot[i];
          const result = allResults[i];
          item.resolve(result);
        }
      } catch (err) {
        for (const item of snapshot) {
          item.reject(err);
        }
      } finally {
        this.isFlushing = false;
        this.activeFlushPromise = undefined;

        // If more writes arrived during flush execution, schedule follow-up flush
        if (this.pending.length > 0) {
          if (this.pending.length >= this.maxBatchSize) {
            void this.triggerFlush();
          } else if (!this.timer) {
            this.timer = setTimeout(() => {
              this.timer = null;
              void this.triggerFlush();
            }, this.maxWaitMs);
          }
        }
      }
    })();

    await this.activeFlushPromise;
  }

  /**
   * Number of write statements currently queued in the buffer.
   */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Whether a batch flush is currently executing.
   */
  get isFlushingNow(): boolean {
    return this.isFlushing;
  }

  /**
   * Clears any buffered items without committing (rejects pending promises).
   */
  clear(error?: Error): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const err = error ?? new Error('D1 write buffer cleared');
    const items = this.pending;
    this.pending = [];
    for (const item of items) {
      item.reject(err);
    }
  }
}

export type AutoBatchD1Database = D1Database & {
  flush(): Promise<void>;
  isAutoBatch: true;
  pendingBatchCount: number;
  readonly rawDb: D1Database;
  readonly writeBatcher: D1WriteBatcher;
};

export function isAutoBatchD1(db: unknown): db is AutoBatchD1Database {
  return Boolean(db && typeof db === 'object' && (db as any).isAutoBatch === true);
}

/**
 * Creates a wrapped D1PreparedStatement that auto-batches mutation .run() calls
 * while maintaining strict Read-Your-Own-Writes consistency for read methods.
 */
function createWrappedStatement(
  rawStmt: D1PreparedStatement,
  sql: string,
  batcher: D1WriteBatcher,
  enabled: boolean
): D1PreparedStatement {
  const isMutation = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

  const wrapped: D1PreparedStatement = {
    bind(...values: unknown[]): D1PreparedStatement {
      const bound = rawStmt.bind(...values);
      return createWrappedStatement(bound, sql, batcher, enabled);
    },

    async first<T = unknown>(colName?: string): Promise<T | null> {
      // Read-Your-Own-Writes: flush any pending writes before reading
      if (batcher.pendingCount > 0 || batcher.isFlushingNow) {
        await batcher.flush();
      }
      return colName !== undefined ? rawStmt.first<T>(colName) : rawStmt.first<T>();
    },

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      if (enabled && isMutation) {
        return batcher.enqueue<T>(rawStmt, sql);
      }
      return rawStmt.run<T>();
    },

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      // Read-Your-Own-Writes: flush any pending writes before reading
      if (batcher.pendingCount > 0 || batcher.isFlushingNow) {
        await batcher.flush();
      }
      return rawStmt.all<T>();
    },

    async raw<T = unknown[]>(options?: any): Promise<any> {
      // Read-Your-Own-Writes: flush any pending writes before reading
      if (batcher.pendingCount > 0 || batcher.isFlushingNow) {
        await batcher.flush();
      }
      return rawStmt.raw<T>(options);
    },
  };

  (wrapped as any)[UNWRAPPED_STMT] = rawStmt;
  return wrapped;
}

/**
 * Wraps a D1Database instance with automatic in-memory micro-batching.
 *
 * All .run() mutations are coalesced in memory and flushed via db.batch().
 * All .first(), .all(), .raw(), .batch(), and .exec() queries trigger an immediate
 * pre-flush ensuring strict Read-Your-Own-Writes consistency.
 */
export function withAutoBatch(
  rawDb: D1Database,
  config?: AutoBatchConfig
): AutoBatchD1Database {
  if (isAutoBatchD1(rawDb)) {
    return rawDb;
  }

  const enabled = config?.enabled !== false;
  const batcher = new D1WriteBatcher(rawDb, config);

  const autoDb: AutoBatchD1Database = {
    isAutoBatch: true,

    get rawDb(): D1Database {
      return rawDb;
    },

    get writeBatcher(): D1WriteBatcher {
      return batcher;
    },

    get pendingBatchCount(): number {
      return batcher.pendingCount;
    },

    async flush(): Promise<void> {
      await batcher.flush();
    },

    prepare(query: string): D1PreparedStatement {
      const rawStmt = rawDb.prepare(query);
      return createWrappedStatement(rawStmt, query, batcher, enabled);
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      // Read-Your-Own-Writes: flush any prior pending writes first
      if (batcher.pendingCount > 0 || batcher.isFlushingNow) {
        await batcher.flush();
      }
      const unwrapped = statements.map(unwrapStatement);
      return rawDb.batch<T>(unwrapped);
    },

    async exec(query: string): Promise<D1ExecResult> {
      // Read-Your-Own-Writes: flush any prior pending writes first
      if (batcher.pendingCount > 0 || batcher.isFlushingNow) {
        await batcher.flush();
      }
      return rawDb.exec(query);
    },

    async dump(): Promise<ArrayBuffer> {
      if (batcher.pendingCount > 0 || batcher.isFlushingNow) {
        await batcher.flush();
      }
      return rawDb.dump();
    },

    withSession(bookmark?: string): any {
      if (typeof (rawDb as any).withSession === 'function') {
        const sessionDb = (rawDb as any).withSession(bookmark);
        return withAutoBatch(sessionDb, config);
      }
      return this;
    },
  };

  return autoDb;
}
