// 权益发放器（契约 §4）：verified → granting → D1 写权益 + outbox → R2 投递完成 → active。
// 幂等：active 订单重复进入直接返回当前状态，不重复发放。

import type { Env } from '../../types';
import type {
  GroupCapacityEntitlementRow,
  PaymentOrderRow,
  PaymentTxClaimRow,
  WalletEntitlementRow,
} from '../../db/schema';
import { isGroupLike } from '../../db/schema';
import { computeMembershipExpiry, computeQuote, getConfigByVersion } from './config';
import { insertMemberWithCapacity } from './capacity';
import { writeAudit } from './audit';
import {
  buildGroupSnapshot,
  buildOrderReceipt,
  deliverPendingOutbox,
  enqueueOutbox,
  rebuildWalletSnapshot,
} from './outbox';

async function loadOrder(db: D1Database, id: string): Promise<PaymentOrderRow | null> {
  return db.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(id).first<PaymentOrderRow>();
}

async function setOrder(
  db: D1Database,
  id: string,
  status: PaymentOrderRow['status'],
  statusReason: string | null,
  grantedAt?: string
): Promise<void> {
  await db
    .prepare('UPDATE payment_orders SET status = ?, status_reason = ?, updated_at = ?, granted_at = COALESCE(?, granted_at) WHERE id = ?')
    .bind(status, statusReason, new Date().toISOString(), grantedAt ?? null, id)
    .run();
}

// 会员发放：从 max(now, 当前到期) 顺延 duration_days（契约 §0）
async function grantMembership(db: D1Database, order: PaymentOrderRow, nowIso: string): Promise<WalletEntitlementRow> {
  const wallet = order.wallet_address;
  const tier = order.duration_days === 365 ? 'year' : 'month';
  const existing = await db
    .prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?')
    .bind(wallet)
    .first<WalletEntitlementRow>();
  const expiresAt = computeMembershipExpiry(nowIso, existing?.membership_expires_at ?? null, order.duration_days ?? 30);
  if (existing) {
    await db
      .prepare('UPDATE wallet_entitlements SET membership_tier = ?, membership_expires_at = ?, entitlement_version = entitlement_version + 1, updated_at = ? WHERE wallet_address = ?')
      .bind(tier, expiresAt, nowIso, wallet)
      .run();
  } else {
    await db
      .prepare('INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, ?, ?, 1, ?)')
      .bind(wallet, tier, expiresAt, nowIso)
      .run();
  }
  return (await db.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?').bind(wallet).first<WalletEntitlementRow>())!;
}

// 扩群发放（契约 §4 并发规则）。返回 null 表示已授予，否则返回 manual_review 原因。
async function grantCapacity(db: D1Database, order: PaymentOrderRow, nowIso: string): Promise<string | null> {
  const groupId = order.group_id!;
  const fromTier = order.from_tier ?? 50;
  const toTier = order.to_tier!;
  const existing = await db
    .prepare('SELECT * FROM group_capacity_entitlements WHERE group_id = ?')
    .bind(groupId)
    .first<GroupCapacityEntitlementRow>();
  const currentTier = existing?.capacity_tier ?? 50;

  if (currentTier >= toTier) {
    return 'tier_changed'; // 档位已被其它订单覆盖，无法自动差额处理
  }
  if (currentTier > fromTier) {
    // from_tier < currentTier < to_tier：重算应付差价，已付 ≥ 新差价则授予（不多收），不足转人工
    const config = await getConfigByVersion(db, order.config_version);
    if (config) {
      const requoted = computeQuote(config, 'group_capacity', {
        currentTier,
        toTier,
        isMember: order.discount_bps > 0,
      });
      if (BigInt(order.amount) < BigInt(requoted.amount)) {
        return 'tier_changed_insufficient';
      }
    }
  }

  if (existing) {
    await db
      .prepare('UPDATE group_capacity_entitlements SET capacity_tier = ?, last_order_id = ?, revoked_at = NULL, revoke_reason = NULL, entitlement_version = entitlement_version + 1, updated_at = ? WHERE group_id = ?')
      .bind(toTier, order.id, nowIso, groupId)
      .run();
  } else {
    await db
      .prepare('INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, last_order_id, updated_at) VALUES (?, ?, 1, ?, ?)')
      .bind(groupId, toTier, order.id, nowIso)
      .run();
  }
  return null;
}

export interface GrantResult {
  order: PaymentOrderRow;
  granted: boolean;
}

// 付费进 club 发放：insertMemberWithCapacity 原子入群；容量满 → manual_review（不吞单）。
// 返回 null 表示已授予，否则返回 manual_review 原因。
async function grantClubJoin(db: D1Database, order: PaymentOrderRow): Promise<string | null> {
  const clubId = order.group_id;
  if (!clubId) return 'missing_group';
  const conv = await db
    .prepare('SELECT id, type FROM conversations WHERE id = ?')
    .bind(clubId)
    .first<{ id: string; type: string }>();
  if (!conv || !isGroupLike(conv.type)) return 'club_not_found';

  // conversation_members.user_id 有 FK：下单钱包可能尚未建 users 行，先兜底
  const now = Date.now();
  await db
    .prepare("INSERT OR IGNORE INTO users (id, wallet_address, public_metadata, private_metadata, created_at, updated_at) VALUES (?, ?, '{}', '{}', ?, ?)")
    .bind(order.wallet_address, order.wallet_address, now, now)
    .run();

  const joined = await insertMemberWithCapacity(db, clubId, order.wallet_address, 'member');
  if (!joined.ok) return 'capacity_full';
  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, clubId).run();
  return null;
}

