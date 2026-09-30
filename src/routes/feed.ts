// 动态 feed 路由：图片上传/公开读取、发帖、游标分页、点赞（幂等）、软删与编辑。
// 删帖/编辑权限：作者本人，或 club 帖所属 club 的 owner/admin（403 错误码按全局帖/club 帖区分）。
// GET /feed/images/<key> 公开无 auth（同 stickers 模式，Cache-Control immutable）。

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  createFeedPost,
  feedPostCreatedJson,
  deleteFeedPost,
  likeFeedPost,
  listFeed,
  unlikeFeedPost,
  updateFeedPost,
  uploadFeedImage,
  uploadFeedVideo,
  FEED_IMAGE_PREFIX,
  FEED_VIDEO_PREFIX,
} from '../services/feed';

const feedRoutes = new Hono<AppEnv>();

// POST /feed/images — multipart 单文件上传（png/jpeg/webp，≤10MB）
feedRoutes.post('/images', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.parseBody();
    const file = body['file'] || body['image'];
    if (!file || typeof file === 'string') {
      return c.json({ error: 'Image file is required in form-data (key "file" or "image")' }, 400);
    }
    const fileObj = file as File;
    const data = new Uint8Array(await fileObj.arrayBuffer());
    const result = await uploadFeedImage(c.env.VOICE_BUCKET, user.id, data, fileObj.type || 'image/png');
    return c.json(result, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /feed/images/<key> — 公开读（key 含 feed/ 前缀，故路径为 /feed/images/feed/xxx.png）
feedRoutes.get('/images/*', async (c) => {
  const key = c.req.path.replace(/^\/feed\/images\//, '');
  if (!key.startsWith(FEED_IMAGE_PREFIX) || key.includes('..')) {
    return c.json({ error: 'NOT_FOUND' }, 404);
  }
  const object = await c.env.VOICE_BUCKET.get(key);
  if (!object) return c.json({ error: 'NOT_FOUND' }, 404);
  const dot = key.lastIndexOf('.');
  const ext = dot >= 0 ? key.slice(dot + 1).toLowerCase() : '';
  const contentType =
    ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return new Response(object.body as any, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': object.size.toString(),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

// POST /feed/videos — multipart 单文件上传（mp4/m4v/mov/webm，≤50MB）
feedRoutes.post('/videos', authMiddleware, async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.parseBody();
    const file = body['file'] || body['video'];
    if (!file || typeof file === 'string') {
      return c.json({ error: 'Video file is required in form-data (key "file" or "video")' }, 400);
    }
    const fileObj = file as File;
    const data = new Uint8Array(await fileObj.arrayBuffer());
    const result = await uploadFeedVideo(c.env.VOICE_BUCKET, user.id, data, fileObj.type || 'video/mp4');
    return c.json(result, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /feed/videos/<key> — 公开读（key 含 feed-videos/ 前缀）
// GET /feed/videos/<key> — 公开读（key 含 feed-videos/ 前缀）。
// 必须真正支持 Range/206：ExoPlayer/video_player 网络播放按段拉流，
// 忽略 Range 返回 200 全量会让播放器按错位字节流解码（绿紫花屏）。
feedRoutes.get('/videos/*', async (c) => {
  const key = c.req.path.replace(/^\/feed\/videos\//, '');
  if (!key.startsWith(FEED_VIDEO_PREFIX) || key.includes('..')) {
    return c.json({ error: 'NOT_FOUND' }, 404);
  }
  const dot = key.lastIndexOf('.');
  const ext = dot >= 0 ? key.slice(dot + 1).toLowerCase() : '';
  const contentType =
    ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };

  const rangeHeader = c.req.header('Range');
  const range = rangeHeader
    ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    : null;
  if (range && (range[1] !== '' || range[2] !== '')) {
    const head = await c.env.VOICE_BUCKET.head(key);
    if (!head) return c.json({ error: 'NOT_FOUND' }, 404);
    const total = head.size;
    let start: number;
    let end: number;
    if (range[1] === '') {
      const suffix = Math.min(Number(range[2]), total);
      start = total - suffix;
      end = total - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` },
      });
    }
    const object = await c.env.VOICE_BUCKET.get(key, {
      range: { offset: start, length: end - start + 1 },
    });
    if (!object) return c.json({ error: 'NOT_FOUND' }, 404);
    return new Response(object.body as any, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${total}`,
      },
    });
  }

  const object = await c.env.VOICE_BUCKET.get(key);
  if (!object) return c.json({ error: 'NOT_FOUND' }, 404);
  return new Response(object.body as any, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Length': object.size.toString(),
    },
  });
});

// 以下均需登录
feedRoutes.use('/posts', authMiddleware);
feedRoutes.use('/posts/*', authMiddleware);
feedRoutes.use('/', authMiddleware);

// POST /feed/posts {content(≤2000), images:[feed/ key, ...](≤9)} → {post}
feedRoutes.post('/posts', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; images?: unknown };
    const post = await createFeedPost(c.env.DB, user.id, body);
    return c.json({ post: feedPostCreatedJson(post) }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// GET /feed?cursor=&limit=（默认 20，上限 50）→ {posts, next_cursor, has_more}
feedRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const limitParam = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;
    const result = await listFeed(c.env.DB, user.id, { cursor: c.req.query('cursor'), limit });
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Invalid cursor')) return c.json({ error: 'INVALID_CURSOR' }, 400);
    return c.json({ error: message }, 400);
  }
});

// POST /feed/posts/:id/like — 幂等点赞 → {liked:true, like_count}
feedRoutes.post('/posts/:id/like', async (c) => {
  const user = c.get('user');
  const result = await likeFeedPost(c.env.DB, user.id, c.req.param('id'));
  if (!result) return c.json({ error: 'POST_NOT_FOUND' }, 404);
  return c.json(result);
});

// DELETE /feed/posts/:id/like — 幂等取消点赞 → {liked:false, like_count}
feedRoutes.delete('/posts/:id/like', async (c) => {
  const user = c.get('user');
  const result = await unlikeFeedPost(c.env.DB, user.id, c.req.param('id'));
  if (!result) return c.json({ error: 'POST_NOT_FOUND' }, 404);
  return c.json(result);
});

// PATCH /feed/posts/:id {content?, images?} — 部分更新（images 全量替换）；作者或 club owner/admin
feedRoutes.patch('/posts/:id', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { content?: unknown; images?: unknown };
    const result = await updateFeedPost(c.env.DB, user.id, c.req.param('id'), body);
    if (result.status === 'not_found') return c.json({ error: 'POST_NOT_FOUND' }, 404);
    if (result.status === 'forbidden') {
      return result.scope === 'club'
        ? c.json({ error: 'NOT_AUTHOR_OR_CLUB_ADMIN' }, 403)
        : c.json({ error: 'FORBIDDEN' }, 403);
    }
    return c.json({ post: result.post });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// DELETE /feed/posts/:id — 作者本人或该帖所属 club 的 owner/admin 软删
feedRoutes.delete('/posts/:id', async (c) => {
  const user = c.get('user');
  const result = await deleteFeedPost(c.env.DB, user.id, c.req.param('id'));
  if (result === 'not_found') return c.json({ error: 'POST_NOT_FOUND' }, 404);
  if (result === 'forbidden_club') return c.json({ error: 'NOT_AUTHOR_OR_CLUB_ADMIN' }, 403);
  if (result === 'forbidden_global') return c.json({ error: 'FORBIDDEN' }, 403);
  return c.json({ ok: true });
});

export { feedRoutes };
