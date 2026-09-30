// Feed 管理权限与编辑：club owner/admin 可删/可编他人帖（403 文案区分）、
// 部分更新语义（images 全量替换）、recent_likers 头像栈（DESC 前 8）、internalAdmin 编辑（审计）。

import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { insertClub } from './helpers/club';
import type { Env } from '../src/types';

const SECRET = 'test-internal-secret';

let db: D1Database;
let bucket: MockR2Bucket;
let env: Env;
let alice: TestWallet; // club A owner
let bob: TestWallet;   // club A admin
let carol: TestWallet; // club A 普通成员
let aliceToken: string;
let bobToken: string;
let carolToken: string;
let clubA: { id: string };

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

async function uploadImage(token: string) {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'p.png');
  const res = await app.request('/feed/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  }, env);
  return ((await res.json()) as { key: string }).key;
}

async function createPost(token: string, body: Record<string, unknown>) {
  return app.request('/feed/posts', {
    method: 'POST', headers: authed(token), body: JSON.stringify(body),
  }, env);
}

async function clubPost(token: string, clubId: string, body: Record<string, unknown>) {
  return app.request(`/clubs/${encodeURIComponent(clubId)}/feed/posts`, {
    method: 'POST', headers: authed(token), body: JSON.stringify(body),
  }, env);
}

function patchPost(token: string, postId: string, body: Record<string, unknown>) {
  return app.request(`/feed/posts/${postId}`, {
    method: 'PATCH', headers: authed(token), body: JSON.stringify(body),
  }, env);
}

function deletePost(token: string, postId: string) {
  return app.request(`/feed/posts/${postId}`, { method: 'DELETE', headers: authed(token) }, env);
}

beforeEach(async () => {
  db = createMockD1Database(true);
  bucket = createMockR2Bucket() as MockR2Bucket;
  env = { DB: db, VOICE_BUCKET: bucket, INTERNAL_ADMIN_SECRET: SECRET };
  alice = createTestWallet();
  bob = createTestWallet();
  carol = createTestWallet();
  aliceToken = await login(alice);
  bobToken = await login(bob);
  carolToken = await login(carol);
  clubA = await insertClub(db, {
    ownerId: alice.address, name: 'Club A',
    members: [
      { userId: bob.address, role: 'admin' },
      { userId: carol.address, role: 'member' },
    ],
  });
});

describe('club feed moderation (delete/edit by club owner/admin)', () => {
  it('club admin edits and deletes owner\'s post; member gets 403 NOT_AUTHOR_OR_CLUB_ADMIN', async () => {
    const { post } = (await (await clubPost(aliceToken, clubA.id, { content: '公告' })).json()) as any;
    // 先点一个赞，验证编辑不动 like_count
    await app.request(`/feed/posts/${post.id}/like`, { method: 'POST', headers: authed(carolToken) }, env);

    const edited = await patchPost(bobToken, post.id, { content: 'admin 修订' });
    expect(edited.status).toBe(200);
    const editedPost = ((await edited.json()) as any).post;
    expect(editedPost.content).toBe('admin 修订');
    expect(editedPost.like_count).toBe(1);
    expect(editedPost.created_at).toBe(post.created_at);

    const memberPatch = await patchPost(carolToken, post.id, { content: 'x' });
    expect(memberPatch.status).toBe(403);
    expect(((await memberPatch.json()) as any).error).toBe('NOT_AUTHOR_OR_CLUB_ADMIN');

    const memberDelete = await deletePost(carolToken, post.id);
    expect(memberDelete.status).toBe(403);
    expect(((await memberDelete.json()) as any).error).toBe('NOT_AUTHOR_OR_CLUB_ADMIN');

    expect((await deletePost(bobToken, post.id)).status).toBe(200);
    const feed = (await (await app.request(`/clubs/${clubA.id}/feed`, { headers: authed(aliceToken) }, env)).json()) as any;
    expect(feed.posts.map((p: any) => p.id)).not.toContain(post.id);
  });

  it('club owner can also edit/delete; non-author on global post gets plain FORBIDDEN', async () => {
    // club 帖：owner（非作者场景的镜像——bob 发帖，alice 作为 owner 删）
    const { post: clubPostByAdmin } = (await (await clubPost(bobToken, clubA.id, { content: 'admin 帖' })).json()) as any;
    expect((await patchPost(aliceToken, clubPostByAdmin.id, { content: 'owner 修订' })).status).toBe(200);
    expect((await deletePost(aliceToken, clubPostByAdmin.id)).status).toBe(200);

    // 全局帖：即使是某 club 的 admin，对全局帖也无管理权，403 文案保持 FORBIDDEN
    const { post: globalPost } = (await (await createPost(aliceToken, { content: 'global' })).json()) as any;
    const patchRes = await patchPost(bobToken, globalPost.id, { content: 'x' });
    expect(patchRes.status).toBe(403);
    expect(((await patchRes.json()) as any).error).toBe('FORBIDDEN');
    const delRes = await deletePost(bobToken, globalPost.id);
    expect(delRes.status).toBe(403);
    expect(((await delRes.json()) as any).error).toBe('FORBIDDEN');
  });

  it('author edits own post; partial update keeps untouched fields; validations', async () => {
    const key = await uploadImage(aliceToken);
    const { post } = (await (await createPost(aliceToken, { content: 'orig', images: [key] })).json()) as any;

    // 只给 content：images 不动、created_at 不动
    const edited = await patchPost(aliceToken, post.id, { content: 'edited' });
    expect(edited.status).toBe(200);
    const p1 = ((await edited.json()) as any).post;
    expect(p1.content).toBe('edited');
    expect(JSON.parse(p1.images)).toEqual([key]);
    expect(p1.created_at).toBe(post.created_at);

    // 只给 images：全量替换，content 不动
    const reImaged = await patchPost(aliceToken, post.id, { images: [] });
    const p2 = ((await reImaged.json()) as any).post;
    expect(p2.content).toBe('edited');
    expect(JSON.parse(p2.images)).toEqual([]);

    // 校验：空 body / 超长 / 非 feed 前缀 / 清空后为空帖
    expect((await patchPost(aliceToken, post.id, {})).status).toBe(400);
    expect((await patchPost(aliceToken, post.id, { content: 'x'.repeat(2001) })).status).toBe(400);
    expect((await patchPost(aliceToken, post.id, { images: ['images/abc.png'] })).status).toBe(400);
    expect((await patchPost(aliceToken, post.id, { content: '   ' })).status).toBe(400);

    // 已删帖不可编辑
    expect((await deletePost(aliceToken, post.id)).status).toBe(200);
    expect((await patchPost(aliceToken, post.id, { content: 'x' })).status).toBe(404);
  });
});

