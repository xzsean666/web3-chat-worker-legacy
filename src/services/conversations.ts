import { isAddress } from 'viem';
import type { ConversationRow, ConversationMemberRow, UserRow } from '../db/schema';
import { normalizeAddress } from '../db';

export interface ConversationMemberWithUser extends ConversationMemberRow {
  wallet_address: string;
}

export interface ConversationDetail extends ConversationRow {
  members: ConversationMemberWithUser[];
  my_role?: 'owner' | 'member';
}

export async function findOrCreateUser(db: D1Database, identifier: string): Promise<UserRow> {
  const addr = normalizeAddress(identifier);
  if (isAddress(addr)) {
    let user = await db.prepare(
      'SELECT * FROM users WHERE wallet_address = ? OR id = ?'
    ).bind(addr, addr).first<UserRow>();

    if (!user) {
      const now = Date.now();
      await db.prepare(
        'INSERT OR IGNORE INTO users (id, wallet_address, public_metadata, private_metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(addr, addr, '{}', '{}', now, now).run();
      user = {
        id: addr,
        wallet_address: addr,
        public_metadata: '{}',
        private_metadata: '{}',
        avatar_key: null,
        avatar_mime: null,
        avatar_updated_at: null,
        created_at: now,
        updated_at: now,
      };
    } else {
      user.id = user.wallet_address;
    }
    return user;
  }

  const user = await db.prepare(
    'SELECT * FROM users WHERE id = ? OR wallet_address = ?'
  ).bind(identifier, identifier).first<UserRow>();

  if (!user) {
    throw new Error(`Target user not found: ${identifier}`);
  }
  return user;
}

export async function getOrCreateDirectConversation(
  db: D1Database,
  currentUserId: string,
  targetIdentifier: string
): Promise<ConversationDetail> {
  const targetUser = await findOrCreateUser(db, targetIdentifier);

  if (targetUser.id === currentUserId) {
    throw new Error('Cannot create direct conversation with yourself');
  }

  // Check if target user has blocked current user
  const isBlocked = await db.prepare(
    'SELECT 1 FROM blacklist WHERE user_id = ? AND blocked_address = ?'
  ).bind(targetUser.id, currentUserId).first();

  if (isBlocked) {
    throw new Error('Cannot start conversation: you have been blocked by this user');
  }

  // Deterministic Direct Conversation ID: direct:min:max
  const [userA, userB] = [currentUserId, targetUser.id].sort();
  const convId = `direct:${userA}:${userB}`;

  const existingConv = await db.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).bind(convId).first<ConversationRow>();

  if (existingConv) {
    return getConversation(db, convId, currentUserId);
  }

  // Create new deterministic direct conversation
  const now = Date.now();

  await db.prepare(
    'INSERT INTO conversations (id, type, owner_address, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(convId, 'direct', null, null, now, now).run();

  await db.prepare(
    'INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(`${convId}:${currentUserId}`, convId, currentUserId, 'member', now).run();

  await db.prepare(
    'INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(`${convId}:${targetUser.id}`, convId, targetUser.id, 'member', now).run();

  return getConversation(db, convId, currentUserId);
}

export async function listUserConversations(
  db: D1Database,
  userId: string
): Promise<Array<ConversationRow & { role: string; member_count: number }>> {
  const query = `
    SELECT
      c.id, c.type, c.owner_address, c.name, c.created_at, c.updated_at,
      my_cm.role,
      (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
    FROM conversations c
    JOIN conversation_members my_cm ON my_cm.conversation_id = c.id AND my_cm.user_id = ?
    ORDER BY c.updated_at DESC
  `;

  const res = await db.prepare(query).bind(userId).all<ConversationRow & { role: string; member_count: number }>();
  return res.results;
}

export async function getConversation(
  db: D1Database,
  conversationId: string,
  userId: string
): Promise<ConversationDetail> {
  const membership = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, userId).first<{ role: 'owner' | 'member' }>();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this conversation');
  }

  const conv = await db.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).bind(conversationId).first<ConversationRow>();

  if (!conv) {
    throw new Error('Conversation not found');
  }

  const membersRes = await db.prepare(`
    SELECT
      cm.id, cm.conversation_id, cm.user_id, cm.role, cm.joined_at, cm.last_read_message_id,
      u.wallet_address
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
    ORDER BY cm.joined_at ASC
  `).bind(conversationId).all<ConversationMemberWithUser>();

  return {
    ...conv,
    members: membersRes.results,
    my_role: membership.role,
  };
}

