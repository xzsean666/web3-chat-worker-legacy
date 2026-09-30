// Feed（动态）：图片上传/公开读取、发帖校验、游标分页、点赞幂等、作者软删、管理端列表/软删。

import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

const SECRET = 'test-internal-secret';

let db: D1Database;
let bucket: MockR2Bucket;
let env: Env;
let alice: TestWallet;
let bob: TestWallet;
let aliceToken: string;
let bobToken: string;

async function login(wallet: TestWallet): Promise<string> {
  const nonceRes = await app.request('/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address }),
  }, env);
  const { message } = (await nonceRes.json()) as { message: string };
  const verifyRes = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address, signature: await wallet.signMessage(message) }),
  }, env);
  return ((await verifyRes.json()) as { token: string }).token;
}

function authed(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function uploadImage(token: string, bytes: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime = 'image/png') {
  const formData = new FormData();
  formData.append('file', new Blob([bytes], { type: mime }), 'p.png');
  return app.request('/feed/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  }, env);
}

async function createPost(token: string, body: Record<string, unknown>) {
  return app.request('/feed/posts', {
    method: 'POST', headers: authed(token), body: JSON.stringify(body),
  }, env);
}

function sign(method: string, path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const message = `${ts}\n${nonce}\n${method}\n${path}\n${bodyHash}`;
  return {
    'X-Internal-Timestamp': ts,
    'X-Internal-Nonce': nonce,
    'X-Internal-Signature': createHmac('sha256', SECRET).update(message).digest('hex'),
  };
}

async function adminCall(method: string, path: string, body?: unknown): Promise<Response> {
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = sign(method, path.split('?')[0], bodyStr);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, { method, headers, body: body === undefined ? undefined : bodyStr }, env);
}

beforeEach(async () => {
  db = createMockD1Database(true);
  bucket = createMockR2Bucket() as MockR2Bucket;
  env = { DB: db, VOICE_BUCKET: bucket, INTERNAL_ADMIN_SECRET: SECRET };
  alice = createTestWallet();
  bob = createTestWallet();
  aliceToken = await login(alice);
  bobToken = await login(bob);
});

describe('feed images', () => {
  it('uploads multipart image to R2 feed/ prefix; public read with immutable cache', async () => {
    const up = await uploadImage(aliceToken);
    expect(up.status).toBe(201);
    const { key, url } = (await up.json()) as any;
    expect(key).toMatch(/^feed\/.+\.png$/);
    expect(url).toBe(`/feed/images/${key}`);
    expect(bucket.hasKey(key)).toBe(true);

    // 公开读：无 auth 也可访问
    const get = await app.request(url, {}, env);
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/png');
    expect(get.headers.get('Cache-Control')).toContain('immutable');
    expect(await get.text()).toBe(new TextDecoder().decode(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));

    const missing = await app.request('/feed/images/feed/no-such.png', {}, env);
    expect(missing.status).toBe(404);
    const traversal = await app.request('/feed/images/feed/..%2Fsecret.png', {}, env);
    expect(traversal.status).toBe(404);
  });

  it('rejects unsupported mime and oversize', async () => {
    const badMime = await uploadImage(aliceToken, new Uint8Array([1, 2, 3]), 'image/gif');
    expect(badMime.status).toBe(400);

    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const oversize = await uploadImage(aliceToken, big);
    expect(oversize.status).toBe(400);

    const noFile = await app.request('/feed/images', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: new FormData(),
    }, env);
    expect(noFile.status).toBe(400);
  });
});

