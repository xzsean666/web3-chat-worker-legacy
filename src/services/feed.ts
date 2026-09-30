// 动态 feed：发帖（文本+图片 keys）、游标分页列表、点赞/取消（幂等）、软删与编辑。
// 删帖/编辑权限：作者本人，或 club 帖所属 club（feed_posts.club_id）的 owner/admin。
// 图片二进制存 R2（VOICE_BUCKET，feed/ 前缀）；D1 只存 key 数组。

import type { FeedPostRow } from '../db/schema';

export const FEED_IMAGE_PREFIX = 'feed/';
export const MAX_FEED_CONTENT_LENGTH = 2000;
export const MAX_FEED_IMAGES = 9;
export const MAX_FEED_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const RECENT_LIKERS_LIMIT = 8;

/** 动态目标板块（社群主页四个 Tab）：featured=精选 / admins=自选 / media=图片·视频 / files=文件。 */
export const FEED_SECTIONS = ['featured', 'admins', 'media', 'files'] as const;
export type FeedSection = (typeof FEED_SECTIONS)[number];

/** 动态视频附件：R2 key 前缀与格式/大小约束。 */
export const FEED_VIDEO_PREFIX = 'feed-videos/';
export const MAX_FEED_VIDEO_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export const FEED_VIDEO_MIME_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/m4v': 'm4v',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export const FEED_IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function parseJsonSafe(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function parseImageKeys(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** 上传 feed 图片到 R2，返回 key（feed/ 前缀）与相对 url。 */
export async function uploadFeedImage(
  r2: R2Bucket,
  userId: string,
  data: Uint8Array,
  mimeType: string
): Promise<{ key: string; url: string }> {
  const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
  const ext = FEED_IMAGE_MIME_TYPES[normalizedMime];
  if (!ext) {
    throw new Error(`Unsupported image format: ${mimeType}. Allowed: png, jpeg, webp`);
  }
  if (data.byteLength === 0) throw new Error('Image file cannot be empty');
  if (data.byteLength > MAX_FEED_IMAGE_SIZE_BYTES) {
    throw new Error(`Image file exceeds maximum size of ${MAX_FEED_IMAGE_SIZE_BYTES / (1024 * 1024)}MB`);
  }
  const key = `${FEED_IMAGE_PREFIX}${crypto.randomUUID()}.${ext}`;
  await r2.put(key, data, {
    httpMetadata: { contentType: normalizedMime },
    customMetadata: { uploaded_by: userId, uploaded_at: Date.now().toString() },
  });
  return { key, url: `/feed/images/${key}` };
}

/** 上传 feed 视频到 R2，返回 key（feed-videos/ 前缀）与相对 url。 */
export async function uploadFeedVideo(
  r2: R2Bucket,
  userId: string,
  data: Uint8Array,
  mimeType: string
): Promise<{ key: string; url: string }> {
  const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
  const ext = FEED_VIDEO_MIME_TYPES[normalizedMime];
  if (!ext) {
    throw new Error(`Unsupported video format: ${mimeType}. Allowed: mp4, m4v, mov, webm`);
  }
  if (data.byteLength === 0) throw new Error('Video file cannot be empty');
  if (data.byteLength > MAX_FEED_VIDEO_SIZE_BYTES) {
    throw new Error(`Video file exceeds maximum size of ${MAX_FEED_VIDEO_SIZE_BYTES / (1024 * 1024)}MB`);
  }
  const key = `${FEED_VIDEO_PREFIX}${crypto.randomUUID()}.${ext}`;
  await r2.put(key, data, {
    httpMetadata: { contentType: normalizedMime },
    customMetadata: { uploaded_by: userId, uploaded_at: Date.now().toString() },
  });
  return { key, url: `/feed/videos/${key}` };
}

function validateVideoKey(video: unknown): string | null {  if (video === undefined || video === null) return null;
  if (typeof video !== 'string') throw new Error('video must be an uploaded feed video key');
  const key = video.trim();
  if (key === '') return null;
  if (!key.startsWith(FEED_VIDEO_PREFIX) || key.includes('..')) {
    throw new Error('video must be an uploaded feed video key (feed-videos/ prefix)');
  }
  return key;
}

