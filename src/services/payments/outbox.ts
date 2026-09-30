// D1→R2 异步同步 outbox（契约 §1/§4）：权益变更先写 D1 + outbox(pending)，由同步流程投递 R2。
// 快照 JSON 格式见契约 §2。

import type {
  GroupCapacityEntitlementRow,
  PaymentOrderRow,
  WalletEntitlementRow,
} from '../../db/schema';
import type { Env } from '../../types';
import { getActiveConfig, isWhitelisted, WHITELIST_MEMBERSHIP } from './config';
import { getEntitlementBucket, groupSnapshotKey, orderReceiptKey, walletSnapshotKey } from './storage';

export async function enqueueOutbox(
  db: D1Database,
  kind: 'wallet_snapshot' | 'group_snapshot' | 'order_receipt',
  refKey: string,
  payload: unknown
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO payment_outbox (kind, ref_key, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .bind(kind, refKey, JSON.stringify(payload), 'pending', now, now)
    .run();
}

export interface WalletGroupsSnapshot {
  [groupId: string]: { capacity: number; version: number; updatedAt: string };
}

// 钱包权益快照 JSON（契约 §2，客户端缓存同构）。
// groups 映射覆盖该钱包名下的群（群主视角）：capacity/version/updatedAt。
// 契约 §13：白名单钱包的 membership 字段覆盖为永久会员哨兵（D1 不写假行）。
export function buildWalletSnapshot(
  row: WalletEntitlementRow,
  groups: WalletGroupsSnapshot = {},
  opts: { whitelisted?: boolean } = {}
): Record<string, unknown> {
  const expiresAt = row.membership_expires_at;
  const active = !!row.membership_tier && !!expiresAt && Date.parse(expiresAt) > Date.now();
  return {
    schemaVersion: 1,
    entitlementVersion: row.entitlement_version,
    walletAddress: row.wallet_address,
    membership: opts.whitelisted
      ? { ...WHITELIST_MEMBERSHIP }
      : {
          tier: row.membership_tier,
          expiresAt,
          active,
        },
    groups,
    updatedAt: row.updated_at,
  };
}

// 群容量快照 JSON（契约 §2）。
export function buildGroupSnapshot(row: GroupCapacityEntitlementRow): Record<string, unknown> {
  return {
    schemaVersion: 1,
    entitlementVersion: row.entitlement_version,
    groupId: row.group_id,
    capacity: row.capacity_tier,
    lastOrderId: row.last_order_id,
    revokedAt: row.revoked_at,
    updatedAt: row.updated_at,
  };
}

// 订单凭证 JSON（契约 §2）。
export function buildOrderReceipt(order: PaymentOrderRow, logIndex: number | null): Record<string, unknown> {
  return {
    schemaVersion: 1,
    orderId: order.id,
    walletAddress: order.wallet_address,
    groupId: order.group_id ?? undefined,
    kind: order.kind,
    chainId: order.chain_id,
    txHash: order.tx_hash,
    logIndex: logIndex ?? undefined,
    amount: order.amount,
    tokenType: order.token_type,
    tokenAddress: order.token_address ?? undefined,
    tokenSymbol: order.token_symbol,
    recipientAddress: order.recipient_address,
    confirmedAt: order.confirmed_at,
    blockNumber: order.tx_block_number,
    status: order.status,
  };
}

// 从 D1 重建钱包完整快照（含名下群容量映射），供 /entitlements/me miss 重建与对账使用。
// 契约 §13：白名单钱包按 active 配置覆盖 membership 为永久会员哨兵。
export async function rebuildWalletSnapshot(db: D1Database, wallet: string): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  let row = await db
    .prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?')
    .bind(wallet)
    .first<WalletEntitlementRow>();
  if (!row) {
    row = { wallet_address: wallet, membership_tier: null, membership_expires_at: null, entitlement_version: 1, updated_at: now };
  }
  const activeConfig = await getActiveConfig(db);
  const whitelisted = isWhitelisted(activeConfig?.payload, wallet);
  const ownedGroups = await db
    .prepare(
      `SELECT c.id AS group_id, g.capacity_tier, g.entitlement_version, g.updated_at
       FROM conversations c
       LEFT JOIN group_capacity_entitlements g ON g.group_id = c.id
       WHERE c.type IN ('group','club') AND c.owner_address = ?`
    )
    .bind(wallet)
    .all<{ group_id: string; capacity_tier: number | null; entitlement_version: number | null; updated_at: string | null }>();
  const groups: WalletGroupsSnapshot = {};
  for (const g of ownedGroups.results) {
    groups[g.group_id] = {
      capacity: g.capacity_tier ?? 50,
      version: g.entitlement_version ?? 1,
      updatedAt: g.updated_at ?? now,
    };
  }
  return buildWalletSnapshot(row, groups, { whitelisted });
}

function outboxKey(kind: string, refKey: string): string | null {
  if (kind === 'wallet_snapshot') return walletSnapshotKey(refKey);
  if (kind === 'group_snapshot') return groupSnapshotKey(refKey);
  if (kind === 'order_receipt') return orderReceiptKey(refKey);
  return null;
}

// 投递单条 outbox 到 R2。成功 → done；失败 → attempts+1/last_error，超过 50 次置 failed。
// 返回 true 表示该条已投递成功。
export async function deliverOutboxRow(
  db: D1Database,
  env: Env,
  row: { id: number; kind: string; ref_key: string; payload_json: string; attempts: number }
): Promise<boolean> {
  const key = outboxKey(row.kind, row.ref_key);
  const now = new Date().toISOString();
  if (!key) {
    await db
      .prepare("UPDATE payment_outbox SET status = 'failed', last_error = 'unknown_kind', updated_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();
    return false;
  }
  try {
    await getEntitlementBucket(env).put(key, row.payload_json, {
      httpMetadata: { contentType: 'application/json' },
    });
    await db
      .prepare("UPDATE payment_outbox SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();
    return true;
  } catch (err: any) {
    const attempts = row.attempts + 1;
    const status = attempts > 50 ? 'failed' : 'pending';
    await db
      .prepare('UPDATE payment_outbox SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .bind(status, attempts, err?.message ?? String(err), now, row.id)
      .run();
    return false;
  }
}

// 批量投递 pending outbox（cron / 发放后立即投递共用）。
export async function deliverPendingOutbox(db: D1Database, env: Env, limit = 20): Promise<{ delivered: number; failed: number }> {
  const rows = await db
    .prepare("SELECT * FROM payment_outbox WHERE status = 'pending' ORDER BY id LIMIT ?")
    .bind(limit)
    .all<{ id: number; kind: string; ref_key: string; payload_json: string; attempts: number }>();
  let delivered = 0;
  let failed = 0;
  for (const row of rows.results) {
    // 乐观占位：已被别的 tick 拿走（status 变化）则跳过
    const claim = await db
      .prepare("UPDATE payment_outbox SET updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(new Date().toISOString(), row.id)
      .run();
    if ((claim.meta.changes ?? 0) === 0) continue;
    if (await deliverOutboxRow(db, env, row)) delivered++;
    else failed++;
  }
  return { delivered, failed };
}
