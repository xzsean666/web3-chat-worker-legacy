// 发放器 + cron tick 测试（契约 §4）：幂等、并发 tier 规则、outbox→R2 投递、对账修复。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { saveConfig, type PaymentConfigPayload } from '../src/services/payments/config';
import { grantOrder } from '../src/services/payments/grant';
import { runPaymentsTick } from '../src/services/payments/tick';
import { setPaymentChainClientFactoryForTests } from '../src/services/payments/flow';
import { walletSnapshotKey, groupSnapshotKey, orderReceiptKey } from '../src/services/payments/storage';
import type { PaymentChainClient } from '../src/services/payments/verifier';
import type { Env } from '../src/types';
import type { PaymentOrderRow, WalletEntitlementRow, GroupCapacityEntitlementRow } from '../src/db/schema';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const TX_HASH = '0x' + 'cd'.repeat(32);

let db: D1Database;
let bucket: MockR2Bucket;
let env: Env;

function payload(): PaymentConfigPayload {
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
      { chainId: 56, rpcUrls: ['https://rpc1.example.com'], confirmations: 12, recipientAddress: RECIPIENT, token: { type: 'native', symbol: 'BNB', decimals: 18, address: null } },
    ],
  };
}

beforeEach(async () => {
  db = createMockD1Database(true);
  bucket = createMockR2Bucket() as MockR2Bucket;
  env = { DB: db, VOICE_BUCKET: bucket };
  await saveConfig(db, payload(), 'tester');
});

afterEach(() => {
  setPaymentChainClientFactoryForTests(null);
});

async function makeOrder(overrides: Partial<PaymentOrderRow> & { status: PaymentOrderRow['status'] }): Promise<PaymentOrderRow> {
  const now = new Date().toISOString();
  const id = overrides.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO payment_orders (id, wallet_address, kind, group_id, owner_at_order, from_tier, to_tier, duration_days, amount, list_amount, discount_bps, chain_id, token_type, token_symbol, token_decimals, recipient_address, config_version, status, tx_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 56, 'native', 'BNB', 18, ?, 1, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      overrides.wallet_address ?? WALLET,
      overrides.kind ?? 'membership_month',
      overrides.group_id ?? null,
      overrides.owner_at_order ?? null,
      overrides.from_tier ?? null,
      overrides.to_tier ?? null,
      overrides.duration_days ?? 30,
      overrides.amount ?? '5000000000000000000',
      overrides.list_amount ?? '5000000000000000000',
      overrides.discount_bps ?? 0,
      overrides.recipient_address ?? RECIPIENT,
      overrides.status,
      overrides.tx_hash ?? TX_HASH,
      overrides.expires_at ?? now,
      overrides.created_at ?? now,
      now
    )
    .run();
  if (overrides.tx_hash !== null) {
    await db
      .prepare('INSERT INTO payment_tx_claims (chain_id, tx_hash, order_id, claimed_at) VALUES (56, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(overrides.tx_hash ?? TX_HASH, id, now)
      .run();
  }
  return (await db.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(id).first<PaymentOrderRow>())!;
}

function stubOkClient(): PaymentChainClient {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    getTransaction: async () => ({ hash: TX_HASH, from: WALLET, to: RECIPIENT, value: 5000000000000000000n, blockNumber: 90 }),
    getTransactionReceipt: async () => ({ status: '0x1', blockNumber: 90, logs: [] }),
    getBlockNumber: async () => 110,
    getBlockTimestamp: async () => nowSec,
  };
}

