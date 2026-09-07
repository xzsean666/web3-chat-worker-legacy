export interface CleanupResult {
  purged_messages: number;
  deleted_voice_objects: number;
  deleted_image_objects: number;
  deleted_file_objects: number;
  deleted_media_objects: number;
  timestamp: number;
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

  // Subquery condition for expired messages OR completed burn-on-read messages past viewing window
  const expiredFilter = `
    m.expires_at <= ?
    OR (
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
    )
  `;

  if (r2) {
    // 1. Find expired voice messages so we can remove objects from R2
    const voiceRowsRes = await db.prepare(`
      SELECT vm.object_key, vm.message_id
      FROM voice_messages vm
      JOIN messages m ON m.id = vm.message_id
      WHERE ${expiredFilter}
      LIMIT ?
    `).bind(now, now, batchSize).all<{ object_key: string; message_id: string }>();

    for (const v of voiceRowsRes.results ?? []) {
      try {
        await r2.delete(v.object_key);
        deletedVoiceObjects++;
      } catch (err) {
        console.error(`Failed to delete R2 voice object ${v.object_key}:`, err);
      }
    }

    // 2. Find expired image messages so we can remove objects from R2
    const imageRowsRes = await db.prepare(`
      SELECT im.object_key, im.message_id
      FROM image_messages im
      JOIN messages m ON m.id = im.message_id
      WHERE ${expiredFilter}
      LIMIT ?
    `).bind(now, now, batchSize).all<{ object_key: string; message_id: string }>();

    for (const img of imageRowsRes.results ?? []) {
      try {
        await r2.delete(img.object_key);
        deletedImageObjects++;
      } catch (err) {
        console.error(`Failed to delete R2 image object ${img.object_key}:`, err);
      }
    }

    // 3. Find expired file messages so we can remove objects from R2
    const fileRowsRes = await db.prepare(`
      SELECT fm.object_key, fm.message_id
      FROM file_messages fm
      JOIN messages m ON m.id = fm.message_id
      WHERE ${expiredFilter}
      LIMIT ?
    `).bind(now, now, batchSize).all<{ object_key: string; message_id: string }>();

    for (const f of fileRowsRes.results ?? []) {
      try {
        await r2.delete(f.object_key);
        deletedFileObjects++;
      } catch (err) {
        console.error(`Failed to delete R2 file object ${f.object_key}:`, err);
      }
    }
  }

  // 4. Delete expired message records from D1 (cascade deletes child rows)
  const deleteRes = await db.prepare(`
    DELETE FROM messages
    WHERE id IN (
      SELECT m.id FROM messages m WHERE ${expiredFilter} LIMIT ?
    )
  `).bind(now, now, batchSize).run();

  const purgedCount = deleteRes.meta?.changes ?? 0;

  return {
    purged_messages: purgedCount,
    deleted_voice_objects: deletedVoiceObjects,
    deleted_image_objects: deletedImageObjects,
    deleted_file_objects: deletedFileObjects,
    deleted_media_objects: deletedVoiceObjects + deletedImageObjects + deletedFileObjects,
    timestamp: now,
  };
}
