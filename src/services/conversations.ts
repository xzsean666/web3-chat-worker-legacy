import { isAddress } from 'viem';
import type {
  ConversationRow,
  ConversationMemberRow,
  GroupInviteLinkRow,
  GroupJoinRequestRow,
  MessageRow,
  UserRow,
} from '../db/schema';
import { isGroupLike } from '../db/schema';
import { normalizeAddress, chunkArray } from '../db';
import { ALLOWED_AVATAR_MIME_TYPES, MAX_AVATAR_SIZE_BYTES, type UploadAvatarOptions } from './users';
import { FREE_CAPACITY, GroupCapacityError, computeNextTier, insertMemberWithCapacity } from './payments/capacity';
import { isMemberWallet } from './payments/config';
import { assertHoldingsGate, parseJoinGate, parseJoinPrice, type ClubJoinPrice } from './clubs';

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
  rename_admin_only?: boolean;
  join_admin_only?: boolean;
  joinable?: boolean;               // false = 公开群不开放加入（默认 true）
  join_requires_approval?: boolean; // true = 公开群加入需管理员审批（走 group_join_requests）
  tencent_meeting_url?: string;     // 腾讯会议链接（群活动入口）
  tencent_meeting_start_at?: number; // 腾讯会议开播时间 epoch ms（设置链接时必填）
  tags?: string[];                  // 群标签（社区发现展示）
  banned_reason?: string;           // 封禁原因（管理端 is_banned=1 时写入）
  hot?: boolean;                    // 运营标记：热门（管理端 flags 写入）
  verified?: boolean;               // 运营标记：官方认证（管理端 flags 写入）
  join_gate?: {                     // club 持仓门槛：链上余额 ≥ min_amount 才可加入
    chain_id: number;
    token_address?: string | null;  // null/缺省 = 链原生币
    min_amount: string;             // 最小单位十进制整数字符串
  };
  join_price?: {                    // club 付费门槛：需先走 kind='club_join' 支付订单
    amount: string;                 // 最小单位十进制整数字符串
    token?: string;
  };
  [key: string]: any;        // 支持前端自定义扩展字段
}

export interface CreateInviteLinkOptions {
  expires_in_seconds?: number;
  max_uses?: number;
  /** Optional t.me/+name style custom slug: globally unique, [a-z0-9_-]{3,32}. */
  slug?: string;
}

export interface JoinRequestWithApplicant extends GroupJoinRequestRow {
  handler_wallet_address: string | null;
}

/** Public-safe group fields returned to an invitee before membership exists. */
export interface GroupInvitePreview {
  id: string;
  name: string | null;
  avatar_url: string | null;
  avatar_updated_at: number | null;
  member_count: number;
  metadata: GroupMetadata;
}

export type JoinByTokenResult =
  | { status: 'joined'; member: ConversationMemberWithUser; conversation: ConversationDetail; already_member?: boolean }
  | { status: 'pending'; pending: true; join_request: GroupJoinRequestRow; request: GroupJoinRequestRow; group: GroupInvitePreview }
  | { status: 'rejected'; pending: false; join_request: GroupJoinRequestRow; request: GroupJoinRequestRow; group: GroupInvitePreview };

/** club 付费门槛：不直接加入，由客户端走 kind='club_join' 支付订单后再入群。 */
export interface JoinClubPaymentRequired {
  status: 'requires_payment';
  join_price: ClubJoinPrice;
  group: GroupInvitePreview;
}

export type JoinPublicGroupResult = JoinByTokenResult | JoinClubPaymentRequired;

function isOwnerOrAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

function userDisplaySnapshot(user: UserRow): { nickname: string | null; avatar_url: string | null } {
  const publicMetadata = parseJsonSafe(user.public_metadata);
  return {
    nickname: typeof publicMetadata.nickname === 'string' ? publicMetadata.nickname : user.username,
    avatar_url: user.avatar_key ? `/users/${encodeURIComponent(user.wallet_address)}/avatar` : null,
  };
}