function validateImageKeys(images: unknown): string[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error('images must be an array of feed image keys');
  const keys = images.map((k) => String(k));
  if (keys.length > MAX_FEED_IMAGES) throw new Error(`images exceeds maximum of ${MAX_FEED_IMAGES}`);
  for (const key of keys) {
    if (!key.startsWith(FEED_IMAGE_PREFIX) || key.includes('..')) {
      throw new Error('images keys must be uploaded feed keys (feed/ prefix)');
    }
  }
  return keys;
}

function validateSection(section: unknown): string | null {
  if (section === undefined || section === null) return null;
  if (typeof section !== 'string') throw new Error('section must be a string');
  const value = section.trim();
  if (value === '') return null;
  if (!(FEED_SECTIONS as readonly string[]).includes(value)) {
    throw new Error(`section must be one of: ${FEED_SECTIONS.join('|')}`);
  }
  return value;
}

export async function createFeedPost(
  db: D1Database,
  authorId: string,
  input: { content?: string; images?: unknown; section?: unknown; video?: unknown },
  clubId: string | null = null
): Promise<FeedPostRow> {
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (content.length > MAX_FEED_CONTENT_LENGTH) {
    throw new Error(`content is too long (max ${MAX_FEED_CONTENT_LENGTH} characters)`);
  }
  const imageKeys = validateImageKeys(input.images);
  const video = validateVideoKey(input.video);
  if (!content && imageKeys.length === 0 && !video) {
    throw new Error('content, images or video is required');
  }
  const section = validateSection(input.section);
  const post: FeedPostRow = {
    id: crypto.randomUUID(),
    author_id: authorId,
    content,
    images: JSON.stringify(imageKeys),
    like_count: 0,
    is_deleted: 0,
    created_at: Date.now(),
    club_id: clubId,
    section,
    video,
  };
  await db.prepare(
    'INSERT INTO feed_posts (id, author_id, content, images, like_count, is_deleted, created_at, club_id, section, video) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)'
  ).bind(post.id, post.author_id, post.content, post.images, post.created_at, post.club_id, post.section, post.video).run();
  return post;
}

/** 发帖响应的 JSON 形态：与列表接口一致，video 转为可播放的相对 URL。 */
export function feedPostCreatedJson(post: FeedPostRow): Record<string, unknown> {
  return {
    ...post,
    video: post.video ? `/feed/videos/${post.video}` : null,
  };
}

export interface FeedRecentLiker {
  wallet_address: string;
  nickname: string | null;
  avatar_url: string | null;
}

export interface FeedPostItem {
  id: string;
  author: {
    wallet_address: string;
    nickname: string | null;
    avatar_url: string | null;
    /** 作者在 post 所属 club 中的角色（owner/admin/member）；全局帖或非成员为 null */
    role: string | null;
  };
  content: string;
  images: string[];
  like_count: number;
  is_liked: boolean;
  is_mine: boolean;
  /** 最近点赞者头像栈（feed_likes.created_at DESC 前 8 个，JOIN users 同 author 解析） */
  recent_likers: FeedRecentLiker[];
  created_at: number;
  /** 所属 club；全局帖为 null */
  club_id: string | null;
  /** 目标板块；旧帖为 null（按派生规则归入各 Tab） */
  section: string | null;
  /** 视频附件播放地址（/feed/videos/<key>）；无视频为 null */
  video: string | null;
}

/** 游标 "<created_at>_<id>"；与 searchPublicClubs 同一分隔约定（id 为 UUID 无下划线）。 */
function parseFeedCursor(cursor: string): { ts: number; id: string } | null {
  const idx = cursor.indexOf('_');
  if (idx <= 0) return null;
  const ts = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(ts) || ts < 0 || !id) return null;
  return { ts, id };
}

