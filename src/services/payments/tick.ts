// 支付 cron tick（契约 §4/§5）：过期单、批量重验、outbox 重投、R2 对账。
// 并发保护：UPDATE ... WHERE status=预期值 乐观占位，changes==0 即被别的 tick 拿走。

import type { Env } from '../../types';
import type { GroupCapacityEntitlementRow, PaymentOrderRow, WalletEntitlementRow } from '../../db/schema';
import { grantOrder } from './grant';
import { verifyAndMaybeGrant } from './flow';
import { buildGroupSnapshot, deliverPendingOutbox, enqueueOutbox, rebuildWalletSnapshot } from './outbox';
import { getEntitlementBucket, groupSnapshotKey, walletSnapshotKey } from './storage';

const REVERIFY_LIMIT = 10;
const OUTBOX_LIMIT = 20;
const RECONCILE_LIMIT = 10;

export interface PaymentsTickResult {
  expired: number;
  reverified: number;
  outboxDelivered: number;
  outboxFailed: number;
  activated: number;
  reconciled: number;
  errors: string[];
}

async function snapshotMatchesR2(env: Env, key: string, payload: Record<string, unknown>): Promise<boolean> {
  const obj = await getEntitlementBucket(env).get(key);
  if (!obj) return false;
  try {
    return (await obj.text()) === JSON.stringify(payload);
  } catch {
    return false;
  }
}

export async function runPaymentsTick(env: Env): Promise<PaymentsTickResult> {
  const db = env.DB;
  const now = new Date().toISOString();
  const result: PaymentsTickResult = {
    expired: 0,
    reverified: 0,
    outboxDelivered: 0,
    outboxFailed: 0,
    activated: 0,
    reconciled: 0,
    errors: [],
  };

  // ① awaiting_payment 过期单批置 expired
  const expired = await db
    .prepare("UPDATE payment_orders SET status = 'expired', updated_at = ? WHERE status = 'awaiting_payment' AND expires_at <= ?")
    .bind(now, now)
    .run();
  result.expired = expired.meta.changes ?? 0;

  // ② submitted/confirming 批量重验（每 tick 上限 10 笔）
  const pending = await db
    .prepare("SELECT id FROM payment_orders WHERE status IN ('submitted', 'confirming') ORDER BY updated_at ASC LIMIT ?")
    .bind(REVERIFY_LIMIT)
    .all<{ id: string }>();
  for (const { id } of pending.results) {
    // 乐观占位
    const claim = await db
      .prepare("UPDATE payment_orders SET updated_at = ? WHERE id = ? AND status IN ('submitted', 'confirming')")
      .bind(new Date().toISOString(), id)
      .run();
    if ((claim.meta.changes ?? 0) === 0) continue;
    try {
      const order = await db.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(id).first<PaymentOrderRow>();
      if (!order) continue;
      const verify = await verifyAndMaybeGrant(db, env, order);
      if (verify) result.reverified++;
    } catch (err: any) {
      result.errors.push(`verify ${id}: ${err?.message ?? String(err)}`);
    }
  }

  // ③ granting 订单关联 outbox 重投 R2（上限 20 条）
  const outbox = await deliverPendingOutbox(db, env, OUTBOX_LIMIT);
  result.outboxDelivered = outbox.delivered;
  result.outboxFailed = outbox.failed;

  // granting 且关联 outbox 全部 done → active（契约 §4：active = 权益已写 D1 + outbox 已投递）
  const granting = await db
    .prepare("SELECT * FROM payment_orders WHERE status = 'granting' ORDER BY updated_at ASC LIMIT 10")
    .all<PaymentOrderRow>();
  for (const order of granting.results) {
    const remaining = await db
      .prepare("SELECT COUNT(*) AS n FROM payment_outbox WHERE status = 'pending' AND ref_key IN (?, ?, ?)")
      .bind(order.id, order.wallet_address, order.group_id ?? '')
      .first<{ n: number }>();
    if ((remaining?.n ?? 0) > 0) continue;
    const claim = await db
      .prepare("UPDATE payment_orders SET status = 'active', granted_at = COALESCE(granted_at, ?), updated_at = ? WHERE id = ? AND status = 'granting'")
      .bind(now, now, order.id)
      .run();
    result.activated += claim.meta.changes ?? 0;
  }

  // ④ 对账：抽查权益表与 R2 快照一致性，不一致重建并 enqueue outbox（轮换扫描：最久未更新优先）
  const perTable = Math.max(1, Math.floor(RECONCILE_LIMIT / 2));
  const wallets = await db
    .prepare('SELECT wallet_address FROM wallet_entitlements ORDER BY updated_at ASC LIMIT ?')
    .bind(perTable)
    .all<Pick<WalletEntitlementRow, 'wallet_address'>>();
  for (const { wallet_address } of wallets.results) {
    try {
      const snapshot = await rebuildWalletSnapshot(db, wallet_address);
      if (!(await snapshotMatchesR2(env, walletSnapshotKey(wallet_address), snapshot))) {
        await enqueueOutbox(db, 'wallet_snapshot', wallet_address, snapshot);
        result.reconciled++;
      }
    } catch (err: any) {
      result.errors.push(`reconcile wallet ${wallet_address}: ${err?.message ?? String(err)}`);
    }
  }
  const groups = await db
    .prepare('SELECT * FROM group_capacity_entitlements ORDER BY updated_at ASC LIMIT ?')
    .bind(perTable)
    .all<GroupCapacityEntitlementRow>();
  for (const row of groups.results) {
    try {
      const snapshot = buildGroupSnapshot(row);
      if (!(await snapshotMatchesR2(env, groupSnapshotKey(row.group_id), snapshot))) {
        await enqueueOutbox(db, 'group_snapshot', row.group_id, snapshot);
        result.reconciled++;
      }
    } catch (err: any) {
      result.errors.push(`reconcile group ${row.group_id}: ${err?.message ?? String(err)}`);
    }
  }

  return result;
}
