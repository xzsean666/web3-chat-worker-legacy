// Public static sticker (telemoji animated WebP) hosting from R2.
// No auth required: content is public, immutable, and cacheable forever.

import { Hono } from 'hono';
import type { AppEnv } from '../types';

const stickerRoutes = new Hono<AppEnv>();

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.json': 'application/json',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

stickerRoutes.get('/*', async (c) => {
  const path = c.req.path.replace(/^\/stickers\/?/, '');

  if (!path || path.includes('..')) {
    return c.json({ error: 'NOT_FOUND' }, 404);
  }

  const object = await c.env.VOICE_BUCKET.get(`stickers/${path}`);
  if (!object) {
    return c.json({ error: 'NOT_FOUND' }, 404);
  }

  return new Response(object.body as any, {
    status: 200,
    headers: {
      'Content-Type': contentTypeFor(path),
      'Content-Length': object.size.toString(),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

export { stickerRoutes };