describe('feed posts', () => {
  it('creates post with content + image keys; validates inputs', async () => {
    const up = await uploadImage(aliceToken);
    const { key } = (await up.json()) as any;

    const created = await createPost(aliceToken, { content: 'hello feed', images: [key] });
    expect(created.status).toBe(201);
    const { post } = (await created.json()) as any;
    expect(post.content).toBe('hello feed');
    expect(post.author_id).toBe(alice.address.toLowerCase());
    expect(JSON.parse(post.images)).toEqual([key]);

    // 空内容且无图 → 400
    expect((await createPost(aliceToken, {})).status).toBe(400);
    // 超长内容 → 400
    expect((await createPost(aliceToken, { content: 'x'.repeat(2001) })).status).toBe(400);
    // 超过 9 图 → 400
    expect((await createPost(aliceToken, { images: Array(10).fill(key) })).status).toBe(400);
    // 非 feed/ 前缀 key → 400
    expect((await createPost(aliceToken, { images: ['images/abc.png'] })).status).toBe(400);
  });

  it('lists posts newest-first with author info, is_mine, pagination', async () => {
    const p1 = (await (await createPost(aliceToken, { content: 'first' })).json()) as any;
    const p2 = (await (await createPost(bobToken, { content: 'second' })).json()) as any;
    const p3 = (await (await createPost(aliceToken, { content: 'third' })).json()) as any;
    // 固定 created_at 保证排序确定
    await db.prepare('UPDATE feed_posts SET created_at = 1000 WHERE id = ?').bind(p1.post.id).run();
    await db.prepare('UPDATE feed_posts SET created_at = 3000 WHERE id = ?').bind(p2.post.id).run();
    await db.prepare('UPDATE feed_posts SET created_at = 2000 WHERE id = ?').bind(p3.post.id).run();

    const page1 = await app.request('/feed?limit=2', { headers: authed(aliceToken) }, env);
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as any;
    expect(body1.posts.map((p: any) => p.id)).toEqual([p2.post.id, p3.post.id]);
    expect(body1.has_more).toBe(true);
    expect(body1.posts[0].author.wallet_address).toBe(bob.address.toLowerCase());
    expect(body1.posts[0].is_mine).toBe(false);
    expect(body1.posts[0].is_liked).toBe(false);
    expect(body1.posts[1].is_mine).toBe(true);

    const page2 = await app.request(`/feed?limit=2&cursor=${encodeURIComponent(body1.next_cursor)}`, {
      headers: authed(aliceToken),
    }, env);
    const body2 = (await page2.json()) as any;
    expect(body2.posts.map((p: any) => p.id)).toEqual([p1.post.id]);
    expect(body2.has_more).toBe(false);
    expect(body2.next_cursor).toBeNull();

    const badCursor = await app.request('/feed?cursor=xx', { headers: authed(aliceToken) }, env);
    expect(badCursor.status).toBe(400);

    const noAuth = await app.request('/feed', {}, env);
    expect(noAuth.status).toBe(401);
  });

  it('like/unlike are idempotent and only count real transitions', async () => {
    const { post } = (await (await createPost(aliceToken, { content: 'like me' })).json()) as any;

    const like1 = await app.request(`/feed/posts/${post.id}/like`, { method: 'POST', headers: authed(bobToken) }, env);
    expect(((await like1.json()) as any)).toMatchObject({ liked: true, like_count: 1 });
    // 重复点赞不重复计数
    const like2 = await app.request(`/feed/posts/${post.id}/like`, { method: 'POST', headers: authed(bobToken) }, env);
    expect(((await like2.json()) as any).like_count).toBe(1);

    await app.request(`/feed/posts/${post.id}/like`, { method: 'POST', headers: authed(aliceToken) }, env);

    const list = await app.request('/feed', { headers: authed(bobToken) }, env);
    const item = ((await list.json()) as any).posts.find((p: any) => p.id === post.id);
    expect(item.like_count).toBe(2);
    expect(item.is_liked).toBe(true);

    const unlike = await app.request(`/feed/posts/${post.id}/like`, { method: 'DELETE', headers: authed(bobToken) }, env);
    expect(((await unlike.json()) as any)).toMatchObject({ liked: false, like_count: 1 });
    // 重复取消幂等
    const unlike2 = await app.request(`/feed/posts/${post.id}/like`, { method: 'DELETE', headers: authed(bobToken) }, env);
    expect(((await unlike2.json()) as any).like_count).toBe(1);

    const missing = await app.request('/feed/posts/no-such/like', { method: 'POST', headers: authed(bobToken) }, env);
    expect(missing.status).toBe(404);
  });

  it('author soft-deletes own post; others forbidden; deleted posts hidden', async () => {
    const { post } = (await (await createPost(aliceToken, { content: 'bye' })).json()) as any;

    const forbidden = await app.request(`/feed/posts/${post.id}`, { method: 'DELETE', headers: authed(bobToken) }, env);
    expect(forbidden.status).toBe(403);

    const del = await app.request(`/feed/posts/${post.id}`, { method: 'DELETE', headers: authed(aliceToken) }, env);
    expect(del.status).toBe(200);

    const list = await app.request('/feed', { headers: authed(aliceToken) }, env);
    expect(((await list.json()) as any).posts.map((p: any) => p.id)).not.toContain(post.id);

    const again = await app.request(`/feed/posts/${post.id}`, { method: 'DELETE', headers: authed(aliceToken) }, env);
    expect(again.status).toBe(404);
    // 已删帖子不可点赞
    const like = await app.request(`/feed/posts/${post.id}/like`, { method: 'POST', headers: authed(bobToken) }, env);
    expect(like.status).toBe(404);
  });
});

