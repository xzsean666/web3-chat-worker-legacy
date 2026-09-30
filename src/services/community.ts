// 社区运营：公开群列表（含封禁）、封禁/解封、Banner CRUD。
// 管理端（internalAdmin，HMAC）与公开端（routes/community.ts，authMiddleware）共用此服务。

import type { CommunityBannerRow } from '../db/schema';
import type { GroupMetadata } from './conversations';

export interface AdminCommunityGroupItem {
  id: string;
  name: string | null;
  owner_address: string | null;
  member_count: number;
  last_message_at: number | null;
  is_banned: boolean;
  banned_reason: string | null;
  hot: boolean;
  verified: boolean;
  created_at: number;
}

export interface ListCommunityGroupsOptions {
  keyword?: string;
  offset?: number;
  limit?: number;
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

/** 管理端 club 列表（含已封禁），LIMIT/OFFSET 分页。社区运营只管理 club。 */
export async function listCommunityGroups(
  db: D1Database,
  options: ListCommunityGroupsOptions = {}
): Promise<{ items: AdminCommunityGroupItem[]; total: number; offset: number; limit: number }> {
  const keyword = (options.keyword ?? '').trim();
  const escaped = keyword.replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const like = `%${escaped}%`;
  const limit = Math.min(Math.max(Math.floor(Number(options.limit)) || 20, 1), 100);
  const offset = Math.max(Math.floor(Number(options.offset)) || 0, 0);

  const where = `WHERE c.type = 'club'
    AND (? = '' OR c.name LIKE ? ESCAPE '\\' OR c.metadata LIKE ? ESCAPE '\\')`;
  const total =
    (await db.prepare(`SELECT COUNT(*) AS n FROM conversations c ${where}`).bind(keyword, like, like).first<{ n: number }>())
      ?.n ?? 0;

  const rows = await db.prepare(`
    SELECT c.id, c.name, c.owner_address, c.metadata, c.is_banned, c.last_message_at, c.created_at,
      (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count
    FROM conversations c
    ${where}
    ORDER BY COALESCE(c.last_message_at, c.updated_at, 0) DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).bind(keyword, like, like, limit, offset).all<{
    id: string;
    name: string | null;
    owner_address: string | null;
    metadata: string;
    is_banned: number;
    last_message_at: number | null;
    created_at: number;
    member_count: number;
  }>();

  const items = rows.results.map((row) => {
    const metadata = parseJsonSafe(row.metadata) as GroupMetadata;
    return {
      id: row.id,
      name: row.name,
      owner_address: row.owner_address,
      member_count: Number(row.member_count ?? 0),
      last_message_at: row.last_message_at ?? null,
      is_banned: row.is_banned === 1,
      banned_reason: typeof metadata.banned_reason === 'string' ? metadata.banned_reason : null,
      hot: metadata.hot === true,
      verified: metadata.verified === true,
      created_at: row.created_at,
    };
  });

  return { items, total: Number(total), offset, limit };
}

/** 封禁/解封 club；banned_reason 合并进 metadata（解封时移除）。club 不存在返回 null。 */
export async function setGroupBanned(
  db: D1Database,
  groupId: string,
  banned: boolean,
  reason?: string
): Promise<AdminCommunityGroupItem | null> {
  const conv = await db.prepare(
    "SELECT id, name, owner_address, metadata, is_banned, last_message_at, created_at FROM conversations WHERE id = ? AND type = 'club'"
  ).bind(groupId).first<{
    id: string;
    name: string | null;
    owner_address: string | null;
    metadata: string;
    is_banned: number;
    last_message_at: number | null;
    created_at: number;
  }>();
  if (!conv) return null;

  const metadata = parseJsonSafe(conv.metadata) as GroupMetadata;
  if (banned) {
    if (reason) metadata.banned_reason = reason;
  } else {
    delete metadata.banned_reason;
  }
  await db.prepare('UPDATE conversations SET is_banned = ?, metadata = ? WHERE id = ?')
    .bind(banned ? 1 : 0, JSON.stringify(metadata), groupId).run();

  const memberCount = await db.prepare(
    'SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?'
  ).bind(groupId).first<{ n: number }>();

  return {
    id: conv.id,
    name: conv.name,
    owner_address: conv.owner_address,
    member_count: Number(memberCount?.n ?? 0),
    last_message_at: conv.last_message_at ?? null,
    is_banned: banned,
    banned_reason: typeof metadata.banned_reason === 'string' ? metadata.banned_reason : null,
    hot: metadata.hot === true,
    verified: metadata.verified === true,
    created_at: conv.created_at,
  };
}

/** 运营标记 hot/verified（布尔，metadata 顶层合并写入，未提供的键不动）。club 不存在返回 null。 */
export async function setGroupFlags(
  db: D1Database,
  groupId: string,
  flags: { hot?: boolean; verified?: boolean }
): Promise<AdminCommunityGroupItem | null> {
  const conv = await db.prepare(
    "SELECT id FROM conversations WHERE id = ? AND type = 'club'"
  ).bind(groupId).first<{ id: string }>();
  if (!conv) return null;

  if (flags.hot !== undefined || flags.verified !== undefined) {
    const row = await db.prepare('SELECT metadata FROM conversations WHERE id = ?')
      .bind(groupId).first<{ metadata: string }>();
    const metadata = parseJsonSafe(row?.metadata) as GroupMetadata;
    if (flags.hot !== undefined) metadata.hot = Boolean(flags.hot);
    if (flags.verified !== undefined) metadata.verified = Boolean(flags.verified);
    await db.prepare('UPDATE conversations SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(metadata), Date.now(), groupId).run();
  }

  // 读回最新条目（不改封禁状态）
  const current = await db.prepare(
    'SELECT is_banned FROM conversations WHERE id = ?'
  ).bind(groupId).first<{ is_banned: number }>();
  return readAdminCommunityGroup(db, groupId, current?.is_banned === 1);
}

/** 读回 club 管理端条目（不改任何状态）。 */
async function readAdminCommunityGroup(
  db: D1Database,
  groupId: string,
  isBanned: boolean
): Promise<AdminCommunityGroupItem | null> {
  const conv = await db.prepare(
    "SELECT id, name, owner_address, metadata, last_message_at, created_at FROM conversations WHERE id = ? AND type = 'club'"
  ).bind(groupId).first<{
    id: string;
    name: string | null;
    owner_address: string | null;
    metadata: string;
    last_message_at: number | null;
    created_at: number;
  }>();
  if (!conv) return null;
  const metadata = parseJsonSafe(conv.metadata) as GroupMetadata;
  const memberCount = await db.prepare(
    'SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?'
  ).bind(groupId).first<{ n: number }>();
  return {
    id: conv.id,
    name: conv.name,
    owner_address: conv.owner_address,
    member_count: Number(memberCount?.n ?? 0),
    last_message_at: conv.last_message_at ?? null,
    is_banned: isBanned,
    banned_reason: typeof metadata.banned_reason === 'string' ? metadata.banned_reason : null,
    hot: metadata.hot === true,
    verified: metadata.verified === true,
    created_at: conv.created_at,
  };
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

export interface BannerInput {
  title?: string | null;
  image_url?: string;
  link_url?: string | null;
  sort?: number;
  enabled?: boolean;
}

/** includeDisabled=false 时只返回启用项（App 端），按 sort/created_at 升序。 */
export async function listBanners(db: D1Database, includeDisabled: boolean): Promise<CommunityBannerRow[]> {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  const rows = await db.prepare(
    `SELECT * FROM community_banners ${where} ORDER BY sort ASC, created_at ASC`
  ).all<CommunityBannerRow>();
  return rows.results;
}

export async function createBanner(db: D1Database, input: BannerInput): Promise<CommunityBannerRow> {
  const imageUrl = typeof input.image_url === 'string' ? input.image_url.trim() : '';
  if (!imageUrl) throw new Error('image_url is required');
  const now = Date.now();
  const banner: CommunityBannerRow = {
    id: crypto.randomUUID(),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : null,
    image_url: imageUrl,
    link_url: typeof input.link_url === 'string' && input.link_url.trim() ? input.link_url.trim() : null,
    sort: Number.isFinite(Number(input.sort)) ? Math.floor(Number(input.sort)) : 0,
    enabled: input.enabled === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  await db.prepare(`
    INSERT INTO community_banners (id, title, image_url, link_url, sort, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(banner.id, banner.title, banner.image_url, banner.link_url, banner.sort, banner.enabled, banner.created_at, banner.updated_at).run();
  return banner;
}

/** 部分更新；不存在返回 null。 */
export async function updateBanner(db: D1Database, id: string, input: BannerInput): Promise<CommunityBannerRow | null> {
  const existing = await db.prepare('SELECT * FROM community_banners WHERE id = ?').bind(id).first<CommunityBannerRow>();
  if (!existing) return null;

  const imageUrl = input.image_url !== undefined ? String(input.image_url).trim() : existing.image_url;
  if (!imageUrl) throw new Error('image_url cannot be empty');

  const next: CommunityBannerRow = {
    ...existing,
    title: input.title !== undefined ? (typeof input.title === 'string' && input.title.trim() ? input.title.trim() : null) : existing.title,
    image_url: imageUrl,
    link_url: input.link_url !== undefined ? (typeof input.link_url === 'string' && input.link_url.trim() ? input.link_url.trim() : null) : existing.link_url,
    sort: input.sort !== undefined && Number.isFinite(Number(input.sort)) ? Math.floor(Number(input.sort)) : existing.sort,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    updated_at: Date.now(),
  };
  await db.prepare(`
    UPDATE community_banners SET title = ?, image_url = ?, link_url = ?, sort = ?, enabled = ?, updated_at = ? WHERE id = ?
  `).bind(next.title, next.image_url, next.link_url, next.sort, next.enabled, next.updated_at, id).run();
  return next;
}

export async function deleteBanner(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM community_banners WHERE id = ?').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
