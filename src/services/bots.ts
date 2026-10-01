import type { BotRow, UserRow, ConversationRow, BotTaskRow, BotAuditLogRow, BotTaskType, BotTaskStatus } from '../db/schema';
import { isGroupLike } from '../db/schema';
import { hashToken } from './auth';
import {
  joinGroupByInviteToken,
  joinPublicGroup,
  findOrCreateUser,
  addGroupMember,
  removeGroupMember,
  setGroupMute,
  setMemberMute,
  updateGroup,
  getConversation,
} from './conversations';
import { getGroupCapacityInfo } from './payments/capacity';
import { sendMessage } from './messages';
import { allow } from './rateLimit';

export interface CreateBotOptions {
  name: string;
  username?: string | null;
  description?: string | null;
  avatar_url?: string | null;
}

export interface UpdateBotOptions {
  name?: string;
  username?: string | null;
  description?: string | null;
  avatar_url?: string | null;
  status?: 'active' | 'disabled';
}

export interface BotWithSecret extends BotRow {
  api_key: string;
}

export async function hashApiKey(key: string): Promise<string> {
  return hashToken(key);
}

export function generateApiKey(): string {
  const p1 = crypto.randomUUID().replace(/-/g, '');
  const p2 = crypto.randomUUID().replace(/-/g, '');
  return `bot_sec_${p1}${p2}`;
}

export function validateBotUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,32}$/.test(username);
}

export const MAX_BOTS_PER_OWNER = 20;

/**
 * Creates a new bot owned by ownerId.
 * Creates both a bot record and a corresponding virtual user record.
 */
export async function createBot(
  db: D1Database,
  ownerId: string,
  options: CreateBotOptions
): Promise<BotWithSecret> {
  // Quota check: limit bots per owner to prevent Sybil/D1 bloat
  const countRow = await db
    .prepare('SELECT COUNT(*) AS count FROM bots WHERE owner_id = ?')
    .bind(ownerId)
    .first<{ count: number }>();
  if (countRow && countRow.count >= MAX_BOTS_PER_OWNER) {
    throw new Error(`Maximum bot quota reached (max ${MAX_BOTS_PER_OWNER} bots per user)`);
  }

  const name = options.name ? options.name.trim() : '';
  if (!name) {
    throw new Error('Bot name is required');
  }
  if (name.length > 64) {
    throw new Error('Bot name cannot exceed 64 characters');
  }

  let cleanUsername: string | null = null;
  if (options.username && options.username.trim()) {
    cleanUsername = options.username.trim().toLowerCase();
    if (!validateBotUsername(cleanUsername)) {
      throw new Error('Invalid username: must be 3-32 alphanumeric characters or underscores');
    }

    // Check uniqueness in bots and users table in a single roundtrip
    const existing = await db
      .prepare(
        `SELECT 1 FROM (
          SELECT username FROM bots WHERE username = ?
          UNION ALL
          SELECT username FROM users WHERE username = ?
        ) LIMIT 1`
      )
      .bind(cleanUsername, cleanUsername)
      .first();
    if (existing) {
      throw new Error('Username already taken');
    }
  }

  const now = Date.now();
  const botId = `bot_${crypto.randomUUID().replace(/-/g, '')}`;
  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const apiKeyPrefix = apiKey.substring(0, 15);
  const description = options.description ? options.description.trim() : null;
  const avatarUrl = options.avatar_url ? options.avatar_url.trim() : null;

  const publicMetadata = JSON.stringify({
    nickname: name,
    description: description || '',
    avatar_url: avatarUrl,
    is_bot: true,
    bot_id: botId,
    owner_id: ownerId,
  });

  // Batch insert into users and bots tables
  const insertUserStmt = db
    .prepare(
      'INSERT INTO users (id, wallet_address, username, public_metadata, private_metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(botId, botId, cleanUsername, publicMetadata, '{}', now, now);

  const insertBotStmt = db
    .prepare(
      'INSERT INTO bots (id, owner_id, name, username, description, api_key_hash, api_key_prefix, avatar_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      botId,
      ownerId,
      name,
      cleanUsername,
      description,
      apiKeyHash,
      apiKeyPrefix,
      avatarUrl,
      'active',
      now,
      now
    );

  await db.batch([insertUserStmt, insertBotStmt]);

  return {
    id: botId,
    owner_id: ownerId,
    name,
    username: cleanUsername,
    description,
    api_key_hash: apiKeyHash,
    api_key_prefix: apiKeyPrefix,
    avatar_url: avatarUrl,
    status: 'active',
    created_at: now,
    updated_at: now,
    api_key: apiKey,
  };
}

/**
 * List all bots owned by a user.
 */
export async function listUserBots(db: D1Database, ownerId: string): Promise<BotRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at DESC')
    .bind(ownerId)
    .all<BotRow>();
  return results || [];
}

