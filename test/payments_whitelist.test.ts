// 白名单钱包测试（契约 §13）：配置校验/归一化、永久会员解析、免单自动发放、
// 折扣判定、移除白名单后新快照失效、已发放权益不回撤。

import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import {
  getActiveConfig,
  isWhitelisted,
  saveConfig,
  validateConfigPayload,
  WHITELIST_MEMBERSHIP,
  type PaymentConfigPayload,
} from '../src/services/payments/config';
import { walletSnapshotKey, groupSnapshotKey } from '../src/services/payments/storage';
import type { Env } from '../src/types';

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const WL = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'; // 故意大小写混合
const WL_LOWER = WL.toLowerCase();

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
    recipientAddress: RECIPIENT,
    quoteTtlSeconds: 1800,
    chains: [
      { chainId: 56, rpcUrls: ['https://rpc-unreachable.invalid'], confirmations: 12, recipientAddress: RECIPIENT, token: { type: 'native', symbol: 'BNB', decimals: 18, address: null } },
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address }),
  }, env);
  const { message } = (await nonceRes.json()) as { message: string };
  const verifyRes = await app.request('/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address, signature: await wallet.signMessage(message) }),
  }, env);
  return ((await verifyRes.json()) as { token: string }).token;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function makeGroup(groupId: string, ownerWallet: string): Promise<void> {
  const now = Date.now();
  await db.prepare("INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, created_at, updated_at) VALUES (?, 'group', ?, 'g', '{}', 0, NULL, ?, ?)")
    .bind(groupId, ownerWallet, now, now).run();
  await db.prepare("INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)")
    .bind(`${groupId}:${ownerWallet}`, groupId, ownerWallet, now).run();
}

