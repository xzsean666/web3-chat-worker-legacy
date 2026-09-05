export async function destroyMessage(
  db: D1Database,
  r2: R2Bucket | undefined,
  messageId: string
): Promise<{ deleted: boolean; object_key?: string }> {
  // Check if voice message metadata exists
  const voice = await db.prepare(
    'SELECT object_key FROM voice_messages WHERE message_id = ?'
  ).bind(messageId).first<{ object_key: string }>();

  if (voice && r2) {
    try {
      await r2.delete(voice.object_key);
    } catch (err) {
      console.error(`Failed to delete R2 object ${voice.object_key}:`, err);
    }
  }

  // Delete message row from D1; foreign key cascade will delete voice_messages and receipts
  const res = await db.prepare('DELETE FROM messages WHERE id = ?').bind(messageId).run();

  return {
    deleted: (res.meta.changes ?? 0) > 0,
    object_key: voice?.object_key,
  };
}