type FeedAuthorJoin = {
  wallet_address: string | null;
  public_metadata: string | null;
  avatar_key: string | null;
  member_role: string | null;
};

function toFeedItem(
  row: FeedPostRow & FeedAuthorJoin,
  viewerId: string,
  isLiked: boolean,
  recentLikers: FeedRecentLiker[] = []
): FeedPostItem {
  const publicMetadata = parseJsonSafe(row.public_metadata);
  const wallet = row.wallet_address ?? row.author_id;
  return {
    id: row.id,
    author: {
      wallet_address: wallet,
      nickname: typeof publicMetadata.nickname === 'string' ? publicMetadata.nickname : null,
      avatar_url: row.avatar_key ? `/users/${encodeURIComponent(wallet)}/avatar` : null,
      role: row.member_role ?? null,
    },
    content: row.content,
    images: parseImageKeys(row.images).map((key) => `/feed/images/${key}`),
    like_count: row.like_count,
    is_liked: isLiked,
    is_mine: row.author_id === viewerId,
    recent_likers: recentLikers,
    created_at: row.created_at,
    club_id: row.club_id ?? null,
    section: row.section ?? null,
    video: row.video ? `/feed/videos/${row.video}` : null,
  };
}

/**
 * 批量取每个 post 最近 RECENT_LIKERS_LIMIT 个点赞者（feed_likes.created_at DESC）。
 * 单条窗口函数查询（ROW_NUMBER PARTITION BY post_id），整页 ≤50 帖只发一次 SQL，避免 N+1。
 */
async function listRecentLikers(db: D1Database, postIds: string[]): Promise<Map<string, FeedRecentLiker[]>> {
  const map = new Map<string, FeedRecentLiker[]>();
  if (postIds.length === 0) return map;
  const placeholders = postIds.map(() => '?').join(', ');
  const res = await db.prepare(`
    SELECT post_id, user_id, wallet_address, public_metadata, avatar_key FROM (
      SELECT fl.post_id, fl.user_id, u.wallet_address, u.public_metadata, u.avatar_key,
        ROW_NUMBER() OVER (PARTITION BY fl.post_id ORDER BY fl.created_at DESC, fl.id DESC) AS rn
      FROM feed_likes fl
      JOIN users u ON u.id = fl.user_id
      WHERE fl.post_id IN (${placeholders})
    ) WHERE rn <= ?
    ORDER BY post_id, rn
  `).bind(...postIds, RECENT_LIKERS_LIMIT).all<{
    post_id: string;
    user_id: string;
    wallet_address: string | null;
    public_metadata: string | null;
    avatar_key: string | null;
  }>();
  for (const row of res.results) {
    const wallet = row.wallet_address ?? row.user_id;
    const publicMetadata = parseJsonSafe(row.public_metadata);
    const list = map.get(row.post_id) ?? [];
    list.push({
      wallet_address: wallet,
      nickname: typeof publicMetadata.nickname === 'string' ? publicMetadata.nickname : null,
      avatar_url: row.avatar_key ? `/users/${encodeURIComponent(wallet)}/avatar` : null,
    });
    map.set(row.post_id, list);
  }
  return map;
}

