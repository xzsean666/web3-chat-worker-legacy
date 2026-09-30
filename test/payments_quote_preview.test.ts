// POST /payments/quote-preview（纯报价）：与 /payments/quote 相同的校验与计算，
// 但不建单/不写 audit/不走 grant；独立限流桶 quote_preview 60/分钟。

import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { saveConfig, type PaymentConfigPayload } from '../src/services/payments/config';
import type { Env } from '../src/types';

const RECIPIENT = '0x1111111111111111111111111111111111111111';

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

async function preview(token: string, body: Record<string, unknown>) {
  return app.request('/payments/quote-preview', { method: 'POST', headers: authed(token), body: JSON.stringify(body) }, env);
}

async function orderCount(): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM payment_orders').first<{ n: number }>())?.n ?? 0;
}

async function auditCount(): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM payment_audit_log').first<{ n: number }>())?.n ?? 0;
}

describe('POST /payments/quote-preview', () => {
  it('会员月/年报价：金额/时长/链/代币字段正确，且不落库（无订单、无审计）', async () => {
    await saveConfig(db, payload(), 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);

    const month = await preview(token, { kind: 'membership_month' });
    expect(month.status).toBe(200);
    const m = (await month.json()) as any;
    expect(m.kind).toBe('membership_month');
    expect(m.amount).toBe('5000000000000000000');
    expect(m.listAmount).toBe('5000000000000000000');
    expect(m.discountBps).toBe(0);
    expect(m.durationDays).toBe(30);
    expect(m.chainId).toBe(56);
    expect(m.tokenType).toBe('native');
    expect(m.tokenAddress).toBeNull();
    expect(m.tokenSymbol).toBe('BNB');
    expect(m.tokenDecimals).toBe(18);
    expect(m.recipientAddress).toBe(RECIPIENT);

    const year = await preview(token, { kind: 'membership_year' });
    expect(year.status).toBe(200);
    const y = (await year.json()) as any;
    expect(y.amount).toBe('50000000000000000000');
    expect(y.durationDays).toBe(365);

    // 关键断言：不建单、不写审计
    expect(await orderCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('扩群：durationDays 为 null；有效会员享受折扣；群主校验与档位校验同 quote', async () => {
    await saveConfig(db, payload(), 'tester');
    const owner = createTestWallet();
    const ownerToken = await login(owner);
    await makeGroup('grp1', owner.address);

    const outsider = createTestWallet();
    const outsiderToken = await login(outsider);
    const notOwner = await preview(outsiderToken, { kind: 'group_capacity', groupId: 'grp1', toTier: 100 });
    expect(notOwner.status).toBe(403);
    expect(((await notOwner.json()) as { error: string }).error).toBe('NOT_GROUP_OWNER');

    const noGroup = await preview(ownerToken, { kind: 'group_capacity', groupId: 'nope', toTier: 100 });
    expect(noGroup.status).toBe(404);
    expect(((await noGroup.json()) as { error: string }).error).toBe('GROUP_NOT_FOUND');

    const badTier = await preview(ownerToken, { kind: 'group_capacity', groupId: 'grp1', toTier: 150 });
    expect(badTier.status).toBe(400);
    expect(((await badTier.json()) as { error: string }).error).toBe('INVALID_TIER');

    // 非会员：原价无折扣
    const plain = await preview(ownerToken, { kind: 'group_capacity', groupId: 'grp1', toTier: 100 });
    expect(plain.status).toBe(200);
    const p = (await plain.json()) as any;
    expect(p.kind).toBe('group_capacity');
    expect(p.durationDays).toBeNull();
    expect(p.amount).toBe('10000000000000000000');
    expect(p.listAmount).toBe('10000000000000000000');
    expect(p.discountBps).toBe(0);

    // 有效会员：差价 × 0.8
    await db
      .prepare("INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', ?, 1, ?)")
      .bind(owner.address, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString())
      .run();
    const member = await preview(ownerToken, { kind: 'group_capacity', groupId: 'grp1', toTier: 100 });
    const mp = (await member.json()) as any;
    expect(mp.amount).toBe('8000000000000000000');
    expect(mp.discountBps).toBe(2000);

    // 已在 200 档再买 200 → TIER_NOT_UPGRADE
    await db.prepare("INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES ('grp1', 200, 1, ?)").bind(new Date().toISOString()).run();
    const notUpgrade = await preview(ownerToken, { kind: 'group_capacity', groupId: 'grp1', toTier: 200 });
    expect(notUpgrade.status).toBe(400);
    expect(((await notUpgrade.json()) as { error: string }).error).toBe('TIER_NOT_UPGRADE');

    expect(await orderCount()).toBe(0);
  });

  it('白名单钱包免单：amount=0、discountBps=10000、listAmount 保留原价，且不触发 grant', async () => {
    const wallet = createTestWallet();
    await saveConfig(db, payload({ whitelistWallets: [wallet.address] }), 'tester');
    const token = await login(wallet);

    const res = await preview(token, { kind: 'membership_year' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.amount).toBe('0');
    expect(data.listAmount).toBe('50000000000000000000');
    expect(data.discountBps).toBe(10000);

    // 不建单/不审计/不发放权益（grant 管线未走）
    expect(await orderCount()).toBe(0);
    expect(await auditCount()).toBe(0);
    const ent = await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(wallet.address).first();
    expect(ent).toBeNull();
  });

  it('配置未开放 → 503；kind 非法 → 400；无 auth → 401', async () => {
    const wallet = createTestWallet();
    const token = await login(wallet);

    const res1 = await preview(token, { kind: 'membership_month' });
    expect(res1.status).toBe(503);
    expect(((await res1.json()) as { error: string }).error).toBe('CONFIG_INCOMPLETE');

    await saveConfig(db, payload({ paymentsEnabled: false }), 'tester');
    const res2 = await preview(token, { kind: 'membership_month' });
    expect(res2.status).toBe(503);
    expect(((await res2.json()) as { error: string }).error).toBe('PAYMENTS_DISABLED');

    await saveConfig(db, payload({ membershipEnabled: false }), 'tester');
    const res3 = await preview(token, { kind: 'membership_month' });
    expect(((await res3.json()) as { error: string }).error).toBe('PAYMENTS_DISABLED');

    await saveConfig(db, payload({ chains: [] }), 'tester');
    const res4 = await preview(token, { kind: 'membership_month' });
    expect(((await res4.json()) as { error: string }).error).toBe('CONFIG_INCOMPLETE');

    await saveConfig(db, payload(), 'tester');
    const badKind = await preview(token, { kind: 'vip' });
    expect(badKind.status).toBe(400);
    expect(((await badKind.json()) as { error: string }).error).toBe('INVALID_KIND');

    const noAuth = await app.request('/payments/quote-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'membership_month' }),
    }, env);
    expect(noAuth.status).toBe(401);

    expect(await orderCount()).toBe(0);
  });

  it('限流：quote_preview 独立桶 60 次/分钟，超过 → 429 RATE_LIMITED', async () => {
    await saveConfig(db, payload(), 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const res = await preview(token, { kind: 'membership_month' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    // 独立桶：不影响 quote（quote 20/分钟 仍可用）
    const quote = await app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    expect(quote.status).toBe(200);
  });
});