describe('grantOrder 会员发放', () => {
  it('verified → active：写权益、enqueue 三类 outbox、立即投递 R2', async () => {
    const order = await makeOrder({ status: 'verified' });
    const res = await grantOrder(db, env, order.id);
    expect(res.granted).toBe(true);
    expect(res.order.status).toBe('active');
    expect(res.order.granted_at).not.toBeNull();

    const ent = await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(WALLET).first<WalletEntitlementRow>();
    expect(ent!.membership_tier).toBe('month');
    expect(ent!.entitlement_version).toBe(1);
    const expectedExpiry = Date.now() + 30 * 86_400_000;
    expect(Math.abs(Date.parse(ent!.membership_expires_at!) - expectedExpiry)).toBeLessThan(60_000);

    expect(bucket.hasKey(walletSnapshotKey(WALLET))).toBe(true);
    expect(bucket.hasKey(orderReceiptKey(order.id))).toBe(true);
    const outbox = await db.prepare('SELECT COUNT(*) AS n FROM payment_outbox WHERE status = \'pending\'').first<{ n: number }>();
    expect(outbox!.n).toBe(0);
  });

  it('续费顺延：未到期从当前到期累加；已到期从 now 重算', async () => {
    // 未到期顺延
    await db
      .prepare("INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', ?, 1, ?)")
      .bind(WALLET, '2027-06-01T00:00:00.000Z', new Date().toISOString())
      .run();
    const o1 = await makeOrder({ status: 'verified', kind: 'membership_year', duration_days: 365, tx_hash: '0x' + '11'.repeat(32) });
    await grantOrder(db, env, o1.id);
    let ent = (await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(WALLET).first<WalletEntitlementRow>())!;
    expect(ent.membership_tier).toBe('year');
    expect(ent.membership_expires_at).toBe('2028-05-31T00:00:00.000Z'); // 2027-06-01 + 365 天（跨 2028 闰年 2/29）
    expect(ent.entitlement_version).toBe(2);

    // 已到期重算
    await db.prepare("UPDATE wallet_entitlements SET membership_expires_at = '2020-01-01T00:00:00.000Z' WHERE wallet_address = ?").bind(WALLET).run();
    const o2 = await makeOrder({ status: 'verified', duration_days: 30, tx_hash: '0x' + '22'.repeat(32) });
    await grantOrder(db, env, o2.id);
    ent = (await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(WALLET).first<WalletEntitlementRow>())!;
    expect(Math.abs(Date.parse(ent.membership_expires_at!) - (Date.now() + 30 * 86_400_000))).toBeLessThan(60_000);
    expect(ent.entitlement_version).toBe(3);
  });

  it('幂等：active 订单重复发放不重复加权益', async () => {
    const order = await makeOrder({ status: 'verified' });
    await grantOrder(db, env, order.id);
    const entBefore = (await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(WALLET).first<WalletEntitlementRow>())!;
    const outboxCount = (await db.prepare('SELECT COUNT(*) AS n FROM payment_outbox').first<{ n: number }>())!.n;

    const again = await grantOrder(db, env, order.id);
    expect(again.order.status).toBe('active');
    const entAfter = (await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(WALLET).first<WalletEntitlementRow>())!;
    expect(entAfter.entitlement_version).toBe(entBefore.entitlement_version);
    expect(entAfter.membership_expires_at).toBe(entBefore.membership_expires_at);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM payment_outbox').first<{ n: number }>())!.n).toBe(outboxCount);
  });

  it('非 verified/granting 状态不发放', async () => {
    const order = await makeOrder({ status: 'submitted' });
    const res = await grantOrder(db, env, order.id);
    expect(res.granted).toBe(false);
    expect(res.order.status).toBe('submitted');
  });
});

