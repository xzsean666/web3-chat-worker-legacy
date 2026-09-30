import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket } from './helpers/r2';
import { allow } from '../src/services/rateLimit';
import type { Env } from '../src/types';
import type { PaymentConfigPayload } from '../src/services/payments/config';

const SECRET = 'test-internal-secret';

let db: D1Database;
let env: Env;

beforeEach(() => {
  db = createMockD1Database(true);
  env = {
    DB: db,
    VOICE_BUCKET: createMockR2Bucket(),
    INTERNAL_ADMIN_SECRET: SECRET,
  };
});

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

async function call(method: string, path: string, body?: unknown, envOverride?: Env): Promise<Response> {
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const pathname = path.split('?')[0]; // 签名只含 path，不含 query（契约 §7）
  const headers: Record<string, string> = sign(method, pathname, bodyStr);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, { method, headers, body: body === undefined ? undefined : bodyStr }, envOverride ?? env);
}

function validPayload(): PaymentConfigPayload {
  return {
    schemaVersion: 1,
    membershipEnabled: true,
    paymentsEnabled: true,
    membership: {
      monthly: { price: '5000000000000000000', durationDays: 30 },
      yearly: { price: '50000000000000000000', durationDays: 365 },
    },
    capacityTiers: [
      { tier: 100, price: '10000000000000000000' },
      { tier: 200, price: '25000000000000000000' },
      { tier: 300, price: '45000000000000000000' },
      { tier: 400, price: '70000000000000000000' },
      { tier: 500, price: '100000000000000000000' },
    ],
    memberDiscountBps: 2000,
    quoteTtlSeconds: 1800,
    recipientAddress: '0x1111111111111111111111111111111111111111',
    chains: [
      {
        chainId: 56,
        rpcUrls: ['https://bsc.publicnode.com'],
        confirmations: 12,
        recipientAddress: '0x1111111111111111111111111111111111111111',
        token: { type: 'native', symbol: 'BNB', decimals: 18, address: null },
      },
    ],
  };
}

