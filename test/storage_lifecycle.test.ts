import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import worker, { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { countPendingCleanup, runStorageLifecycle } from '../src/services/storageLifecycle';
import type { Env } from '../src/types';

const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'test-internal-secret';

let db: D1Database;
let r2: MockR2Bucket;
let env: Env;
let now: number;

async function count(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
}

async function insertSession(id: string, expiresAt: number) {
  await db
    .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, 'u1', `hash-${id}`, expiresAt, now - 40 * DAY)
    .run();
}

async function insertNonce(id: string, expiresAt: number) {
  await db
    .prepare('INSERT INTO nonces (id, wallet_address, nonce, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, '0x1', `nonce-${id}`, expiresAt, now - 40 * DAY)
    .run();
}

async function insertJoinRequest(id: string, status: string, createdAt: number, handledAt: number | null, userId = 'u1') {
  await db
    .prepare(
      'INSERT INTO group_join_requests (id, group_id, user_id, wallet_address, status, created_at, handled_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(id, 'g1', userId, '0x1', status, createdAt, handledAt)
    .run();
}

async function insertInviteLink(
  token: string,
  opts: { expiresAt: number | null; maxUses: number | null; usesCount: number; createdAt: number }
) {
  await db
    .prepare(
      'INSERT INTO group_invite_links (token, group_id, created_by, expires_at, max_uses, uses_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(token, 'g1', 'u1', opts.expiresAt, opts.maxUses, opts.usesCount, opts.createdAt)
    .run();
}

async function insertEvidence(objectKey: string, reportId: string | null, createdAt: number) {
  await db
    .prepare(
      'INSERT INTO report_evidence (object_key, uploaded_by, report_id, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(objectKey, 'u1', reportId, 'image/png', 128, createdAt)
    .run();
}

async function insertFeedPost(id: string, images: string[], isDeleted: number, createdAt: number, video: string | null = null) {
  await db
    .prepare(
      'INSERT INTO feed_posts (id, author_id, content, images, like_count, is_deleted, created_at, video) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
    )
    .bind(id, 'u1', 'content', JSON.stringify(images), isDeleted, createdAt, video)
    .run();
}

async function insertOrder(id: string) {
  const iso = new Date(now).toISOString();
  await db
    .prepare(
      `INSERT INTO payment_orders (id, wallet_address, kind, amount, list_amount, chain_id, token_type, token_symbol, token_decimals, recipient_address, config_version, status, expires_at, created_at, updated_at)
       VALUES (?, ?, 'membership_month', '100', '100', 56, 'native', 'BNB', 18, '0x1111111111111111111111111111111111111111', 1, 'verified', ?, ?, ?)`
    )
    .bind(id, '0x1', iso, iso, iso)
    .run();
}

async function insertOutbox(id: number, status: string, updatedAtIso: string) {
  await db
    .prepare(
      'INSERT INTO payment_outbox (id, kind, ref_key, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(id, 'wallet_snapshot', `ref-${id}`, '{}', status, updatedAtIso, updatedAtIso)
    .run();
}

async function insertVerifyAttempt(orderId: string, createdAtIso: string) {
  await db
    .prepare('INSERT INTO payment_verify_attempts (order_id, result, created_at) VALUES (?, ?, ?)')
    .bind(orderId, 'ok', createdAtIso)
    .run();
}

async function insertClubApplication(id: string, status: string, handledAt: number | null, createdAt: number) {
  await db
    .prepare(
      'INSERT INTO club_applications (id, applicant_id, name, status, handled_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(id, 'u1', `club-${id}`, status, handledAt, createdAt)
    .run();
}

function sign(method: string, path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const message = `${ts}\n${nonce}\n${method}\n${path}\n${bodyHash}`;
  const signature = createHmac('sha256', SECRET).update(message).digest('hex');
  return {
    'X-Internal-Timestamp': ts,
    'X-Internal-Nonce': nonce,
    'X-Internal-Signature': signature,
  };
}

async function callAdmin(method: string, path: string, body?: unknown): Promise<Response> {
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = sign(method, path, bodyStr);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, { method, headers, body: body === undefined ? undefined : bodyStr }, env);
}

async function seedAllStaleRows() {
  // sessions：过期 8 天（过 7 天宽限 → 删）；过期 6 天（宽限内 → 留）；未过期（留）
  await insertSession('s_expired_old', now - 8 * DAY);
  await insertSession('s_expired_grace', now - 6 * DAY);
  await insertSession('s_active', now + DAY);

  // nonces：过期即删；未过期留
  await insertNonce('n_expired', now - 1000);
  await insertNonce('n_active', now + 60_000);

  // group_join_requests：已处理 >90 天删；pending >30 天删；其余留
  await insertJoinRequest('jr_handled_old', 'approved', now - 100 * DAY, now - 91 * DAY);
  await insertJoinRequest('jr_handled_recent', 'rejected', now - 20 * DAY, now - 10 * DAY);
  await insertJoinRequest('jr_pending_stale', 'pending', now - 31 * DAY, null);
  // 部分唯一索引 (group_id,user_id) WHERE status='pending'：第二条 pending 换用户
  await insertJoinRequest('jr_pending_fresh', 'pending', now - 5 * DAY, null, 'u2');

  // group_invite_links：（过期或次数用尽）且创建 >30 天删
  await insertInviteLink('il_expired_old', { expiresAt: now - DAY, maxUses: null, usesCount: 0, createdAt: now - 31 * DAY });
  await insertInviteLink('il_exhausted_old', { expiresAt: null, maxUses: 5, usesCount: 5, createdAt: now - 31 * DAY });
  await insertInviteLink('il_expired_fresh', { expiresAt: now - DAY, maxUses: null, usesCount: 0, createdAt: now - 10 * DAY });
  await insertInviteLink('il_active', { expiresAt: now + DAY, maxUses: 5, usesCount: 1, createdAt: now - 40 * DAY });

  // report_evidence 孤儿：report_id NULL 且 >24h 删（D1+R2）；其余留
  await insertEvidence('report-evidence/u1/orphan-old.png', null, now - 25 * 60 * 60 * 1000);
  await insertEvidence('report-evidence/u1/orphan-fresh.png', null, now - 60 * 60 * 1000);
  await db
    .prepare(
      "INSERT INTO reports (id, reporter_user_id, reported_wallet_address, category, status, created_at) VALUES ('rep1', 'u1', '0x2', 'harassment', 'received', ?)"
    )
    .bind(now - 40 * DAY)
    .run();
  await insertEvidence('report-evidence/u1/attached-old.png', 'rep1', now - 40 * DAY);

  // feed_posts：软删 >30 天硬删（feed_likes 级联 + R2 图片与视频）；其余留
  await insertFeedPost('fp_deleted_old', ['feed/a.png', 'feed/b.png'], 1, now - 31 * DAY, 'feed-videos/v_old.mp4');
  await db
    .prepare('INSERT INTO feed_likes (id, post_id, user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('like1', 'fp_deleted_old', 'u1', now - 31 * DAY)
    .run();
  await insertFeedPost('fp_deleted_fresh', ['feed/c.png'], 1, now - 10 * DAY, 'feed-videos/v_fresh.mp4');
  await insertFeedPost('fp_active_old', ['feed/d.png'], 0, now - 40 * DAY);

  // payment_outbox：done 且 updated_at >30 天删（TEXT ISO）
  await insertOutbox(1, 'done', new Date(now - 31 * DAY).toISOString());
  await insertOutbox(2, 'done', new Date(now - 10 * DAY).toISOString());
  await insertOutbox(3, 'pending', new Date(now - 60 * DAY).toISOString());

  // payment_verify_attempts：created_at >90 天删（TEXT ISO，财务凭证 payment_orders 不碰）
  await insertOrder('order1');
  await insertVerifyAttempt('order1', new Date(now - 91 * DAY).toISOString());
  await insertVerifyAttempt('order1', new Date(now - 10 * DAY).toISOString());

  // club_applications：已处理且 handled_at >180 天删
  await insertClubApplication('ca_handled_old', 'approved', now - 181 * DAY, now - 200 * DAY);
  await insertClubApplication('ca_handled_recent', 'rejected', now - 30 * DAY, now - 40 * DAY);
  await insertClubApplication('ca_pending_old', 'pending', null, now - 200 * DAY);

  // R2 对象
  await r2.put('report-evidence/u1/orphan-old.png', new Uint8Array(128));
  await r2.put('report-evidence/u1/orphan-fresh.png', new Uint8Array(128));
  await r2.put('report-evidence/u1/attached-old.png', new Uint8Array(128));
  await r2.put('feed/a.png', new Uint8Array(10));
  await r2.put('feed/b.png', new Uint8Array(10));
  await r2.put('feed/c.png', new Uint8Array(10));
  await r2.put('feed/d.png', new Uint8Array(10));
  await r2.put('feed-videos/v_old.mp4', new Uint8Array(10));
  await r2.put('feed-videos/v_fresh.mp4', new Uint8Array(10));
}

beforeEach(async () => {
  db = createMockD1Database(true);
  r2 = createMockR2Bucket() as unknown as MockR2Bucket;
  env = {
    DB: db,
    VOICE_BUCKET: r2 as unknown as R2Bucket,
    INTERNAL_ADMIN_SECRET: SECRET,
  };
  now = Date.now();

  await db
    .prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind('u1', '0x1', now - 300 * DAY, now - 300 * DAY)
    .run();
  await db
    .prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind('u2', '0x2', now - 300 * DAY, now - 300 * DAY)
    .run();
  await db
    .prepare('INSERT INTO conversations (id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind('g1', 'group', 'group1', now - 300 * DAY, now - 300 * DAY)
    .run();
});

describe('runStorageLifecycle 全量规则', () => {
  it('按保留期删除全部九类目标，R2 对象同步删，未到期行保留', async () => {
    await seedAllStaleRows();

    const result = await runStorageLifecycle(db, r2 as unknown as R2Bucket);

    expect(result).toEqual({
      sessions: 1,
      nonces: 1,
      group_join_requests: 2,
      group_invite_links: 2,
      report_evidence_orphans: 1,
      feed_posts: 1,
      payment_outbox: 1,
      payment_verify_attempts: 1,
      club_applications: 1,
    });

    // 剩余行数
    expect(await count('sessions')).toBe(2);
    expect(await count('nonces')).toBe(1);
    expect(await count('group_join_requests')).toBe(2);
    expect(await count('group_invite_links')).toBe(2);
    expect(await count('report_evidence')).toBe(2);
    expect(await count('feed_posts')).toBe(2);
    expect(await count('payment_outbox')).toBe(2);
    expect(await count('payment_verify_attempts')).toBe(1);
    expect(await count('club_applications')).toBe(2);

    // 财务凭证不碰
    expect(await count('payment_orders')).toBe(1);

    // feed 硬删级联 likes
    expect(await count('feed_likes')).toBe(0);
    expect(await db.prepare('SELECT * FROM feed_posts WHERE id = ?').bind('fp_deleted_old').first()).toBeNull();
    expect(await db.prepare('SELECT * FROM feed_posts WHERE id = ?').bind('fp_deleted_fresh').first()).not.toBeNull();
    expect(await db.prepare('SELECT * FROM feed_posts WHERE id = ?').bind('fp_active_old').first()).not.toBeNull();

    // R2：被删帖图片与视频、孤儿证据删除，其余保留
    expect(r2.hasKey('feed/a.png')).toBe(false);
    expect(r2.hasKey('feed/b.png')).toBe(false);
    expect(r2.hasKey('feed-videos/v_old.mp4')).toBe(false);
    expect(r2.hasKey('feed/c.png')).toBe(true);
    expect(r2.hasKey('feed/d.png')).toBe(true);
    expect(r2.hasKey('feed-videos/v_fresh.mp4')).toBe(true);
    expect(r2.hasKey('report-evidence/u1/orphan-old.png')).toBe(false);
    expect(r2.hasKey('report-evidence/u1/orphan-fresh.png')).toBe(true);
    expect(r2.hasKey('report-evidence/u1/attached-old.png')).toBe(true);
  });

  it('dryRun 只计数不写库、不删 R2', async () => {
    await seedAllStaleRows();

    const result = await runStorageLifecycle(db, r2 as unknown as R2Bucket, { dryRun: true });

    expect(result.sessions).toBe(1);
    expect(result.feed_posts).toBe(1);
    expect(result.report_evidence_orphans).toBe(1);
    expect(result.payment_outbox).toBe(1);

    // 数据库与 R2 均未变
    expect(await count('sessions')).toBe(3);
    expect(await count('feed_posts')).toBe(3);
    expect(await count('feed_likes')).toBe(1);
    expect(await count('report_evidence')).toBe(3);
    expect(r2.hasKey('feed/a.png')).toBe(true);
    expect(r2.hasKey('report-evidence/u1/orphan-old.png')).toBe(true);
  });

  it('targets 子集只清理指定目标', async () => {
    await seedAllStaleRows();

    const result = await runStorageLifecycle(db, r2 as unknown as R2Bucket, {
      targets: ['sessions', 'nonces'],
    });

    expect(result).toEqual({ sessions: 1, nonces: 1 });
    expect(await count('sessions')).toBe(2);
    expect(await count('nonces')).toBe(1);
    // 其他目标未动
    expect(await count('group_join_requests')).toBe(4);
    expect(await count('payment_outbox')).toBe(3);
    expect(await count('club_applications')).toBe(3);
  });

  it('countPendingCleanup 与实际删除数一致', async () => {
    await seedAllStaleRows();

    expect(await countPendingCleanup(db, 'sessions')).toBe(1);
    expect(await countPendingCleanup(db, 'group_invite_links')).toBe(2);
    expect(await countPendingCleanup(db, 'report_evidence_orphans')).toBe(1);
    expect(await countPendingCleanup(db, 'club_applications')).toBe(1);
    expect(await countPendingCleanup(db, 'payment_verify_attempts')).toBe(1);
  });

  it('scheduled cron 触发存储生命周期清理', async () => {
    await insertSession('s_expired_old', now - 8 * DAY);

    let waitedPromise: Promise<any> | null = null;
    const ctx = {
      waitUntil: (promise: Promise<any>) => {
        waitedPromise = promise;
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const controller: ScheduledController = {
      scheduledTime: Date.now(),
      cron: '* * * * *',
      noRetry: () => {},
    };

    await worker.scheduled(controller, env, ctx);
    expect(waitedPromise).not.toBeNull();
    await waitedPromise;

    expect(await db.prepare('SELECT * FROM sessions WHERE id = ?').bind('s_expired_old').first()).toBeNull();
  });
});

describe('存储管理端点（internalAdmin HMAC）', () => {
  it('GET /internal/admin/storage/stats 返回表行数与待清理估算', async () => {
    await seedAllStaleRows();

    const res = await callAdmin('GET', '/internal/admin/storage/stats');
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.tables.sessions).toBe(3);
    expect(data.tables.feed_posts).toBe(3);
    expect(data.tables.payment_outbox).toBe(3);
    expect(data.pending_cleanup.sessions).toBe(1);
    expect(data.pending_cleanup.group_join_requests).toBe(2);
    expect(data.pending_cleanup.feed_posts).toBe(1);
  });

  it('POST /internal/admin/storage/cleanup 支持 dry_run 与 targets，写审计', async () => {
    await seedAllStaleRows();

    // dry_run：返回计数但不动数据
    const dryRes = await callAdmin('POST', '/internal/admin/storage/cleanup', {
      actor: 'admin1',
      dry_run: true,
      targets: ['sessions'],
    });
    expect(dryRes.status).toBe(200);
    expect(((await dryRes.json()) as any).deleted).toEqual({ sessions: 1 });
    expect(await count('sessions')).toBe(3);

    // 真删 sessions
    const res = await callAdmin('POST', '/internal/admin/storage/cleanup', {
      actor: 'admin1',
      targets: ['sessions'],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).deleted).toEqual({ sessions: 1 });
    expect(await count('sessions')).toBe(2);

    // 审计两次 storage_cleanup
    const audits = await db
      .prepare("SELECT * FROM payment_audit_log WHERE action = 'storage_cleanup' ORDER BY id ASC")
      .all<{ actor: string; detail_json: string }>();
    expect(audits.results.length).toBe(2);
    expect(audits.results[0].actor).toBe('admin1');
    const detail = JSON.parse(audits.results[1].detail_json);
    expect(detail.targets).toEqual(['sessions']);
    expect(detail.dry_run).toBe(false);
    expect(detail.deleted).toEqual({ sessions: 1 });
  });

  it('POST /internal/admin/storage/cleanup 非法 targets 返回 400', async () => {
    const res = await callAdmin('POST', '/internal/admin/storage/cleanup', { targets: ['users'] });
    expect(res.status).toBe(400);
    const emptyRes = await callAdmin('POST', '/internal/admin/storage/cleanup', { targets: [] });
    expect(emptyRes.status).toBe(400);
  });

  it('存储端点无 HMAC 签名返回 401', async () => {
    const res = await app.request('/internal/admin/storage/stats', {}, env);
    expect(res.status).toBe(401);
  });
});
