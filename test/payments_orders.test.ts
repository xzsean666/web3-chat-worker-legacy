// 用户侧支付路由测试（契约 §6）：quote 校验/冻结、submit 幂等/认领/过期、订单查询、entitlements/me、capacity。

import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { saveConfig, type PaymentConfigPayload } from '../src/services/payments/config';
import { walletSnapshotKey } from '../src/services/payments/storage';
import type { Env } from '../src/types';

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const TX_HASH = '0x' + 'ab'.repeat(32);
const TX_HASH_2 = '0x' + 'cd'.repeat(32);

let db: D1Database;
let bucket: MockR2Bucket;
let env: Env;

function payload(overrides: Partial<PaymentConfigPayload> = {}): PaymentConfigPayload {
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
    // 不可达 RPC：submit 的即时验款快速失败留 submitted，cron 兜底
    chains: [
      { chainId: 56, rpcUrls: ['http://127.0.0.1:9'], confirmations: 12, recipientAddress: RECIPIENT, token: { type: 'native', symbol: 'BNB', decimals: 18, address: null } },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  db = createMockD1Database(true);
  bucket = createMockR2Bucket() as MockR2Bucket;
  env = { DB: db, VOICE_BUCKET: bucket };
});

async function login(wallet: TestWallet): Promise<string> {
  const nonceRes = await app.request('/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address }),
  }, env);
  const { message } = (await nonceRes.json()) as { message: string };
  const signature = await wallet.signMessage(message);
  const verifyRes = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address, signature }),
  }, env);
  return ((await verifyRes.json()) as { token: string }).token;
}

