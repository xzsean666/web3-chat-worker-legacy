export async function destroyMessage(
  db: D1Database,
  r2: R2Bucket | undefined,
  messageId: string,
  typeHint?: string
): Promise<{ deleted: boolean; object_key?: string }> {
  let objectKey: string | undefined;

  let type = typeHint;
  if (!type) {
    const msg = await db.prepare('SELECT type FROM messages WHERE id = ?').bind(messageId).first<{ type: string }>();
    type = msg?.type;
  }

  if (type === 'voice') {
    const voice = await db.prepare(
      'SELECT object_key FROM voice_messages WHERE message_id = ?'
    ).bind(messageId).first<{ object_key: string }>();
    if (voice) objectKey = voice.object_key;
  } else if (type === 'image') {
    const image = await db.prepare(
      'SELECT object_key FROM image_messages WHERE message_id = ?'
    ).bind(messageId).first<{ object_key: string }>();
    if (image) objectKey = image.object_key;
  } else if (type === 'file') {
    const file = await db.prepare(
      'SELECT object_key FROM file_messages WHERE message_id = ?'
    ).bind(messageId).first<{ object_key: string }>();
    if (file) objectKey = file.object_key;
  }

  if (objectKey && r2) {
    try {
      await r2.delete(objectKey);
    } catch (err) {
      console.error(`Failed to delete R2 object ${objectKey}:`, err);
    }
  }

  // Delete message row from D1; foreign key cascade will delete voice_messages, image_messages, file_messages, and receipts
  const res = await db.prepare('DELETE FROM messages WHERE id = ?').bind(messageId).run();

  return {
    deleted: (res.meta.changes ?? 0) > 0,
    object_key: objectKey,
  };
}

export async function destroyMediaOnly(
  db: D1Database,
  r2: R2Bucket | undefined,
  messageId: string
): Promise<{ deleted: boolean; object_key?: string }> {
  let objectKey: string | undefined;

  const voice = await db.prepare(
    'SELECT object_key FROM voice_messages WHERE message_id = ?'
  ).bind(messageId).first<{ object_key: string }>();

  if (voice) {
    objectKey = voice.object_key;
    await db.prepare('DELETE FROM voice_messages WHERE message_id = ?').bind(messageId).run();
  } else {
    const image = await db.prepare(
      'SELECT object_key FROM image_messages WHERE message_id = ?'
    ).bind(messageId).first<{ object_key: string }>();

    if (image) {
      objectKey = image.object_key;
      await db.prepare('DELETE FROM image_messages WHERE message_id = ?').bind(messageId).run();
    } else {
      const file = await db.prepare(
        'SELECT object_key FROM file_messages WHERE message_id = ?'
      ).bind(messageId).first<{ object_key: string }>();

      if (file) {
        objectKey = file.object_key;
        await db.prepare('DELETE FROM file_messages WHERE message_id = ?').bind(messageId).run();
      }
    }
  }

  if (objectKey && r2) {
    try {
      await r2.delete(objectKey);
    } catch (err) {
      console.error(`Failed to delete R2 object ${objectKey}:`, err);
    }
  }

  return {
    deleted: !!objectKey,
    object_key: objectKey,
  };
}