async function insertOrder(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO payment_orders (id, wallet_address, kind, amount, list_amount, chain_id, token_type, token_symbol, token_decimals, recipient_address, config_version, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, '100', '100', 56, 'native', 'BNB', 18, '0x1111111111111111111111111111111111111111', 1, ?, ?, ?, ?)`
    )
    .bind(
      id,
      (overrides.wallet_address as string) ?? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      (overrides.kind as string) ?? 'membership_month',
      (overrides.status as string) ?? 'failed',
      (overrides.expires_at as string) ?? now,
      now,
      now
    )
    .run();
  return id;
}

describe('internalAuth middleware', () => {
  it('returns 401 when headers are missing', async () => {
    const res = await app.request('/internal/admin/config', {}, env);
    expect(res.status).toBe(401);
  });

  it('returns 401 for stale timestamp', async () => {
    const headers = sign('GET', '/internal/admin/config', '');
    headers['X-Internal-Timestamp'] = (Math.floor(Date.now() / 1000) - 1000).toString();
    // 重新签名使签名本身合法，仅时间戳过期
    const bodyHash = createHash('sha256').update('').digest('hex');
    headers['X-Internal-Signature'] = createHmac('sha256', SECRET)
      .update(`${headers['X-Internal-Timestamp']}\n${headers['X-Internal-Nonce']}\nGET\n/internal/admin/config\n${bodyHash}`)
      .digest('hex');
    const res = await app.request('/internal/admin/config', { headers }, env);
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong signature', async () => {
    const headers = sign('GET', '/internal/admin/config', '');
    headers['X-Internal-Signature'] = '0'.repeat(64);
    const res = await app.request('/internal/admin/config', { headers }, env);
    expect(res.status).toBe(401);
  });

  it('returns 401 on nonce replay', async () => {
    const headers = sign('GET', '/internal/admin/config', '');
    const first = await app.request('/internal/admin/config', { headers }, env);
    expect(first.status).toBe(200);
    const replay = await app.request('/internal/admin/config', { headers }, env);
    expect(replay.status).toBe(401);
  });

  it('returns 503 when INTERNAL_ADMIN_SECRET is not configured', async () => {
    const noSecretEnv: Env = { DB: db, VOICE_BUCKET: createMockR2Bucket() };
    const res = await app.request('/internal/admin/config', { headers: sign('GET', '/internal/admin/config', '') }, noSecretEnv);
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('INTERNAL_AUTH_NOT_CONFIGURED');
  });

  it('accepts a properly signed request', async () => {
    const res = await call('GET', '/internal/admin/config');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { version: number | null; payload: unknown };
    expect(data.version).toBeNull();
    expect(data.payload).toBeNull();
  });
});

describe('internal admin config endpoints', () => {
  it('PUT /config rejects invalid payload with details', async () => {
    const p = validPayload();
    p.memberDiscountBps = 99999;
    const res = await call('PUT', '/internal/admin/config', { payload: p, createdBy: 'admin1' });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; details: string[] };
    expect(data.error).toBe('INVALID_CONFIG');
    expect(data.details.length).toBeGreaterThan(0);
  });

  it('PUT /config requires createdBy', async () => {
    const res = await call('PUT', '/internal/admin/config', { payload: validPayload() });
    expect(res.status).toBe(400);
  });

  it('PUT /config saves new version, GET /config returns it, audit written', async () => {
    const put = await call('PUT', '/internal/admin/config', { payload: validPayload(), createdBy: 'admin1' });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { version: number }).version).toBe(1);

    const get = await call('GET', '/internal/admin/config');
    const data = (await get.json()) as { version: number; payload: PaymentConfigPayload };
    expect(data.version).toBe(1);
    expect(data.payload.memberDiscountBps).toBe(2000);

    const audit = await db
      .prepare("SELECT * FROM payment_audit_log WHERE action = 'config_update'")
      .first<{ actor: string; target: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('admin1');
    expect(audit!.target).toBe('v1');

    // 第二版：active 唯一、版本递增、diff 落库
    const p2 = validPayload();
    p2.memberDiscountBps = 1000;
    const put2 = await call('PUT', '/internal/admin/config', { payload: p2, createdBy: 'admin2' });
    expect(((await put2.json()) as { version: number }).version).toBe(2);

    const versions = await call('GET', '/internal/admin/config/versions?page=1&limit=10');
    const vData = (await versions.json()) as { versions: Array<{ version: number; is_active: number; change_summary: string | null }>; total: number };
    expect(vData.total).toBe(2);
    expect(vData.versions[0].version).toBe(2);
    expect(vData.versions[0].is_active).toBe(1);
    expect(vData.versions[1].is_active).toBe(0);
    const diff = JSON.parse(vData.versions[0].change_summary!) as Record<string, unknown>;
    expect(diff['memberDiscountBps']).toEqual({ from: 2000, to: 1000 });
  });

  it('PUT /config also accepts the payload flattened at top level', async () => {
    const res = await call('PUT', '/internal/admin/config', { ...validPayload(), createdBy: 'admin1' });
    expect(res.status).toBe(200);
  });
});

describe('internal admin orders endpoints', () => {
  it('lists orders with filters and pagination', async () => {
    await insertOrder({ status: 'failed', wallet_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    await insertOrder({ status: 'active', wallet_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });

    const all = await call('GET', '/internal/admin/orders');
    expect(((await all.json()) as { total: number }).total).toBe(2);

    const filtered = await call('GET', '/internal/admin/orders?status=active');
    const fData = (await filtered.json()) as { total: number; orders: Array<{ status: string }> };
    expect(fData.total).toBe(1);
    expect(fData.orders[0].status).toBe('active');

    const byWallet = await call('GET', '/internal/admin/orders?wallet=0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    expect(((await byWallet.json()) as { total: number }).total).toBe(1);
  });

  it('returns order detail with verify attempts and outbox status', async () => {
    const id = await insertOrder({ status: 'failed' });
    await db
      .prepare("INSERT INTO payment_verify_attempts (order_id, result, error, created_at) VALUES (?, 'failed', 'bad sig', ?)")
      .bind(id, new Date().toISOString())
      .run();
    await db
      .prepare("INSERT INTO payment_outbox (kind, ref_key, payload_json, status, created_at, updated_at) VALUES ('order_receipt', ?, '{}', 'failed', ?, ?)")
      .bind(id, new Date().toISOString(), new Date().toISOString())
      .run();

    const res = await call('GET', `/internal/admin/orders/${id}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      order: { id: string };
      verifyAttempts: Array<{ error: string }>;
      outbox: Array<{ kind: string; status: string }>;
    };
    expect(data.order.id).toBe(id);
    expect(data.verifyAttempts).toHaveLength(1);
    expect(data.verifyAttempts[0].error).toBe('bad sig');
    expect(data.outbox).toHaveLength(1);
    expect(data.outbox[0].status).toBe('failed');
  });

  it('returns 404 for unknown order', async () => {
    const res = await call('GET', '/internal/admin/orders/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('ORDER_NOT_FOUND');
  });

  it('retry-verify resets order to submitted and writes audit', async () => {
    const id = await insertOrder({ status: 'failed' });
    await db.prepare("UPDATE payment_orders SET status_reason = 'bad_amount' WHERE id = ?").bind(id).run();

    const res = await call('POST', `/internal/admin/orders/${id}/retry-verify`, { actor: 'ops1' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { order: { status: string; status_reason: string | null } };
    expect(data.order.status).toBe('submitted');
    expect(data.order.status_reason).toBeNull();

    const audit = await db
      .prepare("SELECT * FROM payment_audit_log WHERE action = 'retry_verify' AND target = ?")
      .bind(id)
      .first<{ actor: string; detail_json: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('ops1');
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ from: 'failed' });
  });

  it('retry-verify rejects active orders', async () => {
    const id = await insertOrder({ status: 'active' });
    const res = await call('POST', `/internal/admin/orders/${id}/retry-verify`, { actor: 'ops1' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_ORDER_STATE');
  });

  it('retry-sync resets related outbox rows to pending and writes audit', async () => {
    const id = await insertOrder({ status: 'granting' });
    await db
      .prepare("INSERT INTO payment_outbox (kind, ref_key, payload_json, status, attempts, last_error, created_at, updated_at) VALUES ('order_receipt', ?, '{}', 'failed', 3, 'boom', ?, ?)")
      .bind(id, new Date().toISOString(), new Date().toISOString())
      .run();

    const res = await call('POST', `/internal/admin/orders/${id}/retry-sync`, { actor: 'ops2' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(1);

    const row = await db
      .prepare('SELECT status, last_error FROM payment_outbox WHERE ref_key = ?')
      .bind(id)
      .first<{ status: string; last_error: string | null }>();
    expect(row!.status).toBe('pending');
    expect(row!.last_error).toBeNull();

    const audit = await db
      .prepare("SELECT * FROM payment_audit_log WHERE action = 'retry_sync' AND target = ?")
      .bind(id)
      .first<{ actor: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('ops2');
  });
});

describe('internal admin revoke', () => {
  const WALLET = '0xcccccccccccccccccccccccccccccccccccccccc';

  it('revokes membership: clears tier/expires, bumps version, writes audit and outbox', async () => {
    const now = new Date().toISOString();
    await db
      .prepare("INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'year', '2027-01-01T00:00:00.000Z', 3, ?)")
      .bind(WALLET, now)
      .run();

    const res = await call('POST', '/internal/admin/revoke', {
      kind: 'membership',
      walletAddress: WALLET,
      reason: 'refund',
      actor: 'admin9',
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      entitlement: { membership_tier: string | null; membership_expires_at: string | null; entitlement_version: number };
    };
    expect(data.entitlement.membership_tier).toBeNull();
    expect(data.entitlement.membership_expires_at).toBeNull();
    expect(data.entitlement.entitlement_version).toBe(4);

    const audit = await db
      .prepare("SELECT * FROM payment_audit_log WHERE action = 'revoke_membership' AND target = ?")
      .bind(WALLET)
      .first<{ actor: string; detail_json: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.actor).toBe('admin9');
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ reason: 'refund', previous: { tier: 'year' } });

    const outbox = await db
      .prepare("SELECT * FROM payment_outbox WHERE kind = 'wallet_snapshot' AND ref_key = ?")
      .bind(WALLET)
      .first<{ status: string; payload_json: string }>();
    expect(outbox).not.toBeNull();
    expect(outbox!.status).toBe('pending');
    const snapshot = JSON.parse(outbox!.payload_json) as {
      schemaVersion: number;
      entitlementVersion: number;
      walletAddress: string;
      membership: { tier: string | null; expiresAt: string | null; active: boolean };
    };
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.entitlementVersion).toBe(4);
    expect(snapshot.walletAddress).toBe(WALLET);
    expect(snapshot.membership).toEqual({ tier: null, expiresAt: null, active: false });
  });

  it('revokes capacity: back to 50 with revoked_at/reason, writes audit and outbox', async () => {
    const now = new Date().toISOString();
    await db
      .prepare("INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, last_order_id, updated_at) VALUES ('grp1', 300, 2, 'order1', ?)")
      .bind(now)
      .run();

    const res = await call('POST', '/internal/admin/revoke', {
      kind: 'capacity',
      groupId: 'grp1',
      reason: 'fraud',
      actor: 'admin9',
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      entitlement: { capacity_tier: number; entitlement_version: number; revoked_at: string | null; revoke_reason: string | null };
    };
    expect(data.entitlement.capacity_tier).toBe(50);
    expect(data.entitlement.entitlement_version).toBe(3);
    expect(data.entitlement.revoked_at).not.toBeNull();
    expect(data.entitlement.revoke_reason).toBe('fraud');

    const audit = await db
      .prepare("SELECT * FROM payment_audit_log WHERE action = 'revoke_capacity' AND target = 'grp1'")
      .first<{ detail_json: string }>();
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ reason: 'fraud', previous: { capacityTier: 300 } });

    const outbox = await db
      .prepare("SELECT * FROM payment_outbox WHERE kind = 'group_snapshot' AND ref_key = 'grp1'")
      .first<{ status: string; payload_json: string }>();
    expect(outbox).not.toBeNull();
    const snapshot = JSON.parse(outbox!.payload_json) as { groupId: string; capacity: number; revokedAt: string | null };
    expect(snapshot.groupId).toBe('grp1');
    expect(snapshot.capacity).toBe(50);
    expect(snapshot.revokedAt).not.toBeNull();
  });

  it('returns 404 when there is nothing to revoke', async () => {
    const res = await call('POST', '/internal/admin/revoke', {
      kind: 'membership',
      walletAddress: WALLET,
      reason: 'x',
      actor: 'a',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('ENTITLEMENT_NOT_FOUND');

    const res2 = await call('POST', '/internal/admin/revoke', { kind: 'capacity', groupId: 'nope', reason: 'x', actor: 'a' });
    expect(res2.status).toBe(404);
  });

  it('validates kind and required ids', async () => {
    const res = await call('POST', '/internal/admin/revoke', { kind: 'other', actor: 'a' });
    expect(res.status).toBe(400);
    const res2 = await call('POST', '/internal/admin/revoke', { kind: 'membership', actor: 'a' });
    expect(res2.status).toBe(400);
  });
});

describe('rateLimit allow()', () => {
  it('allows up to perMinute then blocks within the same window', async () => {
    const wallet = '0xdddddddddddddddddddddddddddddddddddddddd';
    expect(await allow(db, 'quote', wallet, 2)).toBe(true);
    expect(await allow(db, 'quote', wallet, 2)).toBe(true);
    expect(await allow(db, 'quote', wallet, 2)).toBe(false);
    // 不同 action 独立计数
    expect(await allow(db, 'submit', wallet, 2)).toBe(true);
    // 不同 wallet 独立计数
    expect(await allow(db, 'quote', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 2)).toBe(true);
  });
});


describe('internal admin report review', () => {
  const REPORTER_ID = 'user-reporter';
  const GROUP_ID = 'group-reported';

  async function seedFixtures() {
    const now = Date.now();
    await db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(REPORTER_ID, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', now, now)
      .run();
    await db.prepare(
      `INSERT INTO conversations (id, type, name, metadata, is_muted, group_type, content_protected, created_at, updated_at)
       VALUES (?, 'group', 'Scam Group', '{}', 0, 'private', 0, ?, ?)`
    )
      .bind(GROUP_ID, now, now)
      .run();
    await db.prepare(
      `INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m1', ?, ?, 'owner', ?)`
    )
      .bind(GROUP_ID, REPORTER_ID, now)
      .run();
  }

  async function insertReport(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
    const id = (overrides.id as string) ?? randomUUID();
    const targetType = (overrides.target_type as string) ?? 'user';
    await db.prepare(
      `INSERT INTO reports (
         id, reporter_user_id, reported_user_id, reported_wallet_address, reported_group_id, target_type,
         category, message_ids, description, status, created_at
       ) VALUES (?, ?, NULL, ?, ?, ?, 'fraud', ?, NULL, ?, ?)`
    )
      .bind(
        id,
        REPORTER_ID,
        (overrides.reported_wallet_address as string | null) ?? (targetType === 'user' ? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : null),
        (overrides.reported_group_id as string | null) ?? (targetType === 'group' ? GROUP_ID : null),
        targetType,
        JSON.stringify((overrides.message_ids as string[]) ?? ['msg-1']),
        (overrides.status as string) ?? 'received',
        (overrides.created_at as number) ?? Date.now()
      )
      .run();
    return id;
  }

  it('requires internal auth on the reports endpoints', async () => {
    const res = await app.request('/internal/admin/reports', {}, env);
    expect(res.status).toBe(401);
  });

  it('lists reports with status/target_type filters and group info', async () => {
    await seedFixtures();
    const baseNow = Date.now();
    const userReport = await insertReport({ status: 'received', created_at: baseNow - 200 });
    const groupReport = await insertReport({ target_type: 'group', status: 'received', created_at: baseNow });
    await insertReport({ status: 'resolved', created_at: baseNow - 100 });

    const all = await call('GET', '/internal/admin/reports');
    expect(all.status).toBe(200);
    const allData = (await all.json()) as any;
    expect(allData.total).toBe(3);
    expect(allData.list).toHaveLength(3);
    // 倒序：群举报（created_at 最新）排第一
    expect(allData.list[0].id).toBe(groupReport);

    const groupsOnly = await call('GET', '/internal/admin/reports?target_type=group&status=received');
    const groupData = (await groupsOnly.json()) as any;
    expect(groupData.total).toBe(1);
    expect(groupData.list[0].id).toBe(groupReport);
    expect(groupData.list[0].target_type).toBe('group');
    expect(groupData.list[0].group_name).toBe('Scam Group');
    expect(groupData.list[0].group_member_count).toBe(1);

    const resolvedOnly = await call('GET', '/internal/admin/reports?status=resolved');
    expect(((await resolvedOnly.json()) as any).total).toBe(1);

    const badFilter = await call('GET', '/internal/admin/reports?status=nope');
    expect(badFilter.status).toBe(400);
    expect(userReport).toBeTruthy();
  });

  it('returns report detail with evidence keys and raw message_ids', async () => {
    await seedFixtures();
    const reportId = await insertReport({ target_type: 'group' });
    const key = `report-evidence/${REPORTER_ID}/ev1.png`;
    await db.prepare(
      `INSERT INTO report_evidence (object_key, uploaded_by, report_id, mime_type, size, created_at)
       VALUES (?, ?, ?, 'image/png', 4, ?)`
    )
      .bind(key, REPORTER_ID, reportId, Date.now())
      .run();

    const res = await call('GET', `/internal/admin/reports/${reportId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.report.id).toBe(reportId);
    expect(data.report.target_type).toBe('group');
    expect(data.report.message_ids).toBe('["msg-1"]');
    expect(data.evidence_keys).toEqual([key]);
    expect(data.group).toEqual({ name: 'Scam Group', member_count: 1 });

    const missing = await call('GET', '/internal/admin/reports/nope');
    expect(missing.status).toBe(404);
  });

  it('reviews a report to resolved/rejected with audit, and rejects invalid actions/states', async () => {
    await seedFixtures();
    const reportId = await insertReport({ status: 'received' });

    const res = await call('POST', `/internal/admin/reports/${reportId}/review`, {
      action: 'resolve', actor: 'admin1', note: 'confirmed scam',
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.report.status).toBe('resolved');

    const audit = await db
      .prepare("SELECT * FROM payment_audit_log WHERE action = 'report_review' AND target = ?")
      .bind(reportId)
      .first<any>();
    expect(audit).toBeTruthy();
    expect(audit.actor).toBe('admin1');
    expect(JSON.parse(audit.detail_json)).toMatchObject({ action: 'resolve', note: 'confirmed scam', from: 'received', to: 'resolved' });

    // 已结案不可重复审核
    const again = await call('POST', `/internal/admin/reports/${reportId}/review`, { action: 'reject', actor: 'admin1' });
    expect(again.status).toBe(409);

    const other = await insertReport({ status: 'under_review' });
    const rejected = await call('POST', `/internal/admin/reports/${other}/review`, { action: 'reject', actor: 'admin2' });
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as any).report.status).toBe('rejected');

    const badAction = await call('POST', `/internal/admin/reports/${other}/review`, { action: 'ban', actor: 'a' });
    expect(badAction.status).toBe(400);
    const notFound = await call('POST', '/internal/admin/reports/nope/review', { action: 'resolve', actor: 'a' });
    expect(notFound.status).toBe(404);
  });

  it('streams evidence binaries only for keys belonging to the report', async () => {
    await seedFixtures();
    const reportId = await insertReport({ target_type: 'group' });
    const otherReport = await insertReport({ target_type: 'group' });
    const key = `report-evidence/${REPORTER_ID}/pic.png`;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await (env.VOICE_BUCKET as unknown as { put(k: string, v: Uint8Array): Promise<unknown> }).put(key, bytes);
    await db.prepare(
      `INSERT INTO report_evidence (object_key, uploaded_by, report_id, mime_type, size, created_at)
       VALUES (?, ?, ?, 'image/png', 4, ?)`
    )
      .bind(key, REPORTER_ID, reportId, Date.now())
      .run();

    const res = await call('GET', `/internal/admin/reports/${reportId}/evidence/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    // 属于其他举报的 key 不可经本举报访问
    const wrongReport = await call('GET', `/internal/admin/reports/${otherReport}/evidence/${key}`);
    expect(wrongReport.status).toBe(404);
    const missingKey = await call('GET', `/internal/admin/reports/${reportId}/evidence/report-evidence/${REPORTER_ID}/nope.png`);
    expect(missingKey.status).toBe(404);
  });
});
