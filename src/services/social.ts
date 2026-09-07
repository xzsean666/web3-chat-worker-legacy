import { isAddress } from 'viem';
import type { FriendRow, BlacklistRow, UserRow } from '../db/schema';
import { normalizeAddress } from '../db';

export interface FriendProfile {
  friend_address: string;
  alias: string | null;
  tags: string[];
  public_metadata: Record<string, any>;
  avatar_url: string | null;
  avatar_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface BlockedUserProfile {
  blocked_address: string;
  reason: string | null;
  public_metadata: Record<string, any>;
  avatar_url: string | null;
  created_at: number;
}

export interface AddFriendOptions {
  alias?: string;
  tags?: string[];
}

export interface UpdateFriendOptions {
  alias?: string | null;
  tags?: string[];
}

function parseJsonSafe(val: string | null | undefined): any {
  if (!val) return {};
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function ensureUserExists(db: D1Database, address: string): Promise<void> {
  const now = Date.now();
  await db.prepare(`
    INSERT OR IGNORE INTO users (id, wallet_address, public_metadata, private_metadata, created_at, updated_at)
    VALUES (?, ?, '{}', '{}', ?, ?)
  `).bind(address, address, now, now).run();
}

// ---------------- FRIENDS MANAGEMENT ----------------

export async function addFriend(
  db: D1Database,
  userId: string,
  targetAddress: string,
  options: AddFriendOptions = {}
): Promise<FriendProfile> {
  const user = normalizeAddress(userId);
  const friend = normalizeAddress(targetAddress);

  if (!isAddress(friend)) {
    throw new Error(`Invalid EVM friend address: ${targetAddress}`);
  }

  if (user === friend) {
    throw new Error('Cannot add yourself as a friend');
  }

  // Check if target user has blocked current user
  const isBlocked = await db.prepare(
    'SELECT 1 FROM blacklist WHERE user_id = ? AND blocked_address = ?'
  ).bind(friend, user).first();

  if (isBlocked) {
    throw new Error('Cannot add user: you have been blocked by this user');
  }

  await ensureUserExists(db, friend);

  const now = Date.now();
  const id = `${user}:${friend}`;
  const alias = options.alias ? options.alias.trim() : null;
  const tagsList = Array.isArray(options.tags)
    ? Array.from(new Set(options.tags.map((t) => t.trim()).filter(Boolean)))
    : [];
  const tagsJson = JSON.stringify(tagsList);

  await db.prepare(`
    INSERT INTO friends (id, user_id, friend_address, alias, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, friend_address) DO UPDATE SET
      alias = COALESCE(excluded.alias, friends.alias),
      tags = excluded.tags,
      updated_at = excluded.updated_at
  `).bind(id, user, friend, alias, tagsJson, now, now).run();

  const profile = await getFriend(db, user, friend);
  if (!profile) {
    throw new Error('Failed to retrieve friend profile after saving');
  }

  return profile;
}

export async function getFriends(
  db: D1Database,
  userId: string,
  options: { tag?: string } = {}
): Promise<FriendProfile[]> {
  const user = normalizeAddress(userId);
  const rowsRes = await db.prepare(`
    SELECT
      f.friend_address,
      f.alias,
      f.tags,
      f.created_at,
      f.updated_at,
      u.public_metadata,
      u.avatar_key,
      u.avatar_updated_at
    FROM friends f
    LEFT JOIN users u ON u.id = f.friend_address
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).bind(user).all<{
    friend_address: string;
    alias: string | null;
    tags: string;
    created_at: number;
    updated_at: number;
    public_metadata: string | null;
    avatar_key: string | null;
    avatar_updated_at: number | null;
  }>();

  const results: FriendProfile[] = [];
  const targetTag = options.tag?.trim().toLowerCase();

  for (const r of rowsRes.results ?? []) {
    let parsedTags: string[] = [];
    try {
      parsedTags = JSON.parse(r.tags || '[]');
      if (!Array.isArray(parsedTags)) parsedTags = [];
    } catch {
      parsedTags = [];
    }

    if (targetTag && !parsedTags.map((t) => t.toLowerCase()).includes(targetTag)) {
      continue;
    }

    results.push({
      friend_address: r.friend_address,
      alias: r.alias,
      tags: parsedTags,
      public_metadata: parseJsonSafe(r.public_metadata),
      avatar_url: r.avatar_key ? `/users/${r.friend_address}/avatar` : null,
      avatar_updated_at: r.avatar_updated_at ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }

  return results;
}

export async function getFriend(
  db: D1Database,
  userId: string,
  targetAddress: string
): Promise<FriendProfile | null> {
  const user = normalizeAddress(userId);
  const friend = normalizeAddress(targetAddress);

  const row = await db.prepare(`
    SELECT
      f.friend_address,
      f.alias,
      f.tags,
      f.created_at,
      f.updated_at,
      u.public_metadata,
      u.avatar_key,
      u.avatar_updated_at
    FROM friends f
    LEFT JOIN users u ON u.id = f.friend_address
    WHERE f.user_id = ? AND f.friend_address = ?
  `).bind(user, friend).first<{
    friend_address: string;
    alias: string | null;
    tags: string;
    created_at: number;
    updated_at: number;
    public_metadata: string | null;
    avatar_key: string | null;
    avatar_updated_at: number | null;
  }>();

  if (!row) {
    return null;
  }

  let parsedTags: string[] = [];
  try {
    parsedTags = JSON.parse(row.tags || '[]');
    if (!Array.isArray(parsedTags)) parsedTags = [];
  } catch {
    parsedTags = [];
  }

  return {
    friend_address: row.friend_address,
    alias: row.alias,
    tags: parsedTags,
    public_metadata: parseJsonSafe(row.public_metadata),
    avatar_url: row.avatar_key ? `/users/${row.friend_address}/avatar` : null,
    avatar_updated_at: row.avatar_updated_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function updateFriend(
  db: D1Database,
  userId: string,
  targetAddress: string,
  options: UpdateFriendOptions
): Promise<FriendProfile> {
  const user = normalizeAddress(userId);
  const friend = normalizeAddress(targetAddress);

  const existing = await getFriend(db, user, friend);
  if (!existing) {
    throw new Error('Friend not found');
  }

  const now = Date.now();
  const alias = options.alias !== undefined ? (options.alias ? options.alias.trim() : null) : existing.alias;
  const tagsList = options.tags !== undefined
    ? Array.from(new Set(options.tags.map((t) => t.trim()).filter(Boolean)))
    : existing.tags;
  const tagsJson = JSON.stringify(tagsList);

  await db.prepare(`
    UPDATE friends
    SET alias = ?, tags = ?, updated_at = ?
    WHERE user_id = ? AND friend_address = ?
  `).bind(alias, tagsJson, now, user, friend).run();

  return (await getFriend(db, user, friend))!;
}

export async function setFriendTags(
  db: D1Database,
  userId: string,
  targetAddress: string,
  tags: string[]
): Promise<FriendProfile> {
  return updateFriend(db, userId, targetAddress, { tags });
}

export async function getAllFriendTags(
  db: D1Database,
  userId: string
): Promise<string[]> {
  const user = normalizeAddress(userId);
  const rowsRes = await db.prepare(
    'SELECT tags FROM friends WHERE user_id = ?'
  ).bind(user).all<{ tags: string }>();

  const allTags = new Set<string>();
  for (const r of rowsRes.results ?? []) {
    try {
      const parsed = JSON.parse(r.tags || '[]');
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          if (typeof t === 'string' && t.trim()) {
            allTags.add(t.trim());
          }
        }
      }
    } catch {}
  }

  return Array.from(allTags).sort();
}

export async function removeFriend(
  db: D1Database,
  userId: string,
  targetAddress: string
): Promise<boolean> {
  const user = normalizeAddress(userId);
  const friend = normalizeAddress(targetAddress);

  const res = await db.prepare(
    'DELETE FROM friends WHERE user_id = ? AND friend_address = ?'
  ).bind(user, friend).run();

  return (res.meta?.changes ?? 0) > 0;
}

// ---------------- BLACKLIST MANAGEMENT ----------------

export async function blockUser(
  db: D1Database,
  userId: string,
  targetAddress: string,
  reason?: string
): Promise<BlockedUserProfile> {
  const user = normalizeAddress(userId);
  const blocked = normalizeAddress(targetAddress);

  if (!isAddress(blocked)) {
    throw new Error(`Invalid EVM address to block: ${targetAddress}`);
  }

  if (user === blocked) {
    throw new Error('Cannot block yourself');
  }

  await ensureUserExists(db, blocked);

  const now = Date.now();
  const id = `${user}:${blocked}`;
  const cleanReason = reason ? reason.trim() : null;

  await db.prepare(`
    INSERT INTO blacklist (id, user_id, blocked_address, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, blocked_address) DO UPDATE SET
      reason = COALESCE(excluded.reason, blacklist.reason)
  `).bind(id, user, blocked, cleanReason, now).run();

  const userRow = await db.prepare(
    'SELECT public_metadata, avatar_key FROM users WHERE id = ?'
  ).bind(blocked).first<{ public_metadata: string | null; avatar_key: string | null }>();

  return {
    blocked_address: blocked,
    reason: cleanReason,
    public_metadata: parseJsonSafe(userRow?.public_metadata),
    avatar_url: userRow?.avatar_key ? `/users/${blocked}/avatar` : null,
    created_at: now,
  };
}

export async function getBlockedUsers(
  db: D1Database,
  userId: string
): Promise<BlockedUserProfile[]> {
  const user = normalizeAddress(userId);
  const rowsRes = await db.prepare(`
    SELECT
      b.blocked_address,
      b.reason,
      b.created_at,
      u.public_metadata,
      u.avatar_key
    FROM blacklist b
    LEFT JOIN users u ON u.id = b.blocked_address
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
  `).bind(user).all<{
    blocked_address: string;
    reason: string | null;
    created_at: number;
    public_metadata: string | null;
    avatar_key: string | null;
  }>();

  return (rowsRes.results ?? []).map((r) => ({
    blocked_address: r.blocked_address,
    reason: r.reason,
    public_metadata: parseJsonSafe(r.public_metadata),
    avatar_url: r.avatar_key ? `/users/${r.blocked_address}/avatar` : null,
    created_at: r.created_at,
  }));
}

export async function unblockUser(
  db: D1Database,
  userId: string,
  targetAddress: string
): Promise<boolean> {
  const user = normalizeAddress(userId);
  const blocked = normalizeAddress(targetAddress);

  const res = await db.prepare(
    'DELETE FROM blacklist WHERE user_id = ? AND blocked_address = ?'
  ).bind(user, blocked).run();

  return (res.meta?.changes ?? 0) > 0;
}

export async function isUserBlocked(
  db: D1Database,
  blockerUserId: string,
  targetAddress: string
): Promise<boolean> {
  const blocker = normalizeAddress(blockerUserId);
  const target = normalizeAddress(targetAddress);

  const row = await db.prepare(
    'SELECT 1 FROM blacklist WHERE user_id = ? AND blocked_address = ?'
  ).bind(blocker, target).first();

  return !!row;
}
