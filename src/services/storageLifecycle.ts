// 存储生命周期管理：无界增长表的保留期清理（D1 行 + R2 对象同步删）。
// 每类目标批量上限 500，幂等可重入；支持 targets 子集与 dryRun（只计数不写库/不删 R2）。
// 时间列格式（以 migrations 为准）：sessions/nonces/group_join_requests/group_invite_links/
// report_evidence/feed_posts/club_applications 为 INTEGER ms（Date.now()）；
// payment_outbox/payment_verify_attempts 为 TEXT ISO（new Date().toISOString()，字典序可比）。

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 500;

export const STORAGE_LIFECYCLE_TARGETS = [
  'sessions',
  'nonces',
  'group_join_requests',
  'group_invite_links',
  'report_evidence_orphans',
  'feed_posts',
  'payment_outbox',
  'payment_verify_attempts',
  'club_applications',
] as const;

export type StorageLifecycleTarget = (typeof STORAGE_LIFECYCLE_TARGETS)[number];

export function isStorageLifecycleTarget(name: string): name is StorageLifecycleTarget {
  return (STORAGE_LIFECYCLE_TARGETS as readonly string[]).includes(name);
}

/** stats 端点展示用：纳入生命周期管理的 D1 表（report_evidence_orphans 对应 report_evidence）。 */
export const STORAGE_LIFECYCLE_TABLES = [
  'sessions',
  'nonces',
  'group_join_requests',
  'group_invite_links',
  'report_evidence',
  'feed_posts',
  'payment_outbox',
  'payment_verify_attempts',
  'club_applications',
] as const;

export interface StorageLifecycleOptions {
  targets?: string[];
  dryRun?: boolean;
}

export type StorageLifecycleResult = Partial<Record<StorageLifecycleTarget, number>>;

interface SqlCondition {
  sql: string;
  params: unknown[];
}

/** 各纯 D1 目标的过滤条件（now = Date.now() 毫秒）。 */
function simpleCondition(target: StorageLifecycleTarget, now: number): SqlCondition {
  switch (target) {
    case 'sessions':
      // 过期后再保留 7 天宽限
      return { sql: 'expires_at < ?', params: [now - 7 * DAY_MS] };
    case 'nonces':
      return { sql: 'expires_at <= ?', params: [now] };
    case 'group_join_requests':
      // 已处理 >90 天；pending 超时未处理 >30 天
      return {
        sql: "(status != 'pending' AND handled_at IS NOT NULL AND handled_at < ?) OR (status = 'pending' AND created_at < ?)",
        params: [now - 90 * DAY_MS, now - 30 * DAY_MS],
      };
    case 'group_invite_links':
      // （已过期 或 次数用尽）且创建 >30 天
      return {
        sql: '((expires_at IS NOT NULL AND expires_at <= ?) OR (max_uses IS NOT NULL AND uses_count >= max_uses)) AND created_at < ?',
        params: [now, now - 30 * DAY_MS],
      };
    case 'payment_outbox':
      // TEXT ISO；done >30 天（payment_orders/payment_tx_claims 财务凭证不碰）
      return { sql: "status = 'done' AND updated_at < ?", params: [new Date(now - 30 * DAY_MS).toISOString()] };
    case 'payment_verify_attempts':
      return { sql: 'created_at < ?', params: [new Date(now - 90 * DAY_MS).toISOString()] };
    case 'club_applications':
      return {
        sql: "status != 'pending' AND handled_at IS NOT NULL AND handled_at < ?",
        params: [now - 180 * DAY_MS],
      };
    default:
      throw new Error(`not a simple target: ${target}`);
  }
}

async function countWhere(db: D1Database, table: string, cond: SqlCondition): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${cond.sql}`)
    .bind(...cond.params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function deleteWhereBatch(db: D1Database, table: string, cond: SqlCondition): Promise<number> {
  const res = await db
    .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${cond.sql} LIMIT ?)`)
    .bind(...cond.params, BATCH_LIMIT)
    .run();
  return res.meta?.changes ?? 0;
}

/** 某目标当前可清理的行数估算（dryRun / stats 用，封顶单批上限）。 */
export async function countPendingCleanup(db: D1Database, target: StorageLifecycleTarget, now = Date.now()): Promise<number> {
  if (target === 'report_evidence_orphans') {
    const n = await countWhere(db, 'report_evidence', {
      sql: 'report_id IS NULL AND created_at < ?',
      params: [now - DAY_MS],
    });
    return Math.min(n, BATCH_LIMIT);
  }
  if (target === 'feed_posts') {
    const n = await countWhere(db, 'feed_posts', {
      sql: 'is_deleted = 1 AND created_at < ?',
      params: [now - 30 * DAY_MS],
    });
    return Math.min(n, BATCH_LIMIT);
  }
  const n = await countWhere(db, target, simpleCondition(target, now));
  return Math.min(n, BATCH_LIMIT);
}