/** Emits a structured event into the existing messages and incremental-sync pipeline. */
async function sendGroupSystemEvent(
  db: D1Database,
  conversationId: string,
  senderId: string,
  event: Record<string, unknown>,
  now = Date.now()
): Promise<MessageRow> {
  const id = crypto.randomUUID();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  const content = JSON.stringify(event);
  await db.prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at, burn_after_seconds, mentions
    ) VALUES (?, ?, ?, 'system', ?, 'permanent', 'pending', ?, ?, NULL, '[]')
  `).bind(id, conversationId, senderId, content, expiresAt, now).run();

  return {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    type: 'system',
    content,
    retention: 'permanent',
    status: 'pending',
    expires_at: expiresAt,
    delivered_at: null,
    read_at: null,
    created_at: now,
    recalled_at: null,
    burn_after_seconds: null,
    mentions: '[]',
  };
}

async function getGroupInvitePreview(
  db: D1Database,
  conv: ConversationRow
): Promise<GroupInvitePreview> {
  const memberCount = await db.prepare(
    'SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = ?'
  ).bind(conv.id).first<{ count: number }>();
  const metadata = parseJsonSafe(conv.metadata) as GroupMetadata;
  const avatarUrl = conv.avatar_key
    ? `/groups/${encodeURIComponent(conv.id)}/avatar`
    : (typeof metadata.avatar_url === 'string' ? metadata.avatar_url : null);

  return {
    id: conv.id,
    name: conv.name,
    avatar_url: avatarUrl,
    avatar_updated_at: conv.avatar_updated_at ?? null,
    member_count: Number(memberCount?.count ?? 0),
    metadata,
  };
}

export interface PublicGroupSummary {
  id: string;
  name: string | null;
  description: string | null;
  avatar_url: string | null;
  avatar_updated_at: number | null;
  member_count: number;
  favorite_count: number;
  is_favorited: boolean;
  last_message_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PublicGroupSearchResult {
  items: PublicGroupSummary[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface SearchPublicGroupsOptions {
  cursor?: string;
  limit?: number;
  /** 当前用户 id（users.id = wallet 地址）；提供时计算 is_favorited */
  userId?: string;
}

/** 解析 "<last_message_at>_<id>" 游标；id 可含冒号/下划线（如 0xabc:my_team），
 *  时间戳部分恒为纯数字，因此按下划线第一次出现的位置分隔最可靠。 */
function parsePublicGroupCursor(cursor: string): { ts: number; id: string } | null {
  const idx = cursor.indexOf('_');
  if (idx <= 0) return null;
  const ts = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(ts) || ts < 0 || !id) return null;
  return { ts, id };
}

/**
 * Read-only discovery of public clubs（发现页只服务 club；存量公开群已由 0019 迁移为 type='club'）。
 * 排序：最近活跃优先（last_message_at DESC, id DESC），封禁 club 排除。
 * 游标分页：cursor = "<sort_ts>_<id>"，sort_ts 取 COALESCE(last_message_at, updated_at, 0)
 * 保证无消息的老 club（last_message_at 回填后为 NULL）不丢。
 */
export async function searchPublicClubs(
  db: D1Database,
  keyword: string,
  options: SearchPublicGroupsOptions = {}
): Promise<PublicGroupSearchResult> {
  const trimmed = keyword.trim();
  const escaped = trimmed.replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const like = `%${escaped}%`;
  const limit = Math.min(Math.max(Math.floor(Number(options.limit)) || 20, 1), 50);

  const cursor = options.cursor ? parsePublicGroupCursor(options.cursor) : null;
  if (options.cursor && !cursor) {
    throw new Error('Invalid cursor');
  }

  // 排序键与游标比较键必须一致：COALESCE(last_message_at, updated_at, 0)
  const sortExpr = 'COALESCE(c.last_message_at, c.updated_at, 0)';
  const cursorClause = cursor ? `AND (${sortExpr}, c.id) < (?, ?)` : '';
  // 占位符顺序按 SQL 文本出现位置绑定：SELECT 里的 is_favorited 在最前
  const params: unknown[] = [options.userId ?? '', trimmed, like, like];
  if (cursor) params.push(cursor.ts, cursor.id);
  params.push(limit + 1);

  const res = await db.prepare(`
    SELECT
      c.id, c.name, c.metadata, c.avatar_key, c.avatar_updated_at, c.created_at, c.updated_at,
      c.last_message_at, ${sortExpr} AS sort_ts,
      (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count,
      (SELECT COUNT(*) FROM club_favorites cf WHERE cf.club_id = c.id) AS favorite_count,
      EXISTS(SELECT 1 FROM club_favorites cf2 WHERE cf2.club_id = c.id AND cf2.user_id = ?) AS is_favorited
    FROM conversations c
    WHERE c.type = 'club' AND c.group_type = 'public' AND c.is_banned = 0
      AND (? = '' OR c.name LIKE ? ESCAPE '\\' OR c.metadata LIKE ? ESCAPE '\\')
      ${cursorClause}
    ORDER BY sort_ts DESC, c.id DESC
    LIMIT ?
  `).bind(...params).all<{
    id: string;
    name: string | null;
    metadata: string;
    avatar_key: string | null;
    avatar_updated_at: number | null;
    created_at: number;
    updated_at: number;
    last_message_at: number | null;
    sort_ts: number;
    member_count: number;
    favorite_count: number;
    is_favorited: number;
  }>();

  const rows = res.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items = page.map((row) => {
    const metadata = parseJsonSafe(row.metadata) as GroupMetadata;
    const avatarUrl = row.avatar_key
      ? `/groups/${encodeURIComponent(row.id)}/avatar`
      : (typeof metadata.avatar_url === 'string' ? metadata.avatar_url : null);
    return {
      id: row.id,
      name: row.name,
      description: typeof metadata.description === 'string' ? metadata.description : null,
      metadata,
      avatar_url: avatarUrl,
      avatar_updated_at: row.avatar_updated_at ?? null,
      member_count: Number(row.member_count ?? 0),
      favorite_count: Number(row.favorite_count ?? 0),
      is_favorited: Boolean(row.is_favorited),
      last_message_at: row.last_message_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });

  const last = page.length > 0 ? page[page.length - 1] : null;
  return {
    items,
    next_cursor: hasMore && last ? `${last.sort_ts}_${last.id}` : null,
    has_more: hasMore,
  };
}

/** 旧名 alias：发现查询已只查 club，保留导出名防断引用。 */
export const searchPublicGroups = searchPublicClubs;

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
  /** 会话类型：'group'（默认，普通群）| 'club'（社群，需会员钱包才可创建，固定公开可发现） */
  type?: 'group' | 'club';
  /** 内部入口（管理端审核通过创建 club）：跳过 isMemberWallet 校验（申请人已审过） */
  skipMembershipCheck?: boolean;
}

export interface UpdateGroupOptions {
  name?: string;
  description?: string;
  announcement?: string;
  marquee?: Partial<GroupMarquee> | boolean;
  metadata?: Record<string, any>;
  group_type?: 'private' | 'public';
  content_protected?: boolean;
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
        username: null,
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
    'SELECT * FROM users WHERE id = ? OR wallet_address = ? OR username = ?'
  ).bind(identifier, identifier, identifier).first<UserRow>();

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

  // Create new deterministic direct conversation atomically via batch
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
      c.id, c.type, c.owner_address, c.name, c.metadata, c.is_muted, c.mute_until,
      c.avatar_key, c.avatar_mime, c.avatar_updated_at,
      c.group_type, c.content_protected, c.last_message_at, c.is_banned,
      c.created_at, c.updated_at,
      my_cm.role,
      my_cm.group_nickname,
      (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
    FROM conversations c
    JOIN conversation_members my_cm ON my_cm.conversation_id = c.id AND my_cm.user_id = ?
    ORDER BY c.updated_at DESC
  `;

  const res = await db.prepare(query).bind(userId).all<any>();
  const now = Date.now();

  return res.results.map((c: any) => {
    const metadata = parseJsonSafe(c.metadata);
    if (isGroupLike(c.type) && c.avatar_key) {
      metadata.avatar_url = `/groups/${encodeURIComponent(c.id)}/avatar`;
    }
    return {
      ...c,
      metadata,
      is_muted: Boolean(c.is_muted && (!c.mute_until || c.mute_until > now)),
      mute_until: c.mute_until ?? null,
    };
  });
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
      cm.id, cm.conversation_id, cm.user_id, cm.role, cm.muted_until, cm.mute_reason, cm.group_nickname, cm.joined_at, cm.last_read_message_id,
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

  const metadata = parseJsonSafe(conv.metadata);
  if (isGroupLike(conv.type) && conv.avatar_key) {
    metadata.avatar_url = `/groups/${encodeURIComponent(conv.id)}/avatar`;
  }

  return {
    ...conv,
    metadata,
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

  const convType = options.type ?? 'group';
  if (convType !== 'group' && convType !== 'club') {
    throw new Error('type must be "group" or "club"');
  }

  const creator = await findOrCreateUser(db, creatorId);

  // club 创建门禁：仅会员钱包（白名单或未到期会员）可创建；路由映射 403 MEMBERSHIP_REQUIRED。
  // 管理端审核通过走 skipMembershipCheck 内部 bypass（申请人已被人工审过）。
  if (convType === 'club' && !options.skipMembershipCheck && !(await isMemberWallet(db, creator.id))) {
    throw new Error('MEMBERSHIP_REQUIRED: only member wallets can create a club');
  }

  const now = Date.now();

  // 契约 §8：新群容量恒为免费 50 档。创建者 + 初始成员总数超限 → 整单拒绝（不入库）。
  const resolvedMemberIds: string[] = [];
  const seenUsers = new Set<string>([creator.id]);
  for (const identifier of memberIdentifiers) {
    try {
      const user = await findOrCreateUser(db, identifier);
      if (user && !seenUsers.has(user.id)) {
        seenUsers.add(user.id);
        resolvedMemberIds.push(user.id);
      }
    } catch {
      // Ignore unknown non-address member identifiers gracefully
    }
  }
  if (1 + resolvedMemberIds.length > FREE_CAPACITY) {
    throw new GroupCapacityError({
      capacity: FREE_CAPACITY,
      tier: FREE_CAPACITY,
      memberCount: 1 + resolvedMemberIds.length,
      nextTier: await computeNextTier(db, FREE_CAPACITY),
    });
  }

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

  // club 固定 group_type='public'（发现页只覆盖 public club；group_type 列对 club 无用户语义，不接受入参）
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      'INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, group_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)'
    ).bind(convId, convType, creator.id, trimmedName, JSON.stringify(meta), convType === 'club' ? 'public' : 'private', now, now),
    db.prepare(
      'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(`${convId}:${creator.id}`, convId, creator.id, 'owner', now),
  ];

  for (const userId of resolvedMemberIds) {
    stmts.push(
      db.prepare(
        'INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(`${convId}:${userId}`, convId, userId, 'member', now)
    );
  }

  const chunks = chunkArray(stmts, 50);
  for (const chunk of chunks) {
    await db.batch(chunk);
  }

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
  if (!isGroupLike(conv.type)) {
    throw new Error('Cannot update settings of direct conversation');
  }

  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();

  const meta: GroupMetadata = parseJsonSafe(conv.metadata);
  if (!isOwnerOrAdmin(requester?.role)) {
    // The flag is explicitly enforced here. Other group settings have always
    // been administrator-only and retain that safer legacy permission model.
    if (meta.rename_admin_only && (updates.name !== undefined || updates.metadata?.name !== undefined)) {
      throw new Error('Unauthorized: only group owner or admin can rename this group');
    }
    throw new Error('Unauthorized: only group owner or admin can update group settings');
  }
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
    // 顶层合并：null 表示删除该 key（供"清空腾讯会议链接"等场景）。
    for (const [key, value] of Object.entries(updates.metadata)) {
      if (value === null) {
        delete meta[key];
      } else {
        meta[key] = value;
      }
    }
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

  let groupType = conv.group_type;
  if (updates.group_type !== undefined) {
    if (updates.group_type !== 'private' && updates.group_type !== 'public') {
      throw new Error('group_type must be "private" or "public"');
    }
    groupType = updates.group_type;
  }

  let contentProtected = conv.content_protected;
  if (updates.content_protected !== undefined) {
    contentProtected = updates.content_protected ? 1 : 0;
  }

  const now = Date.now();
  await db.prepare(
    'UPDATE conversations SET name = ?, metadata = ?, group_type = ?, content_protected = ?, updated_at = ? WHERE id = ?'
  ).bind(newName, JSON.stringify(meta), groupType, contentProtected, now, conversationId).run();

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
  if (!conv || !isGroupLike(conv.type)) {
    throw new Error('Group not found');
  }

  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();

  const metadata = parseJsonSafe(conv.metadata) as GroupMetadata;
  if (metadata.join_admin_only && !isOwnerOrAdmin(requester?.role)) {
    throw new Error('Unauthorized: group membership requires owner or admin approval; use join requests');
  }
  if (!isOwnerOrAdmin(requester?.role)) {
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

  // 契约 §8：容量强制（原子条件插入；已满 → 403 GROUP_CAPACITY_REACHED）
  const joined = await insertMemberWithCapacity(db, conversationId, targetUser.id, 'member');
  if (!joined.ok) throw new GroupCapacityError(joined.info);

  await db.prepare(
    'UPDATE conversations SET updated_at = ? WHERE id = ?'
  ).bind(now, conversationId).run();

  await sendGroupSystemEvent(db, conversationId, targetUser.id, {
    event: 'member_joined',
    user_id: targetUser.id,
    wallet_address: targetUser.wallet_address,
  }, now);

  return {
    id: memberId,
    conversation_id: conversationId,
    user_id: targetUser.id,
    role: 'member',
    muted_until: null,
    mute_reason: null,
    group_nickname: null,
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
  targetIdentifier: string,
  r2?: R2Bucket
): Promise<{ success: boolean; message: string }> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) {
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
      if (r2 && conv.avatar_key) {
        try {
          await r2.delete(conv.avatar_key);
        } catch {
          // Ignore deletion error of group avatar
        }
      }
      await db.prepare('DELETE FROM conversations WHERE id = ?').bind(conversationId).run();
      return { success: true, message: 'Group deleted as owner left' };
    }

    const now = Date.now();
    await db.batch([
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(conversationId, targetId),
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId),
    ]);

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

  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(conversationId, targetId),
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId),
  ]);

  return { success: true, message: 'Member removed successfully' };
}