/**
 * Get bot details by ID.
 */
export async function getBot(db: D1Database, botId: string, ownerId?: string): Promise<BotRow> {
  const bot = await db.prepare('SELECT * FROM bots WHERE id = ?').bind(botId).first<BotRow>();
  if (!bot) {
    throw new Error('Bot not found');
  }
  if (ownerId && bot.owner_id !== ownerId) {
    throw new Error('Unauthorized: you do not own this bot');
  }
  return bot;
}

/**
 * Update bot details.
 */
export async function updateBot(
  db: D1Database,
  botId: string,
  ownerId: string,
  updates: UpdateBotOptions
): Promise<BotRow> {
  const bot = await getBot(db, botId, ownerId);
  const now = Date.now();

  const newName = updates.name !== undefined ? updates.name.trim() : bot.name;
  if (!newName) {
    throw new Error('Bot name cannot be empty');
  }

  let newUsername = bot.username;
  if (updates.username !== undefined) {
    const clean = updates.username ? updates.username.trim().toLowerCase() : null;
    if (clean && clean !== bot.username) {
      if (!validateBotUsername(clean)) {
        throw new Error('Invalid username: must be 3-32 alphanumeric characters or underscores');
      }
      const existing = await db
        .prepare(
          `SELECT 1 FROM (
            SELECT username FROM bots WHERE username = ? AND id != ?
            UNION ALL
            SELECT username FROM users WHERE username = ? AND id != ?
          ) LIMIT 1`
        )
        .bind(clean, botId, clean, botId)
        .first();
      if (existing) {
        throw new Error('Username already taken');
      }
    }
    newUsername = clean;
  }

  const newDescription =
    updates.description !== undefined
      ? updates.description
        ? updates.description.trim()
        : null
      : bot.description;
  const newAvatarUrl =
    updates.avatar_url !== undefined
      ? updates.avatar_url
        ? updates.avatar_url.trim()
        : null
      : bot.avatar_url;
  const newStatus = updates.status !== undefined ? updates.status : bot.status;

  const publicMetadata = JSON.stringify({
    nickname: newName,
    description: newDescription || '',
    avatar_url: newAvatarUrl,
    is_bot: true,
    bot_id: botId,
    owner_id: ownerId,
  });

  const updateBotStmt = db
    .prepare(
      'UPDATE bots SET name = ?, username = ?, description = ?, avatar_url = ?, status = ?, updated_at = ? WHERE id = ?'
    )
    .bind(newName, newUsername, newDescription, newAvatarUrl, newStatus, now, botId);

  const updateUserStmt = db
    .prepare('UPDATE users SET username = ?, public_metadata = ?, updated_at = ? WHERE id = ?')
    .bind(newUsername, publicMetadata, now, botId);

  await db.batch([updateBotStmt, updateUserStmt]);
  invalidateBotCache(botId);

  return {
    ...bot,
    name: newName,
    username: newUsername,
    description: newDescription,
    avatar_url: newAvatarUrl,
    status: newStatus,
    updated_at: now,
  };
}

/**
 * Regenerate / Reset API Key for a bot.
 * Old API key is immediately invalidated.
 */
