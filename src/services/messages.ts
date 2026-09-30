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
  type?: 'text' | 'voice' | 'image' | 'file' | 'system' | 'sticker';
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
  // 同毫秒决胜游标（指南 阶段4③）：与 since 搭配，(created_at, id) 全序防漏单
  since_id?: string;
  limit?: number;
}

export interface SyncCursor {
  ts: number;
  id: string;
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
  // sticker 消息：content 为 R2 贴纸键主体（分类/文件名，不含 webp/ 前缀与 .webp 后缀），
  // 形如 animated/U+2764_1、flags/CN；二进制由公开路由 GET /stickers/<content>.webp 提供。
  if (type === 'sticker') {
    const content = options.content?.trim() ?? '';
    if (!/^[a-z_]+\/[A-Za-z0-9+_.-]{1,90}$/.test(content)) {
      throw new Error('Invalid sticker content: expected "<category>/<name>" (e.g. "animated/U+2764_1")');
    }
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

  await db.prepare('UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?').bind(now, now, conversationId).run();

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
          AND m.created_at >= ? AND (m.created_at > ? OR m.id > ?)
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
): Promise<{ messages: MessageWithSender[]; sync_timestamp: number; has_more: boolean; next_cursor: SyncCursor | null }> {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 200);
  const now = Date.now();
  const since = options.since ? Number(options.since) : 0;
  const sinceId = options.since_id ?? '';

  // (created_at, id) 全序决胜：仅在客户端传 since_id 时启用同毫秒续拉；
  // 无 since_id 时保持旧语义（created_at > since），向后兼容老客户端。
  // 两种形式的首个约束都是 created_at 的纯范围比较，可下推到
  // idx_messages_conv_created / idx_messages_created_at；有 since_id 时的
  // 残差 OR 仅在 created_at = since 的同毫秒行上评估。
  const cursorClause = sinceId
    ? 'm.created_at >= ? AND (m.created_at > ? OR m.id > ?)'
    : 'm.created_at > ?';
  const cursorParams: unknown[] = sinceId ? [since, since, sinceId] : [since];

