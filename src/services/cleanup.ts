export interface CleanupResult {
  purged_messages: number;
  deleted_voice_objects: number;
  deleted_image_objects: number;
  deleted_file_objects: number;
  deleted_media_objects: number;
  timestamp: number;
}

// D1/SQLite 绑定变量上限保守取 50：id IN (...) 分块执行
const BIND_CHUNK = 50;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function sweepExpiredMessages(
  db: D1Database,
  r2: R2Bucket | undefined,
  batchSize = 500
): Promise<CleanupResult> {
  const now = Date.now();

  let deletedVoiceObjects = 0;
  let deletedImageObjects = 0;
  let deletedFileObjects = 0;

  // 阅后即焚完成分支（仅在 retention='on_read' 的少量行上评估相关子查询，
  // 由部分索引 idx_messages_retention_on_read 支撑）。
  const burnOnReadFilter = `
    m.retention = 'on_read'
    AND (
      SELECT COUNT(*) FROM conversation_members cm
      WHERE cm.conversation_id = m.conversation_id AND cm.user_id != m.sender_id
    ) > 0
    AND (
      SELECT COUNT(DISTINCT mr.user_id) FROM message_receipts mr
      WHERE mr.message_id = m.id AND mr.status = 'read'
    ) >= (
      SELECT COUNT(*) FROM conversation_members cm
      WHERE cm.conversation_id = m.conversation_id AND cm.user_id != m.sender_id
    )
    AND (
      SELECT MAX(mr.timestamp) FROM message_receipts mr
      WHERE mr.message_id = m.id AND mr.status = 'read'
    ) <= (? - (COALESCE(m.burn_after_seconds, 30) * 1000))
  `;

  // 拆成两个独立过滤（原 OR 让 SQLite 无法用索引，退化为每分钟全表扫描 + 逐行相关子查询）：
  // A. 纯过期 expires_at <= now → idx_messages_expires_at；优先占满本轮批量预算。
  // B. 阅后即焚完成 → 部分索引，使用剩余预算；本轮总量仍不超过 batchSize。
  const expiredByTime = await db.prepare(`
    SELECT m.id FROM messages m WHERE m.expires_at <= ? LIMIT ?
  `).bind(now, batchSize).all<{ id: string }>();

  const remaining = Math.max(0, batchSize - expiredByTime.results.length);
  const burnedOnRead = remaining > 0
    ? await db.prepare(`
        SELECT m.id FROM messages m WHERE ${burnOnReadFilter} LIMIT ?
      `).bind(now, remaining).all<{ id: string }>()
    : { results: [] as { id: string }[] };

  const expiredIds = [
    ...expiredByTime.results.map((r) => r.id),
    ...burnedOnRead.results.map((r) => r.id),
  ];

  let purgedCount = 0;

  if (expiredIds.length > 0) {
    if (r2) {
      // 1-3. 找出待删消息的媒体对象，从 R2 移除（按 id IN 分块，走 message_id 索引）
      const mediaTables = [
        { table: 'voice_messages', onDelete: () => deletedVoiceObjects++ },
        { table: 'image_messages', onDelete: () => deletedImageObjects++ },
        { table: 'file_messages', onDelete: () => deletedFileObjects++ },
      ] as const;

      for (const { table, onDelete } of mediaTables) {
        for (const ids of chunked(expiredIds, BIND_CHUNK)) {
          const placeholders = ids.map(() => '?').join(',');
          const rowsRes = await db.prepare(`
            SELECT object_key FROM ${table} WHERE message_id IN (${placeholders})
          `).bind(...ids).all<{ object_key: string }>();

          const keys = (rowsRes.results ?? []).map((r) => r.object_key).filter(Boolean);
          if (keys.length > 0) {
            try {
              await r2.delete(keys);
              for (let i = 0; i < keys.length; i++) onDelete();
            } catch {
              const settled = await Promise.allSettled(
                keys.map(async (key) => {
                  await r2.delete(key);
                  onDelete();
                })
              );
              for (const res of settled) {
                if (res.status === 'rejected') {
                  console.error('cleanup: failed to delete R2 object:', res.reason);
                }
              }
            }
          }
        }
      }
    }

    // 4. Delete expired message records from D1 (cascade deletes child rows)
    for (const ids of chunked(expiredIds, BIND_CHUNK)) {
      const placeholders = ids.map(() => '?').join(',');
      const deleteRes = await db.prepare(`
        DELETE FROM messages WHERE id IN (${placeholders})
      `).bind(...ids).run();
      purgedCount += deleteRes.meta?.changes ?? 0;
    }
  }

  return {
    purged_messages: purgedCount,
    deleted_voice_objects: deletedVoiceObjects,
    deleted_image_objects: deletedImageObjects,
    deleted_file_objects: deletedFileObjects,
    deleted_media_objects: deletedVoiceObjects + deletedImageObjects + deletedFileObjects,
    timestamp: now,
  };
}
