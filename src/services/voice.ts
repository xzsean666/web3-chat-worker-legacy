import type { MessageRow, VoiceMessageRow } from '../db/schema';

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
};

const MAX_VOICE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface UploadVoiceParams {
  conversation_id: string;
  audioData: Uint8Array | ArrayBuffer;
  mime_type: string;
  duration: number;
  retention?: 'permanent' | 'on_read';
  expires_in_seconds?: number;
}

export async function uploadVoiceMessage(
  db: D1Database,
  r2: R2Bucket,
  senderId: string,
  params: UploadVoiceParams
): Promise<{ message: MessageRow; voice: VoiceMessageRow }> {
  // 1. Verify membership
  const membership = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(params.conversation_id, senderId).first();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this conversation');
  }

  // 2. Validate MIME type
  const normalizedMime = params.mime_type.toLowerCase().split(';')[0].trim();
  const ext = ALLOWED_MIME_TYPES[normalizedMime];
  if (!ext) {
    throw new Error(`Unsupported audio format: ${params.mime_type}. Allowed: webm, mp3, ogg, wav, aac, mp4`);
  }

  // 3. Validate size
  const byteLength = params.audioData.byteLength;
  if (byteLength === 0) {
    throw new Error('Audio file cannot be empty');
  }
  if (byteLength > MAX_VOICE_SIZE_BYTES) {
    throw new Error(`Audio file exceeds maximum size of ${MAX_VOICE_SIZE_BYTES / (1024 * 1024)}MB`);
  }

  // 4. Validate duration
  const duration = Math.max(Number(params.duration) || 0, 0);

  const messageId = crypto.randomUUID();
  const voiceId = crypto.randomUUID();
  const objectKey = `voice/${messageId}.${ext}`;
  const now = Date.now();
  const retention = params.retention || 'permanent';
  const expiresInMs =
    params.expires_in_seconds && params.expires_in_seconds > 0
      ? params.expires_in_seconds * 1000
      : 24 * 60 * 60 * 1000;
  const expiresAt = now + expiresInMs;

  // 5. Store in Cloudflare R2
  await r2.put(objectKey, params.audioData, {
    httpMetadata: {
      contentType: normalizedMime,
    },
    customMetadata: {
      messageId,
      conversationId: params.conversation_id,
      duration: duration.toString(),
    },
  });

  // 6. Save message and voice metadata in D1
  await db.prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at
    ) VALUES (?, ?, ?, 'voice', ?, ?, 'pending', ?, ?)
  `).bind(messageId, params.conversation_id, senderId, `[Voice: ${duration}s]`, retention, expiresAt, now).run();

  await db.prepare(`
    INSERT INTO voice_messages (
      id, message_id, object_key, duration, mime_type, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(voiceId, messageId, objectKey, duration, normalizedMime, byteLength, now).run();

  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, params.conversation_id).run();

  const message: MessageRow = {
    id: messageId,
    conversation_id: params.conversation_id,
    sender_id: senderId,
    type: 'voice',
    content: `[Voice: ${duration}s]`,
    retention,
    status: 'pending',
    expires_at: expiresAt,
    delivered_at: null,
    read_at: null,
    created_at: now,
  };

  const voice: VoiceMessageRow = {
    id: voiceId,
    message_id: messageId,
    object_key: objectKey,
    duration,
    mime_type: normalizedMime,
    size: byteLength,
    created_at: now,
  };

  return { message, voice };
}

export async function getVoiceAudio(
  db: D1Database,
  r2: R2Bucket,
  userId: string,
  messageId: string
): Promise<{ object: R2ObjectBody; metadata: VoiceMessageRow }> {
  const msg = await db.prepare(
    'SELECT id, conversation_id, expires_at FROM messages WHERE id = ?'
  ).bind(messageId).first<{ id: string; conversation_id: string; expires_at: number }>();

  if (!msg) {
    throw new Error('Message not found');
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

  const voice = await db.prepare(
    'SELECT * FROM voice_messages WHERE message_id = ?'
  ).bind(messageId).first<VoiceMessageRow>();

  if (!voice) {
    throw new Error('Voice metadata not found');
  }

  const object = await r2.get(voice.object_key);
  if (!object) {
    throw new Error('Audio file not found in storage');
  }

  return { object, metadata: voice };
}