  const query = `
    SELECT m.*, u.wallet_address AS sender_address
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
    WHERE m.expires_at > ?
      AND ${cursorClause}
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

  const res = await db.prepare(query).bind(userId, now, ...cursorParams, userId, now, limit + 1).all<MessageWithSender>();
  const rows = res.results;
  const has_more = rows.length > limit;
  const messages = has_more ? rows.slice(0, limit) : rows;
  const enriched = await enrichMessagesWithMedia(db, messages);
  const last = enriched.length > 0 ? enriched[enriched.length - 1] : null;

  return {
    messages: enriched,
    sync_timestamp: now,
    has_more,
    next_cursor: last ? { ts: last.created_at, id: last.id } : null,
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

// ---- ACK 批量查询公共工具 -------------------------------------------------
// D1/SQLite 绑定变量上限保守取 50：所有 IN (...) 批量查询按块拆分，每块绑定参数 ≤50。
const BIND_CHUNK = 50;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

interface AckMessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  retention: 'permanent' | 'on_read';
  status: string;
  burn_after_seconds: number | null;
  created_at: number;
}

// Phase 1 批量版：一次 IN 查询同时完成“消息存在 + 当前用户是群成员”校验，
// 结果按 id 建 Map，调用方再按输入顺序回填 acknowledged/skipped（语义与逐条一致）。
async function fetchAckCandidates(
  db: D1Database,
  userId: string,
  messageIds: string[]
): Promise<Map<string, AckMessageRow>> {
  const map = new Map<string, AckMessageRow>();
  // 每块 1(userId) + 49(ids) = 50 个绑定参数
  for (const ids of chunked(messageIds, BIND_CHUNK - 1)) {
    const res = await db.prepare(`
      SELECT m.id, m.conversation_id, m.sender_id, m.retention, m.status, m.burn_after_seconds, m.created_at
      FROM messages m
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE m.id IN (${placeholders(ids.length)})
    `).bind(userId, ...ids).all<AckMessageRow>();
    for (const row of res.results) {
      map.set(row.id, row);
    }
  }
  return map;
}

// Phase 3 批量版：recipientCount = 会话成员总数 - (发送者仍是成员 ? 1 : 0)。
// 两步 GROUP BY / 行值 IN 批量查询替代原 per-message COUNT：
//  1) 每个会话成员总数 GROUP BY conversation_id；
//  2) 批量探测各 (conversation_id, sender_id) 成员关系（SQLite 行值 IN）。
async function getRecipientCounts(
  db: D1Database,
  msgs: AckMessageRow[]
): Promise<Map<string, number>> {
  const pairMap = new Map<string, { conversation_id: string; sender_id: string }>();
  for (const m of msgs) {
    pairMap.set(`${m.conversation_id} ${m.sender_id}`, m);
  }

  const convIds = [...new Set(msgs.map((m) => m.conversation_id))];
  const totals = new Map<string, number>();
  for (const ids of chunked(convIds, BIND_CHUNK)) {
    const res = await db.prepare(`
      SELECT conversation_id, COUNT(*) AS count
      FROM conversation_members
      WHERE conversation_id IN (${placeholders(ids.length)})
      GROUP BY conversation_id
    `).bind(...ids).all<{ conversation_id: string; count: number }>();
    for (const r of res.results) {
      totals.set(r.conversation_id, r.count);
    }
  }

  const senderIsMember = new Set<string>();
  // 每块 25 对 × 2 列 = 50 个绑定参数
  for (const pairs of chunked([...pairMap.values()], BIND_CHUNK / 2)) {
    const tuplePh = pairs.map(() => '(?, ?)').join(',');
    const res = await db.prepare(`
      SELECT conversation_id, user_id
      FROM conversation_members
      WHERE (conversation_id, user_id) IN (${tuplePh})
    `).bind(...pairs.flatMap((p) => [p.conversation_id, p.sender_id])).all<{ conversation_id: string; user_id: string }>();
    for (const r of res.results) {
      senderIsMember.add(`${r.conversation_id} ${r.user_id}`);
    }
  }

  const counts = new Map<string, number>();
  for (const [key, m] of pairMap) {
    const total = totals.get(m.conversation_id) ?? 0;
    counts.set(key, senderIsMember.has(key) ? total - 1 : total);
  }
  return counts;
}

// Phase 3 批量版：一次 GROUP BY 同时给出每条消息的 delivered 与 read 去重人数，
// 替代原 per-message 的 2~3 次 COUNT 聚合。
async function getReceiptCountsByMessage(
  db: D1Database,
  messageIds: string[]
): Promise<Map<string, { delivered: number; read: number }>> {
  const counts = new Map<string, { delivered: number; read: number }>();
  for (const ids of chunked(messageIds, BIND_CHUNK)) {
    const res = await db.prepare(`
      SELECT message_id,
        COUNT(DISTINCT user_id) AS delivered_count,
        COUNT(DISTINCT CASE WHEN status = 'read' THEN user_id END) AS read_count
      FROM message_receipts
      WHERE message_id IN (${placeholders(ids.length)})
        AND status IN ('delivered', 'read')
      GROUP BY message_id
    `).bind(...ids).all<{ message_id: string; delivered_count: number; read_count: number }>();
    for (const r of res.results) {
      counts.set(r.message_id, { delivered: r.delivered_count, read: r.read_count });
    }
  }
  return counts;
}

// 批量投递 ACK（指南 支柱三/写压优化）：读校验与聚合统计均改为 IN (...) 分块批量查询，
// 回执写入与状态推进各合并为单次 db.batch，N 条消息仅产生 O(N/50) 次 D1 往返。
export async function acknowledgeDelivery(
  db: D1Database,
  userId: string,
  messageIds: string[]
): Promise<{ acknowledged: string[]; skipped: string[] }> {
  const acknowledged: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();

  // Phase 1: membership + sender validation (batched reads)
  const candidates = await fetchAckCandidates(db, userId, messageIds);
  const valid: AckMessageRow[] = [];
  for (const id of messageIds) {
    const msg = candidates.get(id);
    if (!msg || msg.sender_id === userId) {
      skipped.push(id);
      continue;
    }
    valid.push(msg);
    acknowledged.push(id);
  }

  if (valid.length === 0) {
    return { acknowledged, skipped };
  }

  // Phase 2: single batched write for all receipts (UNIQUE(message_id,user_id,status) 幂等)
  await db.batch(
    valid.map((msg) =>
      db.prepare(`
        INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
        VALUES (?, ?, ?, 'delivered', ?)
      `).bind(crypto.randomUUID(), msg.id, userId, now)
    )
  );

  // Phase 3: batched aggregate counts (reads), then one batched write for status advancement
  const recipientCounts = await getRecipientCounts(db, valid);
  const receiptCounts = await getReceiptCountsByMessage(db, valid.map((m) => m.id));

  const advancements: D1PreparedStatement[] = [];
  for (const msg of valid) {
    const recipientCount = recipientCounts.get(`${msg.conversation_id} ${msg.sender_id}`) ?? 0;
    const deliveredCount = receiptCounts.get(msg.id)?.delivered ?? 0;

    // Transition message status only when ALL recipients have received it
    if (recipientCount > 0 && deliveredCount >= recipientCount && msg.status === 'pending') {
      advancements.push(
        db.prepare(`UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?`).bind(now, msg.id)
      );
    }
  }
  if (advancements.length > 0) {
    await db.batch(advancements);
  }

  return { acknowledged, skipped };
}

// 批量已读 ACK（指南 支柱三/写压优化）：读校验与聚合统计为 IN (...) 分块批量查询，
// 回执/last_read/状态推进均合并为 db.batch。
// last_read_message_id 按会话取已读消息中 created_at 最大者（与请求数组顺序无关）。
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

  interface ValidMsg extends AckMessageRow {}
  const valid: ValidMsg[] = [];

  // Phase 1: membership + sender validation (batched reads)
  const candidates = await fetchAckCandidates(db, userId, messageIds);
  for (const id of messageIds) {
    const msg = candidates.get(id);
    if (!msg || msg.sender_id === userId) {
      skipped.push(id);
      continue;
    }
    valid.push(msg);
  }

  if (valid.length === 0) {
    return { read, burned, skipped, burn_windows };
  }

  // Phase 2: batched writes — last_read 游标（每会话一条）+ delivered/read 回执（幂等）
  const writes: D1PreparedStatement[] = [];
  const latestByConv = new Map<string, ValidMsg>();
  for (const msg of valid) {
    const cur = latestByConv.get(msg.conversation_id);
    if (!cur || msg.created_at > cur.created_at || (msg.created_at === cur.created_at && msg.id > cur.id)) {
      latestByConv.set(msg.conversation_id, msg);
    }
  }
  for (const [convId, msg] of latestByConv) {
    writes.push(
      db.prepare(`
        UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?
      `).bind(msg.id, convId, userId)
    );
  }
  for (const msg of valid) {
    writes.push(
      db.prepare(`
        INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
        VALUES (?, ?, ?, 'delivered', ?)
      `).bind(crypto.randomUUID(), msg.id, userId, now),
      db.prepare(`
        INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
        VALUES (?, ?, ?, 'read', ?)
      `).bind(crypto.randomUUID(), msg.id, userId, now)
    );
  }
  await db.batch(writes);

  // Phase 3: batched aggregate counts (reads), batched status advancement
  const advancements: D1PreparedStatement[] = [];
  interface BurnCandidate {
    msg: ValidMsg;
    burnWindowMs: number;
  }
  const burnCandidates: BurnCandidate[] = [];

  const recipientCounts = await getRecipientCounts(db, valid);
  const receiptCounts = await getReceiptCountsByMessage(db, valid.map((m) => m.id));

  for (const msg of valid) {
    // Calculate recipient count (all members except sender)
    const recipientCount = recipientCounts.get(`${msg.conversation_id} ${msg.sender_id}`) ?? 0;
    const counts = receiptCounts.get(msg.id);
    const readCount = counts?.read ?? 0;
    const deliveredCount = counts?.delivered ?? 0;

    const allDelivered = recipientCount > 0 && deliveredCount >= recipientCount;
    const allRead = recipientCount > 0 && readCount >= recipientCount;

    if (allDelivered && msg.status === 'pending') {
      advancements.push(
        db.prepare(`
          UPDATE messages SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?) WHERE id = ?
        `).bind(now, msg.id)
      );
    }

    if (msg.retention === 'on_read') {
      // Burn on read: allow viewing for at least 30s.
      // Physical destruction delays until all recipients read AND all viewing windows elapse.
      const burnWindowSeconds = msg.burn_after_seconds ?? 30;
      burn_windows[msg.id] = burnWindowSeconds;
      if (allRead) {
        burnCandidates.push({ msg, burnWindowMs: burnWindowSeconds * 1000 });
      }
      burned.push(msg.id);
    } else {
      if (allRead && msg.status !== 'read') {
        advancements.push(
          db.prepare(`UPDATE messages SET status = 'read', read_at = ? WHERE id = ?`).bind(now, msg.id)
        );
      }
      read.push(msg.id);
    }
  }
  if (advancements.length > 0) {
    await db.batch(advancements);
  }

  // Phase 4: 物理销毁（全员已读且最晚已读满 burn 窗口；罕见路径，逐条处理）
  for (const { msg, burnWindowMs } of burnCandidates) {
    const latestReadRes = await db.prepare(`
      SELECT MAX(timestamp) as latest_read
      FROM message_receipts
      WHERE message_id = ? AND status = 'read'
    `).bind(msg.id).first<{ latest_read: number | null }>();
    const latestRead = latestReadRes?.latest_read ?? now;
    if (now - latestRead >= burnWindowMs) {
      await destroyMessage(db, r2, msg.id);
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
