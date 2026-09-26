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

let lastMonotonicTimestamp = 0;
export function getMonotonicNow(): number {
  let now = Date.now();
  if (now <= lastMonotonicTimestamp) {
    now = lastMonotonicTimestamp + 1;
  }
  lastMonotonicTimestamp = now;
  return now;
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

  const now = getMonotonicNow();
  const expiresAt = now + expiresInMs;
  const messageId = crypto.randomUUID();
  const content = options.content ? options.content.trim() : null;

  const insertStmt = db.prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at, burn_after_seconds, mentions
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).bind(messageId, conversationId, senderId, type, content, retention, expiresAt, now, burnAfterSeconds, mentionsJson);

  const updateStmt = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId);

  await db.batch([insertStmt, updateStmt]);

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

export async function sendMessagesBatch(
  db: D1Database,
  conversationId: string,
  senderId: string,
  messagesOptions: SendMessageOptions[]
): Promise<MessageRow[]> {
  if (!messagesOptions || messagesOptions.length === 0) {
    return [];
  }

  // 1. Check membership, blacklist, group mute, and individual mute ONCE for all messages
  await assertCanSendMessage(db, conversationId, senderId);

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const results: MessageRow[] = [];

  for (let i = 0; i < messagesOptions.length; i++) {
    const options = messagesOptions[i];
    const type = options.type || 'text';
    if (type === 'text' && (!options.content || !options.content.trim())) {
      throw new Error(`Message at index ${i} has empty content for text message`);
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

    const msgCreatedAt = now + i;
    const expiresAt = msgCreatedAt + expiresInMs;
    const messageId = crypto.randomUUID();
    const content = options.content ? options.content.trim() : null;

    statements.push(
      db.prepare(`
        INSERT INTO messages (
          id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at, burn_after_seconds, mentions
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).bind(messageId, conversationId, senderId, type, content, retention, expiresAt, msgCreatedAt, burnAfterSeconds, mentionsJson)
    );

    results.push({
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
      created_at: msgCreatedAt,
      recalled_at: null,
      burn_after_seconds: burnAfterSeconds,
      mentions: mentionsJson,
    });
  }

  statements.push(
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now + messagesOptions.length, conversationId)
  );

  await db.batch(statements);

  return results;
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
  if (!messageIds || messageIds.length === 0) {
    return { acknowledged, skipped };
  }

  const uniqueIds = Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && id.trim())));
  if (uniqueIds.length === 0) {
    return { acknowledged, skipped };
  }

  const now = Date.now();
  const placeholders = uniqueIds.map(() => '?').join(',');

  // 1. Single query: Fetch all messages where current user is a member of the conversation
  const query = `
    SELECT m.id, m.conversation_id, m.sender_id, m.status
    FROM messages m
    JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
    WHERE m.id IN (${placeholders})
  `;
  const res = await db.prepare(query).bind(userId, ...uniqueIds).all<{
    id: string;
    conversation_id: string;
    sender_id: string;
    status: string;
  }>();

  const foundMap = new Map<string, { id: string; conversation_id: string; sender_id: string; status: string }>();
  for (const m of res.results) {
    foundMap.set(m.id, m);
  }

  const validMessages: { id: string; conversation_id: string; sender_id: string; status: string }[] = [];
  for (const id of uniqueIds) {
    const msg = foundMap.get(id);
    if (!msg || msg.sender_id === userId) {
      skipped.push(id);
    } else {
      validMessages.push(msg);
      acknowledged.push(id);
    }
  }

  if (validMessages.length === 0) {
    return { acknowledged, skipped };
  }

  // 2. Batch insert 'delivered' receipts for all valid messages
  const receiptStatements: D1PreparedStatement[] = validMessages.map((m) =>
    db.prepare(`
      INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
      VALUES (?, ?, ?, 'delivered', ?)
    `).bind(crypto.randomUUID(), m.id, userId, now)
  );

  // 3. Batch fetch conversation members for involved conversations
  const convIds = Array.from(new Set(validMessages.map((m) => m.conversation_id)));
  const convPlaceholders = convIds.map(() => '?').join(',');
  const membersRes = await db.prepare(`
    SELECT conversation_id, user_id
    FROM conversation_members
    WHERE conversation_id IN (${convPlaceholders})
  `).bind(...convIds).all<{ conversation_id: string; user_id: string }>();

  const convMembersMap = new Map<string, Set<string>>();
  for (const row of membersRes.results) {
    if (!convMembersMap.has(row.conversation_id)) {
      convMembersMap.set(row.conversation_id, new Set());
    }
    convMembersMap.get(row.conversation_id)!.add(row.user_id);
  }

  // Execute the receipt insertions in batch!
  await db.batch(receiptStatements);

  // 4. Batch query delivered counts for all valid messages
  const validIds = validMessages.map((m) => m.id);
  const validPlaceholders = validIds.map(() => '?').join(',');
  const deliveredCountsRes = await db.prepare(`
    SELECT message_id, COUNT(DISTINCT user_id) as count
    FROM message_receipts
    WHERE message_id IN (${validPlaceholders}) AND status IN ('delivered', 'read')
    GROUP BY message_id
  `).bind(...validIds).all<{ message_id: string; count: number }>();

  const deliveredMap = new Map<string, number>();
  for (const row of deliveredCountsRes.results) {
    deliveredMap.set(row.message_id, row.count);
  }

  // 5. Batch transition message status to 'delivered' if all recipients have received it
  const updateStatements: D1PreparedStatement[] = [];
  for (const msg of validMessages) {
    const membersSet = convMembersMap.get(msg.conversation_id);
    const recipientCount = membersSet ? membersSet.size - (membersSet.has(msg.sender_id) ? 1 : 0) : 0;
    const deliveredCount = deliveredMap.get(msg.id) ?? 0;

    if (recipientCount > 0 && deliveredCount >= recipientCount && msg.status === 'pending') {
      updateStatements.push(
        db.prepare(`
          UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?
        `).bind(now, msg.id)
      );
    }
  }

  if (updateStatements.length > 0) {
    await db.batch(updateStatements);
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

  if (!messageIds || messageIds.length === 0) {
    return { read, burned, skipped, burn_windows };
  }

  const uniqueIds = Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && id.trim())));
  if (uniqueIds.length === 0) {
    return { read, burned, skipped, burn_windows };
  }

  const now = Date.now();
  const placeholders = uniqueIds.map(() => '?').join(',');

  // 1. Single query: Fetch all messages where current user is a member of the conversation
  const query = `
    SELECT m.id, m.conversation_id, m.sender_id, m.retention, m.status, m.burn_after_seconds
    FROM messages m
    JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
    WHERE m.id IN (${placeholders})
  `;
  const res = await db.prepare(query).bind(userId, ...uniqueIds).all<{
    id: string;
    conversation_id: string;
    sender_id: string;
    retention: 'permanent' | 'on_read';
    status: string;
    burn_after_seconds: number | null;
  }>();

  const foundMap = new Map<string, {
    id: string;
    conversation_id: string;
    sender_id: string;
    retention: 'permanent' | 'on_read';
    status: string;
    burn_after_seconds: number | null;
  }>();
  for (const m of res.results) {
    foundMap.set(m.id, m);
  }

  const validMessages: {
    id: string;
    conversation_id: string;
    sender_id: string;
    retention: 'permanent' | 'on_read';
    status: string;
    burn_after_seconds: number | null;
  }[] = [];

  for (const id of uniqueIds) {
    const msg = foundMap.get(id);
    if (!msg || msg.sender_id === userId) {
      skipped.push(id);
    } else {
      validMessages.push(msg);
    }
  }

  if (validMessages.length === 0) {
    return { read, burned, skipped, burn_windows };
  }

  // 2. Batch update conversation_members.last_read_message_id for each conversation involved
  const convLastMsgMap = new Map<string, string>();
  for (const m of validMessages) {
    convLastMsgMap.set(m.conversation_id, m.id);
  }

  const initialBatchStmts: D1PreparedStatement[] = [];
  for (const [convId, lastMsgId] of convLastMsgMap.entries()) {
    initialBatchStmts.push(
      db.prepare(`
        UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?
      `).bind(lastMsgId, convId, userId)
    );
  }

  // 3. Batch insert 'delivered' and 'read' receipts
  for (const m of validMessages) {
    initialBatchStmts.push(
      db.prepare(`
        INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
        VALUES (?, ?, ?, 'delivered', ?)
      `).bind(crypto.randomUUID(), m.id, userId, now)
    );
    initialBatchStmts.push(
      db.prepare(`
        INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
        VALUES (?, ?, ?, 'read', ?)
      `).bind(crypto.randomUUID(), m.id, userId, now)
    );
  }

  await db.batch(initialBatchStmts);

  // 4. Batch fetch conversation members
  const convIds = Array.from(new Set(validMessages.map((m) => m.conversation_id)));
  const convPlaceholders = convIds.map(() => '?').join(',');
  const membersRes = await db.prepare(`
    SELECT conversation_id, user_id
    FROM conversation_members
    WHERE conversation_id IN (${convPlaceholders})
  `).bind(...convIds).all<{ conversation_id: string; user_id: string }>();

  const convMembersMap = new Map<string, Set<string>>();
  for (const row of membersRes.results) {
    if (!convMembersMap.has(row.conversation_id)) {
      convMembersMap.set(row.conversation_id, new Set());
    }
    convMembersMap.get(row.conversation_id)!.add(row.user_id);
  }

  // 5. Batch fetch delivered and read counts in a single query
  const validIds = validMessages.map((m) => m.id);
  const validPlaceholders = validIds.map(() => '?').join(',');
  const receiptCountsRes = await db.prepare(`
    SELECT
      message_id,
      COUNT(DISTINCT user_id) AS delivered_count,
      COUNT(DISTINCT CASE WHEN status = 'read' THEN user_id END) AS read_count
    FROM message_receipts
    WHERE message_id IN (${validPlaceholders}) AND status IN ('delivered', 'read')
    GROUP BY message_id
  `).bind(...validIds).all<{ message_id: string; delivered_count: number; read_count: number }>();

  const countsMap = new Map<string, { delivered_count: number; read_count: number }>();
  for (const r of receiptCountsRes.results) {
    countsMap.set(r.message_id, {
      delivered_count: r.delivered_count,
      read_count: r.read_count,
    });
  }

  // 6. Check status transitions
  const updateStmts: D1PreparedStatement[] = [];
  const onReadCandidates: string[] = [];

  for (const msg of validMessages) {
    const membersSet = convMembersMap.get(msg.conversation_id);
    const recipientCount = membersSet ? membersSet.size - (membersSet.has(msg.sender_id) ? 1 : 0) : 0;
    const counts = countsMap.get(msg.id) ?? { delivered_count: 0, read_count: 0 };
    const deliveredCount = counts.delivered_count;
    const readCount = counts.read_count;

    const allDelivered = recipientCount > 0 && deliveredCount >= recipientCount;
    const allRead = recipientCount > 0 && readCount >= recipientCount;

    if (allDelivered && msg.status === 'pending') {
      updateStmts.push(
        db.prepare(`
          UPDATE messages SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?) WHERE id = ?
        `).bind(now, msg.id)
      );
    }

    if (msg.retention === 'on_read') {
      const burnWindowSeconds = msg.burn_after_seconds ?? 30;
      burn_windows[msg.id] = burnWindowSeconds;
      if (allRead) {
        onReadCandidates.push(msg.id);
      }
      burned.push(msg.id);
    } else {
      if (allRead && msg.status !== 'read') {
        updateStmts.push(
          db.prepare(`
            UPDATE messages SET status = 'read', read_at = ? WHERE id = ?
          `).bind(now, msg.id)
        );
      }
      read.push(msg.id);
    }
  }

  if (updateStmts.length > 0) {
    await db.batch(updateStmts);
  }

  // 7. Check destruction for on_read messages that are allRead
  if (onReadCandidates.length > 0) {
    const candidatePlaceholders = onReadCandidates.map(() => '?').join(',');
    const latestReadRes = await db.prepare(`
      SELECT message_id, MAX(timestamp) as latest_read
      FROM message_receipts
      WHERE message_id IN (${candidatePlaceholders}) AND status = 'read'
      GROUP BY message_id
    `).bind(...onReadCandidates).all<{ message_id: string; latest_read: number | null }>();

    const latestReadMap = new Map<string, number>();
    for (const r of latestReadRes.results) {
      if (r.latest_read !== null) {
        latestReadMap.set(r.message_id, r.latest_read);
      }
    }

    for (const id of onReadCandidates) {
      const msg = foundMap.get(id);
      const burnWindowSeconds = msg?.burn_after_seconds ?? 30;
      const burnWindowMs = burnWindowSeconds * 1000;
      const latestRead = latestReadMap.get(id) ?? now;
      if (now - latestRead >= burnWindowMs) {
        await destroyMessage(db, r2, id);
      }
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

  const updateMsgStmt = db.prepare(
    "UPDATE messages SET recalled_at = ?, content = '[Message recalled]' WHERE id = ?"
  ).bind(now, messageId);

  const updateConvStmt = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, msg.conversation_id);

  await db.batch([updateMsgStmt, updateConvStmt]);

  return {
    success: true,
    message_id: messageId,
    recalled_at: now,
  };
}
