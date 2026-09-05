import type { ConversationRow, ConversationMemberRow, UserRow } from '../db/schema';
import { normalizeAddress } from '../db';

export interface ConversationMemberWithUser extends ConversationMemberRow {
  wallet_address: string;
}

export interface ConversationDetail extends ConversationRow {
  members: ConversationMemberWithUser[];
  my_role?: 'owner' | 'admin' | 'member';
}

async function findUserByIdOrAddress(db: D1Database, identifier: string): Promise<UserRow | null> {
  if (identifier.startsWith('0x')) {
    const addr = normalizeAddress(identifier);
    return db.prepare('SELECT * FROM users WHERE wallet_address = ?').bind(addr).first<UserRow>();
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(identifier).first<UserRow>();
}

export async function getOrCreateDirectConversation(
  db: D1Database,
  currentUserId: string,
  targetIdentifier: string
): Promise<ConversationDetail> {
  const targetUser = await findUserByIdOrAddress(db, targetIdentifier);
  if (!targetUser) {
    throw new Error('Target user not found');
  }

  if (targetUser.id === currentUserId) {
    throw new Error('Cannot create direct conversation with yourself');
  }

  // Check if direct conversation already exists
  const existingConv = await db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at, c.updated_at
    FROM conversations c
    JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?
    JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ?
    WHERE c.type = 'direct'
    LIMIT 1
  `).bind(currentUserId, targetUser.id).first<ConversationRow>();

  if (existingConv) {
    return getConversation(db, existingConv.id, currentUserId);
  }

  // Create new direct conversation
  const convId = crypto.randomUUID();
  const now = Date.now();

  await db.prepare(
    'INSERT INTO conversations (id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(convId, 'direct', null, now, now).run();

  await db.prepare(
    'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), convId, currentUserId, 'owner', now).run();

  await db.prepare(
    'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), convId, targetUser.id, 'member', now).run();

  return getConversation(db, convId, currentUserId);
}

export async function listUserConversations(
  db: D1Database,
  userId: string
): Promise<Array<ConversationRow & { role: string; member_count: number }>> {
  const query = `
    SELECT
      c.id, c.type, c.name, c.created_at, c.updated_at,
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
  ).bind(conversationId, userId).first<{ role: 'owner' | 'admin' | 'member' }>();

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
  memberIdentifiers: string[] = []
): Promise<ConversationDetail> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Group name cannot be empty');
  }

  const convId = crypto.randomUUID();
  const now = Date.now();

  await db.prepare(
    'INSERT INTO conversations (id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(convId, 'group', trimmedName, now, now).run();

  await db.prepare(
    'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), convId, creatorId, 'owner', now).run();

  const seenUsers = new Set<string>([creatorId]);
  for (const identifier of memberIdentifiers) {
    const user = await findUserByIdOrAddress(db, identifier);
    if (user && !seenUsers.has(user.id)) {
      seenUsers.add(user.id);
      await db.prepare(
        'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(crypto.randomUUID(), convId, user.id, 'member', now).run();
    }
  }

  return getConversation(db, convId, creatorId);
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

  const membership = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, userId).first<{ role: string }>();

  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    throw new Error('Unauthorized: only owner or admin can rename the group');
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
  targetIdentifier: string,
  role: 'admin' | 'member' = 'member'
): Promise<ConversationMemberWithUser> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || conv.type !== 'group') {
    throw new Error('Group not found');
  }

  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();

  if (!requester || (requester.role !== 'owner' && requester.role !== 'admin')) {
    throw new Error('Unauthorized: only owner or admin can add members');
  }

  const targetUser = await findUserByIdOrAddress(db, targetIdentifier);
  if (!targetUser) {
    throw new Error('Target user not found');
  }

  const existingMember = await db.prepare(
    'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetUser.id).first();

  if (existingMember) {
    throw new Error('User is already a member of this group');
  }

  const memberId = crypto.randomUUID();
  const now = Date.now();

  await db.prepare(
    'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(memberId, conversationId, targetUser.id, role, now).run();

  await db.prepare(
    'UPDATE conversations SET updated_at = ? WHERE id = ?'
  ).bind(now, conversationId).run();

  return {
    id: memberId,
    conversation_id: conversationId,
    user_id: targetUser.id,
    role,
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
    if (target.role === 'owner') {
      // Find another admin or member to promote to owner
      const nextOwner = await db.prepare(`
        SELECT id, user_id, role FROM conversation_members
        WHERE conversation_id = ? AND user_id != ?
        ORDER BY CASE WHEN role = 'admin' THEN 1 ELSE 2 END, joined_at ASC
        LIMIT 1
      `).bind(conversationId, targetUserId).first<{ id: string; user_id: string; role: string }>();

      if (nextOwner) {
        await db.prepare('UPDATE conversation_members SET role = ? WHERE id = ?').bind('owner', nextOwner.id).run();
      } else {
        // No other members left, delete the group conversation
        await db.prepare('DELETE FROM conversations WHERE id = ?').bind(conversationId).run();
        return { success: true, message: 'Group deleted as last owner left' };
      }
    }
  } else {
    // Kicking another user
    if (requester.role === 'member') {
      throw new Error('Unauthorized: regular members cannot remove others');
    }
    if (requester.role === 'admin' && (target.role === 'owner' || target.role === 'admin')) {
      throw new Error('Unauthorized: admins cannot remove owners or other admins');
    }
  }

  await db.prepare(
    'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetUserId).run();

  const now = Date.now();
  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId).run();

  return { success: true, message: isSelf ? 'Left group successfully' : 'Member removed successfully' };
}
