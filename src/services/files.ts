import type { MessageRow, FileMessageRow } from '../db/schema';
import { assertCanSendMessage } from './conversations';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export function sanitizeFileName(name: string): string {
  const base = name.trim().replace(/^.*[\\/]/, ''); // Strip any directory paths
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'file.bin';
}

export interface UploadFileParams {
  conversation_id: string;
  fileData: Uint8Array | ArrayBuffer;
  file_name: string;
  mime_type?: string;
  caption?: string;
  retention?: 'permanent' | 'on_read';
  expires_in_seconds?: number;
  burn_after_seconds?: number;
}

export async function uploadFileMessage(
  db: D1Database,
  r2: R2Bucket,
  senderId: string,
  params: UploadFileParams
): Promise<{ message: MessageRow; file: FileMessageRow }> {
  // 1. Verify membership and mute permissions
  await assertCanSendMessage(db, params.conversation_id, senderId);

  // 2. Validate file name
  const rawFileName = (params.file_name || '').trim();
  if (!rawFileName) {
    throw new Error('File name is required');
  }
  const safeFileName = sanitizeFileName(rawFileName);

  // 3. Validate size
  const byteLength = params.fileData.byteLength;
  if (byteLength === 0) {
    throw new Error('File cannot be empty');
  }
  if (byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File exceeds maximum size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`);
  }

  // 4. Normalize MIME type
  const mimeType = params.mime_type && params.mime_type.trim()
    ? params.mime_type.toLowerCase().split(';')[0].trim()
    : 'application/octet-stream';

  const messageId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const objectKey = `files/${messageId}/${safeFileName}`;
  const now = Date.now();
  const retention = params.retention || 'permanent';
  const burnAfterSeconds = params.burn_after_seconds !== undefined ? Math.max(Number(params.burn_after_seconds), 0) : 30;
  const expiresInMs =
    params.expires_in_seconds && params.expires_in_seconds > 0
      ? params.expires_in_seconds * 1000
      : 24 * 60 * 60 * 1000;
  const expiresAt = now + expiresInMs;

  const content = params.caption && params.caption.trim()
    ? `${params.caption.trim()} (${safeFileName})`
    : `[File: ${safeFileName}]`;

  // 5. Store in Cloudflare R2
  await r2.put(objectKey, params.fileData, {
    httpMetadata: {
      contentType: mimeType,
      contentDisposition: `attachment; filename="${encodeURIComponent(safeFileName)}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`,
    },
    customMetadata: {
      messageId,
      conversationId: params.conversation_id,
      fileName: safeFileName,
    },
  });

  // 6. Save message and file metadata in D1
  await db.prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at, burn_after_seconds
    ) VALUES (?, ?, ?, 'file', ?, ?, 'pending', ?, ?, ?)
  `).bind(messageId, params.conversation_id, senderId, content, retention, expiresAt, now, burnAfterSeconds).run();

  await db.prepare(`
    INSERT INTO file_messages (
      id, message_id, object_key, file_name, mime_type, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(fileId, messageId, objectKey, safeFileName, mimeType, byteLength, now).run();

  await db.prepare('UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?').bind(now, now, params.conversation_id).run();

  const message: MessageRow = {
    id: messageId,
    conversation_id: params.conversation_id,
    sender_id: senderId,
    type: 'file',
    content,
    retention,
    status: 'pending',
    expires_at: expiresAt,
    delivered_at: null,
    read_at: null,
    created_at: now,
  };

  const file: FileMessageRow = {
    id: fileId,
    message_id: messageId,
    object_key: objectKey,
    file_name: safeFileName,
    mime_type: mimeType,
    size: byteLength,
    created_at: now,
  };

  return { message, file };
}

export async function getFile(
  db: D1Database,
  r2: R2Bucket,
  userId: string,
  messageId: string
): Promise<{ object: R2ObjectBody; metadata: FileMessageRow }> {
  const metadata = await getFileMetadata(db, userId, messageId);

  const object = await r2.get(metadata.object_key);
  if (!object) {
    throw new Error('File not found in storage');
  }

  return { object, metadata };
}

export async function getFileMetadata(
  db: D1Database,
  userId: string,
  messageId: string
): Promise<FileMessageRow> {
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

  const file = await db.prepare(
    'SELECT * FROM file_messages WHERE message_id = ?'
  ).bind(messageId).first<FileMessageRow>();

  if (!file) {
    throw new Error('File metadata not found');
  }

  return file;
}