async function deleteR2Keys(bucket: R2Bucket | undefined, keys: string[]): Promise<number> {
  if (!bucket || keys.length === 0) return 0;
  let deleted = 0;
  const CHUNK_SIZE = 50;
  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    const chunk = keys.slice(i, i + CHUNK_SIZE);
    try {
      await bucket.delete(chunk);
      deleted += chunk.length;
    } catch {
      const settled = await Promise.allSettled(
        chunk.map(async (key) => {
          await bucket.delete(key);
        })
      );
      for (const res of settled) {
        if (res.status === 'fulfilled') {
          deleted++;
        } else {
          console.error('storageLifecycle: failed to delete R2 object:', res.reason);
        }
      }
    }
  }
  return deleted;
}

/** 孤儿举报证据：report_id IS NULL 且上传 >24h，D1 行 + R2 对象（report-evidence/ 前缀）同删。 */
async function runReportEvidenceOrphans(db: D1Database, bucket: R2Bucket | undefined, dryRun: boolean, now: number): Promise<number> {
  const rows = await db
    .prepare('SELECT object_key FROM report_evidence WHERE report_id IS NULL AND created_at < ? LIMIT ?')
    .bind(now - DAY_MS, BATCH_LIMIT)
    .all<{ object_key: string }>();
  const keys = (rows.results ?? []).map((r) => r.object_key);
  if (dryRun || keys.length === 0) return keys.length;
  await deleteR2Keys(bucket, keys);
  const placeholders = keys.map(() => '?').join(', ');
  const res = await db
    .prepare(`DELETE FROM report_evidence WHERE object_key IN (${placeholders})`)
    .bind(...keys)
    .run();
  return res.meta?.changes ?? 0;
}

/** 软删动态：is_deleted=1 且创建 >30 天硬删（feed_likes FK CASCADE），并删 images JSON 数组里的 R2 对象（feed/ 前缀）。 */
async function runFeedPosts(db: D1Database, bucket: R2Bucket | undefined, dryRun: boolean, now: number): Promise<number> {
  const rows = await db
    .prepare('SELECT id, images FROM feed_posts WHERE is_deleted = 1 AND created_at < ? LIMIT ?')
    .bind(now - 30 * DAY_MS, BATCH_LIMIT)
    .all<{ id: string; images: string }>();
  const posts = rows.results ?? [];
  if (dryRun || posts.length === 0) return posts.length;
  const imageKeys: string[] = [];
  for (const post of posts) {
    try {
      const parsed = JSON.parse(post.images);
      if (Array.isArray(parsed)) imageKeys.push(...parsed.map((k) => String(k)));
    } catch (err) {
      console.error(`storageLifecycle: failed to parse images of feed post ${post.id}:`, err);
    }
  }
  await deleteR2Keys(bucket, imageKeys);
  const placeholders = posts.map(() => '?').join(', ');
  const res = await db
    .prepare(`DELETE FROM feed_posts WHERE id IN (${placeholders})`)
    .bind(...posts.map((p) => p.id))
    .run();
  return res.meta?.changes ?? 0;
}

export async function runStorageLifecycle(
  db: D1Database,
  bucket: R2Bucket | undefined,
  options: StorageLifecycleOptions = {}
): Promise<StorageLifecycleResult> {
  const now = Date.now();
  const dryRun = options.dryRun === true;
  const targets: StorageLifecycleTarget[] = (options.targets ?? STORAGE_LIFECYCLE_TARGETS).filter(
    (t): t is StorageLifecycleTarget => isStorageLifecycleTarget(t)
  );

  const result: StorageLifecycleResult = {};
  for (const target of targets) {
    let deleted: number;
    if (dryRun) {
      deleted = await countPendingCleanup(db, target, now);
    } else if (target === 'report_evidence_orphans') {
      deleted = await runReportEvidenceOrphans(db, bucket, false, now);
    } else if (target === 'feed_posts') {
      deleted = await runFeedPosts(db, bucket, false, now);
    } else {
      deleted = await deleteWhereBatch(db, target, simpleCondition(target, now));
    }
    result[target] = deleted;
    console.log(`storageLifecycle[${dryRun ? 'dry-run' : 'run'}] ${target}: ${deleted}`);
  }
  return result;
}
