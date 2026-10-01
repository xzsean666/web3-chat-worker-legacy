// 群容量强制执行（契约 §8）：group_capacity_entitlements 是唯一权威来源（无行 = 免费 50 人档）。
// 所有入群路径统一走 insertMemberWithCapacity 的条件 INSERT，原子判定容量。

import type { GroupCapacityEntitlementRow } from '../../db/schema';
import { getActiveConfig } from './config';

export const FREE_CAPACITY = 50;
export const STANDARD_MAX_CAPACITY = 500;
export const SUPERGROUP_MAX_CAPACITY = 100_000;
export const MAX_CAPACITY = SUPERGROUP_MAX_CAPACITY;
export const DEFAULT_TIERS = [100, 200, 300, 400, 500];
export const SUPERGROUP_TIERS = [1000, 2000, 5000, 10000, 50000, 100000];

export interface GroupCapacityInfo {
  capacity: number;
  tier: number;
  memberCount: number;
  isSupergroup?: boolean;
}

export interface GroupCapacityFull extends GroupCapacityInfo {
  nextTier: number | null;
}

// 契约 §8 唯一判定函数：capacity = group_capacity_entitlements.capacity_tier（无行 = 50），且受群自定义 max_members 上限约束
export async function getGroupCapacityInfo(db: D1Database, groupId: string): Promise<GroupCapacityInfo> {
  const row = await db
    .prepare('SELECT capacity_tier FROM group_capacity_entitlements WHERE group_id = ?')
    .bind(groupId)
    .first<Pick<GroupCapacityEntitlementRow, 'capacity_tier'>>();
  let capacity = row?.capacity_tier ?? FREE_CAPACITY;
  let isSupergroup = capacity > STANDARD_MAX_CAPACITY;

  try {
    const convRow = await db
      .prepare('SELECT metadata FROM conversations WHERE id = ?')
      .bind(groupId)
      .first<{ metadata: string }>();
    if (convRow?.metadata) {
      const meta = JSON.parse(convRow.metadata);
      if (meta.is_supergroup === true || meta.supergroup === true) {
        isSupergroup = true;
      }
      if (typeof meta.max_members === 'number' && meta.max_members > 0) {
        capacity = Math.min(capacity, meta.max_members);
      }
    }
  } catch {}

  const memberCount =
    (await db
      .prepare('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?')
      .bind(groupId)
      .first<{ n: number }>())?.n ?? 0;
  return { capacity, tier: row?.capacity_tier ?? FREE_CAPACITY, memberCount, isSupergroup };
}

// 下一可购档：配置档中第一个 > 当前容量者；无配置用默认档表；已到上限为 null
export async function computeNextTier(
  db: D1Database,
  capacity: number,
  isSupergroup?: boolean
): Promise<number | null> {
  const active = await getActiveConfig(db);
  const tiers =
    active?.payload.capacityTiers?.map((t) => t.tier) ??
    (isSupergroup ? [...DEFAULT_TIERS, ...SUPERGROUP_TIERS] : DEFAULT_TIERS);
  return tiers.find((t) => t > capacity) ?? null;
}

// 容量错误结果（契约 §6 错误码）：403 {error:'GROUP_CAPACITY_REACHED', memberCount, capacity, nextTier}
export function capacityErrorResult(info: GroupCapacityFull): Record<string, unknown> {
  return {
    error: 'GROUP_CAPACITY_REACHED',
    memberCount: info.memberCount,
    capacity: info.capacity,
    nextTier: info.nextTier,
  };
}

// service 层抛出的容量错误；路由层 instanceof 判定后映射 403 结构化响应
export class GroupCapacityError extends Error {
  readonly info: GroupCapacityFull;
  constructor(info: GroupCapacityFull) {
    super('GROUP_CAPACITY_REACHED');
    this.name = 'GroupCapacityError';
    this.info = info;
  }
}

export type InsertMemberResult = { ok: true; already?: boolean } | { ok: false; info: GroupCapacityFull };

// 原子条件插入（契约 §8）：INSERT ... SELECT ... WHERE 当前人数 < 容量。
// changes==0 → 先查是否已是成员（幂等 already），否则容量满返回结构化信息。
export async function insertMemberWithCapacity(
  db: D1Database,
  convId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member'
): Promise<InsertMemberResult> {
  const info = await getGroupCapacityInfo(db, convId);
  const res = await db
    .prepare(
      `INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at)
       SELECT ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?) < ?`
    )
    .bind(`${convId}:${userId}`, convId, userId, role, Date.now(), convId, info.capacity)
    .run();
  if ((res.meta.changes ?? 0) > 0) return { ok: true };

  const existing = await db
    .prepare('SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(convId, userId)
    .first();
  if (existing) return { ok: true, already: true };

  const fresh = await getGroupCapacityInfo(db, convId);
  return { ok: false, info: { ...fresh, nextTier: await computeNextTier(db, fresh.capacity, fresh.isSupergroup) } };
}
