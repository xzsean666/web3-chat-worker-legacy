import type { MessageRow, VoiceMessageRow, ImageMessageRow, FileMessageRow } from '../db/schema';
import { destroyMessage, destroyMediaOnly } from './destruction';
import { assertCanSendMessage } from './conversations';

export interface MessageWithSender extends MessageRow {
  sender_address: string;
  is_recalled?: boolean;
  voice?: VoiceMessageRow | null;
  image?: ImageMessageRow | null;
  file?: FileMessageRow | null;
}

export interface SendMessageOptions {
  content?: string;
  type?: 'text' | 'voice' | 'image' | 'file';
  retention?: 'permanent' | 'on_read';
  expires_in_seconds?: number;
  burn_after_seconds?: number;
  mentions?: string[];
}

export interface GetMessagesOptions {
  after_id?: string;
  limit?: number;
}

export interface SyncOptions {
  since?: number;
  limit?: number;
}

export interface RecipientReceipt {
  user_id: string;
  wallet_address: string;
  status: 'pending' | 'delivered' | 'read';
  delivered_at: number | null;
  read_at: number | null;
}

export interface MessageReceiptsSummary {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  total_recipients: number;
  delivered_count: number;
  read_count: number;
  all_delivered: boolean;
  all_read: boolean;
  receipts: RecipientReceipt[];
}

export async function sendMessage(
  db: D1Database,
  conversationId: string,
  senderId: string,
  options: SendMessageOptions
): Promise<MessageRow> {
  // 1. Check membership, blacklist, group mute, and individual mute
  await assertCanSendMessage(db, conversationId, senderId);

  const type = options.type || 'text';
  if (type === 'text' && (!options.content || !options.content.trim())) {
    throw new Error('Message content cannot be empty for text messages');
  }

  const retention = options.retention || 'permanent';
  const burnAfterSeconds = retention === 'on_read' ? Math.max(30, Number(options.burn_after_seconds) || 30) : null;
  const mentionsList = Array.isArray(options.mentions)
    ? options.mentions.map((m) => m.toLowerCase().trim()).filter(Boolean)
    : [];
  const mentionsJson = JSON.stringify(mentionsList);

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
      id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at, burn_after_seconds, mentions
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).bind(messageId, conversationId, senderId, type, content, retention, expiresAt, now, burnAfterSeconds, mentionsJson).run();

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
    recalled_at: null,
    burn_after_seconds: burnAfterSeconds,
    mentions: mentionsJson,
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
          AND NOT (
            m.retention = 'on_read'
            AND EXISTS (
              SELECT 1 FROM message_receipts mr
              WHERE mr.message_id = m.id AND mr.user_id = ? AND mr.status = 'read'
                AND (? - mr.timestamp) >= (COALESCE(m.burn_after_seconds, 30) * 1000)
            )
          )
          AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?
      `;
      params = [conversationId, now, userId, now, cursorMsg.created_at, cursorMsg.created_at, options.after_id, limit + 1];
    } else {
      query = `
        SELECT m.*, u.wallet_address AS sender_address
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ?
          AND m.expires_at > ?
          AND NOT (
            m.retention = 'on_read'
            AND EXISTS (
              SELECT 1 FROM message_receipts mr
              WHERE mr.message_id = m.id AND mr.user_id = ? AND mr.status = 'read'
                AND (? - mr.timestamp) >= (COALESCE(m.burn_after_seconds, 30) * 1000)
            )
          )
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?
      `;
      params = [conversationId, now, userId, now, limit + 1];
    }
  } else {
    query = `
      SELECT m.*, u.wallet_address AS sender_address
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
        AND m.expires_at > ?
        AND NOT (
          m.retention = 'on_read'
          AND EXISTS (
            SELECT 1 FROM message_receipts mr
            WHERE mr.message_id = m.id AND mr.user_id = ? AND mr.status = 'read'
              AND (? - mr.timestamp) >= (COALESCE(m.burn_after_seconds, 30) * 1000)
          )
        )
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT ?
    `;
    params = [conversationId, now, userId, now, limit + 1];
  }

  const res = await db.prepare(query).bind(...params).all<MessageWithSender>();
  const rows = res.results;
  const has_more = rows.length > limit;
  const messages = has_more ? rows.slice(0, limit) : rows;
  const enriched = await enrichMessagesWithMedia(db, messages);
  const next_cursor = enriched.length > 0 ? enriched[enriched.length - 1].id : null;

  return {
    messages: enriched,
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
      AND NOT (
        m.retention = 'on_read'
        AND EXISTS (
          SELECT 1 FROM message_receipts mr
          WHERE mr.message_id = m.id AND mr.user_id = ? AND mr.status = 'read'
            AND (? - mr.timestamp) >= (COALESCE(m.burn_after_seconds, 30) * 1000)
        )
      )
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT ?
  `;

  const res = await db.prepare(query).bind(userId, now, since, userId, now, limit + 1).all<MessageWithSender>();
  const rows = res.results;
  const has_more = rows.length > limit;
  const messages = has_more ? rows.slice(0, limit) : rows;
  const enriched = await enrichMessagesWithMedia(db, messages);

  return {
    messages: enriched,
    sync_timestamp: now,
    has_more,
  };
}