describe('grantOrder 扩群并发规则（契约 §4）', () => {
  it('currentTier == from_tier → 正常授予', async () => {
    const order = await makeOrder({ status: 'verified', kind: 'group_capacity', group_id: 'grp1', from_tier: 50, to_tier: 200, amount: '25000000000000000000' });
    const res = await grantOrder(db, env, order.id);
    expect(res.order.status).toBe('active');
    const cap = (await db.prepare('SELECT * FROM group_capacity_entitlements WHERE group_id = \'grp1\'').first<GroupCapacityEntitlementRow>())!;
    expect(cap.capacity_tier).toBe(200);
    expect(cap.last_order_id).toBe(order.id);
    expect(bucket.hasKey(groupSnapshotKey('grp1'))).toBe(true);
  });

  it('currentTier >= to_tier → manual_review(tier_changed) + 审计', async () => {
    await db
      .prepare("INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES ('grp2', 300, 1, ?)")
      .bind(new Date().toISOString())
      .run();
    const order = await makeOrder({ status: 'verified', kind: 'group_capacity', group_id: 'grp2', from_tier: 50, to_tier: 200, amount: '25000000000000000000' });
    const res = await grantOrder(db, env, order.id);
    expect(res.granted).toBe(false);
    expect(res.order.status).toBe('manual_review');
    expect(res.order.status_reason).toBe('tier_changed');
    const audit = await db.prepare("SELECT * FROM payment_audit_log WHERE action = 'manual_review' AND target = ?").bind(order.id).first<{ actor: string }>();
    expect(audit).not.toBeNull();
  });

  it('from_tier < currentTier < to_tier：已付 ≥ 新差价 → 授予（不多收）', async () => {
    // 订单按 50→300 全价付了 45；期间另一单把群升到 100；新差价 = 45-10 = 35，已付 45 ≥ 35 → 授予
    await db
      .prepare("INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES ('grp3', 100, 2, ?)")
      .bind(new Date().toISOString())
      .run();
    const order = await makeOrder({ status: 'verified', kind: 'group_capacity', group_id: 'grp3', from_tier: 50, to_tier: 300, amount: '45000000000000000000' });
    const res = await grantOrder(db, env, order.id);
    expect(res.order.status).toBe('active');
    const cap = (await db.prepare("SELECT * FROM group_capacity_entitlements WHERE group_id = 'grp3'").first<GroupCapacityEntitlementRow>())!;
    expect(cap.capacity_tier).toBe(300);
  });

  it('from_tier < currentTier < to_tier：已付不足新差价 → manual_review(tier_changed_insufficient)', async () => {
    // 订单按 50→100 付了 10；期间群升到 200；目标 300 的新差价 = 45-25 = 20 > 10 → 人工
    await db
      .prepare("INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES ('grp4', 200, 2, ?)")
      .bind(new Date().toISOString())
      .run();
    const order = await makeOrder({ status: 'verified', kind: 'group_capacity', group_id: 'grp4', from_tier: 50, to_tier: 300, amount: '10000000000000000000' });
    const res = await grantOrder(db, env, order.id);
    expect(res.order.status).toBe('manual_review');
    expect(res.order.status_reason).toBe('tier_changed_insufficient');
  });
});

describe('grantOrder outbox 投递失败', () => {
  it('R2 故障 → 订单留 granting，outbox pending 带 last_error', async () => {
    const brokenEnv: Env = { DB: db, VOICE_BUCKET: { put: async () => { throw new Error('r2 down'); } } as unknown as R2Bucket };
    const order = await makeOrder({ status: 'verified' });
    const res = await grantOrder(db, brokenEnv, order.id);
    expect(res.granted).toBe(true); // 权益已写 D1
    expect(res.order.status).toBe('granting'); // 但 R2 未同步
    const ent = await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(WALLET).first<WalletEntitlementRow>();
    expect(ent!.membership_tier).toBe('month');
    const outbox = await db.prepare("SELECT * FROM payment_outbox WHERE status = 'pending'").all<{ last_error: string; attempts: number }>();
    expect(outbox.results.length).toBeGreaterThan(0);
    expect(outbox.results[0].last_error).toContain('r2 down');
    expect(outbox.results[0].attempts).toBe(1);

    // R2 恢复后 tick 重投 → active
    const tick = await runPaymentsTick(env);
    expect(tick.outboxDelivered).toBeGreaterThan(0);
    expect(tick.activated).toBe(1);
    const after = await db.prepare('SELECT status FROM payment_orders WHERE id = ?').bind(order.id).first<{ status: string }>();
    expect(after!.status).toBe('active');
  });
});

