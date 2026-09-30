import { isAddress } from 'viem';
import type { FriendRequestRow } from '../db/schema';
import { normalizeAddress } from '../db';

export interface FriendRequestProfile {
  id: string;
  from_address: string;
  to_address: string;
  message: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  is_read: boolean;
  from_username: string | null;
  from_avatar_url: string | null;
  to_username: string | null;
  to_avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

const MESSAGE_MAX_LENGTH = 500;

async function ensureUserExists(db: D1Database, address: string): Promise<void> {
  const now = Date.now();
  await db.prepare(`
    INSERT OR IGNORE INTO users (id, wallet_address, public_metadata, private_metadata, created_at, updated_at)
    VALUES (?, ?, '{}', '{}', ?, ?)
  `).bind(address, address, now, now).run();
}

async function areMutualFriends(db: D1Database, userA: string, userB: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM friends
    WHERE (user_id = ? AND friend_address = ?)
       OR (user_id = ? AND friend_address = ?)
  `).bind(userA, userB, userB, userA).first<{ count: number }>();
  return (row?.count ?? 0) >= 2;
}

export async function sendFriendRequest(
  db: D1Database,
  fromUserId: string,
  targetAddress: string,
  message?: string
): Promise<FriendRequestProfile> {
  const from = normalizeAddress(fromUserId);
  const to = normalizeAddress(targetAddress);

  if (!isAddress(to)) {
    throw new Error(`Invalid EVM address: ${targetAddress}`);
  }

  if (from === to) {
    throw new Error('Cannot send a friend request to yourself');
  }

  // Block checks in both directions
  const blockedMe = await db.prepare(
    'SELECT 1 FROM blacklist WHERE user_id = ? AND blocked_address = ?'
  ).bind(to, from).first();
  if (blockedMe) {
    throw new Error('Cannot send friend request: you have been blocked by this user');
  }

  const iBlocked = await db.prepare(
    'SELECT 1 FROM blacklist WHERE user_id = ? AND blocked_address = ?'
  ).bind(from, to).first();
  if (iBlocked) {
    throw new Error('Cannot send friend request: you have blocked this user');
  }

  await ensureUserExists(db, to);

  if (await areMutualFriends(db, from, to)) {
    throw new Error('You are already friends with this user');
  }

  const existing = await db.prepare(
    'SELECT status FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?'
  ).bind(from, to).first<{ status: string }>();

  if (existing?.status === 'pending') {
    throw new Error('Friend request is already pending');
  }

  const cleanMessage = message && message.trim() ? message.trim().slice(0, MESSAGE_MAX_LENGTH) : null;
  const now = Date.now();

  // Upsert: a previously accepted/rejected request can be re-sent as pending
  await db.prepare(`
    INSERT INTO friend_requests (id, from_user_id, to_user_id, message, status, is_read, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
    ON CONFLICT(from_user_id, to_user_id) DO UPDATE SET
      message = excluded.message,
      status = 'pending',
      is_read = 0,
      updated_at = excluded.updated_at
  `).bind(crypto.randomUUID(), from, to, cleanMessage, now, now).run();

  const request = await getFriendRequest(db, from, to);
  if (!request) {
    throw new Error('Failed to retrieve friend request after saving');
  }
  return request;
}

async function getFriendRequest(
  db: D1Database,
  from: string,
  to: string
): Promise<FriendRequestProfile | null> {
  const row = await db.prepare(`
    SELECT
      r.*,
      uf.username AS from_username,
      uf.avatar_key AS from_avatar_key,
      ut.username AS to_username,
      ut.avatar_key AS to_avatar_key
    FROM friend_requests r
    LEFT JOIN users uf ON uf.id = r.from_user_id
    LEFT JOIN users ut ON ut.id = r.to_user_id
    WHERE r.from_user_id = ? AND r.to_user_id = ?
  `).bind(from, to).first<FriendRequestRow & {
    from_username: string | null;
    from_avatar_key: string | null;
    to_username: string | null;
    to_avatar_key: string | null;
  }>();

  if (!row) return null;
  return toProfile(row);
}

function toProfile(row: FriendRequestRow & {
  from_username?: string | null;
  from_avatar_key?: string | null;
  to_username?: string | null;
  to_avatar_key?: string | null;
}): FriendRequestProfile {
  return {
    id: row.id,
    from_address: row.from_user_id,
    to_address: row.to_user_id,
    message: row.message,
    status: row.status,
    is_read: row.is_read === 1,
    from_username: row.from_username ?? null,
    from_avatar_url: row.from_avatar_key ? `/users/${row.from_user_id}/avatar` : null,
    to_username: row.to_username ?? null,
    to_avatar_url: row.to_avatar_key ? `/users/${row.to_user_id}/avatar` : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listFriendRequests(
  db: D1Database,
  userId: string,
  direction: 'incoming' | 'outgoing' = 'incoming'
): Promise<{ requests: FriendRequestProfile[]; unread_count: number }> {
  const user = normalizeAddress(userId);
  const unreadCount = await getUnreadFriendRequestCount(db, user);

  if (direction === 'outgoing') {
    const rowsRes = await db.prepare(`
      SELECT
        r.*,
        uf.username AS from_username,
        uf.avatar_key AS from_avatar_key,
        ut.username AS to_username,
        ut.avatar_key AS to_avatar_key
      FROM friend_requests r
      LEFT JOIN users uf ON uf.id = r.from_user_id
      LEFT JOIN users ut ON ut.id = r.to_user_id
      WHERE r.from_user_id = ?
      ORDER BY r.created_at DESC
    `).bind(user).all<FriendRequestRow & {
      from_username: string | null;
      from_avatar_key: string | null;
      to_username: string | null;
      to_avatar_key: string | null;
    }>();

    return { requests: (rowsRes.results ?? []).map(toProfile), unread_count: unreadCount };
  }

  // Incoming: pending requests only; fetching the list marks them as read
  const rowsRes = await db.prepare(`
    SELECT
      r.*,
      uf.username AS from_username,
      uf.avatar_key AS from_avatar_key,
      ut.username AS to_username,
      ut.avatar_key AS to_avatar_key
    FROM friend_requests r
    LEFT JOIN users uf ON uf.id = r.from_user_id
    LEFT JOIN users ut ON ut.id = r.to_user_id
    WHERE r.to_user_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `).bind(user).all<FriendRequestRow & {
    from_username: string | null;
    from_avatar_key: string | null;
    to_username: string | null;
    to_avatar_key: string | null;
  }>();

  await db.prepare(
    "UPDATE friend_requests SET is_read = 1 WHERE to_user_id = ? AND status = 'pending' AND is_read = 0"
  ).bind(user).run();

  return { requests: (rowsRes.results ?? []).map(toProfile), unread_count: unreadCount };
}

export async function getUnreadFriendRequestCount(
  db: D1Database,
  userId: string
): Promise<number> {
  const user = normalizeAddress(userId);
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM friend_requests WHERE to_user_id = ? AND status = 'pending' AND is_read = 0"
  ).bind(user).first<{ count: number }>();
  return row?.count ?? 0;
}

async function resolvePendingRequest(
  db: D1Database,
  userId: string,
  requestId: string,
  action: 'accept' | 'reject'
): Promise<FriendRequestRow> {
  const user = normalizeAddress(userId);
  const request = await db.prepare(
    'SELECT * FROM friend_requests WHERE id = ?'
  ).bind(requestId).first<FriendRequestRow>();

  if (!request) {
    throw new Error('Friend request not found');
  }

  if (request.to_user_id !== user) {
    throw new Error(`Unauthorized: only the recipient can ${action} this friend request`);
  }

  if (request.status !== 'pending') {
    throw new Error(`Friend request has already been ${request.status}`);
  }

  return request;
}

export async function acceptFriendRequest(
  db: D1Database,
  userId: string,
  requestId: string
): Promise<{ success: boolean; friend_address: string }> {
  const user = normalizeAddress(userId);
  const request = await resolvePendingRequest(db, user, requestId, 'accept');

  const now = Date.now();

  // Establish the contact relationship in BOTH directions so direct chat works
  const batchStmts: D1PreparedStatement[] = [];
  for (const [owner, friend] of [[user, request.from_user_id], [request.from_user_id, user]]) {
    batchStmts.push(
      db.prepare(`
        INSERT INTO friends (id, user_id, friend_address, alias, tags, created_at, updated_at)
        VALUES (?, ?, ?, NULL, '[]', ?, ?)
        ON CONFLICT(user_id, friend_address) DO UPDATE SET updated_at = excluded.updated_at
      `).bind(`${owner}:${friend}`, owner, friend, now, now)
    );
  }

  batchStmts.push(
    db.prepare(
      "UPDATE friend_requests SET status = 'accepted', is_read = 1, updated_at = ? WHERE id = ?"
    ).bind(now, requestId)
  );

  await db.batch(batchStmts);

  return { success: true, friend_address: request.from_user_id };
}

export async function rejectFriendRequest(
  db: D1Database,
  userId: string,
  requestId: string
): Promise<{ success: boolean }> {
  const user = normalizeAddress(userId);
  const request = await resolvePendingRequest(db, user, requestId, 'reject');

  await db.prepare(
    "UPDATE friend_requests SET status = 'rejected', is_read = 1, updated_at = ? WHERE id = ?"
  ).bind(Date.now(), requestId).run();

  return { success: true };
}