function authed(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function makeGroup(groupId: string, ownerWallet: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare("INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, created_at, updated_at) VALUES (?, 'group', ?, 'g', '{}', 0, NULL, ?, ?)")
    .bind(groupId, ownerWallet, now, now)
    .run();
  await db
    .prepare("INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)")
    .bind(crypto.randomUUID(), groupId, ownerWallet, now)
    .run();
}

describe('POST /payments/quote', () => {
  it('无配置 → CONFIG_INCOMPLETE；paymentsEnabled=false → PAYMENTS_DISABLED', async () => {
    const wallet = createTestWallet();
    const token = await login(wallet);

    const res1 = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    expect(res1.status).toBe(503);
    expect(((await res1.json()) as { error: string }).error).toBe('CONFIG_INCOMPLETE');

    await saveConfig(db, payload({ paymentsEnabled: false }), 'tester');
    const res2 = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    expect(((await res2.json()) as { error: string }).error).toBe('PAYMENTS_DISABLED');

    await saveConfig(db, payload({ membershipEnabled: false }), 'tester');
    const res3 = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    expect(((await res3.json()) as { error: string }).error).toBe('PAYMENTS_DISABLED');

    await saveConfig(db, payload({ chains: [] }), 'tester');
    const res4 = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    expect(((await res4.json()) as { error: string }).error).toBe('CONFIG_INCOMPLETE');
  });

  it('会员月单：冻结价格/链/收款地址/有效期/配置版本', async () => {
    await saveConfig(db, payload(), 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);
    const res = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { order: any; payment: any };
    expect(data.order.status).toBe('awaiting_payment');
    expect(data.order.kind).toBe('membership_month');
    expect(data.order.duration_days).toBe(30);
    expect(data.order.amount).toBe('5000000000000000000');
    expect(data.order.list_amount).toBe('5000000000000000000');
    expect(data.order.discount_bps).toBe(0);
    expect(data.order.chain_id).toBe(56);
    expect(data.order.token_type).toBe('native');
    expect(data.order.recipient_address).toBe(RECIPIENT);
    expect(data.order.config_version).toBe(1);
    expect(Date.parse(data.order.expires_at)).toBeGreaterThan(Date.now() + 1700_000);
    expect(data.payment.amount).toBe('5000000000000000000');
    expect(data.payment.tokenSymbol).toBe('BNB');
  });

  it('扩群：非群主 NOT_GROUP_OWNER；档位非法 INVALID_TIER；不升级 TIER_NOT_UPGRADE', async () => {
    await saveConfig(db, payload(), 'tester');
    const owner = createTestWallet();
    const ownerToken = await login(owner);
    await makeGroup('grp1', owner.address);

    const outsider = createTestWallet();
    const outsiderToken = await login(outsider);
    const res1 = await app.request('/payments/quote', { method: 'POST', headers: authed(outsiderToken), body: JSON.stringify({ kind: 'group_capacity', groupId: 'grp1', toTier: 100 }) }, env);
    expect(res1.status).toBe(403);
    expect(((await res1.json()) as { error: string }).error).toBe('NOT_GROUP_OWNER');

    const res2 = await app.request('/payments/quote', { method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ kind: 'group_capacity', groupId: 'grp1', toTier: 150 }) }, env);
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as { error: string }).error).toBe('INVALID_TIER');

    // 群已在 200 档，再买 200 → TIER_NOT_UPGRADE
    await db.prepare("INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES ('grp1', 200, 1, ?)").bind(new Date().toISOString()).run();
    const res3 = await app.request('/payments/quote', { method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ kind: 'group_capacity', groupId: 'grp1', toTier: 200 }) }, env);
    expect(res3.status).toBe(400);
    expect(((await res3.json()) as { error: string }).error).toBe('TIER_NOT_UPGRADE');
  });

  it('扩群：会员折扣冻结（amount/list_amount/discount_bps、owner_at_order、from_tier）', async () => {
    await saveConfig(db, payload(), 'tester');
    const owner = createTestWallet();
    const token = await login(owner);
    await makeGroup('grp1', owner.address);
    // 有效会员
    await db
      .prepare("INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', ?, 1, ?)")
      .bind(owner.address, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString())
      .run();

    const res = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'group_capacity', groupId: 'grp1', toTier: 100 }) }, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { order: any; payment: any };
    expect(data.order.from_tier).toBe(50);
    expect(data.order.to_tier).toBe(100);
    expect(data.order.owner_at_order).toBe(owner.address);
    expect(data.order.list_amount).toBe('10000000000000000000');
    expect(data.order.discount_bps).toBe(2000);
    expect(data.order.amount).toBe('8000000000000000000'); // 10e18 * 0.8
    expect(data.payment.note).toContain('会员折扣');
  });

  it('过期会员不享受折扣', async () => {
    await saveConfig(db, payload(), 'tester');
    const owner = createTestWallet();
    const token = await login(owner);
    await makeGroup('grp1', owner.address);
    await db
      .prepare("INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', '2020-01-01T00:00:00.000Z', 1, ?)")
      .bind(owner.address, new Date().toISOString())
      .run();
    const res = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'group_capacity', groupId: 'grp1', toTier: 100 }) }, env);
    const data = (await res.json()) as { order: any };
    expect(data.order.discount_bps).toBe(0);
    expect(data.order.amount).toBe('10000000000000000000');
  });
});