describe('runPaymentsTick', () => {
  it('过期 awaiting_payment 单批置 expired', async () => {
    await makeOrder({ status: 'awaiting_payment', expires_at: new Date(Date.now() - 1000).toISOString(), tx_hash: null });
    await makeOrder({ status: 'awaiting_payment', expires_at: new Date(Date.now() + 3600_000).toISOString(), tx_hash: null });
    const res = await runPaymentsTick(env);
    expect(res.expired).toBe(1);
    const rows = await db.prepare("SELECT status FROM payment_orders ORDER BY created_at").all<{ status: string }>();
    expect(rows.results.map((r) => r.status).sort()).toEqual(['awaiting_payment', 'expired']);
  });

  it('submitted 单重验 → verified → 发放 → active（一次 tick 全链路）', async () => {
    const order = await makeOrder({ status: 'submitted' });
    setPaymentChainClientFactoryForTests(() => stubOkClient());
    const res = await runPaymentsTick(env);
    expect(res.reverified).toBe(1);
    const after = await db.prepare('SELECT status FROM payment_orders WHERE id = ?').bind(order.id).first<{ status: string }>();
    expect(after!.status).toBe('active');
    expect(bucket.hasKey(walletSnapshotKey(WALLET))).toBe(true);
  });

  it('重复 tick 不重复发放（幂等）', async () => {
    const order = await makeOrder({ status: 'submitted' });
    setPaymentChainClientFactoryForTests(() => stubOkClient());
    await runPaymentsTick(env);
    const ent1 = (await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(WALLET).first<WalletEntitlementRow>())!;
    await runPaymentsTick(env);
    await runPaymentsTick(env);
    const ent2 = (await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(WALLET).first<WalletEntitlementRow>())!;
    expect(ent2.entitlement_version).toBe(ent1.entitlement_version);
    expect(ent2.membership_expires_at).toBe(ent1.membership_expires_at);
    const after = await db.prepare('SELECT status FROM payment_orders WHERE id = ?').bind(order.id).first<{ status: string }>();
    expect(after!.status).toBe('active');
  });

  it('对账：权益行存在但 R2 快照缺失 → enqueue outbox，下一 tick 投递', async () => {
    await db
      .prepare("INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', '2027-01-01T00:00:00.000Z', 5, ?)")
      .bind(WALLET, new Date().toISOString())
      .run();
    expect(bucket.hasKey(walletSnapshotKey(WALLET))).toBe(false);

    const t1 = await runPaymentsTick(env);
    expect(t1.reconciled).toBeGreaterThan(0);
    const pending = await db.prepare("SELECT COUNT(*) AS n FROM payment_outbox WHERE status = 'pending' AND kind = 'wallet_snapshot'").first<{ n: number }>();
    expect(pending!.n).toBe(1);

    const t2 = await runPaymentsTick(env);
    expect(t2.outboxDelivered).toBeGreaterThan(0);
    expect(bucket.hasKey(walletSnapshotKey(WALLET))).toBe(true);
    const obj = await bucket.get(walletSnapshotKey(WALLET));
    const snap = JSON.parse(await obj!.text()) as { entitlementVersion: number; membership: { tier: string } };
    expect(snap.entitlementVersion).toBe(5);
    expect(snap.membership.tier).toBe('month');
  });

  it('对账：R2 快照与 D1 一致时不重复 enqueue', async () => {
    const order = await makeOrder({ status: 'submitted' });
    setPaymentChainClientFactoryForTests(() => stubOkClient());
    await runPaymentsTick(env); // 发放 + 投递完成
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM payment_outbox').first<{ n: number }>())!.n;
    const t = await runPaymentsTick(env);
    expect(t.reconciled).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM payment_outbox').first<{ n: number }>())!.n).toBe(count);
  });
});