export async function resetBotApiKey(
  db: D1Database,
  botId: string,
  ownerId: string
): Promise<{ bot: BotRow; api_key: string }> {
  const bot = await getBot(db, botId, ownerId);
  const now = Date.now();

  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const apiKeyPrefix = apiKey.substring(0, 15);

  await db
    .prepare(
      'UPDATE bots SET api_key_hash = ?, api_key_prefix = ?, updated_at = ? WHERE id = ?'
    )
    .bind(apiKeyHash, apiKeyPrefix, now, botId)
    .run();

  invalidateBotCache(botId);

  const updatedBot: BotRow = {
    ...bot,
    api_key_hash: apiKeyHash,
    api_key_prefix: apiKeyPrefix,
    updated_at: now,
  };

  return {
    bot: updatedBot,
    api_key: apiKey,
  };
}

/**
 * Delete a bot and its virtual user.
 */
export async function deleteBot(
  db: D1Database,
  botId: string,
  ownerId: string
): Promise<{ deleted: boolean }> {
  await getBot(db, botId, ownerId);

  // Deleting user cascades to conversation_members, messages, bots, etc.
  const deleteBotStmt = db.prepare('DELETE FROM bots WHERE id = ?').bind(botId);
  const deleteUserStmt = db.prepare('DELETE FROM users WHERE id = ?').bind(botId);

  await db.batch([deleteBotStmt, deleteUserStmt]);
  invalidateBotCache(botId);

  return { deleted: true };
}

interface CachedBotCredentials {
  bot: BotRow;
  user: UserRow;
  cachedUntil: number;
}

const botCredentialCache = new Map<string, CachedBotCredentials>();
const BOT_CACHE_TTL_MS = 20_000; // 20s in-memory cache to eliminate D1 query load on bot polling
const MAX_BOT_CACHE_SIZE = 1000;

export function invalidateBotCache(botId?: string): void {
  if (!botId) {
    botCredentialCache.clear();
    return;
  }
  const target = botId.toLowerCase();
  for (const [key, entry] of botCredentialCache.entries()) {
    if (entry.bot.id.toLowerCase() === target || key.toLowerCase().startsWith(`${target}:`)) {
      botCredentialCache.delete(key);
    }
  }
}

/**
 * Validates bot credentials.
 * Returns the BotRow and the virtual UserRow if valid, otherwise null.
 */