describe('recent_likers', () => {
  it('returns newest 8 likers (created_at DESC) with nickname/avatar on /feed and club feed', async () => {
    const { post } = (await (await createPost(aliceToken, { content: 'like me' })).json()) as any;

    // 10 个点赞者
    const likers: { wallet: TestWallet; token: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const wallet = createTestWallet();
      const token = await login(wallet);
      await app.request(`/feed/posts/${post.id}/like`, { method: 'POST', headers: authed(token) }, env);
      likers.push({ wallet, token });
    }
    // 固定点赞时间保证顺序确定（第 i 个点赞者 ts = 1000 + i）
    for (let i = 0; i < likers.length; i++) {
      await db.prepare('UPDATE feed_likes SET created_at = ? WHERE post_id = ? AND user_id = ?')
        .bind(1000 + i, post.id, likers[i].wallet.address).run();
    }
    // 第 9 个（ts 次新）有昵称；第 10 个（ts 最新）有头像
    await db.prepare("UPDATE users SET public_metadata = ? WHERE id = ?")
      .bind(JSON.stringify({ nickname: 'Liker Nine' }), likers[8].wallet.address).run();
    await db.prepare('UPDATE users SET avatar_key = ? WHERE id = ?')
      .bind('avatars/nine.png', likers[9].wallet.address).run();

    const feed = (await (await app.request('/feed', { headers: authed(aliceToken) }, env)).json()) as any;
    const item = feed.posts.find((p: any) => p.id === post.id);
    expect(item.like_count).toBe(10);
    expect(item.recent_likers).toHaveLength(8);
    // 顺序 = created_at DESC 前 8 个（第 10..3 个点赞者）
    expect(item.recent_likers.map((l: any) => l.wallet_address)).toEqual(
      likers.slice(2).reverse().map((l) => l.wallet.address)
    );
    expect(item.recent_likers[0].avatar_url).toBe(`/users/${encodeURIComponent(likers[9].wallet.address)}/avatar`);
    expect(item.recent_likers[0].nickname).toBeNull();
    expect(item.recent_likers[1].nickname).toBe('Liker Nine');
    expect(item.recent_likers[1].avatar_url).toBeNull();
    expect(item.recent_likers[7].wallet_address).toBe(likers[2].wallet.address);

    // club feed 同样带 recent_likers
    const { post: cp } = (await (await clubPost(aliceToken, clubA.id, { content: 'club post' })).json()) as any;
    await app.request(`/feed/posts/${cp.id}/like`, { method: 'POST', headers: authed(bobToken) }, env);
    await app.request(`/feed/posts/${cp.id}/like`, { method: 'POST', headers: authed(carolToken) }, env);
    await db.prepare('UPDATE feed_likes SET created_at = 100 WHERE post_id = ? AND user_id = ?').bind(cp.id, bob.address).run();
    await db.prepare('UPDATE feed_likes SET created_at = 200 WHERE post_id = ? AND user_id = ?').bind(cp.id, carol.address).run();
    const clubFeed = (await (await app.request(`/clubs/${clubA.id}/feed`, { headers: authed(aliceToken) }, env)).json()) as any;
    const clubItem = clubFeed.posts.find((p: any) => p.id === cp.id);
    expect(clubItem.recent_likers.map((l: any) => l.wallet_address)).toEqual([carol.address, bob.address]);
  });
});

describe('internalAdmin feed edit', () => {
  it('PATCH edits post with audit; 404 missing; 400 empty body; 401 unsigned', async () => {
    const key = await uploadImage(aliceToken);
    const { post } = (await (await createPost(aliceToken, { content: 'moderate me', images: [key] })).json()) as any;

    const edited = await adminCall('PATCH', `/internal/admin/feed/posts/${post.id}`, { actor: 'ops', content: 'admin 编辑' });
    expect(edited.status).toBe(200);
    const editedPost = ((await edited.json()) as any).post;
    expect(editedPost.content).toBe('admin 编辑');
    expect(JSON.parse(editedPost.images)).toEqual([key]);

    const audit = await db.prepare(
      "SELECT actor, action, target FROM payment_audit_log WHERE action = 'feed_post_edit'"
    ).first<{ actor: string; action: string; target: string }>();
    expect(audit).toMatchObject({ actor: 'ops', action: 'feed_post_edit', target: post.id });

    expect((await adminCall('PATCH', '/internal/admin/feed/posts/no-such', { content: 'x' })).status).toBe(404);
    expect((await adminCall('PATCH', `/internal/admin/feed/posts/${post.id}`, {})).status).toBe(400);

    const noAuth = await app.request(`/internal/admin/feed/posts/${post.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }),
    }, env);
    expect(noAuth.status).toBe(401);
  });
});
