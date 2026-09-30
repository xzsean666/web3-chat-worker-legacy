import { describe, it, expect, vi } from 'vitest';
import { createMockD1Database, MockD1Database } from './helpers/db';
import {
  D1WriteBatcher,
  withAutoBatch,
  isAutoBatchD1,
  unwrapStatement,
  chunkArray,
  chunkByParamCount,
  buildInClausePlaceholders,
  buildMultiRowPlaceholders,
  assertD1ParamLimit,
  D1LimitError,
} from '../src/db';

describe('D1WriteBatcher & Auto-Batching Engine', () => {
  it('correctly defaults maxWaitMs to 20ms and maxBatchSize to 100', () => {
    const rawDb = createMockD1Database();
    const batcher = new D1WriteBatcher(rawDb);
    expect((batcher as any).maxWaitMs).toBe(20);
    expect((batcher as any).maxBatchSize).toBe(100);
    expect(batcher.pendingCount).toBe(0);
    expect(batcher.isFlushingNow).toBe(false);
  });

  it('coalesces multiple concurrent stmt.run() calls into a single db.batch()', async () => {
    const rawDb = createMockD1Database(true);
    const batchSpy = vi.spyOn(rawDb, 'batch');

    const db = withAutoBatch(rawDb, { maxWaitMs: 50 });
    expect(isAutoBatchD1(db)).toBe(true);

    const now = Date.now();
    // 3 concurrent write operations
    const p1 = db
      .prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind('u_batch_1', '0x111', now, now)
      .run();

    const p2 = db
      .prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind('u_batch_2', '0x222', now, now)
      .run();

    const p3 = db
      .prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind('u_batch_3', '0x333', now, now)
      .run();

    // In memory, 3 statements are buffered before flush
    expect(db.pendingBatchCount).toBe(3);

    const results = await Promise.all([p1, p2, p3]);

    // All 3 resolved with D1Result
    expect(results).toHaveLength(3);
    expect(results[0].meta.changes).toBe(1);
    expect(results[1].meta.changes).toBe(1);
    expect(results[2].meta.changes).toBe(1);

    // Buffer is drained
    expect(db.pendingBatchCount).toBe(0);

    // D1 received only 1 batch call containing all 3 statements
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const statementsExecuted = batchSpy.mock.calls[0][0];
    expect(statementsExecuted).toHaveLength(3);

    // Verify all 3 users exist in the database
    const users = await rawDb.prepare('SELECT id FROM users WHERE id LIKE ?').bind('u_batch_%').all();
    expect(users.results).toHaveLength(3);
  });

  it('immediately flushes when pending count reaches maxBatchSize', async () => {
    const rawDb = createMockD1Database(true);
    const batchSpy = vi.spyOn(rawDb, 'batch');

    // Configure maxBatchSize to 3
    const db = withAutoBatch(rawDb, { maxBatchSize: 3, maxWaitMs: 5000 });

    const now = Date.now();
    const p1 = db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_lim_1', '0xaa1', now, now).run();
    const p2 = db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_lim_2', '0xaa2', now, now).run();

    // 2 statements pending, maxBatchSize 3 not reached yet
    expect(db.pendingBatchCount).toBe(2);
    expect(batchSpy).not.toHaveBeenCalled();

    // 3rd statement hits threshold -> triggers flush immediately
    const p3 = db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_lim_3', '0xaa3', now, now).run();

    await Promise.all([p1, p2, p3]);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(db.pendingBatchCount).toBe(0);
  });

  it('strictly preserves Read-Your-Own-Writes (RYOW) on first(), all(), and raw()', async () => {
    const rawDb = createMockD1Database(true);
    const batchSpy = vi.spyOn(rawDb, 'batch');

    const db = withAutoBatch(rawDb, { maxWaitMs: 1000 });
    const now = Date.now();

    // 1. Enqueue write (not yet flushed by timer)
    const writePromise = db
      .prepare('INSERT INTO users (id, wallet_address, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('u_ryow', '0xryow', 'ryow_user', now, now)
      .run();

    expect(db.pendingBatchCount).toBe(1);

    // 2. Read query BEFORE timer fires: must trigger pre-flush and see newly inserted record
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind('u_ryow').first<{ username: string }>();

    await writePromise;

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(db.pendingBatchCount).toBe(0);
    expect(user).not.toBeNull();
    expect(user?.username).toBe('ryow_user');
  });

  it('strictly preserves Read-Your-Own-Writes on all() and raw()', async () => {
    const rawDb = createMockD1Database(true);
    const db = withAutoBatch(rawDb, { maxWaitMs: 1000 });
    const now = Date.now();

    void db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_all_1', '0xall1', now, now).run();
    void db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_all_2', '0xall2', now, now).run();

    expect(db.pendingBatchCount).toBe(2);

    const res = await db.prepare('SELECT id FROM users WHERE id LIKE ?').bind('u_all_%').all<{ id: string }>();
    expect(res.results).toHaveLength(2);
    expect(db.pendingBatchCount).toBe(0);

    // Now test raw()
    void db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_raw_1', '0xraw1', now, now).run();
    expect(db.pendingBatchCount).toBe(1);

    const rawRows = await db.prepare('SELECT id FROM users WHERE id = ?').bind('u_raw_1').raw();
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0][0]).toBe('u_raw_1');
    expect(db.pendingBatchCount).toBe(0);
  });

  it('flushes pending queue before explicit db.batch() and executes atomically', async () => {
    const rawDb = createMockD1Database(true);
    const db = withAutoBatch(rawDb, { maxWaitMs: 1000 });
    const now = Date.now();

    // Enqueue a background write
    void db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_pre', '0xpre', now, now).run();
    expect(db.pendingBatchCount).toBe(1);

    // Call explicit db.batch() with wrapped statements
    const s1 = db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_b1', '0xb1', now, now);
    const s2 = db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_b2', '0xb2', now, now);

    const batchRes = await db.batch([s1, s2]);
    expect(batchRes).toHaveLength(2);
    expect(db.pendingBatchCount).toBe(0);

    // Both the pre-queued write and the explicit batch items exist
    const uPre = await db.prepare('SELECT id FROM users WHERE id = ?').bind('u_pre').first();
    const uB1 = await db.prepare('SELECT id FROM users WHERE id = ?').bind('u_b1').first();
    const uB2 = await db.prepare('SELECT id FROM users WHERE id = ?').bind('u_b2').first();
    expect(uPre).not.toBeNull();
    expect(uB1).not.toBeNull();
    expect(uB2).not.toBeNull();
  });

  it('propagates database batch errors to all coalesced promises', async () => {
    const rawDb = createMockD1Database(true);
    vi.spyOn(rawDb, 'batch').mockRejectedValueOnce(new Error('D1 Disk I/O Failure'));

    const db = withAutoBatch(rawDb, { maxWaitMs: 50 });
    const now = Date.now();

    const p1 = db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('err_1', '0xe1', now, now).run();
    const p2 = db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('err_2', '0xe2', now, now).run();

    await expect(p1).rejects.toThrow('D1 Disk I/O Failure');
    await expect(p2).rejects.toThrow('D1 Disk I/O Failure');

    // Ensure queue recovers after failure
    expect(db.pendingBatchCount).toBe(0);
    expect(db.writeBatcher.isFlushingNow).toBe(false);
  });

  it('registers background drain promise with ctx.waitUntil()', async () => {
    const rawDb = createMockD1Database(true);
    const waitUntilSpy = vi.fn();
    const mockCtx = {
      waitUntil: waitUntilSpy,
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const db = withAutoBatch(rawDb, { ctx: mockCtx, maxWaitMs: 20 });
    const now = Date.now();

    void db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u_ctx', '0xctx', now, now).run();

    expect(waitUntilSpy).toHaveBeenCalledTimes(1);

    await db.flush();
    expect(db.pendingBatchCount).toBe(0);
  });

  it('is idempotent when wrapping an already-wrapped database', () => {
    const rawDb = createMockD1Database(true);
    const autoDb1 = withAutoBatch(rawDb);
    const autoDb2 = withAutoBatch(autoDb1);
    expect(autoDb1).toBe(autoDb2);
    expect(autoDb2.rawDb).toBe(rawDb);
  });

  it('unwrapStatement returns underlying statement or original', () => {
    const rawDb = createMockD1Database(true);
    const autoDb = withAutoBatch(rawDb);
    const wrapped = autoDb.prepare('SELECT 1');
    const raw = unwrapStatement(wrapped);
    expect(raw).not.toBe(wrapped);
    expect(unwrapStatement(raw)).toBe(raw);
  });

  it('automatically routes standard db.prepare().run() written in future features through auto-batch', async () => {
    const rawDb = createMockD1Database(true);
    const batchSpy = vi.spyOn(rawDb, 'batch');
    const db = withAutoBatch(rawDb, { maxWaitMs: 30 });

    // Developer writes ordinary D1 code for a new feature without knowing about batcher:
    async function developerFutureFeatureService(database: D1Database) {
      const now = Date.now();
      await database.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('new_user', '0xnew', now, now).run();
      await database.prepare('UPDATE users SET username = ? WHERE id = ?').bind('developer_nick', 'new_user').run();
      return database.prepare('SELECT username FROM users WHERE id = ?').bind('new_user').first<{ username: string }>();
    }

    const res = await developerFutureFeatureService(db);
    expect(res?.username).toBe('developer_nick');

    // Both writes were automatically coalesced and batched!
    expect(batchSpy).toHaveBeenCalled();
  });

  it('supports db.prepare(sql).run() without bind() through auto-batch', async () => {
    const rawDb = createMockD1Database(true);
    const batchSpy = vi.spyOn(rawDb, 'batch');
    const db = withAutoBatch(rawDb, { maxWaitMs: 30 });

    // Write statement without bind parameters
    await db.prepare("INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('u_nobind', '0xnobind', 1000, 1000)").run();

    const row = await db.prepare("SELECT id FROM users WHERE id = 'u_nobind'").first<{ id: string }>();
    expect(row?.id).toBe('u_nobind');
    expect(batchSpy).toHaveBeenCalled();
  });
});