/** 全局流：仅存量全局帖（club_id IS NULL）；club 私有帖走 listClubFeed。 */
export async function listFeed(
  db: D1Database,
  viewerId: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<{ posts: FeedPostItem[]; next_cursor: string | null; has_more: boolean }> {
  const limit = Math.min(Math.max(Math.floor(Number(options.limit)) || 20, 1), 50);
  const cursor = options.cursor ? parseFeedCursor(options.cursor) : null;
  if (options.cursor && !cursor) throw new Error('Invalid cursor');

  const cursorClause = cursor ? 'AND (p.created_at, p.id) < (?, ?)' : '';
  const params: unknown[] = [viewerId];
  if (cursor) params.push(cursor.ts, cursor.id);
  params.push(limit + 1);

  const res = await db.prepare(`
    SELECT p.*, u.wallet_address, u.public_metadata, u.avatar_key, NULL AS member_role,
      EXISTS(SELECT 1 FROM feed_likes fl WHERE fl.post_id = p.id AND fl.user_id = ?) AS liked
    FROM feed_posts p
    LEFT JOIN users u ON u.id = p.author_id
    WHERE p.is_deleted = 0 AND p.club_id IS NULL
      ${cursorClause}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?
  `).bind(...params).all<FeedPostRow & FeedAuthorJoin & { liked: number }>();

  const rows = res.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const likers = await listRecentLikers(db, page.map((row) => row.id));
  const posts = page.map((row) => toFeedItem(row, viewerId, Boolean(row.liked), likers.get(row.id) ?? []));
  const last = page.length > 0 ? page[page.length - 1] : null;
  return {
    posts,
    next_cursor: hasMore && last ? `${last.created_at}_${last.id}` : null,
    has_more: hasMore,
  };
}

export type ClubFeedFilter = 'all' | 'featured' | 'admins' | 'media' | 'files';

/**
 * club 私有动态：club_id=:clubId 且未软删，(created_at,id) 游标 DESC。
 * 板块过滤（migration 0021）：作者发帖时选择的 section 优先命中对应 Tab；
 * 旧帖（section IS NULL）回落原派生规则——
 * featured=归入精选（发帖指定板块前的旧帖原行为就是全部出现在精选，
 * 避免修复后老动态消失），admins=作者当前 role∈owner/admin，
 * media=images/video 非空，files 无旧帖可归。
 * author.role 取作者在 club 的当前角色（非成员 null）。
 */
export async function listClubFeed(
  db: D1Database,
  viewerId: string,
  clubId: string,
  options: { cursor?: string; limit?: number; filter?: ClubFeedFilter } = {}
): Promise<{ posts: FeedPostItem[]; next_cursor: string | null; has_more: boolean }> {
  const limit = Math.min(Math.max(Math.floor(Number(options.limit)) || 20, 1), 50);
  const cursor = options.cursor ? parseFeedCursor(options.cursor) : null;
  if (options.cursor && !cursor) throw new Error('Invalid cursor');
  const filter = options.filter ?? 'all';

  let filterClause = '';
  if (filter === 'featured') {
    filterClause = "AND (p.section = 'featured' OR p.section IS NULL)";
  } else if (filter === 'admins') {
    filterClause = "AND (p.section = 'admins' OR (p.section IS NULL AND cm.role IN ('owner','admin')))";
  } else if (filter === 'media') {
    filterClause = "AND (p.section = 'media' OR (p.section IS NULL AND (p.images != '[]' OR p.video IS NOT NULL)))";
  } else if (filter === 'files') {
    filterClause = "AND p.section = 'files'";
  }
  const cursorClause = cursor ? 'AND (p.created_at, p.id) < (?, ?)' : '';
  const params: unknown[] = [viewerId, clubId];
  if (cursor) params.push(cursor.ts, cursor.id);
  params.push(limit + 1);

  const res = await db.prepare(`
    SELECT p.*, u.wallet_address, u.public_metadata, u.avatar_key, cm.role AS member_role,
      EXISTS(SELECT 1 FROM feed_likes fl WHERE fl.post_id = p.id AND fl.user_id = ?) AS liked
    FROM feed_posts p
    LEFT JOIN users u ON u.id = p.author_id
    LEFT JOIN conversation_members cm ON cm.conversation_id = p.club_id AND cm.user_id = p.author_id
    WHERE p.is_deleted = 0 AND p.club_id = ?
      ${filterClause}
      ${cursorClause}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?
  `).bind(...params).all<FeedPostRow & FeedAuthorJoin & { liked: number }>();

  const rows = res.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const likers = await listRecentLikers(db, page.map((row) => row.id));
  const posts = page.map((row) => toFeedItem(row, viewerId, Boolean(row.liked), likers.get(row.id) ?? []));
  const last = page.length > 0 ? page[page.length - 1] : null;
  return {
    posts,
    next_cursor: hasMore && last ? `${last.created_at}_${last.id}` : null,
    has_more: hasMore,
  };
}

async function getActivePost(db: D1Database, postId: string): Promise<FeedPostRow | null> {
  return db.prepare('SELECT * FROM feed_posts WHERE id = ? AND is_deleted = 0').bind(postId).first<FeedPostRow>();
}

/** 幂等点赞：仅真实插入 feed_likes 才 like_count+1。post 不存在/已删返回 null。 */
export async function likeFeedPost(
  db: D1Database,
  userId: string,
  postId: string
): Promise<{ liked: boolean; like_count: number } | null> {
  if (!(await getActivePost(db, postId))) return null;
  const inserted = await db.prepare(
    'INSERT OR IGNORE INTO feed_likes (id, post_id, user_id, created_at) VALUES (?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), postId, userId, Date.now()).run();
  if ((inserted.meta.changes ?? 0) > 0) {
    await db.prepare('UPDATE feed_posts SET like_count = like_count + 1 WHERE id = ?').bind(postId).run();
  }
  const post = (await db.prepare('SELECT like_count FROM feed_posts WHERE id = ?').bind(postId).first<{ like_count: number }>())!;
  return { liked: true, like_count: post.like_count };
}

/** 幂等取消点赞：仅真实删除 feed_likes 才 like_count-1。post 不存在/已删返回 null。 */
export async function unlikeFeedPost(
  db: D1Database,
  userId: string,
  postId: string
): Promise<{ liked: boolean; like_count: number } | null> {
  if (!(await getActivePost(db, postId))) return null;
  const deleted = await db.prepare('DELETE FROM feed_likes WHERE post_id = ? AND user_id = ?')
    .bind(postId, userId).run();
  if ((deleted.meta.changes ?? 0) > 0) {
    await db.prepare('UPDATE feed_posts SET like_count = MAX(like_count - 1, 0) WHERE id = ?').bind(postId).run();
  }
  const post = (await db.prepare('SELECT like_count FROM feed_posts WHERE id = ?').bind(postId).first<{ like_count: number }>())!;
  return { liked: false, like_count: post.like_count };
}

/** 帖管理权限：作者本人，或 club 帖（club_id 非空）所属 club 的 owner/admin。 */
async function canManagePost(db: D1Database, userId: string, post: FeedPostRow): Promise<boolean> {
  if (post.author_id === userId) return true;
  if (!post.club_id) return false;
  const member = await db.prepare(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(post.club_id, userId).first<{ role: string }>();
  return member?.role === 'owner' || member?.role === 'admin';
}

/** 软删（is_deleted=1）。作者或 club owner/admin 可删；forbidden 按全局帖/club 帖区分。 */
export async function deleteFeedPost(
  db: D1Database,
  userId: string,
  postId: string
): Promise<'deleted' | 'not_found' | 'forbidden_global' | 'forbidden_club'> {
  const post = await getActivePost(db, postId);
  if (!post) return 'not_found';
  if (!(await canManagePost(db, userId, post))) {
    return post.club_id ? 'forbidden_club' : 'forbidden_global';
  }
  await db.prepare('UPDATE feed_posts SET is_deleted = 1 WHERE id = ?').bind(postId).run();
  return 'deleted';
}

/**
 * 编辑入参合并校验：content/images 均为可选部分更新（images 为全量替换数组）。
 * 合并后 content 与 images 不能同时为空（同发帖约束）；不触碰 like_count/created_at。
 */
function applyPostEdit(
  post: FeedPostRow,
  input: { content?: unknown; images?: unknown }
): { content: string; images: string } {
  const hasContent = input.content !== undefined;
  const hasImages = input.images !== undefined;
  if (!hasContent && !hasImages) throw new Error('nothing to update: provide content and/or images');
  let content = post.content;
  if (hasContent) {
    if (typeof input.content !== 'string') throw new Error('content must be a string');
    content = input.content.trim();
    if (content.length > MAX_FEED_CONTENT_LENGTH) {
      throw new Error(`content is too long (max ${MAX_FEED_CONTENT_LENGTH} characters)`);
    }
  }
  let imageKeys = parseImageKeys(post.images);
  if (hasImages) imageKeys = validateImageKeys(input.images);
  if (!content && imageKeys.length === 0) throw new Error('content or images is required');
  return { content, images: JSON.stringify(imageKeys) };
}

export type UpdateFeedPostResult =
  | { status: 'updated'; post: FeedPostRow }
  | { status: 'not_found' }
  | { status: 'forbidden'; scope: 'global' | 'club' };

/** 编辑帖（部分更新）。权限同删除：作者或 club owner/admin。 */
export async function updateFeedPost(
  db: D1Database,
  userId: string,
  postId: string,
  input: { content?: unknown; images?: unknown }
): Promise<UpdateFeedPostResult> {
  const post = await getActivePost(db, postId);
  if (!post) return { status: 'not_found' };
  if (!(await canManagePost(db, userId, post))) {
    return { status: 'forbidden', scope: post.club_id ? 'club' : 'global' };
  }
  const merged = applyPostEdit(post, input);
  await db.prepare('UPDATE feed_posts SET content = ?, images = ? WHERE id = ?')
    .bind(merged.content, merged.images, postId).run();
  return { status: 'updated', post: { ...post, content: merged.content, images: merged.images } };
}

// ---------------------------------------------------------------------------
// 管理端（internalAdmin）
// ---------------------------------------------------------------------------

export interface AdminFeedPostItem extends FeedPostItem {
  author_id: string;
  is_deleted: boolean;
}

/** 管理端列表（含软删），offset/limit 分页；club_id 可选过滤（'global' = 仅全局帖）。 */
export async function listFeedAdmin(
  db: D1Database,
  options: { offset?: number; limit?: number; club_id?: string } = {}
): Promise<{ list: AdminFeedPostItem[]; total: number; offset: number; limit: number }> {
  const limit = Math.min(Math.max(Math.floor(Number(options.limit)) || 20, 1), 100);
  const offset = Math.max(Math.floor(Number(options.offset)) || 0, 0);
  let whereClause = '';
  const params: unknown[] = [];
  if (options.club_id === 'global') {
    whereClause = 'WHERE p.club_id IS NULL';
  } else if (options.club_id) {
    whereClause = 'WHERE p.club_id = ?';
    params.push(options.club_id);
  }
  const total =
    (await db.prepare(`SELECT COUNT(*) AS n FROM feed_posts p ${whereClause}`).bind(...params).first<{ n: number }>())?.n ?? 0;
  const res = await db.prepare(`
    SELECT p.*, u.wallet_address, u.public_metadata, u.avatar_key, NULL AS member_role
    FROM feed_posts p
    LEFT JOIN users u ON u.id = p.author_id
    ${whereClause}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all<FeedPostRow & FeedAuthorJoin>();
  const list = res.results.map((row) => ({
    ...toFeedItem(row, '', false),
    author_id: row.author_id,
    is_deleted: row.is_deleted === 1,
  }));
  return { list, total: Number(total), offset, limit };
}

/** 管理端软删（不校验作者）；成功 true，不存在/已删 false。 */
export async function deleteFeedPostAdmin(db: D1Database, postId: string): Promise<boolean> {
  const post = await getActivePost(db, postId);
  if (!post) return false;
  await db.prepare('UPDATE feed_posts SET is_deleted = 1 WHERE id = ?').bind(postId).run();
  return true;
}

/** 管理端编辑（不校验作者/权限，部分更新）；成功返回更新后 post，不存在/已删 null。 */
export async function updateFeedPostAdmin(
  db: D1Database,
  postId: string,
  input: { content?: unknown; images?: unknown }
): Promise<FeedPostRow | null> {
  const post = await getActivePost(db, postId);
  if (!post) return null;
  const merged = applyPostEdit(post, input);
  await db.prepare('UPDATE feed_posts SET content = ?, images = ? WHERE id = ?')
    .bind(merged.content, merged.images, postId).run();
  return { ...post, content: merged.content, images: merged.images };
}