export async function enrichMessagesWithMedia(
  db: D1Database,
  messages: MessageWithSender[]
): Promise<MessageWithSender[]> {
  if (!messages || messages.length === 0) return messages;

  for (const m of messages) {
    if (m.recalled_at) {
      m.is_recalled = true;
      m.content = '[Message recalled]';
    }
  }

  const activeMessages = messages.filter((m) => !m.recalled_at);
  const voiceMsgIds = activeMessages.filter((m) => m.type === 'voice').map((m) => m.id);
  const imageMsgIds = activeMessages.filter((m) => m.type === 'image').map((m) => m.id);
  const fileMsgIds = activeMessages.filter((m) => m.type === 'file').map((m) => m.id);

  if (voiceMsgIds.length === 0 && imageMsgIds.length === 0 && fileMsgIds.length === 0) {
    return messages;
  }

  const voiceMap = new Map<string, VoiceMessageRow>();
  const imageMap = new Map<string, ImageMessageRow>();
  const fileMap = new Map<string, FileMessageRow>();

  if (voiceMsgIds.length > 0) {
    const placeholders = voiceMsgIds.map(() => '?').join(',');
    const voiceRows = await db.prepare(
      `SELECT * FROM voice_messages WHERE message_id IN (${placeholders})`
    ).bind(...voiceMsgIds).all<VoiceMessageRow>();
    for (const v of voiceRows.results) {
      voiceMap.set(v.message_id, v);
    }
  }

  if (imageMsgIds.length > 0) {
    const placeholders = imageMsgIds.map(() => '?').join(',');
    const imageRows = await db.prepare(
      `SELECT * FROM image_messages WHERE message_id IN (${placeholders})`
    ).bind(...imageMsgIds).all<ImageMessageRow>();
    for (const img of imageRows.results) {
      imageMap.set(img.message_id, img);
    }
  }

  if (fileMsgIds.length > 0) {
    const placeholders = fileMsgIds.map(() => '?').join(',');
    const fileRows = await db.prepare(
      `SELECT * FROM file_messages WHERE message_id IN (${placeholders})`
    ).bind(...fileMsgIds).all<FileMessageRow>();
    for (const f of fileRows.results) {
      fileMap.set(f.message_id, f);
    }
  }

  for (const m of messages) {
    if (m.recalled_at) {
      m.voice = null;
      m.image = null;
      m.file = null;
    } else if (m.type === 'voice') {
      m.voice = voiceMap.get(m.id) ?? null;
    } else if (m.type === 'image') {
      m.image = imageMap.get(m.id) ?? null;
    } else if (m.type === 'file') {
      m.file = fileMap.get(m.id) ?? null;
    }
  }

  return messages;
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
      SELECT m.id, m.conversation_id, m.sender_id, m.status
      FROM messages m
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE m.id = ?
    `).bind(userId, id).first<{ id: string; conversation_id: string; sender_id: string; status: string }>();

    if (!msg || msg.sender_id === userId) {
      skipped.push(id);
      continue;
    }

    await db.prepare(`
      INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
      VALUES (?, ?, ?, 'delivered', ?)
    `).bind(crypto.randomUUID(), id, userId, now).run();

    // Calculate recipient count (all members in conversation except sender)
    const memberRes = await db.prepare(`
      SELECT COUNT(*) as count
      FROM conversation_members
      WHERE conversation_id = ? AND user_id != ?
    `).bind(msg.conversation_id, msg.sender_id).first<{ count: number }>();
    const recipientCount = memberRes?.count ?? 0;

    // Calculate delivered count
    const receiptRes = await db.prepare(`
      SELECT COUNT(DISTINCT user_id) as count
      FROM message_receipts
      WHERE message_id = ? AND status IN ('delivered', 'read')
    `).bind(id).first<{ count: number }>();
    const deliveredCount = receiptRes?.count ?? 0;

    // Transition message status only when ALL recipients have received it
    if (recipientCount > 0 && deliveredCount >= recipientCount && msg.status === 'pending') {
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
): Promise<{ read: string[]; burned: string[]; skipped: string[]; burn_windows?: Record<string, number> }> {
  const read: string[] = [];
  const burned: string[] = [];
  const skipped: string[] = [];
  const burn_windows: Record<string, number> = {};
  const now = Date.now();

  for (const id of messageIds) {
    const msg = await db.prepare(`
      SELECT m.id, m.conversation_id, m.sender_id, m.retention, m.status, m.burn_after_seconds
      FROM messages m
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE m.id = ?
    `).bind(userId, id).first<{
      id: string;
      conversation_id: string;
      sender_id: string;
      retention: 'permanent' | 'on_read';
      status: string;
      burn_after_seconds: number | null;
    }>();

    if (!msg || msg.sender_id === userId) {
      skipped.push(id);
      continue;
    }

    await db.prepare(`
      UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?
    `).bind(id, msg.conversation_id, userId).run();

    // Ensure both delivered and read receipts are recorded
    await db.prepare(`
      INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
      VALUES (?, ?, ?, 'delivered', ?)
    `).bind(crypto.randomUUID(), id, userId, now).run();

    await db.prepare(`
      INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
      VALUES (?, ?, ?, 'read', ?)
    `).bind(crypto.randomUUID(), id, userId, now).run();

    // Calculate recipient count (all members except sender)
    const memberRes = await db.prepare(`
      SELECT COUNT(*) as count
      FROM conversation_members
      WHERE conversation_id = ? AND user_id != ?
    `).bind(msg.conversation_id, msg.sender_id).first<{ count: number }>();
    const recipientCount = memberRes?.count ?? 0;

    // Calculate read count
    const readReceiptRes = await db.prepare(`
      SELECT COUNT(DISTINCT user_id) as count
      FROM message_receipts
      WHERE message_id = ? AND status = 'read'
    `).bind(id).first<{ count: number }>();
    const readCount = readReceiptRes?.count ?? 0;

    // Calculate delivered count
    const deliveredReceiptRes = await db.prepare(`
      SELECT COUNT(DISTINCT user_id) as count
      FROM message_receipts
      WHERE message_id = ? AND status IN ('delivered', 'read')
    `).bind(id).first<{ count: number }>();
    const deliveredCount = deliveredReceiptRes?.count ?? 0;

    const allDelivered = recipientCount > 0 && deliveredCount >= recipientCount;
    const allRead = recipientCount > 0 && readCount >= recipientCount;

    if (allDelivered && msg.status === 'pending') {
      await db.prepare(`
        UPDATE messages SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?) WHERE id = ?
      `).bind(now, id).run();
    }

    if (msg.retention === 'on_read') {
      // Burn on read: allow viewing for at least 30s.
      // Physical destruction delays until all recipients read AND all viewing windows elapse.
      const burnWindowSeconds = msg.burn_after_seconds ?? 30;
      burn_windows[id] = burnWindowSeconds;
      const burnWindowMs = burnWindowSeconds * 1000;
      if (allRead) {
        const latestReadRes = await db.prepare(`
          SELECT MAX(timestamp) as latest_read
          FROM message_receipts
          WHERE message_id = ? AND status = 'read'
        `).bind(id).first<{ latest_read: number | null }>();
        const latestRead = latestReadRes?.latest_read ?? now;
        if (now - latestRead >= burnWindowMs) {
          await destroyMessage(db, r2, id);
        }
      }
      burned.push(id);
    } else {
      if (allRead && msg.status !== 'read') {
        await db.prepare(`
          UPDATE messages SET status = 'read', read_at = ? WHERE id = ?
        `).bind(now, id).run();
      }
      read.push(id);
    }
  }

  return { read, burned, skipped, burn_windows };
}

export async function getMessageReceipts(
  db: D1Database,
  userId: string,
  messageId: string
): Promise<MessageReceiptsSummary> {
  const msg = await db.prepare(`
    SELECT id, conversation_id, sender_id
    FROM messages
    WHERE id = ?
  `).bind(messageId).first<{ id: string; conversation_id: string; sender_id: string }>();

  if (!msg) {
    throw new Error('Message not found or already destroyed');
  }

  const membership = await db.prepare(`
    SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?
  `).bind(msg.conversation_id, userId).first();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this conversation');
  }

  const membersRes = await db.prepare(`
    SELECT cm.user_id, u.wallet_address
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ? AND cm.user_id != ?
    ORDER BY cm.joined_at ASC
  `).bind(msg.conversation_id, msg.sender_id).all<{ user_id: string; wallet_address: string }>();

  const recipients = membersRes.results;

  const receiptsRes = await db.prepare(`
    SELECT user_id, status, timestamp
    FROM message_receipts
    WHERE message_id = ?
  `).bind(messageId).all<{ user_id: string; status: 'delivered' | 'read'; timestamp: number }>();

  const receiptMap = new Map<string, { delivered_at: number | null; read_at: number | null }>();
  for (const r of receiptsRes.results) {
    const cur = receiptMap.get(r.user_id) || { delivered_at: null, read_at: null };
    if (r.status === 'delivered') {
      cur.delivered_at = r.timestamp;
    } else if (r.status === 'read') {
      cur.read_at = r.timestamp;
      if (!cur.delivered_at) {
        cur.delivered_at = r.timestamp;
      }
    }
    receiptMap.set(r.user_id, cur);
  }

  const recipientList: RecipientReceipt[] = recipients.map((r) => {
    const rec = receiptMap.get(r.user_id);
    const delivered_at = rec?.delivered_at ?? null;
    const read_at = rec?.read_at ?? null;
    let status: 'pending' | 'delivered' | 'read' = 'pending';
    if (read_at) {
      status = 'read';
    } else if (delivered_at) {
      status = 'delivered';
    }
    return {
      user_id: r.user_id,
      wallet_address: r.wallet_address,
      status,
      delivered_at,
      read_at,
    };
  });

  const total_recipients = recipientList.length;
  const delivered_count = recipientList.filter(
    (r) => r.status === 'delivered' || r.status === 'read'
  ).length;
  const read_count = recipientList.filter((r) => r.status === 'read').length;
  const all_delivered = total_recipients > 0 && delivered_count === total_recipients;
  const all_read = total_recipients > 0 && read_count === total_recipients;

  return {
    message_id: msg.id,
    conversation_id: msg.conversation_id,
    sender_id: msg.sender_id,
    total_recipients,
    delivered_count,
    read_count,
    all_delivered,
    all_read,
    receipts: recipientList,
  };
}

export async function recallMessage(
  db: D1Database,
  r2: R2Bucket | undefined,
  userId: string,
  messageId: string,
  recallWindowSeconds = 30
): Promise<{ success: boolean; message_id: string; recalled_at: number }> {
  const msg = await db.prepare(
    'SELECT id, conversation_id, sender_id, type, created_at, recalled_at FROM messages WHERE id = ?'
  ).bind(messageId).first<{
    id: string;
    conversation_id: string;
    sender_id: string;
    type: string;
    created_at: number;
    recalled_at: number | null;
  }>();

  if (!msg) {
    throw new Error('Message not found');
  }

  if (msg.sender_id !== userId) {
    throw new Error('Unauthorized: only the sender can recall this message');
  }

  if (msg.recalled_at) {
    throw new Error('Message has already been recalled');
  }

  const now = Date.now();
  const windowMs = recallWindowSeconds * 1000;
  if (now - msg.created_at > windowMs) {
    throw new Error(`Recall window has expired (${recallWindowSeconds}s limit)`);
  }

  await destroyMediaOnly(db, r2, messageId);

  await db.prepare(
    "UPDATE messages SET recalled_at = ?, content = '[Message recalled]' WHERE id = ?"
  ).bind(now, messageId).run();

  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, msg.conversation_id).run();

  return {
    success: true,
    message_id: messageId,
    recalled_at: now,
  };
}