export async function validateBotCredentials(
  db: D1Database,
  botId: string,
  apiKey: string
): Promise<{ bot: BotRow; user: UserRow } | null> {
  if (!botId || !apiKey) {
    return null;
  }

  const cacheKey = `${botId}:${apiKey}`;
  const now = Date.now();
  const cached = botCredentialCache.get(cacheKey);
  if (cached && cached.cachedUntil > now) {
    return { bot: cached.bot, user: cached.user };
  }

  interface BotWithUserRow extends BotRow {
    u_id: string;
    u_wallet_address: string;
    u_username: string | null;
    u_public_metadata: string;
    u_private_metadata: string;
    u_avatar_key: string | null;
    u_avatar_mime: string | null;
    u_avatar_updated_at: number | null;
    u_created_at: number;
    u_updated_at: number;
  }

  const row = await db
    .prepare(
      `SELECT
        b.id,
        b.owner_id,
        b.name,
        b.username,
        b.description,
        b.api_key_hash,
        b.api_key_prefix,
        b.avatar_url,
        b.status,
        b.created_at,
        b.updated_at,
        u.id AS u_id,
        u.wallet_address AS u_wallet_address,
        u.username AS u_username,
        u.public_metadata AS u_public_metadata,
        u.private_metadata AS u_private_metadata,
        u.avatar_key AS u_avatar_key,
        u.avatar_mime AS u_avatar_mime,
        u.avatar_updated_at AS u_avatar_updated_at,
        u.created_at AS u_created_at,
        u.updated_at AS u_updated_at
      FROM bots b
      JOIN users u ON u.id = b.id
      WHERE b.id = ? AND b.status = 'active'`
    )
    .bind(botId)
    .first<BotWithUserRow>();

  if (!row) {
    return null;
  }

  const hash = await hashApiKey(apiKey);
  if (hash !== row.api_key_hash) {
    return null;
  }

  const bot: BotRow = {
    id: row.id,
    owner_id: row.owner_id,
    name: row.name,
    username: row.username,
    description: row.description,
    api_key_hash: row.api_key_hash,
    api_key_prefix: row.api_key_prefix,
    avatar_url: row.avatar_url,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  const user: UserRow = {
    id: row.u_id,
    wallet_address: row.u_wallet_address,
    username: row.u_username,
    public_metadata: row.u_public_metadata,
    private_metadata: row.u_private_metadata,
    avatar_key: row.u_avatar_key,
    avatar_mime: row.u_avatar_mime,
    avatar_updated_at: row.u_avatar_updated_at,
    created_at: row.u_created_at,
    updated_at: row.u_updated_at,
  };

  // Cache verified bot credentials in isolate memory
  if (botCredentialCache.size >= MAX_BOT_CACHE_SIZE) {
    const oldestKey = botCredentialCache.keys().next().value;
    if (oldestKey) botCredentialCache.delete(oldestKey);
  }
  botCredentialCache.set(cacheKey, {
    bot,
    user,
    cachedUntil: now + BOT_CACHE_TTL_MS,
  });

  return { bot, user };
}

export interface BotConversationSummary {
  id: string;
  name: string | null;
  type: 'direct' | 'group' | 'club';
  group_type: 'private' | 'public';
  role: 'owner' | 'admin' | 'member';
  member_count: number;
  joined_at: number;
  updated_at: number;
}

/**
 * List all conversations/groups the bot is currently in.
 */
export async function listBotConversations(
  db: D1Database,
  botId: string
): Promise<BotConversationSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT
        c.id,
        c.name,
        c.type,
        c.group_type,
        cm.role,
        cm.joined_at,
        c.updated_at,
        (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
      FROM conversation_members cm
      JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.user_id = ?
      ORDER BY c.updated_at DESC`
    )
    .bind(botId)
    .all<BotConversationSummary>();

  return results || [];
}

/**
 * Bot joins a group via invite token or public group ID.
 */
export async function botJoinGroup(
  db: D1Database,
  botUser: UserRow,
  options: { group_id?: string; invite_token?: string }
) {
  if (options.invite_token) {
    return joinGroupByInviteToken(db, options.invite_token, botUser);
  }
  if (options.group_id) {
    return joinPublicGroup(db, options.group_id, botUser);
  }
  throw new Error('Either invite_token or group_id must be provided');
}

/**
 * Record a bot administrative action into audit logs.
 */
export async function recordBotAuditLog(
  db: D1Database,
  botId: string,
  groupId: string | null,
  action: string,
  targetId?: string | null,
  details?: Record<string, unknown> | string | null
): Promise<BotAuditLogRow> {
  const id = `audit_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Date.now();
  const detailsStr = details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null;
  await db
    .prepare(
      'INSERT INTO bot_audit_logs (id, bot_id, group_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(id, botId, groupId, action, targetId || null, detailsStr, now)
    .run();
  return {
    id,
    bot_id: botId,
    group_id: groupId,
    action,
    target_id: targetId || null,
    details: detailsStr,
    created_at: now,
  };
}

/**
 * Check single bot message rate limit in a group (B-R4: max 3 messages per minute per bot per group).
 */
export async function checkBotMessageRateLimit(
  db: D1Database,
  botId: string,
  conversationId: string
): Promise<boolean> {
  return allow(db, 'bot_msg', `${botId}:${conversationId}`, 3);
}

export interface BotInviteMemberOptions {
  user_id?: string;
  wallet_address?: string;
  username?: string;
  nickname?: string;
  avatar_url?: string;
}

/**
 * Bot invites/adds a member to a group (Requires bot to be owner/admin).
 * Writes avatar, nickname, and account info into member profile upon entry.
 */
export async function botInviteMember(
  db: D1Database,
  botUser: UserRow,
  groupId: string,
  options: BotInviteMemberOptions
) {
  const botMember = await db
    .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(groupId, botUser.id)
    .first<{ role: string }>();
  if (!botMember || (botMember.role !== 'owner' && botMember.role !== 'admin')) {
    throw new Error('Unauthorized: bot must be owner or admin of the group to invite members');
  }

  const targetIdentifier = options.user_id || options.wallet_address || options.username;
  if (!targetIdentifier) {
    throw new Error('user_id, wallet_address, or username is required');
  }

  const targetUser = await findOrCreateUser(db, targetIdentifier);

  // Update profile metadata if provided
  if (options.nickname || options.avatar_url) {
    try {
      const publicMeta = JSON.parse(targetUser.public_metadata || '{}');
      let updated = false;
      if (options.nickname && (!publicMeta.nickname || publicMeta.nickname !== options.nickname)) {
        publicMeta.nickname = options.nickname;
        updated = true;
      }
      if (options.avatar_url && (!publicMeta.avatar_url || publicMeta.avatar_url !== options.avatar_url)) {
        publicMeta.avatar_url = options.avatar_url;
        updated = true;
      }
      if (updated) {
        await db
          .prepare('UPDATE users SET public_metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(publicMeta), Date.now(), targetUser.id)
          .run();
        targetUser.public_metadata = JSON.stringify(publicMeta);
      }
    } catch {}
  }

  const member = await addGroupMember(db, groupId, botUser.id, targetUser.id);

  if (options.nickname) {
    await db
      .prepare('UPDATE conversation_members SET group_nickname = ? WHERE conversation_id = ? AND user_id = ?')
      .bind(options.nickname, groupId, targetUser.id)
      .run();
    member.group_nickname = options.nickname;
  }

  await recordBotAuditLog(db, botUser.id, groupId, 'invite_member', targetUser.id, {
    nickname: options.nickname,
    avatar_url: options.avatar_url,
  });

  let parsedNickname = targetUser.username;
  let parsedAvatar: string | null = null;
  try {
    const meta = JSON.parse(targetUser.public_metadata || '{}');
    if (meta.nickname) parsedNickname = meta.nickname;
    if (meta.avatar_url) parsedAvatar = meta.avatar_url;
  } catch {}

  const userDisplay = {
    id: targetUser.id,
    wallet_address: targetUser.wallet_address,
    username: targetUser.username,
    nickname: options.nickname || parsedNickname,
    avatar_url: options.avatar_url || parsedAvatar,
  };

  return {
    member,
    user: userDisplay,
  };
}

/**
 * Set group capacity / member limit (Requires bot to be owner/admin).
 */
export async function botSetGroupCapacity(
  db: D1Database,
  botUser: UserRow,
  groupId: string,
  capacity: number
) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error('Capacity must be a positive integer');
  }
  if (capacity > 500) {
    throw new Error('Capacity cannot exceed maximum system limit of 500');
  }

  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(groupId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) {
    throw new Error('Group not found');
  }

  const botMember = await db
    .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(groupId, botUser.id)
    .first<{ role: string }>();
  if (!botMember || (botMember.role !== 'owner' && botMember.role !== 'admin')) {
    throw new Error('Unauthorized: only owner or admin can set group capacity');
  }

  let meta: Record<string, any> = {};
  try {
    meta = JSON.parse(conv.metadata || '{}');
  } catch {}
  meta.max_members = capacity;
  const now = Date.now();

  await db
    .prepare('UPDATE conversations SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(meta), now, groupId)
    .run();

  await recordBotAuditLog(db, botUser.id, groupId, 'set_capacity', null, { capacity });

  const capacityInfo = await getGroupCapacityInfo(db, groupId);
  return {
    group_id: groupId,
    capacity: capacityInfo.capacity,
    max_members: capacity,
    member_count: capacityInfo.memberCount,
    updated_at: now,
  };
}

export interface BotModerateOptions {
  action: 'kick' | 'mute_group' | 'mute_member' | 'set_announcement' | 'update_profile' | 'set_capacity';
  user_id?: string;
  wallet_address?: string;
  muted?: boolean;
  duration_seconds?: number;
  reason?: string;
  announcement?: string;
  name?: string;
  description?: string;
  marquee?: any;
  capacity?: number;
}

/**
 * Unified group moderation endpoint for bots.
 */
export async function botModerateGroup(
  db: D1Database,
  botUser: UserRow,
  groupId: string,
  options: BotModerateOptions,
  voiceBucket?: R2Bucket
) {
  const { action } = options;
  if (!action) {
    throw new Error('Moderation action is required');
  }

  let result: any = null;

  switch (action) {
    case 'kick': {
      const target = options.user_id || options.wallet_address;
      if (!target) throw new Error('user_id or wallet_address is required for kick action');
      result = await removeGroupMember(db, groupId, botUser.id, target, voiceBucket);
      await recordBotAuditLog(db, botUser.id, groupId, 'kick_member', target);
      break;
    }
    case 'mute_group': {
      const muted = options.muted !== false;
      result = await setGroupMute(db, groupId, botUser.id, {
        muted,
        duration_seconds: options.duration_seconds,
      });
      await recordBotAuditLog(db, botUser.id, groupId, muted ? 'mute_group' : 'unmute_group', null, {
        duration_seconds: options.duration_seconds,
      });
      break;
    }
    case 'mute_member': {
      const target = options.user_id || options.wallet_address;
      if (!target) throw new Error('user_id or wallet_address is required for mute_member action');
      const muted = options.muted !== false;
      result = await setMemberMute(db, groupId, botUser.id, target, {
        muted,
        duration_seconds: options.duration_seconds,
        reason: options.reason,
      });
      await recordBotAuditLog(db, botUser.id, groupId, muted ? 'mute_member' : 'unmute_member', target, {
        duration_seconds: options.duration_seconds,
        reason: options.reason,
      });
      break;
    }
    case 'set_announcement': {
      if (options.announcement === undefined) throw new Error('announcement text is required');
      result = await updateGroup(db, groupId, botUser.id, { announcement: options.announcement });
      await recordBotAuditLog(db, botUser.id, groupId, 'set_announcement', null, { announcement: options.announcement });
      break;
    }
    case 'update_profile': {
      result = await updateGroup(db, groupId, botUser.id, {
        name: options.name,
        description: options.description,
        marquee: options.marquee,
      });
      await recordBotAuditLog(db, botUser.id, groupId, 'update_profile', null, {
        name: options.name,
        description: options.description,
      });
      break;
    }
    case 'set_capacity': {
      if (!options.capacity) throw new Error('capacity is required for set_capacity action');
      result = await botSetGroupCapacity(db, botUser, groupId, options.capacity);
      break;
    }
    default:
      throw new Error(`Unsupported moderation action: ${action}`);
  }

  return { action, result };
}

export interface BotGroupEventsOptions {
  group_id?: string;
  since?: number;
  since_id?: string;
  limit?: number;
  type?: string;
}

export interface BotGroupEvent {
  id: string;
  group_id: string;
  event: string;
  actor_id: string;
  user: {
    id: string;
    wallet_address: string;
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
  } | null;
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * Event stream subscription for bots (member_joined, member_left, message_created, etc.).
 */
export async function getBotGroupEvents(
  db: D1Database,
  botId: string,
  options: BotGroupEventsOptions = {}
): Promise<{ events: BotGroupEvent[]; next_since: number; has_more: boolean }> {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const since = options.since ? Number(options.since) : 0;
  const sinceId = options.since_id || '';

  let groupCondition = '';
  const params: unknown[] = [botId];

  if (options.group_id) {
    groupCondition = 'AND m.conversation_id = ?';
    params.push(options.group_id);
  }

  const cursorClause = sinceId
    ? 'm.created_at >= ? AND (m.created_at > ? OR m.id > ?)'
    : 'm.created_at > ?';
  if (sinceId) {
    params.push(since, since, sinceId);
  } else {
    params.push(since);
  }

  params.push(limit + 1);

  const query = `
    SELECT
      m.id,
      m.conversation_id,
      m.sender_id,
      m.type,
      m.content,
      m.created_at
    FROM messages m
    JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
    WHERE 1=1
      ${groupCondition}
      AND ${cursorClause}
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT ?
  `;

  const res = await db.prepare(query).bind(...params).all<{
    id: string;
    conversation_id: string;
    sender_id: string;
    type: string;
    content: string | null;
    created_at: number;
  }>();

  const rows = res.results || [];
  const has_more = rows.length > limit;
  const targetRows = has_more ? rows.slice(0, limit) : rows;

  const userIdsToFetch = new Set<string>();
  const parsedItems: {
    row: (typeof targetRows)[0];
    event: string;
    data: Record<string, unknown>;
    targetUserId: string | null;
  }[] = [];

  for (const r of targetRows) {
    if (r.type === 'system') {
      try {
        const payload = JSON.parse(r.content || '{}');
        const eventName = payload.event || 'system_event';
        const targetUid = payload.user_id || payload.applicant_id || r.sender_id;
        if (targetUid) userIdsToFetch.add(targetUid);
        parsedItems.push({
          row: r,
          event: eventName,
          data: payload,
          targetUserId: targetUid || null,
        });
      } catch {
        parsedItems.push({
          row: r,
          event: 'system_event',
          data: { raw: r.content },
          targetUserId: r.sender_id,
        });
        userIdsToFetch.add(r.sender_id);
      }
    } else {
      userIdsToFetch.add(r.sender_id);
      parsedItems.push({
        row: r,
        event: 'message_created',
        data: {
          content: r.content,
          type: r.type,
        },
        targetUserId: r.sender_id,
      });
    }
  }

  const userMap = new Map<string, { id: string; wallet_address: string; username: string | null; nickname: string | null; avatar_url: string | null }>();
  if (userIdsToFetch.size > 0) {
    const ids = Array.from(userIdsToFetch);
    const placeholders = ids.map(() => '?').join(',');
    const userRows = await db
      .prepare(`SELECT id, wallet_address, username, public_metadata FROM users WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<UserRow>();
    for (const u of userRows.results || []) {
      let nickname = u.username;
      let avatar_url: string | null = null;
      try {
        const meta = JSON.parse(u.public_metadata || '{}');
        if (meta.nickname) nickname = meta.nickname;
        if (meta.avatar_url) avatar_url = meta.avatar_url;
      } catch {}
      userMap.set(u.id, {
        id: u.id,
        wallet_address: u.wallet_address,
        username: u.username,
        nickname,
        avatar_url,
      });
    }
  }

  const events: BotGroupEvent[] = parsedItems.map((item) => {
    const userSnapshot = item.targetUserId ? userMap.get(item.targetUserId) || null : null;
    return {
      id: item.row.id,
      group_id: item.row.conversation_id,
      event: item.event,
      actor_id: item.row.sender_id,
      user: userSnapshot,
      data: item.data,
      timestamp: item.row.created_at,
    };
  });

  const nextSince = events.length > 0 ? events[events.length - 1].timestamp : since;

  return {
    events,
    next_since: nextSince,
    has_more,
  };
}

export interface CreateBotTaskOptions {
  group_id: string;
  type: BotTaskType;
  content?: string | null;
  media_url?: string | null;
  schedule_time: number;
}

/**
 * Creates a scheduled content task for bot.
 */
export async function createBotTask(
  db: D1Database,
  botId: string,
  options: CreateBotTaskOptions
): Promise<BotTaskRow> {
  const { group_id, type, content, media_url, schedule_time } = options;

  if (!group_id) throw new Error('group_id is required');
  if (!type || !['text', 'image', 'video'].includes(type)) {
    throw new Error('type must be text, image, or video');
  }
  if (!content && !media_url) {
    throw new Error('Either content or media_url must be provided');
  }
  if (!schedule_time || schedule_time <= 0) {
    throw new Error('Valid schedule_time is required');
  }

  // Ensure bot is in group
  const member = await db
    .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(group_id, botId)
    .first<{ role: string }>();
  if (!member) {
    throw new Error('Bot is not a member of the target group');
  }

  const taskId = `task_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO bot_tasks (id, bot_id, group_id, type, content, media_url, schedule_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .bind(taskId, botId, group_id, type, content || null, media_url || null, schedule_time, now)
    .run();

  await recordBotAuditLog(db, botId, group_id, 'create_task', taskId, {
    type,
    schedule_time,
  });

  return {
    id: taskId,
    bot_id: botId,
    group_id,
    type,
    content: content || null,
    media_url: media_url || null,
    schedule_time,
    status: 'pending',
    error_reason: null,
    created_at: now,
    executed_at: null,
  };
}

/**
 * List scheduled tasks for bot.
 */
export async function listBotTasks(
  db: D1Database,
  botId: string,
  options: { group_id?: string; status?: BotTaskStatus; limit?: number } = {}
): Promise<BotTaskRow[]> {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  let sql = 'SELECT * FROM bot_tasks WHERE bot_id = ?';
  const params: unknown[] = [botId];

  if (options.group_id) {
    sql += ' AND group_id = ?';
    params.push(options.group_id);
  }
  if (options.status) {
    sql += ' AND status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY schedule_time ASC LIMIT ?';
  params.push(limit);

  const { results } = await db.prepare(sql).bind(...params).all<BotTaskRow>();
  return results || [];
}

/**
 * Get a single bot task.
 */
export async function getBotTask(db: D1Database, botId: string, taskId: string): Promise<BotTaskRow> {
  const task = await db
    .prepare('SELECT * FROM bot_tasks WHERE id = ? AND bot_id = ?')
    .bind(taskId, botId)
    .first<BotTaskRow>();
  if (!task) {
    throw new Error('Task not found');
  }
  return task;
}

/**
 * Cancel a scheduled bot task.
 */
export async function cancelBotTask(db: D1Database, botId: string, taskId: string): Promise<BotTaskRow> {
  const task = await getBotTask(db, botId, taskId);
  if (task.status !== 'pending') {
    throw new Error(`Cannot cancel task with status: ${task.status}`);
  }

  await db
    .prepare('UPDATE bot_tasks SET status = ? WHERE id = ?')
    .bind('cancelled', taskId)
    .run();

  await recordBotAuditLog(db, botId, task.group_id, 'cancel_task', taskId);

  return {
    ...task,
    status: 'cancelled',
  };
}

/**
 * Scheduled executor tick: processes all pending tasks whose schedule_time <= now.
 */
export async function runBotTasksTick(env: { DB: D1Database; GROUP_MASTER_DO?: any }): Promise<{ executed: number; failed: number }> {
  const now = Date.now();
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT * FROM bot_tasks
       WHERE status = 'pending' AND schedule_time <= ?
       ORDER BY schedule_time ASC LIMIT 50`
    )
    .bind(now)
    .all<BotTaskRow>();

  if (!results || results.length === 0) {
    return { executed: 0, failed: 0 };
  }

  let executedCount = 0;
  let failedCount = 0;

  for (const task of results) {
    try {
      const bot = await db.prepare('SELECT * FROM bots WHERE id = ?').bind(task.bot_id).first<BotRow>();
      if (!bot || bot.status !== 'active') {
        throw new Error('Bot is disabled or not found');
      }

      let contentToSend = task.content || '';
      if (task.media_url) {
        contentToSend = contentToSend ? `${contentToSend}\n${task.media_url}` : task.media_url;
      }

      const msg = await sendMessage(db, task.group_id, task.bot_id, {
        content: contentToSend,
        type: task.type === 'text' ? 'text' : task.type === 'image' ? 'image' : 'file',
      });

      if (env.GROUP_MASTER_DO && !task.group_id.startsWith('direct:')) {
        try {
          const masterId = env.GROUP_MASTER_DO.idFromName(task.group_id);
          const stub = env.GROUP_MASTER_DO.get(masterId);
          await stub.fetch('http://internal/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: msg.id,
              conversationId: task.group_id,
              senderId: task.bot_id,
              type: msg.type,
              content: msg.content,
              createdAt: msg.created_at,
              skipD1WriteBack: true,
            }),
          }).catch(() => {});
        } catch {}
      }

      await db
        .prepare('UPDATE bot_tasks SET status = ?, executed_at = ? WHERE id = ?')
        .bind('executed', Date.now(), task.id)
        .run();

      await recordBotAuditLog(db, task.bot_id, task.group_id, 'execute_task', task.id, {
        type: task.type,
        schedule_time: task.schedule_time,
      });

      executedCount++;
    } catch (err: any) {
      const reason = err instanceof Error ? err.message : String(err);
      await db
        .prepare('UPDATE bot_tasks SET status = ?, error_reason = ?, executed_at = ? WHERE id = ?')
        .bind('failed', reason, Date.now(), task.id)
        .run();
      failedCount++;
    }
  }

  return { executed: executedCount, failed: failedCount };
}