export async function leaveGroup(
  db: D1Database,
  conversationId: string,
  userId: string,
  r2?: R2Bucket
): Promise<{ success: boolean; message: string }> {
  return removeGroupMember(db, conversationId, userId, userId, r2);
}

export async function updateMemberRole(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  targetIdentifier: string,
  role: 'admin' | 'member'
): Promise<ConversationMemberWithUser> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) {
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
  await db.batch([
    db.prepare(`
      UPDATE conversation_members
      SET role = ?,
          muted_until = CASE WHEN ? = 'admin' THEN NULL ELSE muted_until END,
          mute_reason = CASE WHEN ? = 'admin' THEN NULL ELSE mute_reason END
      WHERE conversation_id = ? AND user_id = ?
    `).bind(role, role, role, conversationId, targetUser.id),
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId),
  ]);

  return {
    ...targetMember,
    role,
    muted_until: role === 'admin' ? null : targetMember.muted_until,
    mute_reason: role === 'admin' ? null : targetMember.mute_reason,
    is_muted: false,
    wallet_address: targetUser.wallet_address,
  };
}

export async function createGroupInviteLink(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  options: CreateInviteLinkOptions = {}
): Promise<{ token: string; slug: string | null; url: string; expires_at: number | null; max_uses: number | null }> {
  const conv = await db.prepare('SELECT type FROM conversations WHERE id = ?').bind(conversationId).first<{ type: string }>();
  if (!conv || !isGroupLike(conv.type)) throw new Error('Group not found');

  const member = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();
  if (!isOwnerOrAdmin(member?.role)) throw new Error('Unauthorized: only group owner or admin can create invite links');

  const expiresInSeconds = options.expires_in_seconds;
  if (expiresInSeconds !== undefined && (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0)) {
    throw new Error('expires_in_seconds must be a positive number');
  }
  const maxUses = options.max_uses;
  if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses <= 0)) {
    throw new Error('max_uses must be a positive integer');
  }

  let slug: string | null = null;
  if (options.slug !== undefined) {
    slug = options.slug.trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(slug)) {
      throw new Error('Invalid slug: use 3-32 characters of lowercase letters, digits, "_" or "-"');
    }
    // Re-requesting a slug this group already owns returns the existing link
    // instead of failing; a slug owned by another group conflicts globally.
    const taken = await db.prepare('SELECT * FROM group_invite_links WHERE slug = ?').bind(slug).first<GroupInviteLinkRow>();
    if (taken) {
      if (taken.group_id !== conversationId) throw new Error('Slug already taken');
      return {
        token: taken.token,
        slug: taken.slug,
        url: `https://api.chatnice.top/g/${taken.slug}`,
        expires_at: taken.expires_at,
        max_uses: taken.max_uses,
      };
    }
  }

  const now = Date.now();
  const token = crypto.randomUUID().replace(/-/g, '');
  const expiresAt = expiresInSeconds ? now + expiresInSeconds * 1000 : null;
  await db.prepare(`
    INSERT INTO group_invite_links (token, group_id, created_by, expires_at, max_uses, uses_count, slug, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).bind(token, conversationId, requestingUserId, expiresAt, maxUses ?? null, slug, now).run();

  return {
    token,
    slug,
    // 对外统一 https 落地页（无 App 引导下载、有 App 拉起入群）；
    // 客户端 deep_link_service 同时兼容 chaintalk:// 旧链接。
    url: `https://api.chatnice.top/g/${slug ?? token}`,
    expires_at: expiresAt,
    max_uses: maxUses ?? null,
  };
}

