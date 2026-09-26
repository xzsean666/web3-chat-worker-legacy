import { isAddress } from 'viem';
import type { ConversationRow, ConversationMemberRow, UserRow } from '../db/schema';
import { normalizeAddress } from '../db';

export interface ConversationMemberWithUser extends ConversationMemberRow {
  wallet_address: string;
  is_muted?: boolean;
}

export interface GroupMarquee {
  enabled: boolean;          // 是否在群顶部滚动播放群介绍内容
  text?: string;             // 滚动播放的文本内容（若未指定前端默认采用 description）
  speed?: number;            // 滚动播放速度（毫秒或帧率，可选）
}

export interface GroupMetadata {
  name?: string;             // ① 群名称 (同步并保存在 metadata 中)
  description?: string;      // ② 群介绍 (保存在 metadata 中)
  announcement?: string;     // 公告内容
  marquee?: GroupMarquee;    // ③ 群顶部滚动播放群介绍内容配置
  avatar_url?: string;       // 群头像/封面
  moderation?: {
    is_muted?: boolean;
    mute_until?: number | null;
  };
  [key: string]: any;        // 支持前端自定义扩展字段
}

export interface ConversationDetail extends Omit<ConversationRow, 'metadata' | 'is_muted'> {
  metadata: GroupMetadata;
  is_muted: boolean;
  mute_until: number | null;
  members: ConversationMemberWithUser[];
  my_role?: 'owner' | 'admin' | 'member';
  my_is_muted?: boolean;
}

export interface CreateGroupOptions {
  description?: string;
  announcement?: string;
  marquee?: GroupMarquee;
  metadata?: Record<string, any>;
  slug?: string;
}

export interface UpdateGroupOptions {
  name?: string;
  description?: string;
  announcement?: string;
  marquee?: Partial<GroupMarquee> | boolean;
  metadata?: Record<string, any>;
}