// 发放主流程：verified/granting →（写权益 + outbox + 尝试投递）→ active 或留 granting 等 cron。
export async function grantOrder(db: D1Database, env: Env, orderId: string): Promise<GrantResult> {
  let order = await loadOrder(db, orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status === 'active') return { order, granted: true }; // 幂等
  if (order.status !== 'verified' && order.status !== 'granting') return { order, granted: false };

  // 乐观占位：并发 tick/请求只能有一个进入发放
  const claim = await db
    .prepare("UPDATE payment_orders SET status = 'granting', updated_at = ? WHERE id = ? AND status IN ('verified', 'granting')")
    .bind(new Date().toISOString(), order.id)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    return { order: (await loadOrder(db, orderId))!, granted: false };
  }

  const nowIso = new Date().toISOString();

  if (order.kind === 'group_capacity') {
    const reviewReason = await grantCapacity(db, order, nowIso);
    if (reviewReason) {
      await setOrder(db, order.id, 'manual_review', reviewReason);
      await writeAudit(db, 'system', 'manual_review', order.id, { reason: reviewReason });
      return { order: (await loadOrder(db, orderId))!, granted: false };
    }
  } else if (order.kind === 'club_join') {
    const reviewReason = await grantClubJoin(db, order);
    if (reviewReason) {
      await setOrder(db, order.id, 'manual_review', reviewReason);
      await writeAudit(db, 'system', 'manual_review', order.id, { reason: reviewReason });
      return { order: (await loadOrder(db, orderId))!, granted: false };
    }
  } else if (order.kind === 'feed_post') {
    // 动态发布付费订单：无权益可发放——订单 active 即支付凭证，
    // 发帖时由 clubs 路由原子消费（active → consumed，一次一帖）。
  } else {
    await grantMembership(db, order, nowIso);
  }

  // outbox：钱包快照 + 订单凭证；扩群另加群快照
  order = (await loadOrder(db, orderId))!;
  const claimRow = await db
    .prepare('SELECT * FROM payment_tx_claims WHERE chain_id = ? AND tx_hash = ?')
    .bind(order.chain_id, order.tx_hash ?? '')
    .first<PaymentTxClaimRow>();
  const walletSnapshot = await rebuildWalletSnapshot(db, order.wallet_address);
  await enqueueOutbox(db, 'wallet_snapshot', order.wallet_address, walletSnapshot);
  if (order.group_id) {
    const groupRow = await db
      .prepare('SELECT * FROM group_capacity_entitlements WHERE group_id = ?')
      .bind(order.group_id)
      .first<GroupCapacityEntitlementRow>();
    if (groupRow) await enqueueOutbox(db, 'group_snapshot', order.group_id, buildGroupSnapshot(groupRow));
  }
  await enqueueOutbox(db, 'order_receipt', order.id, buildOrderReceipt(order, claimRow?.log_index ?? null));

  // 尝试立即投递；全部成功 → active，否则留 granting 等 cron 重试（契约 §4）
  await deliverPendingOutbox(db, env, 50);
  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM payment_outbox
       WHERE status = 'pending' AND ref_key IN (?, ?, ?)`
    )
    .bind(order.id, order.wallet_address, order.group_id ?? '')
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) === 0) {
    await setOrder(db, order.id, 'active', null, nowIso);
  }
  return { order: (await loadOrder(db, orderId))!, granted: true };
}