export async function createGroupJoinRequest(
  db: D1Database,
  conversationId: string,
  applicant: UserRow,
  message?: string
): Promise<GroupJoinRequestRow> {
  const conv = await db.prepare('SELECT type FROM conversations WHERE id = ?').bind(conversationId).first<{ type: string }>();
  if (!conv || !isGroupLike(conv.type)) throw new Error('Group not found');

  const existingMember = await db.prepare(
    'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, applicant.id).first();
  if (existingMember) throw new Error('User is already a member of this group');

  const pending = await db.prepare(
    "SELECT id FROM group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'"
  ).bind(conversationId, applicant.id).first();
  if (pending) throw new Error('A join request is already pending for this group');

  const trimmedMessage = message?.trim();
  if (trimmedMessage && trimmedMessage.length > 500) throw new Error('Join request message is too long (max 500 characters)');

  const now = Date.now();
  const snapshot = userDisplaySnapshot(applicant);
  const request: GroupJoinRequestRow = {
    id: crypto.randomUUID(),
    group_id: conversationId,
    user_id: applicant.id,
    wallet_address: applicant.wallet_address,
    nickname: snapshot.nickname,
    avatar_url: snapshot.avatar_url,
    message: trimmedMessage || null,
    status: 'pending',
    created_at: now,
    handled_by: null,
    handled_at: null,
  };

  await db.batch([
    db.prepare(`
      INSERT INTO group_join_requests (
        id, group_id, user_id, wallet_address, nickname, avatar_url, message, status, created_at, handled_by, handled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)
    `).bind(
      request.id, request.group_id, request.user_id, request.wallet_address, request.nickname,
      request.avatar_url, request.message, request.created_at
    ),
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId),
  ]);
  await sendGroupSystemEvent(db, conversationId, applicant.id, {
    event: 'join_request_created',
    request_id: request.id,
    user_id: applicant.id,
    wallet_address: applicant.wallet_address,
    message: request.message,
  }, now);
  return request;
}

