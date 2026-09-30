// Clubs（社群）：0019 迁移、会员创建门禁、发现/搜索、收藏幂等、入群门禁四态、club_join 付费链路、管理员 flags。

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/index';
import { createMockD1Database, MockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { insertClub } from './helpers/club';
import { saveConfig, type PaymentConfigPayload } from '../src/services/payments/config';
import { setJoinGateBalanceReaderForTests } from '../src/services/clubs';
import type { Env } from '../src/types';

const SECRET = 'test-internal-secret';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

let db: D1Database;
let bucket: MockR2Bucket;
let env: Env;
let alice: TestWallet;
let bob: TestWallet;
let carol: TestWallet;
let aliceToken: string;
let bobToken: string;
let carolToken: string;

function payload(overrides: Partial<PaymentConfigPayload> = {}): PaymentConfigPayload {
  return {
    schemaVersion: 1,
    membershipEnabled: true,
    paymentsEnabled: true,
    membership: {
      monthly: { price: '5000000000000000000', durationDays: 30 },
      yearly: { price: '50000000000000000000', durationDays: 365 },
    },
    capacityTiers: [
      { tier: 100, price: '10000000000000000000' },
      { tier: 200, price: '25000000000000000000' },
      { tier: 300, price: '45000000000000000000' },
      { tier: 400, price: '70000000000000000000' },
      { tier: 500, price: '100000000000000000000' },
    ],
    memberDiscountBps: 2000,
    quoteTtlSeconds: 1800,
    chains: [
      { chainId: 56, rpcUrls: ['http://127.0.0.1:9'], confirmations: 12, recipientAddress: RECIPIENT, token: { type: 'native', symbol: 'BNB', decimals: 18, address: null } },
    ],
    ...overrides,
  };
}

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

async function grantMembership(address: string) {
  await db.prepare(
    "INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', ?, 1, ?)"
  ).bind(address.toLowerCase(), new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString()).run();
}

async function createClubOk(name: string, metadata: Record<string, unknown> = {}) {
  return insertClub(db, { ownerId: alice.address, name, metadata });
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
  carol = createTestWallet();
  aliceToken = await login(alice);
  bobToken = await login(bob);
  carolToken = await login(carol);
  await grantMembership(alice.address);
});

afterEach(() => {
  setJoinGateBalanceReaderForTests(null);
});