export async function createGroup(
  db: D1Database,
  creatorId: string,
  name: string,
  memberIdentifiers: string[] = [],
  slug?: string
): Promise<ConversationDetail> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Group name cannot be empty');
  }

  const creator = await findOrCreateUser(db, creatorId);
  const now = Date.now();

  // Sovereign Group ID: ${owner_address}:${slug}
  const cleanSlug = (slug ? slug.trim().replace(/[^a-zA-Z0-9_-]/g, '') : '') || crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  let convId = `${creator.id}:${cleanSlug}`;

  const existing = await db.prepare('SELECT id FROM conversations WHERE id = ?').bind(convId).first();
  if (existing) {
    convId = `${creator.id}:${cleanSlug}-${crypto.randomUUID().replace(/-/g, '').slice(0, 4)}`;
  }

  await db.prepare(
    'INSERT INTO conversations (id, type, owner_address, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(convId, 'group', creator.id, trimmedName, now, now).run();

  await db.prepare(
    'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(`${convId}:${creator.id}`, convId, creator.id, 'owner', now).run();

  const seenUsers = new Set<string>([creator.id]);
  for (const identifier of memberIdentifiers) {
    try {
      const user = await findOrCreateUser(db, identifier);
      if (user && !seenUsers.has(user.id)) {
        seenUsers.add(user.id);
        await db.prepare(
          'INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(`${convId}:${user.id}`, convId, user.id, 'member', now).run();
      }
    } catch {
      // Ignore unknown non-address member identifiers gracefully
    }
  }

  return getConversation(db, convId, creator.id);
}

export async function updateGroupName(
  db: D1Database,
  conversationId: string,
  userId: string,
  name: string
): Promise<ConversationRow> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Group name cannot be empty');
  }

  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv) {
    throw new Error('Conversation not found');
  }
  if (conv.type !== 'group') {
    throw new Error('Cannot update name of direct conversation');
  }

  if (conv.owner_address !== userId) {
    throw new Error('Unauthorized: only the group owner can rename the group');
  }

  const now = Date.now();
  await db.prepare(
    'UPDATE conversations SET name = ?, updated_at = ? WHERE id = ?'
  ).bind(trimmedName, now, conversationId).run();

  return {
    ...conv,
    name: trimmedName,
    updated_at: now,
  };
}

export async function addGroupMember(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  targetIdentifier: string
): Promise<ConversationMemberWithUser> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || conv.type !== 'group') {
    throw new Error('Group not found');
  }

  if (conv.owner_address !== requestingUserId) {
    throw new Error('Unauthorized: only the group owner can add members');
  }

  const targetUser = await findOrCreateUser(db, targetIdentifier);

  const existingMember = await db.prepare(
    'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetUser.id).first();

  if (existingMember) {
    throw new Error('User is already a member of this group');
  }

  const memberId = `${conversationId}:${targetUser.id}`;
  const now = Date.now();

  await db.prepare(
    'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(memberId, conversationId, targetUser.id, 'member', now).run();

  await db.prepare(
    'UPDATE conversations SET updated_at = ? WHERE id = ?'
  ).bind(now, conversationId).run();

  return {
    id: memberId,
    conversation_id: conversationId,
    user_id: targetUser.id,
    role: 'member',
    joined_at: now,
    last_read_message_id: null,
    wallet_address: targetUser.wallet_address,
  };
}

export async function removeGroupMember(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  targetUserId: string
): Promise<{ success: boolean; message: string }> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || conv.type !== 'group') {
    throw new Error('Group not found');
  }

  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();

  if (!requester) {
    throw new Error('Unauthorized: you are not a member of this group');
  }

  const target = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetUserId).first<{ role: string }>();

  if (!target) {
    throw new Error('Target user is not a member of this group');
  }

  const isSelf = requestingUserId === targetUserId;

  if (isSelf) {
    if (conv.owner_address === requestingUserId) {
      // Owner leaves: sovereign group is deleted, ownership cannot be transferred!
      await db.prepare('DELETE FROM conversations WHERE id = ?').bind(conversationId).run();
      return { success: true, message: 'Group deleted as owner left' };
    }
  } else {
    // Kicking another member: ONLY the owner can kick!
    if (conv.owner_address !== requestingUserId) {
      throw new Error('Unauthorized: only the group owner can remove members');
    }
  }

  await db.prepare(
    'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetUserId).run();

  const now = Date.now();
  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId).run();

  return { success: true, message: isSelf ? 'Left group successfully' : 'Member removed successfully' };
}