describe('Chunker Utilities', () => {
  it('chunkArray splits items into correct chunk sizes', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(chunkArray(items, 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(chunkArray([], 5)).toEqual([]);
    expect(() => chunkArray(items, 0)).toThrow('chunkSize must be greater than 0');
  });

  it('chunkByParamCount chunks items to stay below parameter thresholds', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    // 6 params per item, maxParams 18 -> 3 items per chunk
    const chunks = chunkByParamCount(items, 6, 18);
    expect(chunks).toEqual([['a', 'b', 'c'], ['d', 'e', 'f'], ['g']]);
  });

  it('chunkByParamCount throws D1LimitError if maxParams exceeds 100', () => {
    expect(() => chunkByParamCount([1], 5, 105)).toThrow(D1LimitError);
    expect(() => chunkByParamCount([1], 90, 80)).toThrow(D1LimitError);
  });

  it('buildInClausePlaceholders generates correct placeholder strings', () => {
    expect(buildInClausePlaceholders(0)).toBe('()');
    expect(buildInClausePlaceholders(1)).toBe('(?)');
    expect(buildInClausePlaceholders(3)).toBe('(?, ?, ?)');
  });

  it('buildMultiRowPlaceholders generates correct multi-row placeholders', () => {
    expect(buildMultiRowPlaceholders(0, 3)).toBe('');
    expect(buildMultiRowPlaceholders(2, 3)).toBe('(?, ?, ?), (?, ?, ?)');
  });

  it('assertD1ParamLimit validates parameter counts against D1 limit', () => {
    expect(() => assertD1ParamLimit(80)).not.toThrow();
    expect(() => assertD1ParamLimit(100)).not.toThrow();
    expect(() => assertD1ParamLimit(101)).toThrow(D1LimitError);
  });
});
