// Club 私有动态（0020）：feed 作用域隔离、仅 owner/admin 发帖、filter=admins/media、社群主页 GET /clubs/:id。

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
let alice: TestWallet; // club A/B owner
let bob: TestWallet;   // club A admin（后被降级）
let carol: TestWallet; // 非成员
let aliceToken: string;
let bobToken: string;
let carolToken: string;

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

async function clubPost(token: string, clubId: string, body: Record<string, unknown>) {
  return app.request(`/clubs/${encodeURIComponent(clubId)}/feed/posts`, {
    method: 'POST', headers: authed(token), body: JSON.stringify(body),
  }, env);
}

async function clubFeed(token: string, clubId: string, query = '') {
  return app.request(`/clubs/${encodeURIComponent(clubId)}/feed${query}`, { headers: authed(token) }, env);
}

let clubA: { id: string };
let clubB: { id: string };

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
    metadata: { description: 'A 社', tags: ['DeFi'] },
    members: [{ userId: bob.address, role: 'admin' }],
  });
  clubB = await insertClub(db, { ownerId: alice.address, name: 'Club B' });
});

describe('club feed scope', () => {
  it('club posts are scoped: not in other club feed nor in global feed; global posts stay global', async () => {
    const pa = (await (await clubPost(aliceToken, clubA.id, { content: 'A 社公告' })).json()) as any;
    expect(pa.post.club_id).toBe(clubA.id);
    const pb = (await (await clubPost(aliceToken, clubB.id, { content: 'B 社公告' })).json()) as any;

    const feedA = (await (await clubFeed(carolToken, clubA.id)).json()) as any;
    expect(feedA.posts.map((p: any) => p.id)).toEqual([pa.post.id]);
    expect(feedA.posts[0].author.role).toBe('owner');
    expect(feedA.posts[0].club_id).toBe(clubA.id);

    const feedB = (await (await clubFeed(carolToken, clubB.id)).json()) as any;
    expect(feedB.posts.map((p: any) => p.id)).toEqual([pb.post.id]);

    // 全局流只含 club_id IS NULL 的帖：club 帖不出现，存量全局帖保留
    const global = await app.request('/feed/posts', {
      method: 'POST', headers: authed(bobToken), body: JSON.stringify({ content: 'global post' }),
    }, env);
    const globalPost = ((await global.json()) as any).post;
    expect(globalPost.club_id).toBeNull();
    const list = (await (await app.request('/feed', { headers: authed(aliceToken) }, env)).json()) as any;
    expect(list.posts.map((p: any) => p.id)).toEqual([globalPost.id]);

    // 未登录 → 401；未知 club → 404
    expect((await app.request(`/clubs/${clubA.id}/feed`, {}, env)).status).toBe(401);
    expect((await clubFeed(aliceToken, 'no-such-club')).status).toBe(404);
    // 非法 filter → 400
    expect((await clubFeed(aliceToken, clubA.id, '?filter=vip')).status).toBe(400);
  });

  it('posting permission: owner/admin unlimited; member posts within free quota; non-member 403 NOT_CLUB_MEMBER', async () => {
    // bob 是 A 社 admin → 可发
    expect((await clubPost(bobToken, clubA.id, { content: 'admin 发帖' })).status).toBe(201);
    // carol 非成员 → 403 NOT_CLUB_MEMBER
    const nonMember = await clubPost(carolToken, clubA.id, { content: 'x' });
    expect(nonMember.status).toBe(403);
    expect(((await nonMember.json()) as any).error).toBe('NOT_CLUB_MEMBER');
    // bob 降级为 member → 仍可发（免费额度内；未配置 feedPost 时成员免费不限量）
    await db.prepare("UPDATE conversation_members SET role = 'member' WHERE conversation_id = ? AND user_id = ?")
      .bind(clubA.id, bob.address).run();
    expect((await clubPost(bobToken, clubA.id, { content: 'member 帖' })).status).toBe(201);
    // bob 不是 B 社成员 → 403
    expect((await clubPost(bobToken, clubB.id, { content: 'x' })).status).toBe(403);
    // 未知 club → 404
    expect((await clubPost(aliceToken, 'no-such-club', { content: 'x' })).status).toBe(404);
  });

  it('filter=admins follows current role; filter=media keeps only posts with images', async () => {
    const p1 = ((await (await clubPost(aliceToken, clubA.id, { content: 'owner 帖' })).json()) as any).post;
    const p2 = ((await (await clubPost(bobToken, clubA.id, { content: 'admin 帖', images: ['feed/x.png'] })).json()) as any).post;

    // 全部
    const all = (await (await clubFeed(aliceToken, clubA.id)).json()) as any;
    expect(all.posts.map((p: any) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(all.posts.find((p: any) => p.id === p2.id).author.role).toBe('admin');

    // filter=media：只有带图帖
    const media = (await (await clubFeed(aliceToken, clubA.id, '?filter=media')).json()) as any;
    expect(media.posts.map((p: any) => p.id)).toEqual([p2.id]);
    expect(media.posts[0].images).toEqual(['/feed/images/feed/x.png']);

    // filter=admins：降级后 bob 的帖不再出现
    const adminsBefore = (await (await clubFeed(aliceToken, clubA.id, '?filter=admins')).json()) as any;
    expect(adminsBefore.posts.map((p: any) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    await db.prepare("UPDATE conversation_members SET role = 'member' WHERE conversation_id = ? AND user_id = ?")
      .bind(clubA.id, bob.address).run();
    const adminsAfter = (await (await clubFeed(aliceToken, clubA.id, '?filter=admins')).json()) as any;
    expect(adminsAfter.posts.map((p: any) => p.id)).toEqual([p1.id]);
  });

  it('filter=featured：板块互斥——发到指定板块的帖只进对应 Tab，无板块旧帖归精选', async () => {
    const legacy = ((await (await clubPost(aliceToken, clubA.id, { content: '旧帖' })).json()) as any).post;
    const featured = ((await (await clubPost(aliceToken, clubA.id, { content: '精选帖', section: 'featured' })).json()) as any).post;
    const admins = ((await (await clubPost(bobToken, clubA.id, { content: '自选帖', section: 'admins' })).json()) as any).post;
    const media = ((await (await clubPost(aliceToken, clubA.id, { content: '图片帖', images: ['feed/m.png'], section: 'media' })).json()) as any).post;
    const files = ((await (await clubPost(aliceToken, clubA.id, { content: '文件帖', section: 'files' })).json()) as any).post;
    // 发帖响应回传 section
    expect(featured.section).toBe('featured');

    const ids = (res: any) => res.posts.map((p: any) => p.id).sort();
    // 精选：明确 section=featured + 无板块旧帖；不含发到其他板块的帖
    const featuredFeed = (await (await clubFeed(aliceToken, clubA.id, '?filter=featured')).json()) as any;
    expect(ids(featuredFeed)).toEqual([legacy.id, featured.id].sort());
    // 自选：仅 section=admins + 旧帖派生（作者当前 role owner/admin）
    const adminsFeed = (await (await clubFeed(aliceToken, clubA.id, '?filter=admins')).json()) as any;
    expect(ids(adminsFeed)).toEqual([legacy.id, admins.id].sort());
    // 图片·视频：仅 section=media + 旧帖带图/视频派生（本例旧帖无图）
    const mediaFeed = (await (await clubFeed(aliceToken, clubA.id, '?filter=media')).json()) as any;
    expect(mediaFeed.posts.map((p: any) => p.id)).toEqual([media.id]);
    // 文件：仅 section=files（旧帖无 files 可归）
    const filesFeed = (await (await clubFeed(aliceToken, clubA.id, '?filter=files')).json()) as any;
    expect(filesFeed.posts.map((p: any) => p.id)).toEqual([files.id]);
    // filter=all 保留全量语义（旧客户端兼容）
    const all = (await (await clubFeed(aliceToken, clubA.id)).json()) as any;
    expect(all.posts.length).toBe(5);
    // 非法 section → 400
    expect((await clubPost(aliceToken, clubA.id, { content: 'x', section: 'vip' })).status).toBe(400);
  });

  it('club feed supports cursor pagination and like/delete reuse global endpoints', async () => {
    const p1 = ((await (await clubPost(aliceToken, clubA.id, { content: 'p1' })).json()) as any).post;
    const p2 = ((await (await clubPost(aliceToken, clubA.id, { content: 'p2' })).json()) as any).post;
    await db.prepare('UPDATE feed_posts SET created_at = 1000 WHERE id = ?').bind(p1.id).run();
    await db.prepare('UPDATE feed_posts SET created_at = 2000 WHERE id = ?').bind(p2.id).run();

    const page1 = (await (await clubFeed(carolToken, clubA.id, '?limit=1')).json()) as any;
    expect(page1.posts.map((p: any) => p.id)).toEqual([p2.id]);
    expect(page1.has_more).toBe(true);
    const page2 = (await (await clubFeed(carolToken, clubA.id, `?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`)).json()) as any;
    expect(page2.posts.map((p: any) => p.id)).toEqual([p1.id]);
    expect(page2.has_more).toBe(false);

    // 点赞沿用全局端点（非成员也可点赞）
    const like = await app.request(`/feed/posts/${p1.id}/like`, { method: 'POST', headers: authed(carolToken) }, env);
    expect(((await like.json()) as any).like_count).toBe(1);
    const afterLike = (await (await clubFeed(carolToken, clubA.id)).json()) as any;
    expect(afterLike.posts.find((p: any) => p.id === p1.id).is_liked).toBe(true);

    // 删帖沿用全局端点（仅作者）
    expect((await app.request(`/feed/posts/${p1.id}`, { method: 'DELETE', headers: authed(carolToken) }, env)).status).toBe(403);
    expect((await app.request(`/feed/posts/${p1.id}`, { method: 'DELETE', headers: authed(aliceToken) }, env)).status).toBe(200);
    const afterDel = (await (await clubFeed(carolToken, clubA.id)).json()) as any;
    expect(afterDel.posts.map((p: any) => p.id)).not.toContain(p1.id);
  });
});

describe('GET /clubs/:id (club profile)', () => {
  it('non-member sees full profile with my_role=null; owner sees my_role=owner', async () => {
    // carol 收藏 → is_favorited/favorite_count
    await app.request(`/clubs/${encodeURIComponent(clubA.id)}/favorite`, { method: 'POST', headers: authed(carolToken) }, env);

    const res = await app.request(`/clubs/${encodeURIComponent(clubA.id)}`, { headers: authed(carolToken) }, env);
    expect(res.status).toBe(200);
    const profile = (await res.json()) as any;
    expect(profile.id).toBe(clubA.id);
    expect(profile.name).toBe('Club A');
    expect(profile.description).toBe('A 社');
    expect(profile.tags).toEqual(['DeFi']);
    expect(profile.verified).toBe(false);
    expect(profile.hot).toBe(false);
    expect(profile.member_count).toBe(2);
    expect(profile.favorite_count).toBe(1);
    expect(profile.is_favorited).toBe(true);
    expect(profile.my_role).toBeNull();
    expect(profile.joinable).toBe(true);
    expect(profile.join_requires_approval).toBe(false);
    expect(profile.join_price).toBeNull();
    expect(profile.join_gate).toBeNull();
    expect(profile.tencent_meeting_url).toBeNull();
    expect(profile.avatar_url).toBeNull();
    expect(profile.avatar_updated_at).toBeNull();
    expect(profile.members).toHaveLength(2);
    expect(profile.members.map((m: any) => m.wallet_address).sort()).toEqual([alice.address, bob.address].sort());
    expect(profile.members[0]).toHaveProperty('nickname');
    expect(profile.members[0]).toHaveProperty('avatar_url');

    // owner 视角
    const ownerView = (await (await app.request(`/clubs/${encodeURIComponent(clubA.id)}`, { headers: authed(aliceToken) }, env)).json()) as any;
    expect(ownerView.my_role).toBe('owner');
    expect(ownerView.is_favorited).toBe(false);

    // admin 视角
    const adminView = (await (await app.request(`/clubs/${encodeURIComponent(clubA.id)}`, { headers: authed(bobToken) }, env)).json()) as any;
    expect(adminView.my_role).toBe('admin');

    // 非 club → 404
    expect((await app.request('/clubs/no-such-club', { headers: authed(aliceToken) }, env)).status).toBe(404);
    // 未登录 → 401
    expect((await app.request(`/clubs/${clubA.id}`, {}, env)).status).toBe(401);
  });

  it('reads gates/flags from metadata', async () => {
    const gated = await insertClub(db, {
      ownerId: alice.address, name: 'Gated',
      metadata: {
        joinable: false,
        join_requires_approval: true,
        join_price: { amount: '1000', token: 'BNB' },
        join_gate: { chain_id: 56, token_address: null, min_amount: '100' },
        verified: true, hot: true,
        tencent_meeting_url: 'https://meeting.tencent.com/x',
      },
    });
    const profile = (await (await app.request(`/clubs/${encodeURIComponent(gated.id)}`, { headers: authed(carolToken) }, env)).json()) as any;
    expect(profile.joinable).toBe(false);
    expect(profile.join_requires_approval).toBe(true);
    expect(profile.join_price).toMatchObject({ amount: '1000', token: 'BNB' });
    expect(profile.join_gate).toMatchObject({ chain_id: 56, token_address: null, min_amount: '100' });
    expect(profile.verified).toBe(true);
    expect(profile.hot).toBe(true);
    expect(profile.tencent_meeting_url).toBe('https://meeting.tencent.com/x');
  });
});

describe('admin feed club_id filter', () => {
  it('filters admin post list by club_id; global keeps only NULL-club posts', async () => {
    const p = ((await (await clubPost(aliceToken, clubA.id, { content: 'club post' })).json()) as any).post;
    const g = ((await (await app.request('/feed/posts', {
      method: 'POST', headers: authed(bobToken), body: JSON.stringify({ content: 'global' }),
    }, env)).json()) as any).post;

    const allList = (await (await adminCall('GET', '/internal/admin/feed/posts')).json()) as any;
    expect(allList.total).toBe(2);
    expect(allList.list.find((x: any) => x.id === p.id).club_id).toBe(clubA.id);
    expect(allList.list.find((x: any) => x.id === g.id).club_id).toBeNull();

    const clubOnly = (await (await adminCall('GET', `/internal/admin/feed/posts?club_id=${encodeURIComponent(clubA.id)}`)).json()) as any;
    expect(clubOnly.total).toBe(1);
    expect(clubOnly.list[0].id).toBe(p.id);

    const globalOnly = (await (await adminCall('GET', '/internal/admin/feed/posts?club_id=global')).json()) as any;
    expect(globalOnly.total).toBe(1);
    expect(globalOnly.list[0].id).toBe(g.id);
  });
});

// 动态发布付费（0023）：成员免费配额 → 402 PAYMENT_REQUIRED → 报价建单 →
// 消费发帖（一次一帖）；owner/admin 不限量；feedPost.enabled=false 全员免费。
import { saveConfig, type PaymentConfigPayload } from '../src/services/payments/config';

const FEED_PAY_RECIPIENT = '0x87084fa42db9bbfe283d59d30206aae1da68943e';
const FEED_POST_PRICE = '20000000000000'; // 0.00002 tBNB(18)

function feedPostPayload(freeQuota = 2, enabled = true): PaymentConfigPayload {
  return {
    schemaVersion: 1,
    membershipEnabled: true,
    paymentsEnabled: true,
    membership: {
      monthly: { price: '100', durationDays: 30 },
      yearly: { price: '1000', durationDays: 365 },
    },
    capacityTiers: [
      { tier: 100, price: '1' },
      { tier: 200, price: '2' },
      { tier: 300, price: '3' },
      { tier: 400, price: '4' },
      { tier: 500, price: '5' },
    ],
    memberDiscountBps: 0,
    quoteTtlSeconds: 1800,
    chains: [
      { chainId: 97, rpcUrls: ['https://bsc-testnet.publicnode.com'], confirmations: 1, recipientAddress: FEED_PAY_RECIPIENT, token: { type: 'native', symbol: 'tBNB', decimals: 18, address: null } },
    ],
    feedPost: {
      enabled,
      price: FEED_POST_PRICE,
      freeQuota,
      chainId: 97,
      recipientAddress: FEED_PAY_RECIPIENT,
      token: { type: 'native', symbol: 'tBNB', decimals: 18, address: null },
    },
  };
}

describe('feed post payment (0023)', () => {
  async function quoteFeedPost(token: string, clubId: string) {
    return app.request('/payments/quote', {
      method: 'POST', headers: authed(token),
      body: JSON.stringify({ kind: 'feed_post', group_id: clubId }),
    }, env);
  }

  it('club-wide total quota: anyone (incl. owner) is charged once total posts reach freeQuota', async () => {
    await saveConfig(db, feedPostPayload(2), 'tester');
    // bob 降级为 member
    await db.prepare("UPDATE conversation_members SET role = 'member' WHERE conversation_id = ? AND user_id = ?")
      .bind(clubA.id, bob.address).run();

    expect((await clubPost(bobToken, clubA.id, { content: '免费 1' })).status).toBe(201);
    expect((await clubPost(aliceToken, clubA.id, { content: '免费 2（owner 也计数）' })).status).toBe(201);
    // 社群总动态数已达 2：member 再发 → 402
    const third = await clubPost(bobToken, clubA.id, { content: '第 3 条' });
    expect(third.status).toBe(402);
    const body = (await third.json()) as any;
    expect(body.error).toBe('PAYMENT_REQUIRED');
    expect(body.price).toBe(FEED_POST_PRICE);
    expect(body.free_quota).toBe(2);
    expect(body.recipient_address).toBe(FEED_PAY_RECIPIENT);
    expect(body.token_symbol).toBe('tBNB');
    expect(body.chain_id).toBe(97);

    // owner 同样被收费（社群总量规则，无角色豁免）
    const ownerThird = await clubPost(aliceToken, clubA.id, { content: 'owner 第 3 条' });
    expect(ownerThird.status).toBe(402);
    expect(((await ownerThird.json()) as any).error).toBe('PAYMENT_REQUIRED');
  });

  it('quote kind=feed_post builds order from feedPost config; consume allows one post only', async () => {
    await saveConfig(db, feedPostPayload(0), 'tester');
    await db.prepare("UPDATE conversation_members SET role = 'member' WHERE conversation_id = ? AND user_id = ?")
      .bind(clubA.id, bob.address).run();

    const quote = await quoteFeedPost(bobToken, clubA.id);
    expect(quote.status).toBe(200);
    const quoteBody = (await quote.json()) as any;
    expect(quoteBody.order.kind).toBe('feed_post');
    expect(quoteBody.order.amount).toBe(FEED_POST_PRICE);
    expect(quoteBody.order.chain_id).toBe(97);
    expect(quoteBody.payment.recipientAddress).toBe(FEED_PAY_RECIPIENT);
    expect(quoteBody.payment.tokenSymbol).toBe('tBNB');
    expect(quoteBody.payment.chainId).toBe(97);

    // 未支付（awaiting_payment）时发帖 → 402
    expect((await clubPost(bobToken, clubA.id, { content: 'x', order_id: quoteBody.order.id })).status).toBe(402);

    // 模拟验款完成 → active
    await db.prepare("UPDATE payment_orders SET status = 'active', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), quoteBody.order.id).run();

    // 消费成功 → 发帖 201，订单转 consumed
    expect((await clubPost(bobToken, clubA.id, { content: '付费帖', order_id: quoteBody.order.id })).status).toBe(201);
    const order = await db.prepare('SELECT status FROM payment_orders WHERE id = ?')
      .bind(quoteBody.order.id).first<{ status: string }>();
    expect(order?.status).toBe('consumed');

    // 同一订单不能复用第二条
    expect((await clubPost(bobToken, clubA.id, { content: 'y', order_id: quoteBody.order.id })).status).toBe(402);

    // 他人订单不可消费
    const carolQuote = await quoteFeedPost(bobToken, clubA.id);
    const carolOrder = ((await carolQuote.json()) as any).order;
    await db.prepare("UPDATE payment_orders SET status = 'active', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), carolOrder.id).run();
    expect((await clubPost(carolToken, clubA.id, { content: 'z', order_id: carolOrder.id })).status).toBe(403);
  });

  it('feedPost.enabled=false → member unlimited; quote → 503', async () => {
    await saveConfig(db, feedPostPayload(0, false), 'tester');
    await db.prepare("UPDATE conversation_members SET role = 'member' WHERE conversation_id = ? AND user_id = ?")
      .bind(clubA.id, bob.address).run();
    expect((await clubPost(bobToken, clubA.id, { content: '随便发' })).status).toBe(201);
    const quote = await quoteFeedPost(bobToken, clubA.id);
    expect(quote.status).toBe(503);
    expect(((await quote.json()) as any).error).toBe('FEED_POST_PAYMENT_DISABLED');
  });
});