function parseJsonSafe(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
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

  const convStmt = db.prepare(
    'INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)'
  ).bind(convId, 'direct', null, null, '{}', now, now);

  const m1Stmt = db.prepare(
    'INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(`${convId}:${currentUserId}`, convId, currentUserId, 'member', now);

  const m2Stmt = db.prepare(
    'INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(`${convId}:${targetUser.id}`, convId, targetUser.id, 'member', now);

  await db.batch([convStmt, m1Stmt, m2Stmt]);

  return getConversation(db, convId, currentUserId);
}

export async function listUserConversations(
  db: D1Database,
  userId: string
): Promise<Array<Omit<ConversationRow, 'metadata' | 'is_muted'> & { metadata: GroupMetadata; is_muted: boolean; role: string; member_count: number }>> {
  const query = `
    SELECT
      c.id, c.type, c.owner_address, c.name, c.metadata, c.is_muted, c.mute_until, c.created_at, c.updated_at,
      my_cm.role,
      (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
    FROM conversations c
    JOIN conversation_members my_cm ON my_cm.conversation_id = c.id AND my_cm.user_id = ?
    ORDER BY c.updated_at DESC
  `;

  const res = await db.prepare(query).bind(userId).all<any>();
  const now = Date.now();

  return res.results.map((c: any) => ({
    ...c,
    metadata: parseJsonSafe(c.metadata),
    is_muted: Boolean(c.is_muted && (!c.mute_until || c.mute_until > now)),
    mute_until: c.mute_until ?? null,
  }));
}

export async function getConversation(
  db: D1Database,
  conversationId: string,
  userId: string
): Promise<ConversationDetail> {
  const membership = await db.prepare(
    'SELECT role, muted_until FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, userId).first<{ role: 'owner' | 'admin' | 'member'; muted_until: number | null }>();

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
      cm.id, cm.conversation_id, cm.user_id, cm.role, cm.muted_until, cm.mute_reason, cm.joined_at, cm.last_read_message_id,
      u.wallet_address
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
    ORDER BY cm.joined_at ASC
  `).bind(conversationId).all<ConversationMemberWithUser>();

  const now = Date.now();
  const groupMuted = Boolean(conv.is_muted && (!conv.mute_until || conv.mute_until > now));

  const members = membersRes.results.map((m) => {
    const isMuted = m.role === 'member' && (m.muted_until === -1 || (m.muted_until !== null && m.muted_until > now));
    return {
      ...m,
      is_muted: Boolean(isMuted),
    };
  });

  const myIsMuted = membership.role === 'owner' || membership.role === 'admin'
    ? false
    : groupMuted || (membership.muted_until === -1 || (membership.muted_until !== null && membership.muted_until > now));

  return {
    ...conv,
    metadata: parseJsonSafe(conv.metadata),
    is_muted: groupMuted,
    mute_until: conv.mute_until ?? null,
    members,
    my_role: membership.role,
    my_is_muted: Boolean(myIsMuted),
  };
}

export async function createGroup(
  db: D1Database,
  creatorId: string,
  name: string,
  memberIdentifiers: string[] = [],
  slugOrOptions?: string | CreateGroupOptions,
  legacyOptions?: CreateGroupOptions
): Promise<ConversationDetail> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Group name cannot be empty');
  }

  const options: CreateGroupOptions =
    typeof slugOrOptions === 'object' && slugOrOptions !== null
      ? slugOrOptions
      : (legacyOptions ?? {});

  const slug =
    typeof slugOrOptions === 'string'
      ? slugOrOptions
      : options.slug;

  const creator = await findOrCreateUser(db, creatorId);
  const now = Date.now();

  // Sovereign Group ID: ${owner_address}:${slug}
  const cleanSlug = (slug ? slug.trim().replace(/[^a-zA-Z0-9_-]/g, '') : '') || crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  let convId = `${creator.id}:${cleanSlug}`;

  const existing = await db.prepare('SELECT id FROM conversations WHERE id = ?').bind(convId).first();
  if (existing) {
    convId = `${creator.id}:${cleanSlug}-${crypto.randomUUID().replace(/-/g, '').slice(0, 4)}`;
  }

  const meta: GroupMetadata = {
    ...(options.metadata || {}),
    name: trimmedName,
  };
  if (options.description) {
    meta.description = options.description;
  }
  if (options.announcement) {
    meta.announcement = options.announcement;
  }
  if (options.marquee) {
    meta.marquee = options.marquee;
  } else if (options.description) {
    meta.marquee = { enabled: false, text: options.description };
  }

  const batchStatements: D1PreparedStatement[] = [];

  batchStatements.push(
    db.prepare(
      'INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)'
    ).bind(convId, 'group', creator.id, trimmedName, JSON.stringify(meta), now, now)
  );

  batchStatements.push(
    db.prepare(
      'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(`${convId}:${creator.id}`, convId, creator.id, 'owner', now)
  );

  const seenUsers = new Set<string>([creator.id]);
  for (const identifier of memberIdentifiers) {
    try {
      const user = await findOrCreateUser(db, identifier);
      if (user && !seenUsers.has(user.id)) {
        seenUsers.add(user.id);
        batchStatements.push(
          db.prepare(
            'INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(`${convId}:${user.id}`, convId, user.id, 'member', now)
        );
      }
    } catch {
      // Ignore unknown non-address member identifiers gracefully
    }
  }

  await db.batch(batchStatements);

  return getConversation(db, convId, creator.id);
}

export async function updateGroup(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  updates: UpdateGroupOptions
): Promise<ConversationDetail> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv) {
    throw new Error('Conversation not found');
  }
  if (conv.type !== 'group') {
    throw new Error('Cannot update settings of direct conversation');
  }

  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();

  if (!requester || (requester.role !== 'owner' && requester.role !== 'admin')) {
    throw new Error('Unauthorized: only group owner or admin can update group settings');
  }

  const meta: GroupMetadata = parseJsonSafe(conv.metadata);
  let newName = conv.name || '';

  if (updates.name !== undefined) {
    const trimmed = updates.name.trim();
    if (!trimmed) {
      throw new Error('Group name cannot be empty');
    }
    newName = trimmed;
    meta.name = trimmed;
  }

  if (updates.metadata) {
    Object.assign(meta, updates.metadata);
    if (updates.metadata.name) {
      const trimmed = String(updates.metadata.name).trim();
      if (trimmed) {
        newName = trimmed;
        meta.name = trimmed;
      }
    }
  }

  if (updates.description !== undefined) {
    meta.description = updates.description;
    if (meta.marquee && !meta.marquee.text) {
      meta.marquee.text = updates.description;
    }
  }

  if (updates.announcement !== undefined) {
    meta.announcement = updates.announcement;
  }

  if (updates.marquee !== undefined) {
    if (typeof updates.marquee === 'boolean') {
      meta.marquee = {
        enabled: updates.marquee,
        text: meta.marquee?.text || meta.description || '',
      };
    } else {
      meta.marquee = {
        enabled: updates.marquee.enabled ?? meta.marquee?.enabled ?? false,
        text: updates.marquee.text ?? meta.marquee?.text ?? meta.description ?? '',
        speed: updates.marquee.speed ?? meta.marquee?.speed,
      };
    }
  }

  const now = Date.now();
  await db.prepare(
    'UPDATE conversations SET name = ?, metadata = ?, updated_at = ? WHERE id = ?'
  ).bind(newName, JSON.stringify(meta), now, conversationId).run();

  return getConversation(db, conversationId, requestingUserId);
}

export async function updateGroupName(
  db: D1Database,
  conversationId: string,
  userId: string,
  name: string
): Promise<ConversationDetail> {
  return updateGroup(db, conversationId, userId, { name });
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

  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();

  if (!requester || (requester.role !== 'owner' && requester.role !== 'admin')) {
    throw new Error('Unauthorized: only group owner or admin can add members');
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
    muted_until: null,
    mute_reason: null,
    is_muted: false,
    joined_at: now,
    last_read_message_id: null,
    wallet_address: targetUser.wallet_address,
  };
}

export async function removeGroupMember(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  targetIdentifier: string
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

  // Resolve target identifier (supports 'me', wallet address, or user ID)
  let targetId = targetIdentifier.trim();
  if (targetId.toLowerCase() === 'me') {
    targetId = requestingUserId;
  } else {
    try {
      const u = await findOrCreateUser(db, targetId);
      targetId = u.id;
    } catch {
      // Keep as targetId if not address
    }
  }

  const target = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetId).first<{ role: string }>();

  if (!target) {
    throw new Error('Target user is not a member of this group');
  }

  const isSelf = requestingUserId === targetId;

  if (isSelf) {
    // ⑤ 成员退群 (Member leaving voluntarily)
    if (conv.owner_address === requestingUserId) {
      // Owner leaves: sovereign group is deleted, ownership cannot be transferred!
      await db.prepare('DELETE FROM conversations WHERE id = ?').bind(conversationId).run();
      return { success: true, message: 'Group deleted as owner left' };
    }

    await db.prepare(
      'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(conversationId, targetId).run();

    const now = Date.now();
    await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId).run();

    return { success: true, message: 'Left group successfully' };
  }

  // ④ 群主/管理员管理踢人删除群员 (Kicking member)
  if (requester.role === 'member') {
    throw new Error('Unauthorized: only the group owner can remove members');
  }

  if (requester.role === 'admin') {
    if (target.role === 'owner' || target.role === 'admin') {
      throw new Error('Unauthorized: admins cannot remove owner or other admins');
    }
  }

  await db.prepare(
    'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetId).run();

  const now = Date.now();
  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId).run();

  return { success: true, message: 'Member removed successfully' };
}

export async function leaveGroup(
  db: D1Database,
  conversationId: string,
  userId: string
): Promise<{ success: boolean; message: string }> {
  return removeGroupMember(db, conversationId, userId, userId);
}

export async function updateMemberRole(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  targetIdentifier: string,
  role: 'admin' | 'member'
): Promise<ConversationMemberWithUser> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || conv.type !== 'group') {
    throw new Error('Group not found');
  }

  if (conv.owner_address !== requestingUserId) {
    throw new Error('Unauthorized: only the group owner can manage member roles');
  }

  const targetUser = await findOrCreateUser(db, targetIdentifier);
  if (targetUser.id === conv.owner_address) {
    throw new Error('Cannot change group owner role');
  }

  const targetMember = await db.prepare(
    'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetUser.id).first<ConversationMemberRow>();

  if (!targetMember) {
    throw new Error('Target user is not a member of this group');
  }

  const now = Date.now();
  // Promoting to admin automatically un-mutes
  await db.prepare(`
    UPDATE conversation_members
    SET role = ?,
        muted_until = CASE WHEN ? = 'admin' THEN NULL ELSE muted_until END,
        mute_reason = CASE WHEN ? = 'admin' THEN NULL ELSE mute_reason END
    WHERE conversation_id = ? AND user_id = ?
  `).bind(role, role, role, conversationId, targetUser.id).run();

  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId).run();

  return {
    ...targetMember,
    role,
    muted_until: role === 'admin' ? null : targetMember.muted_until,
    mute_reason: role === 'admin' ? null : targetMember.mute_reason,
    is_muted: false,
    wallet_address: targetUser.wallet_address,
  };
}

export async function setGroupMute(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  options: { muted: boolean; duration_seconds?: number }
): Promise<{ conversation_id: string; is_muted: boolean; mute_until: number | null }> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || conv.type !== 'group') {
    throw new Error('Group not found');
  }

  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();

  if (!requester || (requester.role !== 'owner' && requester.role !== 'admin')) {
    throw new Error('Unauthorized: only group owner or admin can mute/unmute the group');
  }

  const isMuted = options.muted ? 1 : 0;
  const muteUntil = options.muted && options.duration_seconds && options.duration_seconds > 0
    ? Date.now() + options.duration_seconds * 1000
    : null;

  const meta = parseJsonSafe(conv.metadata);
  meta.moderation = {
    ...(meta.moderation || {}),
    is_muted: Boolean(options.muted),
    mute_until: muteUntil,
  };

  const now = Date.now();
  await db.prepare(
    'UPDATE conversations SET is_muted = ?, mute_until = ?, metadata = ?, updated_at = ? WHERE id = ?'
  ).bind(isMuted, muteUntil, JSON.stringify(meta), now, conversationId).run();

  return {
    conversation_id: conversationId,
    is_muted: Boolean(options.muted),
    mute_until: muteUntil,
  };
}

export async function setMemberMute(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  targetIdentifier: string,
  options: { muted: boolean; duration_seconds?: number; reason?: string }
): Promise<{
  conversation_id: string;
  user_id: string;
  wallet_address: string;
  is_muted: boolean;
  muted_until: number | null;
  mute_reason: string | null;
}> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || conv.type !== 'group') {
    throw new Error('Group not found');
  }

  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();

  if (!requester || (requester.role !== 'owner' && requester.role !== 'admin')) {
    throw new Error('Unauthorized: only group owner or admin can mute members');
  }

  const targetUser = await findOrCreateUser(db, targetIdentifier);
  const targetMember = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, targetUser.id).first<{ role: string }>();

  if (!targetMember) {
    throw new Error('Target user is not a member of this group');
  }

  if (targetMember.role === 'owner' || targetMember.role === 'admin') {
    throw new Error('Cannot mute group owner or admin');
  }

  const now = Date.now();
  let mutedUntil: number | null = null;
  let muteReason: string | null = null;

  if (options.muted) {
    mutedUntil = options.duration_seconds && options.duration_seconds > 0
      ? now + options.duration_seconds * 1000
      : -1; // -1 represents indefinite mute
    muteReason = options.reason || null;
  }

  await db.prepare(
    'UPDATE conversation_members SET muted_until = ?, mute_reason = ? WHERE conversation_id = ? AND user_id = ?'
  ).bind(mutedUntil, muteReason, conversationId, targetUser.id).run();

  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId).run();

  return {
    conversation_id: conversationId,
    user_id: targetUser.id,
    wallet_address: targetUser.wallet_address,
    is_muted: Boolean(options.muted),
    muted_until: mutedUntil,
    mute_reason: muteReason,
  };
}

export async function getGroupMuteStatus(
  db: D1Database,
  conversationId: string,
  requestingUserId: string
): Promise<{
  conversation_id: string;
  is_group_muted: boolean;
  group_mute_until: number | null;
  muted_members: Array<{
    user_id: string;
    wallet_address: string;
    muted_until: number | null;
    mute_reason: string | null;
  }>;
}> {
  const membership = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this group');
  }

  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || conv.type !== 'group') {
    throw new Error('Group not found');
  }

  const now = Date.now();
  const isGroupMuted = Boolean(conv.is_muted && (!conv.mute_until || conv.mute_until > now));

  const res = await db.prepare(`
    SELECT
      cm.user_id, cm.muted_until, cm.mute_reason,
      u.wallet_address
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
      AND cm.role = 'member'
      AND cm.muted_until IS NOT NULL
      AND (cm.muted_until = -1 OR cm.muted_until > ?)
    ORDER BY cm.muted_until ASC
  `).bind(conversationId, now).all<{ user_id: string; wallet_address: string; muted_until: number | null; mute_reason: string | null }>();

  return {
    conversation_id: conversationId,
    is_group_muted: isGroupMuted,
    group_mute_until: conv.mute_until ?? null,
    muted_members: res.results,
  };
}

export async function assertCanSendMessage(
  db: D1Database,
  conversationId: string,
  senderId: string
): Promise<ConversationMemberRow> {
  const membership = await db.prepare(
    'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, senderId).first<ConversationMemberRow>();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this conversation');
  }

  const conv = await db.prepare(
    'SELECT id, type, is_muted, mute_until FROM conversations WHERE id = ?'
  ).bind(conversationId).first<ConversationRow>();

  if (!conv) {
    throw new Error('Conversation not found');
  }

  // Direct chat blacklist check
  if (conv.type === 'direct') {
    const otherMember = await db.prepare(
      'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?'
    ).bind(conversationId, senderId).first<{ user_id: string }>();

    if (otherMember) {
      const isBlocked = await db.prepare(
        'SELECT 1 FROM blacklist WHERE user_id = ? AND blocked_address = ?'
      ).bind(otherMember.user_id, senderId).first();

      if (isBlocked) {
        throw new Error('Cannot send message: you have been blocked by this user');
      }
    }
    return membership;
  }

  // Group chat mute check: "admin始终可以讲话" (Group owner and admins can ALWAYS speak)
  if (membership.role === 'owner' || membership.role === 'admin') {
    return membership;
  }

  const now = Date.now();
  // Check group-wide mute
  if (conv.is_muted === 1 && (!conv.mute_until || conv.mute_until > now)) {
    throw new Error('Group chat is currently muted: only admins can send messages');
  }

  // Check individual member mute
  if (membership.muted_until && (membership.muted_until === -1 || membership.muted_until > now)) {
    const reasonStr = membership.mute_reason ? ` (Reason: ${membership.mute_reason})` : '';
    throw new Error(`You have been muted in this group${reasonStr}`);
  }

  return membership;
}