describe('白名单配置校验与归一化', () => {
  it('合法白名单通过校验；非法地址/非数组拒绝', () => {
    expect(validateConfigPayload(payload({ whitelistWallets: [WL, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] }))).toEqual([]);
    expect(validateConfigPayload(payload({ whitelistWallets: ['0x1234'] })).some((e) => e.includes('whitelistWallets[0]'))).toBe(true);
    expect(validateConfigPayload(payload({ whitelistWallets: ['not-an-address'] })).length).toBeGreaterThan(0);
    expect(validateConfigPayload(payload({ whitelistWallets: '0xabc' as any })).some((e) => e.includes('array'))).toBe(true);
    // 缺省（不带字段）不受影响
    expect(validateConfigPayload(payload())).toEqual([]);
  });

  it('saveConfig 归一化为小写去重', async () => {
    await saveConfig(db, payload({ whitelistWallets: [WL, WL_LOWER, '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'] }), 'tester');
    const active = await getActiveConfig(db);
    expect(active!.payload.whitelistWallets).toEqual([WL_LOWER, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('isWhitelisted 大小写不敏感', () => {
    const p = payload({ whitelistWallets: [WL_LOWER] });
    expect(isWhitelisted(p, WL)).toBe(true);
    expect(isWhitelisted(p, WL_LOWER)).toBe(true);
    expect(isWhitelisted(p, '0xcccccccccccccccccccccccccccccccccccccccc')).toBe(false);
    expect(isWhitelisted(null, WL_LOWER)).toBe(false);
    expect(isWhitelisted(payload(), WL_LOWER)).toBe(false);
  });
});

describe('白名单 quote 免单自动发放', () => {
  it('会员月单：amount=0/discountBps=10000，订单直接 active，权益行写入，快照为永久会员，写审计', async () => {
    await saveConfig(db, payload({ whitelistWallets: [WL] }), 'tester');
    const wallet = createTestWallet();
    // 用白名单地址登录：直接注入用户+会话太重，改为以白名单地址建钱包不可行——用 SQL 直建会话
    // 简化：用真实登录钱包，把其地址塞进白名单配置
    const token = await login(wallet);
    await saveConfig(db, payload({ whitelistWallets: [wallet.address] }), 'tester'); // v2 active

    const res = await app.request('/payments/quote', { method: 'POST', headers: auth(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { order: any; payment: any };
    expect(data.order.amount).toBe('0');
    expect(data.order.list_amount).toBe('5000000000000000000');
    expect(data.order.discount_bps).toBe(10000);
    expect(data.order.status).toBe('active');
    expect(data.order.granted_at).not.toBeNull();
    expect(data.payment.amount).toBe('0');
    expect(data.payment.note).toContain('白名单');

    // D1 真实权益行（购买发放，非假行）
    const ent = await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(wallet.address).first<any>();
    expect(ent.membership_tier).toBe('month');
    expect(Date.parse(ent.membership_expires_at)).toBeGreaterThan(Date.now());

    // R2 快照：membership 覆盖为永久哨兵
    const snapObj = await bucket.get(walletSnapshotKey(wallet.address));
    const snap = JSON.parse(await snapObj!.text()) as any;
    expect(snap.membership).toEqual(WHITELIST_MEMBERSHIP);
    expect(bucket.hasKey(walletSnapshotKey(wallet.address))).toBe(true);

    // 审计
    const audit = await db.prepare("SELECT * FROM payment_audit_log WHERE action = 'whitelist_grant' AND target = ?").bind(data.order.id).first<any>();
    expect(audit).not.toBeNull();
    expect(audit.actor).toBe('system');
    expect(JSON.parse(audit.detail_json)).toMatchObject({ reason: 'whitelist_free_order', wallet: wallet.address });

    // submit 该免单订单：幂等返回 active
    const submit = await app.request(`/payments/orders/${data.order.id}/submit`, {
      method: 'POST', headers: auth(token), body: JSON.stringify({ txHash: '0x' + 'ab'.repeat(32) }),
    }, env);
    expect(submit.status).toBe(200);
    expect(((await submit.json()) as { order: any }).order.status).toBe('active');
    void WL;
  });

  it('扩群单：容量直接发放到目标档，订单 active', async () => {
    const owner = createTestWallet();
    const token = await login(owner);
    await saveConfig(db, payload({ whitelistWallets: [owner.address] }), 'tester');
    await makeGroup('grp1', owner.address);

    const res = await app.request('/payments/quote', { method: 'POST', headers: auth(token), body: JSON.stringify({ kind: 'group_capacity', groupId: 'grp1', toTier: 200 }) }, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { order: any };
    expect(data.order.status).toBe('active');
    expect(data.order.amount).toBe('0');
    expect(data.order.list_amount).toBe('25000000000000000000');

    const cap = await db.prepare("SELECT * FROM group_capacity_entitlements WHERE group_id = 'grp1'").first<any>();
    expect(cap.capacity_tier).toBe(200);
    expect(cap.last_order_id).toBe(data.order.id);
    expect(bucket.hasKey(groupSnapshotKey('grp1'))).toBe(true);
  });

  it('非白名单钱包不受影响：金额全价、订单 awaiting_payment', async () => {
    await saveConfig(db, payload({ whitelistWallets: [WL_LOWER] }), 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);
    const res = await app.request('/payments/quote', { method: 'POST', headers: auth(token), body: JSON.stringify({ kind: 'membership_month' }) }, env);
    const data = (await res.json()) as { order: any };
    expect(data.order.status).toBe('awaiting_payment');
    expect(data.order.amount).toBe('5000000000000000000');
    expect(data.order.discount_bps).toBe(0);
  });
});

describe('白名单会员态解析', () => {
  it('/entitlements/me：无 D1 行的白名单钱包返回永久会员，且不写假行', async () => {
    const wallet = createTestWallet();
    const token = await login(wallet);
    await saveConfig(db, payload({ whitelistWallets: [wallet.address] }), 'tester');

    const res = await app.request('/entitlements/me', { headers: auth(token) }, env);
    const snap = (await res.json()) as any;
    expect(snap.membership).toEqual(WHITELIST_MEMBERSHIP);

    const row = await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(wallet.address).first();
    expect(row).toBeNull(); // D1 不写假行
  });

  it('/groups/:id/capacity：白名单钱包 payableForNextTier 为 0', async () => {
    const owner = createTestWallet();
    const token = await login(owner);
    await saveConfig(db, payload({ whitelistWallets: [owner.address] }), 'tester');
    await makeGroup('grp1', owner.address);

    const res = await app.request('/groups/grp1/capacity', { headers: auth(token) }, env);
    const data = (await res.json()) as any;
    expect(data.payableForNextTier.amount).toBe('0');
    expect(data.payableForNextTier.discountBps).toBe(10000);
    expect(data.payableForNextTier.listAmount).toBe('10000000000000000000');
  });
});

describe('白名单移除', () => {
  it('移除后新快照不再含会员；已发放群容量不回撤', async () => {
    const owner = createTestWallet();
    const token = await login(owner);
    await saveConfig(db, payload({ whitelistWallets: [owner.address] }), 'tester');
    await makeGroup('grp1', owner.address);

    // 免单买 200 档
    const q = await app.request('/payments/quote', { method: 'POST', headers: auth(token), body: JSON.stringify({ kind: 'group_capacity', groupId: 'grp1', toTier: 200 }) }, env);
    expect(((await q.json()) as any).order.status).toBe('active');

    // 移除白名单（v2）
    await saveConfig(db, payload(), 'tester');

    // 清掉 R2 缓存强制重建
    await bucket.delete(walletSnapshotKey(owner.address));
    const res = await app.request('/entitlements/me', { headers: auth(token) }, env);
    const snap = (await res.json()) as any;
    expect(snap.membership.tier).toBeNull();
    expect(snap.membership.active).toBe(false);
    // 已发放群容量不回撤
    expect(snap.groups['grp1'].capacity).toBe(200);
    const cap = await db.prepare("SELECT capacity_tier FROM group_capacity_entitlements WHERE group_id = 'grp1'").first<{ capacity_tier: number }>();
    expect(cap!.capacity_tier).toBe(200);

    // 移除后 quote 恢复全价
    const q2 = await app.request('/payments/quote', { method: 'POST', headers: auth(token), body: JSON.stringify({ kind: 'group_capacity', groupId: 'grp1', toTier: 300 }) }, env);
    const d2 = (await q2.json()) as { order: any };
    expect(d2.order.status).toBe('awaiting_payment');
    expect(d2.order.amount).toBe('20000000000000000000'); // 45-25=20e18，无会员折扣
  });
});