describe('migration 0019', () => {
  it('conversations CHECK accepts club; feed/club tables exist', async () => {
    const now = Date.now();
    await db.prepare(
      "INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, group_type, created_at, updated_at) VALUES (?, 'club', ?, 'c', '{}', 0, NULL, 'public', ?, ?)"
    ).bind('club:check', alice.address, now, now).run();
    const row = await db.prepare("SELECT type FROM conversations WHERE id = 'club:check'").first<{ type: string }>();
    expect(row?.type).toBe('club');

    for (const table of ['club_favorites', 'feed_posts', 'feed_likes']) {
      const found = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).bind(table).first<{ name: string }>();
      expect(found?.name).toBe(table);
    }
  });

  it('migrates existing public groups to club, keeps private groups as group', async () => {
    // 只应用 0001-0018，手工造存量数据，再应用 0019 验证存量迁移
    const legacy = new MockD1Database();
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f.slice(0, 4) <= '0018')) {
      legacy.rawDb.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
    }
    const now = Date.now();
    legacy.rawDb.exec(
      `INSERT INTO users (id, wallet_address, public_metadata, private_metadata, created_at, updated_at) VALUES ('${alice.address}', '${alice.address}', '{}', '{}', ${now}, ${now})`
    );
    legacy.rawDb.exec(
      `INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, group_type, created_at, updated_at) VALUES
       ('pub1', 'group', '${alice.address}', 'pub', '{}', 0, NULL, 'public', ${now}, ${now}),
       ('priv1', 'group', '${alice.address}', 'priv', '{}', 0, NULL, 'private', ${now}, ${now})`
    );
    legacy.rawDb.exec(fs.readFileSync(path.join(migrationsDir, '0019_clubs_and_feed.sql'), 'utf-8'));

    const pub = legacy.rawDb.prepare("SELECT type, group_type FROM conversations WHERE id = 'pub1'").get() as any;
    const priv = legacy.rawDb.prepare("SELECT type, group_type FROM conversations WHERE id = 'priv1'").get() as any;
    expect(pub.type).toBe('club');
    expect(pub.group_type).toBe('public');
    expect(priv.type).toBe('group');
    expect(priv.group_type).toBe('private');

    // payment_orders kind CHECK 扩为 4 值
    legacy.rawDb.exec(
      `INSERT INTO payment_orders (id, wallet_address, kind, amount, list_amount, discount_bps, chain_id, token_type, token_symbol, token_decimals, recipient_address, config_version, status, expires_at, created_at, updated_at)
       VALUES ('o1', '${alice.address}', 'club_join', '1', '1', 0, 56, 'native', 'BNB', 18, '${RECIPIENT}', 1, 'awaiting_payment', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );
    const order = legacy.rawDb.prepare("SELECT kind FROM payment_orders WHERE id = 'o1'").get() as any;
    expect(order.kind).toBe('club_join');
  });
});

describe('club creation gate', () => {
  it('POST /groups type=club is closed (403 CLUB_CREATE_VIA_APPLICATION) for member and non-member', async () => {
    // club 创建已改申请制：直建入口关闭（会员也不例外），走 POST /clubs/apply
    const denied = await app.request('/groups', {
      method: 'POST', headers: authed(bobToken),
      body: JSON.stringify({ name: 'Bob Club', type: 'club' }),
    }, env);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error).toBe('CLUB_CREATE_VIA_APPLICATION');

    const memberDenied = await app.request('/groups', {
      method: 'POST', headers: authed(aliceToken),
      body: JSON.stringify({ name: 'Alice Club', type: 'club' }),
    }, env);
    expect(memberDenied.status).toBe(403);
    expect(((await memberDenied.json()) as any).error).toBe('CLUB_CREATE_VIA_APPLICATION');

    // 普通群创建不受影响
    const plain = await app.request('/groups', {
      method: 'POST', headers: authed(aliceToken), body: JSON.stringify({ name: 'plain group' }),
    }, env);
    expect(plain.status).toBe(201);
    expect(((await plain.json()) as any).type).toBe('group');

    const badType = await app.request('/groups', {
      method: 'POST', headers: authed(aliceToken),
      body: JSON.stringify({ name: 'x', type: 'vip' }),
    }, env);
    expect(badType.status).toBe(400);
  });
});

describe('club discovery & favorites', () => {
  it('GET /clubs returns clubs with favorite_count/is_favorited; legacy /groups/public identical', async () => {
    const c1 = await createClubOk('DeFi Club', { description: 'trading' });
    await createClubOk('Game Club');

    const res = await app.request('/clubs?keyword=DeFi', { headers: authed(bobToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].id).toBe(c1.id);
    expect(body.groups[0].favorite_count).toBe(0);
    expect(body.groups[0].is_favorited).toBe(false);
    expect(body.groups[0].member_count).toBe(1);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();

    // 旧端点结构兼容
    const legacy = await app.request('/groups/public?keyword=DeFi', { headers: authed(bobToken) }, env);
    const legacyBody = (await legacy.json()) as any;
    expect(legacyBody.groups.map((g: any) => g.id)).toEqual([c1.id]);
  });

  it('favorite/unfavorite are idempotent and update counts', async () => {
    const club = await createClubOk('Fav Club');

    const fav1 = await app.request(`/clubs/${encodeURIComponent(club.id)}/favorite`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(fav1.status).toBe(200);
    expect(((await fav1.json()) as any)).toMatchObject({ favorited: true, favorite_count: 1 });

    // 重复收藏幂等
    const fav2 = await app.request(`/clubs/${encodeURIComponent(club.id)}/favorite`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(((await fav2.json()) as any).favorite_count).toBe(1);

    await app.request(`/clubs/${encodeURIComponent(club.id)}/favorite`, {
      method: 'POST', headers: authed(carolToken),
    }, env);

    const list = await app.request('/clubs', { headers: authed(bobToken) }, env);
    const item = ((await list.json()) as any).groups.find((g: any) => g.id === club.id);
    expect(item.favorite_count).toBe(2);
    expect(item.is_favorited).toBe(true);

    const carolList = await app.request('/clubs', { headers: authed(carolToken) }, env);
    expect(((await carolList.json()) as any).groups.find((g: any) => g.id === club.id).is_favorited).toBe(true);

    const unfav = await app.request(`/clubs/${encodeURIComponent(club.id)}/favorite`, {
      method: 'DELETE', headers: authed(bobToken),
    }, env);
    expect(((await unfav.json()) as any)).toMatchObject({ favorited: false, favorite_count: 1 });
    // 重复取消幂等
    const unfav2 = await app.request(`/clubs/${encodeURIComponent(club.id)}/favorite`, {
      method: 'DELETE', headers: authed(bobToken),
    }, env);
    expect(((await unfav2.json()) as any).favorite_count).toBe(1);

    const missing = await app.request('/clubs/no-such-club/favorite', {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(missing.status).toBe(404);
  });
});

describe('club join gates', () => {
  it('joinable=false → 403 GROUP_NOT_JOINABLE', async () => {
    const club = await createClubOk('Closed', { joinable: false });
    const res = await app.request(`/clubs/${encodeURIComponent(club.id)}/join`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe('GROUP_NOT_JOINABLE');
  });

  it('holdings gate: insufficient → 403 HOLDINGS_GATE_FAILED with required/current; sufficient → 201', async () => {
    await saveConfig(db, payload(), 'tester');
    const club = await createClubOk('Gated', {
      join_gate: { chain_id: 56, token_address: null, min_amount: '1000' },
    });

    setJoinGateBalanceReaderForTests(async () => 500n);
    const denied = await app.request(`/clubs/${encodeURIComponent(club.id)}/join`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as any;
    expect(deniedBody.error).toBe('HOLDINGS_GATE_FAILED');
    expect(deniedBody.required).toBe('1000');
    expect(deniedBody.current).toBe('500');

    setJoinGateBalanceReaderForTests(async () => 1000n);
    const joined = await app.request(`/clubs/${encodeURIComponent(club.id)}/join`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(joined.status).toBe(201);
    expect(((await joined.json()) as any).status).toBe('joined');
  });

  it('holdings gate on unknown chain → 500 JOIN_GATE_NOT_CONFIGURED', async () => {
    await saveConfig(db, payload(), 'tester');
    const club = await createClubOk('WrongChain', {
      join_gate: { chain_id: 999, token_address: null, min_amount: '1' },
    });
    const res = await app.request(`/clubs/${encodeURIComponent(club.id)}/join`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toBe('JOIN_GATE_NOT_CONFIGURED');
  });

  it('join_price → 200 requires_payment (no membership granted)', async () => {
    const club = await createClubOk('Paid', { join_price: { amount: '1000', token: 'BNB' } });
    const res = await app.request(`/clubs/${encodeURIComponent(club.id)}/join`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('requires_payment');
    expect(body.join_price.amount).toBe('1000');
    expect(body.group.id).toBe(club.id);

    const member = await db.prepare(
      'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(club.id, bob.address.toLowerCase()).first();
    expect(member).toBeNull();
  });

  it('join_requires_approval on club → 202 pending; plain club → 201', async () => {
    const approvalClub = await createClubOk('Approval Club', { join_requires_approval: true });
    const res = await app.request(`/clubs/${encodeURIComponent(approvalClub.id)}/join`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).status).toBe('pending');

    const plain = await createClubOk('Plain Club');
    const joined = await app.request(`/clubs/${encodeURIComponent(plain.id)}/join`, {
      method: 'POST', headers: authed(carolToken),
    }, env);
    expect(joined.status).toBe(201);
    const joinedBody = (await joined.json()) as any;
    expect(joinedBody.status).toBe('joined');
    expect(joinedBody.conversation.id).toBe(plain.id);

    // 幂等：已是成员 → already_member
    const again = await app.request(`/clubs/${encodeURIComponent(plain.id)}/join`, {
      method: 'POST', headers: authed(carolToken),
    }, env);
    expect(again.status).toBe(201);
    expect(((await again.json()) as any).already_member).toBe(true);
  });
});

describe('club_join payment flow', () => {
  it('quote kind=club_join → whitelist grant → member of club', async () => {
    const club = await createClubOk('Paid Club', { join_price: { amount: '1000' } });
    await saveConfig(db, payload({ whitelistWallets: [bob.address] }), 'tester');

    const quote = await app.request('/payments/quote', {
      method: 'POST', headers: authed(bobToken),
      body: JSON.stringify({ kind: 'club_join', group_id: club.id }),
    }, env);
    expect(quote.status).toBe(200);
    const quoteBody = (await quote.json()) as any;
    expect(quoteBody.order.kind).toBe('club_join');
    expect(quoteBody.order.group_id).toBe(club.id);
    expect(quoteBody.order.list_amount).toBe('1000');
    // 白名单免单 → 自动 verified → grant → active
    expect(quoteBody.order.amount).toBe('0');
    expect(quoteBody.order.status).toBe('active');

    const member = await db.prepare(
      "SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?"
    ).bind(club.id, bob.address.toLowerCase()).first<{ role: string }>();
    expect(member?.role).toBe('member');

    // 入群后再 join 幂等 already_member（不再走付费门槛）
    const join = await app.request(`/clubs/${encodeURIComponent(club.id)}/join`, {
      method: 'POST', headers: authed(bobToken),
    }, env);
    expect(join.status).toBe(201);
    expect(((await join.json()) as any).already_member).toBe(true);
  });

  it('quote club_join without join_price → 400 JOIN_PRICE_NOT_SET; unknown club → 404', async () => {
    await saveConfig(db, payload(), 'tester');
    const noPrice = await createClubOk('Free Club');
    const res1 = await app.request('/payments/quote', {
      method: 'POST', headers: authed(bobToken),
      body: JSON.stringify({ kind: 'club_join', group_id: noPrice.id }),
    }, env);
    expect(res1.status).toBe(400);
    expect(((await res1.json()) as any).error).toBe('JOIN_PRICE_NOT_SET');

    const res2 = await app.request('/payments/quote', {
      method: 'POST', headers: authed(bobToken),
      body: JSON.stringify({ kind: 'club_join', group_id: 'no-such' }),
    }, env);
    expect(res2.status).toBe(404);

    const res3 = await app.request('/payments/quote', {
      method: 'POST', headers: authed(bobToken),
      body: JSON.stringify({ kind: 'club_join' }),
    }, env);
    expect(res3.status).toBe(400);

    // 普通群（非 club）不可 club_join
    const plain = await app.request('/groups', {
      method: 'POST', headers: authed(aliceToken), body: JSON.stringify({ name: 'plain group' }),
    }, env);
    const plainGroup = (await plain.json()) as any;
    const res4 = await app.request('/payments/quote', {
      method: 'POST', headers: authed(bobToken),
      body: JSON.stringify({ kind: 'club_join', group_id: plainGroup.id }),
    }, env);
    expect(res4.status).toBe(404);
  });
});

describe('admin club flags', () => {
  it('sets hot/verified flags with audit; list reflects flags', async () => {
    const club = await createClubOk('Flagged Club');

    const res = await adminCall('POST', `/internal/admin/community/groups/${encodeURIComponent(club.id)}/flags`, {
      hot: true, actor: 'admin1',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.group.hot).toBe(true);
    expect(body.group.verified).toBe(false);

    const res2 = await adminCall('POST', `/internal/admin/community/groups/${encodeURIComponent(club.id)}/flags`, {
      verified: true,
    });
    const body2 = (await res2.json()) as any;
    expect(body2.group.hot).toBe(true); // 未提供的键不动
    expect(body2.group.verified).toBe(true);

    const list = await (await adminCall('GET', '/internal/admin/community/groups')).json() as any;
    const item = list.list.find((g: any) => g.id === club.id);
    expect(item.hot).toBe(true);
    expect(item.verified).toBe(true);

    const audit = await db.prepare(
      "SELECT action, target FROM payment_audit_log WHERE action = 'community_group_flags'"
    ).all<{ action: string; target: string }>();
    expect(audit.results).toHaveLength(2);
    expect(audit.results[0].target).toBe(club.id);

    const bad = await adminCall('POST', `/internal/admin/community/groups/${encodeURIComponent(club.id)}/flags`, { hot: 'yes' });
    expect(bad.status).toBe(400);
    const none = await adminCall('POST', `/internal/admin/community/groups/${encodeURIComponent(club.id)}/flags`, {});
    expect(none.status).toBe(400);
    const missing = await adminCall('POST', '/internal/admin/community/groups/no-such/flags', { hot: true });
    expect(missing.status).toBe(404);
  });
});

describe('feed post sections (0021)', () => {
  async function postTo(clubId: string, body: Record<string, unknown>, token: string = aliceToken) {
    return app.request(`/clubs/${encodeURIComponent(clubId)}/feed/posts`, {
      method: 'POST', headers: authed(token), body: JSON.stringify(body),
    }, env);
  }

  async function feedOf(clubId: string, filter: string) {
    const res = await app.request(
      `/clubs/${encodeURIComponent(clubId)}/feed?filter=${filter}`,
      { headers: authed(bobToken) }, env,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as any).posts as any[];
  }

  it('create with section stores it; invalid section → 400; feed items carry section', async () => {
    const club = await createClubOk('Section Club');

    const ok = await postTo(club.id, { content: 'file post', section: 'files' });
    expect(ok.status).toBe(201);
    const created = ((await ok.json()) as any).post;
    expect(created.section).toBe('files');

    const bad = await postTo(club.id, { content: 'x', section: 'vip' });
    expect(bad.status).toBe(400);

    // 不传 section → null（按派生规则归 Tab）
    const plain = await postTo(club.id, { content: 'plain' });
    expect(((await plain.json()) as any).post.section).toBeNull();
  });

  it('each tab shows its section; legacy null-section posts fall back to derived rules', async () => {
    const club = await createClubOk('Tab Club');
    // alice 是 owner（旧帖无 section → 自选按角色派生命中）
    await postTo(club.id, { content: 'legacy admin post' });
    await postTo(club.id, { content: 'media legacy', images: [] });
    await postTo(club.id, { content: 'picked files', section: 'files' });
    await postTo(club.id, { content: 'picked media', section: 'media' });
    await postTo(club.id, { content: 'picked admins', section: 'admins' });
    await postTo(club.id, { content: 'picked featured', section: 'featured' });

    const all = await feedOf(club.id, 'all');
    expect(all).toHaveLength(6);

    const files = await feedOf(club.id, 'files');
    expect(files.map((p) => p.content)).toEqual(['picked files']);

    const media = await feedOf(club.id, 'media');
    // 显式 media + 旧派生（带图帖）——media legacy 用了空 images 数组不算带图，
    // 这里只断言显式 section 命中与 owner 旧帖按 images 派生
    expect(media.map((p) => p.content)).toContain('picked media');

    const admins = await feedOf(club.id, 'admins');
    expect(admins.map((p) => p.content)).toContain('picked admins');
    expect(admins.map((p) => p.content)).toContain('legacy admin post');
    expect(admins.map((p) => p.content)).not.toContain('picked files');

    const badFilter = await app.request(
      `/clubs/${encodeURIComponent(club.id)}/feed?filter=vip`,
      { headers: authed(bobToken) }, env,
    );
    expect(badFilter.status).toBe(400);
  });
});
