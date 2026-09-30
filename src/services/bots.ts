import type { BotRow, UserRow, ConversationRow } from '../db/schema';
import { hashToken } from './auth';
import { joinGroupByInviteToken, joinPublicGroup } from './conversations';

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

/**
 * Creates a new bot owned by ownerId.
 * Creates both a bot record and a corresponding virtual user record.
 */
export async function createBot(
  db: D1Database,
  ownerId: string,
  options: CreateBotOptions
): Promise<BotWithSecret> {
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

  return { deleted: true };
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
