import type { MessageRow, ImageMessageRow } from '../db/schema';
import { assertCanSendMessage } from './conversations';

const ALLOWED_IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/avif': 'avif',
};

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

export interface UploadImageParams {
  conversation_id: string;
  imageData: Uint8Array | ArrayBuffer;
  mime_type: string;
  file_name?: string;
  caption?: string;
  width?: number;
  height?: number;
  retention?: 'permanent' | 'on_read';
  expires_in_seconds?: number;
  burn_after_seconds?: number;
}

export async function uploadImageMessage(
  db: D1Database,
  r2: R2Bucket,
  senderId: string,
  params: UploadImageParams
): Promise<{ message: MessageRow; image: ImageMessageRow }> {
  // 1. Verify membership and mute permissions
  await assertCanSendMessage(db, params.conversation_id, senderId);

  // 2. Validate MIME type
  const normalizedMime = params.mime_type.toLowerCase().split(';')[0].trim();
  const ext = ALLOWED_IMAGE_MIME_TYPES[normalizedMime];
  if (!ext) {
    throw new Error(
      `Unsupported image format: ${params.mime_type}. Allowed: jpeg, png, webp, gif, svg, bmp, heic, avif`
    );
  }

  // 3. Validate size
  const byteLength = params.imageData.byteLength;
  if (byteLength === 0) {
    throw new Error('Image file cannot be empty');
  }
  if (byteLength > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(`Image file exceeds maximum size of ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)}MB`);
  }

  const messageId = crypto.randomUUID();
  const imageId = crypto.randomUUID();
  const objectKey = `images/${messageId}.${ext}`;
  const now = Date.now();
  const retention = params.retention || 'permanent';
  const burnAfterSeconds = params.burn_after_seconds !== undefined ? Math.max(Number(params.burn_after_seconds), 0) : 30;
  const expiresInMs =
    params.expires_in_seconds && params.expires_in_seconds > 0
      ? params.expires_in_seconds * 1000
      : 24 * 60 * 60 * 1000;
  const expiresAt = now + expiresInMs;

  const content = params.caption && params.caption.trim()
    ? params.caption.trim()
    : (params.file_name ? `[Image: ${params.file_name}]` : '[Image]');

  const width = params.width ? Math.round(Number(params.width)) : null;
  const height = params.height ? Math.round(Number(params.height)) : null;
  const fileName = params.file_name ? params.file_name.trim() : null;

  // 4. Store in Cloudflare R2
  await r2.put(objectKey, params.imageData, {
    httpMetadata: {
      contentType: normalizedMime,
      contentDisposition: `inline; filename="${encodeURIComponent(fileName || `${messageId}.${ext}`)}"`,
    },
    customMetadata: {
      messageId,
      conversationId: params.conversation_id,
      fileName: fileName || '',
    },
  });

  // 5. Save message and image metadata in D1
  await db.prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at, burn_after_seconds
    ) VALUES (?, ?, ?, 'image', ?, ?, 'pending', ?, ?, ?)
  `).bind(messageId, params.conversation_id, senderId, content, retention, expiresAt, now, burnAfterSeconds).run();

  await db.prepare(`
    INSERT INTO image_messages (
      id, message_id, object_key, file_name, mime_type, size, width, height, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(imageId, messageId, objectKey, fileName, normalizedMime, byteLength, width, height, now).run();

  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, params.conversation_id).run();

  const message: MessageRow = {
    id: messageId,
    conversation_id: params.conversation_id,
    sender_id: senderId,
    type: 'image',
    content,
    retention,
    status: 'pending',
    expires_at: expiresAt,
    delivered_at: null,
    read_at: null,
    created_at: now,
  };

  const image: ImageMessageRow = {
    id: imageId,
    message_id: messageId,
    object_key: objectKey,
    file_name: fileName,
    mime_type: normalizedMime,
    size: byteLength,
    width,
    height,
    created_at: now,
  };

  return { message, image };
}

export async function getImage(
  db: D1Database,
  r2: R2Bucket,
  userId: string,
  messageId: string
): Promise<{ object: R2ObjectBody; metadata: ImageMessageRow }> {
  const metadata = await getImageMetadata(db, userId, messageId);

  const object = await r2.get(metadata.object_key);
  if (!object) {
    throw new Error('Image file not found in storage');
  }

  return { object, metadata };
}

export async function getImageMetadata(
  db: D1Database,
  userId: string,
  messageId: string
): Promise<ImageMessageRow> {
  const msg = await db.prepare(
    'SELECT id, conversation_id, expires_at, retention, burn_after_seconds, recalled_at FROM messages WHERE id = ?'
  ).bind(messageId).first<{
    id: string;
    conversation_id: string;
    expires_at: number;
    retention: string;
    burn_after_seconds: number | null;
    recalled_at: number | null;
  }>();

  if (!msg) {
    throw new Error('Message not found');
  }

  if (msg.recalled_at) {
    throw new Error('Message was recalled');
  }

  const membership = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(msg.conversation_id, userId).first();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this conversation');
  }

  if (msg.expires_at <= Date.now()) {
    throw new Error('Message has expired');
  }

  if (msg.retention === 'on_read') {
    const alreadyRead = await db.prepare(
      "SELECT timestamp FROM message_receipts WHERE message_id = ? AND user_id = ? AND status = 'read'"
    ).bind(messageId, userId).first<{ timestamp: number }>();

    if (alreadyRead) {
      const burnWindowMs = (msg.burn_after_seconds ?? 30) * 1000;
      if (Date.now() - alreadyRead.timestamp >= burnWindowMs) {
        throw new Error('Message not found or already burned');
      }
    }
  }

  const image = await db.prepare(
    'SELECT * FROM image_messages WHERE message_id = ?'
  ).bind(messageId).first<ImageMessageRow>();

  if (!image) {
    throw new Error('Image metadata not found');
  }

  return image;
}