describe('POST /payments/orders/:id/submit', () => {
  async function quoteOrder(token: string): Promise<any> {
    const res = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    return ((await res.json()) as { order: any }).order;
  }

  beforeEach(async () => {
    await saveConfig(db, payload(), 'tester');
  });

  it('txHash 格式错误 → 400；他人订单 → 404', async () => {
    const w1 = createTestWallet();
    const t1 = await login(w1);
    const order = await quoteOrder(t1);

    const bad = await app.request(`/payments/orders/${order.id}/submit`, { method: 'POST', headers: authed(t1), body: JSON.stringify({ txHash: '0x1234' }) }, env);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('INVALID_TX_HASH');

    const w2 = createTestWallet();
    const t2 = await login(w2);
    const notMine = await app.request(`/payments/orders/${order.id}/submit`, { method: 'POST', headers: authed(t2), body: JSON.stringify({ txHash: TX_HASH }) }, env);
    expect(notMine.status).toBe(404);
  });

  it('提交成功 → submitted + tx 认领；重复提交同 tx 幂等返回当前状态', async () => {
    const wallet = createTestWallet();
    const token = await login(wallet);
    const order = await quoteOrder(token);

    const res = await app.request(`/payments/orders/${order.id}/submit`, { method: 'POST', headers: authed(token), body: JSON.stringify({ txHash: TX_HASH }) }, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { order: any };
    expect(data.order.status).toBe('submitted'); // RPC 不可达 → 留 submitted 等 cron
    expect(data.order.tx_hash).toBe(TX_HASH);
    const claim = await db.prepare('SELECT * FROM payment_tx_claims WHERE order_id = ?').bind(order.id).first<{ tx_hash: string }>();
    expect(claim!.tx_hash).toBe(TX_HASH);
    const attempt = await db.prepare('SELECT * FROM payment_verify_attempts WHERE order_id = ? ORDER BY id DESC LIMIT 1').bind(order.id).first<{ result: string }>();
    expect(attempt!.result).toBe('retry');

    const again = await app.request(`/payments/orders/${order.id}/submit`, { method: 'POST', headers: authed(token), body: JSON.stringify({ txHash: TX_HASH }) }, env);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { order: any }).order.status).toBe('submitted');
  });

  it('一 tx 多单 → TX_ALREADY_CLAIMED，本单置 failed(tx_already_claimed)', async () => {
    const wallet = createTestWallet();
    const token = await login(wallet);
    const o1 = await quoteOrder(token);
    const o2 = await quoteOrder(token);

    await app.request(`/payments/orders/${o1.id}/submit`, { method: 'POST', headers: authed(token), body: JSON.stringify({ txHash: TX_HASH_2 }) }, env);
    const res = await app.request(`/payments/orders/${o2.id}/submit`, { method: 'POST', headers: authed(token), body: JSON.stringify({ txHash: TX_HASH_2 }) }, env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('TX_ALREADY_CLAIMED');
    const failed = await db.prepare('SELECT status, status_reason FROM payment_orders WHERE id = ?').bind(o2.id).first<{ status: string; status_reason: string }>();
    expect(failed!.status).toBe('failed');
    expect(failed!.status_reason).toBe('tx_already_claimed');
  });

  it('过期订单提交 → ORDER_EXPIRED 且状态置 expired', async () => {
    const wallet = createTestWallet();
    const token = await login(wallet);
    const order = await quoteOrder(token);
    await db.prepare('UPDATE payment_orders SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), order.id).run();
    const res = await app.request(`/payments/orders/${order.id}/submit`, { method: 'POST', headers: authed(token), body: JSON.stringify({ txHash: TX_HASH }) }, env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('ORDER_EXPIRED');
    const row = await db.prepare('SELECT status FROM payment_orders WHERE id = ?').bind(order.id).first<{ status: string }>();
    expect(row!.status).toBe('expired');
  });
});

describe('GET /payments/orders 查询', () => {
  it('仅本人订单，倒序分页 + status 筛选', async () => {
    await saveConfig(db, payload(), 'tester');
    const w1 = createTestWallet();
    const t1 = await login(w1);
    const w2 = createTestWallet();
    const t2 = await login(w2);
    for (let i = 0; i < 3; i++) {
      await app.request('/payments/quote', { method: 'POST', headers: authed(t1), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    }
    await app.request('/payments/quote', { method: 'POST', headers: authed(t2), body: JSON.stringify({ kind: 'membership_year' }) }, env);

    const list = await app.request('/payments/orders?page=1&limit=2', { headers: authed(t1) }, env);
    const data = (await list.json()) as { orders: any[]; total: number };
    expect(data.total).toBe(3);
    expect(data.orders).toHaveLength(2);
    expect(Date.parse(data.orders[0].created_at)).toBeGreaterThanOrEqual(Date.parse(data.orders[1].created_at));
    expect(data.orders.every((o) => o.wallet_address === w1.address)).toBe(true);

    const filtered = await app.request('/payments/orders?status=expired', { headers: authed(t1) }, env);
    expect(((await filtered.json()) as { total: number }).total).toBe(0);

    const detail = await app.request(`/payments/orders/${data.orders[0].id}`, { headers: authed(t1) }, env);
    expect(detail.status).toBe(200);
    const notMine = await app.request(`/payments/orders/${data.orders[0].id}`, { headers: authed(t2) }, env);
    expect(notMine.status).toBe(404);
  });
});

describe('GET /entitlements/me', () => {
  it('R2 miss → 从 D1 重建（含名下群映射）并回写 outbox；R2 hit → 直接返回缓存', async () => {
    const wallet = createTestWallet();
    const token = await login(wallet);
    await makeGroup('grp1', wallet.address);
    await db.prepare("INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES ('grp1', 200, 3, ?)").bind(new Date().toISOString()).run();
    await db
      .prepare("INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'year', '2027-06-01T00:00:00.000Z', 4, ?)")
      .bind(wallet.address, new Date().toISOString())
      .run();

    const res = await app.request('/entitlements/me', { headers: authed(token) }, env);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as any;
    expect(snap.schemaVersion).toBe(1);
    expect(snap.entitlementVersion).toBe(4);
    expect(snap.membership.tier).toBe('year');
    expect(snap.groups['grp1']).toMatchObject({ capacity: 200, version: 3 });

    const outbox = await db.prepare("SELECT * FROM payment_outbox WHERE kind = 'wallet_snapshot' AND ref_key = ?").bind(wallet.address).first<{ status: string }>();
    expect(outbox).not.toBeNull();

    // R2 hit：直接返回 R2 内容（标记字段证明未经重建）
    await bucket.put(walletSnapshotKey(wallet.address), JSON.stringify({ schemaVersion: 1, marker: 'from-r2' }));
    const res2 = await app.request('/entitlements/me', { headers: authed(token) }, env);
    expect(((await res2.json()) as any).marker).toBe('from-r2');
  });
});

describe('GET /groups/:id/capacity', () => {
  it('非成员 403；成员可读容量/档位/价格/会员价', async () => {
    await saveConfig(db, payload(), 'tester');
    const owner = createTestWallet();
    const token = await login(owner);
    await makeGroup('grp1', owner.address);

    const outsider = createTestWallet();
    const outsiderToken = await login(outsider);
    const forbidden = await app.request('/groups/grp1/capacity', { headers: authed(outsiderToken) }, env);
    expect(forbidden.status).toBe(403);

    const res = await app.request('/groups/grp1/capacity', { headers: authed(token) }, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.groupId).toBe('grp1');
    expect(data.memberCount).toBe(1);
    expect(data.capacity).toBe(50);
    expect(data.tier).toBe(50);
    expect(data.nextTier).toBe(100);
    expect(data.tiers).toHaveLength(5);
    expect(data.tiers[0]).toEqual({ tier: 100, price: '10000000000000000000' });
    expect(data.memberDiscountBps).toBe(2000);
    // 非会员视角：无折扣
    expect(data.payableForNextTier.amount).toBe('10000000000000000000');
    expect(data.payableForNextTier.discountBps).toBe(0);

    // 已是 200 档时 nextTier = 300，会员视角打折
    await db.prepare("INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES ('grp1', 200, 2, ?)").bind(new Date().toISOString()).run();
    await db
      .prepare("INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', ?, 1, ?)")
      .bind(owner.address, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString())
      .run();
    const res2 = await app.request('/groups/grp1/capacity', { headers: authed(token) }, env);
    const data2 = (await res2.json()) as any;
    expect(data2.capacity).toBe(200);
    expect(data2.nextTier).toBe(300);
    expect(data2.payableForNextTier.amount).toBe('16000000000000000000'); // (45-25)e18 * 0.8
  });
});

describe('限流', () => {
  it('quote 超过 20 次/分钟 → 429 RATE_LIMITED', async () => {
    await saveConfig(db, payload(), 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);
    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const res = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