export async function listGroupJoinRequests(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  status = 'pending'
): Promise<JoinRequestWithApplicant[]> {
  if (!['pending', 'approved', 'rejected'].includes(status)) throw new Error('Invalid join request status');
  const member = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();
  if (!isOwnerOrAdmin(member?.role)) throw new Error('Unauthorized: only group owner or admin can view join requests');

  const result = await db.prepare(`
    SELECT jr.*, handler.wallet_address AS handler_wallet_address
    FROM group_join_requests jr
    LEFT JOIN users handler ON handler.id = jr.handled_by
    WHERE jr.group_id = ? AND jr.status = ?
    ORDER BY jr.created_at DESC
  `).bind(conversationId, status).all<JoinRequestWithApplicant>();
  return result.results;
}

export async function handleGroupJoinRequest(
  db: D1Database,
  conversationId: string,
  requestId: string,
  requestingUserId: string,
  decision: 'approved' | 'rejected'
): Promise<GroupJoinRequestRow> {
  const handler = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();
  if (!isOwnerOrAdmin(handler?.role)) throw new Error('Unauthorized: only group owner or admin can handle join requests');

  const request = await db.prepare(
    "SELECT * FROM group_join_requests WHERE id = ? AND group_id = ? AND status = 'pending'"
  ).bind(requestId, conversationId).first<GroupJoinRequestRow>();
  if (!request) throw new Error('Pending join request not found');

  const now = Date.now();
  if (decision === 'approved') {
    const existingMember = await db.prepare(
      'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(conversationId, request.user_id).first();
    if (existingMember) throw new Error('Applicant is already a member of this group');

    // 契约 §8：容量满时批准失败，申请保持 pending（不吞掉）
    const joined = await insertMemberWithCapacity(db, conversationId, request.user_id, 'member');
    if (!joined.ok) throw new GroupCapacityError(joined.info);

    await db.batch([
      db.prepare(`
        UPDATE group_join_requests SET status = 'approved', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'pending'
      `).bind(requestingUserId, now, requestId),
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId),
    ]);
    // 并发兜底：请求状态被别的处理人抢先变更 → 回滚成员插入
    const after = await db.prepare('SELECT status FROM group_join_requests WHERE id = ?').bind(requestId).first<{ status: string }>();
    if (after?.status !== 'approved') {
      await db.prepare('DELETE FROM conversation_members WHERE id = ?').bind(`${conversationId}:${request.user_id}`).run();
      throw new Error('Pending join request not found');
    }
  } else {
    await db.batch([
      db.prepare(`
        UPDATE group_join_requests SET status = 'rejected', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'pending'
      `).bind(requestingUserId, now, requestId),
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId),
    ]);
  }

  await sendGroupSystemEvent(db, conversationId, requestingUserId, {
    event: decision === 'approved' ? 'join_request_approved' : 'join_request_rejected',
    request_id: requestId,
    user_id: request.user_id,
    wallet_address: request.wallet_address,
    handled_by: requestingUserId,
  }, now);

  return { ...request, status: decision, handled_by: requestingUserId, handled_at: now };
}

