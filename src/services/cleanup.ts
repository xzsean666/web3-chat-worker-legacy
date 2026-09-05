export interface CleanupResult {
  purged_messages: number;
  deleted_voice_objects: number;
  timestamp: number;
}

export async function sweepExpiredMessages(
  db: D1Database,
  r2: R2Bucket | undefined,
  batchSize = 500
): Promise<CleanupResult> {
  const now = Date.now();

  // 1. Find expired voice messages so we can remove objects from R2
  const voiceRowsRes = await db.prepare(`
    SELECT vm.object_key, vm.message_id
    FROM voice_messages vm
    JOIN messages m ON m.id = vm.message_id
    WHERE m.expires_at <= ?
    LIMIT ?
  `).bind(now, batchSize).all<{ object_key: string; message_id: string }>();

  const voiceRows = voiceRowsRes.results ?? [];
  let deletedVoiceObjects = 0;

  if (r2 && voiceRows.length > 0) {
    for (const v of voiceRows) {
      try {
        await r2.delete(v.object_key);
        deletedVoiceObjects++;
      } catch (err) {
        console.error(`Failed to delete R2 object ${v.object_key}:`, err);
      }
    }
  }

  // 2. Delete expired message records from D1 (cascade deletes child rows)
  const deleteRes = await db.prepare(`
    DELETE FROM messages
    WHERE id IN (
      SELECT id FROM messages WHERE expires_at <= ? LIMIT ?
    )
  `).bind(now, batchSize).run();

  const purgedCount = deleteRes.meta?.changes ?? 0;

  return {
    purged_messages: purgedCount,
    deleted_voice_objects: deletedVoiceObjects,
    timestamp: now,
  };
}
