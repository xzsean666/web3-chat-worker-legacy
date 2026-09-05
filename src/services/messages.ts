import type { MessageRow } from '../db/schema';
import { destroyMessage } from './destruction';

export interface MessageWithSender extends MessageRow {
  sender_address: string;
}

export interface SendMessageOptions {
  content?: string;
  type?: 'text' | 'voice';
  retention?: 'permanent' | 'on_read';
  expires_in_seconds?: number;
}

export interface GetMessagesOptions {
  after_id?: string;
  limit?: number;
}

export interface SyncOptions {
  since?: number;
  limit?: number;
}

export async function sendMessage(
  db: D1Database,
  conversationId: string,
  senderId: string,
  options: SendMessageOptions
): Promise<MessageRow> {
  const membership = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, senderId).first();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this conversation');
  }

  const type = options.type || 'text';
  if (type === 'text' && (!options.content || !options.content.trim())) {
    throw new Error('Message content cannot be empty for text messages');
  }

  const retention = options.retention || 'permanent';
  const expiresInMs =
    options.expires_in_seconds && options.expires_in_seconds > 0
      ? options.expires_in_seconds * 1000
      : 24 * 60 * 60 * 1000;

  const now = Date.now();
  const expiresAt = now + expiresInMs;
  const messageId = crypto.randomUUID();
  const content = options.content ? options.content.trim() : null;

  await db.prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(messageId, conversationId, senderId, type, content, retention, expiresAt, now).run();

  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId).run();

  return {
    id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    type,
    content,
    retention,
    status: 'pending',
    expires_at: expiresAt,
    delivered_at: null,
    read_at: null,
    created_at: now,
  };
}

export async function getConversationMessages(
  db: D1Database,
  conversationId: string,
  userId: string,
  options: GetMessagesOptions = {}
): Promise<{ messages: MessageWithSender[]; next_cursor: string | null; has_more: boolean }> {
  const membership = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, userId).first();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this conversation');
  }

  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const now = Date.now();

  let query: string;
  let params: unknown[];

  if (options.after_id) {
    const cursorMsg = await db.prepare(
      'SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?'
    ).bind(options.after_id, conversationId).first<{ created_at: number }>();

    if (cursorMsg) {
      query = `
        SELECT m.*, u.wallet_address AS sender_address
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ?
          AND m.expires_at > ?
          AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?
      `;
      params = [conversationId, now, cursorMsg.created_at, cursorMsg.created_at, options.after_id, limit + 1];
    } else {
      query = `
        SELECT m.*, u.wallet_address AS sender_address
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ? AND m.expires_at > ?
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?
      `;
      params = [conversationId, now, limit + 1];
    }
  } else {
    query = `
      SELECT m.*, u.wallet_address AS sender_address
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ? AND m.expires_at > ?
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT ?
    `;
    params = [conversationId, now, limit + 1];
  }

  const res = await db.prepare(query).bind(...params).all<MessageWithSender>();
  const rows = res.results;
  const has_more = rows.length > limit;
  const messages = has_more ? rows.slice(0, limit) : rows;
  const next_cursor = messages.length > 0 ? messages[messages.length - 1].id : null;

  return {
    messages,
    next_cursor,
    has_more,
  };
}

export async function getSyncUpdates(
  db: D1Database,
  userId: string,
  options: SyncOptions = {}
): Promise<{ messages: MessageWithSender[]; sync_timestamp: number; has_more: boolean }> {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 200);
  const now = Date.now();
  const since = options.since ? Number(options.since) : 0;

  const query = `
    SELECT m.*, u.wallet_address AS sender_address
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
    WHERE m.expires_at > ?
      AND m.created_at > ?
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT ?
  `;

  const res = await db.prepare(query).bind(userId, now, since, limit + 1).all<MessageWithSender>();
  const rows = res.results;
  const has_more = rows.length > limit;
  const messages = has_more ? rows.slice(0, limit) : rows;

  return {
    messages,
    sync_timestamp: now,
    has_more,
  };
}

export async function acknowledgeDelivery(
  db: D1Database,
  userId: string,
  messageIds: string[]
): Promise<{ acknowledged: string[]; skipped: string[] }> {
  const acknowledged: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();

  for (const id of messageIds) {
    const msg = await db.prepare(`
      SELECT m.id, m.sender_id, m.status
      FROM messages m
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE m.id = ?
    `).bind(userId, id).first<{ id: string; sender_id: string; status: string }>();

    if (!msg || msg.sender_id === userId) {
      skipped.push(id);
      continue;
    }

    await db.prepare(`
      INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
      VALUES (?, ?, ?, 'delivered', ?)
    `).bind(crypto.randomUUID(), id, userId, now).run();

    if (msg.status === 'pending') {
      await db.prepare(`
        UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?
      `).bind(now, id).run();
    }

    acknowledged.push(id);
  }

  return { acknowledged, skipped };
}

export async function acknowledgeRead(
  db: D1Database,
  r2: R2Bucket | undefined,
  userId: string,
  messageIds: string[]
): Promise<{ read: string[]; burned: string[]; skipped: string[] }> {
  const read: string[] = [];
  const burned: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();

  for (const id of messageIds) {
    const msg = await db.prepare(`
      SELECT m.id, m.conversation_id, m.sender_id, m.retention, m.status
      FROM messages m
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE m.id = ?
    `).bind(userId, id).first<{
      id: string;
      conversation_id: string;
      sender_id: string;
      retention: 'permanent' | 'on_read';
      status: string;
    }>();

    if (!msg || msg.sender_id === userId) {
      skipped.push(id);
      continue;
    }

    await db.prepare(`
      UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?
    `).bind(id, msg.conversation_id, userId).run();

    await db.prepare(`
      INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
      VALUES (?, ?, ?, 'read', ?)
    `).bind(crypto.randomUUID(), id, userId, now).run();

    if (msg.retention === 'on_read') {
      await destroyMessage(db, r2, id);
      burned.push(id);
    } else {
      if (msg.status !== 'read') {
        await db.prepare(`
          UPDATE messages SET status = 'read', read_at = ? WHERE id = ?
        `).bind(now, id).run();
      }
      read.push(id);
    }
  }

  return { read, burned, skipped };
}