export async function joinGroupByInviteToken(
  db: D1Database,
  token: string,
  applicant: UserRow,
  message?: string,
  retry = false
): Promise<JoinByTokenResult> {
  // Accepts either the opaque token or a custom slug (t.me/+name style link).
  const link = await db.prepare('SELECT * FROM group_invite_links WHERE token = ? OR slug = ?').bind(token, token).first<GroupInviteLinkRow>();
  const now = Date.now();
  if (!link) throw new Error('Invite link not found');
  if (link.expires_at !== null && link.expires_at <= now) throw new Error('Invite link has expired');

  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(link.group_id).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) throw new Error('Invite link group not found');
  // Public groups never go through the approval workflow: joining always succeeds directly.
  const isPublicGroup = conv.group_type === 'public';
  const group = await getGroupInvitePreview(db, conv);
  const existingMember = await db.prepare(
    'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(link.group_id, applicant.id).first();
  if (existingMember) {
    const conversation = await getConversation(db, link.group_id, applicant.id);
    const member = conversation.members.find((item) => item.user_id === applicant.id);
    if (!member) throw new Error('Group membership could not be loaded');
    return { status: 'joined', member, conversation, already_member: true };
  }

  if (!isPublicGroup) {
    const latestRequest = await db.prepare(`
      SELECT * FROM group_join_requests
      WHERE group_id = ? AND user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).bind(link.group_id, applicant.id).first<GroupJoinRequestRow>();
    if (latestRequest?.status === 'pending') {
      return {
        status: 'pending',
        pending: true,
        join_request: latestRequest,
        request: latestRequest,
        group,
      };
    }
    if (latestRequest?.status === 'rejected' && !retry) {
      return {
        status: 'rejected',
        pending: false,
        join_request: latestRequest,
        request: latestRequest,
        group,
      };
    }

    // A retry after rejection belongs to an invite already consumed by this
    // applicant, so it deliberately does not consume another limited-use slot.
    if (latestRequest?.status === 'rejected' && retry) {
      const request = await createGroupJoinRequest(db, link.group_id, applicant, message);
      return { status: 'pending', pending: true, join_request: request, request, group };
    }

    const pendingRequest = await db.prepare(
      "SELECT id FROM group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'"
    ).bind(link.group_id, applicant.id).first();
    if (pendingRequest) throw new Error('A join request is already pending for this group');
  }

  const metadata = parseJsonSafe(conv.metadata) as GroupMetadata;
  const consumeInviteUse = async () => {
    const consumed = await db.prepare(`
      UPDATE group_invite_links SET uses_count = uses_count + 1
      WHERE token = ?
        AND (expires_at IS NULL OR expires_at > ?)
        AND (max_uses IS NULL OR uses_count < max_uses)
    `).bind(link.token, now).run();
    if (consumed.meta.changes !== 1) throw new Error('Invite link has reached its usage limit');
  };

  if (!isPublicGroup && metadata.join_admin_only) {
    await consumeInviteUse(); // 保持原有语义：转申请分支也消耗一次邀请
    const request = await createGroupJoinRequest(db, link.group_id, applicant, message);
    // Re-read only the count so previews reflect the actual current member set.
    const currentGroup = await getGroupInvitePreview(db, conv);
    return { status: 'pending', pending: true, join_request: request, request, group: currentGroup };
  }

  // 契约 §8：容量插入成功后才消耗邀请次数（容量满不消耗 uses_count；消耗失败回滚成员插入）
  const memberId = `${link.group_id}:${applicant.id}`;
  const joined = await insertMemberWithCapacity(db, link.group_id, applicant.id, 'member');
  if (!joined.ok) throw new GroupCapacityError(joined.info);
  try {
    await consumeInviteUse();
  } catch (err) {
    if (!joined.already) {
      await db.prepare('DELETE FROM conversation_members WHERE id = ?').bind(memberId).run();
    }
    throw err;
  }
  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, link.group_id).run();
  await sendGroupSystemEvent(db, link.group_id, applicant.id, {
    event: 'member_joined',
    user_id: applicant.id,
    wallet_address: applicant.wallet_address,
    invite_token: token,
  }, now);
  const member: ConversationMemberWithUser = {
      id: memberId,
      conversation_id: link.group_id,
      user_id: applicant.id,
      role: 'member',
      muted_until: null,
      mute_reason: null,
      group_nickname: null,
      joined_at: now,
      last_read_message_id: null,
      wallet_address: applicant.wallet_address,
      is_muted: false,
    };
  const conversation = await getConversation(db, link.group_id, applicant.id);
  return { status: 'joined', member, conversation };
}

/// Directly join a public group/club (no invite token). Idempotent:
/// already-member returns the same joined payload with already_member=true.
/// metadata 前置校验（按序）：
/// - ① joinable === false → 抛 GROUP_NOT_JOINABLE（路由映射 403）
/// - ② club 且 metadata.join_gate → 链上持仓校验，不足抛 HoldingsGateError（路由映射 403 HOLDINGS_GATE_FAILED）
/// - ③ club 且 metadata.join_price → 不加入，返回 200 requires_payment（走 club_join 支付订单）
/// - ④ join_requires_approval === true → 转 group_join_requests 审批流，返回 pending
/// - ⑤ 全过 → insertMemberWithCapacity 直接入群（201 结构不变）
export async function joinPublicGroup(
  db: D1Database,
  groupId: string,
  applicant: UserRow
): Promise<JoinPublicGroupResult> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(groupId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) throw new Error('Group not found');
  if (conv.group_type !== 'public') throw new Error('Group is not public');

  const metadata = parseJsonSafe(conv.metadata) as GroupMetadata;
  if (metadata.joinable === false) {
    throw new Error('GROUP_NOT_JOINABLE: this group is not open for joining');
  }

  const now = Date.now();
  const existingMember = await db.prepare(
    'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(groupId, applicant.id).first();
  if (existingMember) {
    const conversation = await getConversation(db, groupId, applicant.id);
    const member = conversation.members.find((item) => item.user_id === applicant.id);
    if (!member) throw new Error('Group membership could not be loaded');
    return { status: 'joined', member, conversation, already_member: true };
  }

  // club 门禁：持仓门槛先于付费门槛（持仓不达标直接 403，不进入付费引导）
  if (conv.type === 'club') {
    const gate = parseJoinGate(metadata);
    if (gate) {
      await assertHoldingsGate(db, gate, applicant.wallet_address);
    }
    const joinPrice = parseJoinPrice(metadata);
    if (joinPrice) {
      const group = await getGroupInvitePreview(db, conv);
      return { status: 'requires_payment', join_price: joinPrice, group };
    }
  }

  if (metadata.join_requires_approval === true) {
    // 已有 pending 申请时直接返回该申请（幂等），与 join-by-token 的 pending 语义一致
    const pendingRequest = await db.prepare(
      "SELECT * FROM group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'"
    ).bind(groupId, applicant.id).first<GroupJoinRequestRow>();
    const request = pendingRequest ?? await createGroupJoinRequest(db, groupId, applicant);
    const group = await getGroupInvitePreview(db, conv);
    return { status: 'pending', pending: true, join_request: request, request, group };
  }

  const memberId = `${groupId}:${applicant.id}`;
  // 契约 §8：容量强制（原子条件插入；已满 → 403 GROUP_CAPACITY_REACHED）
  const joined = await insertMemberWithCapacity(db, groupId, applicant.id, 'member');
  if (!joined.ok) throw new GroupCapacityError(joined.info);
  await db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, groupId).run();
  await sendGroupSystemEvent(db, groupId, applicant.id, {
    event: 'member_joined',
    user_id: applicant.id,
    wallet_address: applicant.wallet_address,
  }, now);
  const member: ConversationMemberWithUser = {
    id: memberId,
    conversation_id: groupId,
    user_id: applicant.id,
    role: 'member',
    muted_until: null,
    mute_reason: null,
    group_nickname: null,
    joined_at: now,
    last_read_message_id: null,
    wallet_address: applicant.wallet_address,
    is_muted: false,
  };
  const conversation = await getConversation(db, groupId, applicant.id);
  return { status: 'joined', member, conversation };
}

export async function transferGroupOwnership(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  targetIdentifier: string
): Promise<{ group_id: string; previous_owner_user_id: string; new_owner_user_id: string; owner_address: string }> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) throw new Error('Group not found');
  const requester = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first<{ role: string }>();
  if (requester?.role !== 'owner') throw new Error('Unauthorized: only the group owner can transfer ownership');

  const target = await findOrCreateUser(db, targetIdentifier);
  if (target.id === requestingUserId) throw new Error('Target user is already the group owner');
  const targetMember = await db.prepare(
    'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, target.id).first();
  if (!targetMember) throw new Error('Target user must be a member of this group');

  const now = Date.now();
  await db.batch([
    // Clear any corrupted legacy owner role before assigning exactly one owner.
    db.prepare(`
      UPDATE conversation_members
      SET role = CASE WHEN user_id = ? THEN 'admin' ELSE 'member' END,
          muted_until = CASE WHEN user_id = ? THEN NULL ELSE muted_until END,
          mute_reason = CASE WHEN user_id = ? THEN NULL ELSE mute_reason END
      WHERE conversation_id = ? AND role = 'owner'
    `).bind(requestingUserId, requestingUserId, requestingUserId, conversationId),
    db.prepare(`
      UPDATE conversation_members SET role = 'owner', muted_until = NULL, mute_reason = NULL
      WHERE conversation_id = ? AND user_id = ?
    `).bind(conversationId, target.id),
    db.prepare('UPDATE conversations SET owner_address = ?, updated_at = ? WHERE id = ?')
      .bind(target.wallet_address, now, conversationId),
  ]);
  await sendGroupSystemEvent(db, conversationId, requestingUserId, {
    event: 'ownership_transferred',
    previous_owner_user_id: requestingUserId,
    new_owner_user_id: target.id,
    new_owner_wallet_address: target.wallet_address,
  }, now);

  return {
    group_id: conversationId,
    previous_owner_user_id: requestingUserId,
    new_owner_user_id: target.id,
    owner_address: target.wallet_address,
  };
}

const GROUP_NICKNAME_MAX_LENGTH = 64;

export async function setGroupNickname(
  db: D1Database,
  conversationId: string,
  userId: string,
  nickname: string | null
): Promise<ConversationMemberWithUser> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) {
    throw new Error('Group not found');
  }

  const member = await db.prepare(
    'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, userId).first<ConversationMemberRow>();

  if (!member) {
    throw new Error('Unauthorized: you are not a member of this group');
  }

  // Empty string clears the nickname
  const trimmed = nickname && nickname.trim() ? nickname.trim() : null;
  if (trimmed && trimmed.length > GROUP_NICKNAME_MAX_LENGTH) {
    throw new Error(`Group nickname is too long (max ${GROUP_NICKNAME_MAX_LENGTH} characters)`);
  }

  await db.prepare(
    'UPDATE conversation_members SET group_nickname = ? WHERE conversation_id = ? AND user_id = ?'
  ).bind(trimmed, conversationId, userId).run();

  const userRow = await db.prepare(
    'SELECT wallet_address FROM users WHERE id = ?'
  ).bind(userId).first<{ wallet_address: string }>();

  return {
    ...member,
    group_nickname: trimmed,
    is_muted: false,
    wallet_address: userRow?.wallet_address ?? userId,
  };
}

export async function getGroupMembers(
  db: D1Database,
  conversationId: string,
  userId: string
): Promise<ConversationMemberWithUser[]> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) {
    throw new Error('Group not found');
  }

  const membership = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, userId).first();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this group');
  }

  const membersRes = await db.prepare(`
    SELECT
      cm.id, cm.conversation_id, cm.user_id, cm.role, cm.muted_until, cm.mute_reason, cm.group_nickname, cm.joined_at, cm.last_read_message_id,
      u.wallet_address
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
    ORDER BY cm.joined_at ASC
  `).bind(conversationId).all<ConversationMemberWithUser>();

  const now = Date.now();
  return membersRes.results.map((m) => ({
    ...m,
    is_muted: m.role === 'member' && (m.muted_until === -1 || (m.muted_until !== null && m.muted_until > now)),
  }));
}

export async function setGroupMute(
  db: D1Database,
  conversationId: string,
  requestingUserId: string,
  options: { muted: boolean; duration_seconds?: number }
): Promise<{ conversation_id: string; is_muted: boolean; mute_until: number | null }> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) {
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
  if (!conv || !isGroupLike(conv.type)) {
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

  await db.batch([
    db.prepare(
      'UPDATE conversation_members SET muted_until = ?, mute_reason = ? WHERE conversation_id = ? AND user_id = ?'
    ).bind(mutedUntil, muteReason, conversationId, targetUser.id),
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now, conversationId),
  ]);

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
  if (!conv || !isGroupLike(conv.type)) {
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
  interface ConvAndMemberRow extends ConversationMemberRow {
    conv_id: string;
    conv_type: string;
    conv_is_muted: number;
    conv_mute_until: number | null;
  }

  const row = await db.prepare(`
    SELECT
      cm.id, cm.conversation_id, cm.user_id, cm.role, cm.joined_at, cm.last_read_message_id, cm.muted_until, cm.mute_reason, cm.group_nickname,
      c.id AS conv_id,
      c.type AS conv_type,
      c.is_muted AS conv_is_muted,
      c.mute_until AS conv_mute_until
    FROM conversations c
    LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
    WHERE c.id = ?
  `).bind(senderId, conversationId).first<ConvAndMemberRow>();

  if (!row) {
    throw new Error('Conversation not found');
  }

  if (!row.id) {
    throw new Error('Unauthorized: you are not a member of this conversation');
  }

  const membership: ConversationMemberRow = {
    id: row.id,
    conversation_id: row.conversation_id,
    user_id: row.user_id,
    role: row.role,
    joined_at: row.joined_at,
    last_read_message_id: row.last_read_message_id,
    muted_until: row.muted_until,
    mute_reason: row.mute_reason,
    group_nickname: row.group_nickname,
  };

  const conv = {
    id: row.conv_id,
    type: row.conv_type,
    is_muted: row.conv_is_muted,
    mute_until: row.conv_mute_until,
  };

  // Direct chat blacklist check
  if (conv.type === 'direct') {
    const otherMember = await db.prepare(
      'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?'
    ).bind(conversationId, senderId).first<{ user_id: string }>();

    if (otherMember) {
      const check = await db.prepare(
        `SELECT
          (SELECT 1 FROM blacklist WHERE user_id = ? AND blocked_address = ?) AS is_blocked,
          (SELECT 1 FROM bots WHERE id IN (?, ?) LIMIT 1) AS is_bot,
          (SELECT COUNT(*) FROM friends
           WHERE (user_id = ? AND friend_address = ?)
              OR (user_id = ? AND friend_address = ?)) AS friend_count`
      ).bind(
        otherMember.user_id, senderId,
        senderId, otherMember.user_id,
        senderId, otherMember.user_id, otherMember.user_id, senderId
      ).first<{ is_blocked: number | null; is_bot: number | null; friend_count: number }>();

      if (check?.is_blocked) {
        throw new Error('Cannot send message: you have been blocked by this user');
      }

      // Direct chats require mutual friendship, unless one participant is a bot
      if (!check?.is_bot && (check?.friend_count ?? 0) < 2) {
        throw new Error('Unauthorized: you are no longer friends with this user');
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


export async function uploadGroupAvatar(
  db: D1Database,
  r2: R2Bucket,
  conversationId: string,
  requestingUserId: string,
  options: UploadAvatarOptions
): Promise<{ avatar_url: string; avatar_updated_at: number }> {
  const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first<ConversationRow>();
  if (!conv || !isGroupLike(conv.type)) {
    throw new Error('Group not found');
  }

  if (conv.owner_address !== requestingUserId) {
    throw new Error('Unauthorized: only the group owner can change the group avatar');
  }

  const normalizedMime = options.mimeType.toLowerCase().split(';')[0].trim();
  const ext = ALLOWED_AVATAR_MIME_TYPES[normalizedMime];
  if (!ext) {
    throw new Error(
      `Unsupported avatar image format: ${options.mimeType}. Allowed: jpeg, png, webp, gif, svg`
    );
  }

  const byteLength = options.avatarData.byteLength;
  if (byteLength === 0) {
    throw new Error('Avatar image cannot be empty');
  }
  if (byteLength > MAX_AVATAR_SIZE_BYTES) {
    throw new Error(`Avatar image exceeds maximum size of ${MAX_AVATAR_SIZE_BYTES / (1024 * 1024)}MB`);
  }

  // Single avatar constraint: Delete previous avatar if exists
  if (conv.avatar_key) {
    try {
      await r2.delete(conv.avatar_key);
    } catch {
      // Ignore deletion error of previous avatar
    }
  }

  const now = Date.now();
  const objectKey = `group-avatars/${encodeURIComponent(conversationId)}-${now}.${ext}`;

  await r2.put(objectKey, options.avatarData, {
    httpMetadata: {
      contentType: normalizedMime,
    },
    customMetadata: {
      conversation_id: conversationId,
      uploaded_by: requestingUserId,
      uploaded_at: now.toString(),
    },
  });

  const meta: GroupMetadata = parseJsonSafe(conv.metadata);
  meta.avatar_url = `/groups/${encodeURIComponent(conversationId)}/avatar`;

  await db.prepare(`
    UPDATE conversations
    SET avatar_key = ?, avatar_mime = ?, avatar_updated_at = ?, metadata = ?, updated_at = ?
    WHERE id = ?
  `).bind(objectKey, normalizedMime, now, JSON.stringify(meta), now, conversationId).run();

  return {
    avatar_url: meta.avatar_url,
    avatar_updated_at: now,
  };
}

export async function getGroupAvatar(
  db: D1Database,
  r2: R2Bucket,
  conversationId: string,
  requestingUserId: string
): Promise<{ object: R2ObjectBody; mimeType: string } | null> {
  const membership = await db.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(conversationId, requestingUserId).first();

  if (!membership) {
    throw new Error('Unauthorized: you are not a member of this group');
  }

  const conv = await db.prepare(
    'SELECT avatar_key, avatar_mime FROM conversations WHERE id = ?'
  ).bind(conversationId).first<ConversationRow>();

  if (!conv || !conv.avatar_key) {
    return null;
  }

  const object = await r2.get(conv.avatar_key);
  if (!object) {
    return null;
  }

  return {
    object,
    mimeType: conv.avatar_mime || 'image/png',
  };
}