describe('feed admin', () => {
  it('lists posts with author info (incl. soft-deleted) and soft-deletes with audit', async () => {
    const { post } = (await (await createPost(aliceToken, { content: 'moderate me' })).json()) as any;
    const { post: post2 } = (await (await createPost(bobToken, { content: 'keep me' })).json()) as any;

    const list = await adminCall('GET', '/internal/admin/feed/posts');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as any;
    expect(listBody.total).toBe(2);
    const item = listBody.list.find((p: any) => p.id === post.id);
    expect(item.author_id).toBe(alice.address.toLowerCase());
    expect(item.author.wallet_address).toBe(alice.address.toLowerCase());
    expect(item.is_deleted).toBe(false);

    const del = await adminCall('DELETE', `/internal/admin/feed/posts/${post.id}`, { actor: 'admin1' });
    expect(del.status).toBe(200);

    const listAfter = await (await adminCall('GET', '/internal/admin/feed/posts')).json() as any;
    expect(listAfter.list.find((p: any) => p.id === post.id).is_deleted).toBe(true);

    // 公开列表只剩 bob 的帖子
    const feed = await (await app.request('/feed', { headers: authed(aliceToken) }, env)).json() as any;
    expect(feed.posts.map((p: any) => p.id)).toEqual([post2.id]);

    const audit = await db.prepare(
      "SELECT action FROM payment_audit_log WHERE action = 'feed_post_delete'"
    ).first<{ action: string }>();
    expect(audit?.action).toBe('feed_post_delete');

    const delAgain = await adminCall('DELETE', `/internal/admin/feed/posts/${post.id}`, {});
    expect(delAgain.status).toBe(404);

    const noAuth = await app.request('/internal/admin/feed/posts', {}, env);
    expect(noAuth.status).toBe(401);
  });
});

describe('feed video (0022)', () => {
  it('upload validation: mp4 ok, wrong mime 400, then create post with video and read it publicly', async () => {
    const upload = await app.request('/feed/videos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: (() => {
        const fd = new FormData();
        fd.append('file', new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x18])], { type: 'video/mp4' }), 'v.mp4');
        return fd;
      })(),
    }, env);
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as any;
    expect(uploaded.key.startsWith('feed-videos/')).toBe(true);
    expect(uploaded.url).toBe(`/feed/videos/${uploaded.key}`);

    const badMime = await app.request('/feed/videos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: (() => {
        const fd = new FormData();
        fd.append('file', new Blob([new Uint8Array([0x89])], { type: 'image/png' }), 'p.png');
        return fd;
      })(),
    }, env);
    expect(badMime.status).toBe(400);

    // 视频帖：无正文无图片也合法
    const created = await createPost(aliceToken, { video: uploaded.key });
    expect(created.status).toBe(201);
    const post = ((await created.json()) as any).post;
    expect(post.video).toBe(`/feed/videos/${uploaded.key}`);

    // 非法 key（图片前缀/越界）拒绝
    const badKey = await createPost(aliceToken, { video: 'feed/abc.png' });
    expect(badKey.status).toBe(400);
    const traversal = await createPost(aliceToken, { video: 'feed-videos/../secret' });
    expect(traversal.status).toBe(400);

    // 公开读取：200 + video/mp4 + 无 auth
    const pub = await app.request(`/feed/videos/${uploaded.key}`, {}, env);
    expect(pub.status).toBe(200);
    expect(pub.headers.get('Content-Type')).toBe('video/mp4');
    const missing = await app.request('/feed/videos/feed-videos/no-such.mp4', {}, env);
    expect(missing.status).toBe(404);
  });

  it('global feed list carries video field; legacy posts have null', async () => {
    const upload = await app.request('/feed/videos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: (() => {
        const fd = new FormData();
        fd.append('file', new Blob([new Uint8Array([0x00])], { type: 'video/webm' }), 'v.webm');
        return fd;
      })(),
    }, env);
    const uploaded = (await upload.json()) as any;
    await createPost(aliceToken, { video: uploaded.key });
    await createPost(aliceToken, { content: 'text only' });

    const feed = await (await app.request('/feed', { headers: authed(aliceToken) }, env)).json() as any;
    const withVideo = feed.posts.find((p: any) => p.video != null);
    expect(withVideo.video).toBe(`/feed/videos/${uploaded.key}`);
    const withoutVideo = feed.posts.find((p: any) => p.content === 'text only');
    expect(withoutVideo.video).toBeNull();
  });
});

describe('feed video Range support', () => {
  it('GET /feed/videos/<key> honors Range with 206, suffix ranges, and 416', async () => {
    const bytes = new Uint8Array(2000).map((_, i) => i % 256);
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'video/mp4' }), 'v.mp4');
    const upload = await app.request('/feed/videos', {
      method: 'POST', headers: { Authorization: `Bearer ${aliceToken}` }, body: fd,
    }, env);
    const { key } = (await upload.json()) as any;

    const part = await app.request(`/feed/videos/${key}`, { headers: { Range: 'bytes=0-99' } }, env);
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 0-99/2000');
    const partBuf = new Uint8Array(await part.arrayBuffer());
    expect(partBuf.length).toBe(100);
    expect(partBuf[99]).toBe(99 % 256);

    const suffix = await app.request(`/feed/videos/${key}`, { headers: { Range: 'bytes=-50' } }, env);
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('Content-Range')).toBe('bytes 1950-1999/2000');

    const full = await app.request(`/feed/videos/${key}`, {}, env);
    expect(full.status).toBe(200);
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');

    const oob = await app.request(`/feed/videos/${key}`, { headers: { Range: 'bytes=9999-10000' } }, env);
    expect(oob.status).toBe(416);
  });
});
