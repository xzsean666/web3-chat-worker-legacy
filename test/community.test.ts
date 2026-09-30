import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { insertClub } from './helpers/club';
import type { Env } from '../src/types';

const SECRET = 'test-internal-secret';

describe('Community: public discovery cursor, join gates, admin ban, banners', () => {
  let db: D1Database;
  let env: Env;
  let alice: TestWallet;
  let bob: TestWallet;
  let aliceToken: string;
  let bobToken: string;

  async function login(wallet: TestWallet) {
    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, env);
    const nonce = await nonceRes.json() as { message: string };
    const verifyRes = await app.request('/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address, signature: await wallet.signMessage(nonce.message) }),
    }, env);
    return await verifyRes.json() as { token: string; user: { id: string; wallet_address: string } };
  }

  async function createGroup(name: string, metadata: Record<string, unknown> = {}) {
    // 发现页只服务 club（0019）；0020 起 club 直建关闭（申请制），测试夹具直接插库
    return insertClub(db, { ownerId: alice.address, name, metadata }) as Promise<any>;
  }

  async function sendMessage(token: string, conversationId: string, content: string) {
    const res = await app.request(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    }, env);
    expect(res.status).toBe(201);
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
    env = { DB: db, VOICE_BUCKET: {} as R2Bucket, INTERNAL_ADMIN_SECRET: SECRET };
    alice = createTestWallet();
    bob = createTestWallet();
    aliceToken = (await login(alice)).token;
    bobToken = (await login(bob)).token;
    // club 创建门禁：alice 需要会员权益
    await db.prepare(
      "INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', ?, 1, ?)"
    ).bind(alice.address, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString()).run();
  });

  it('migration 0018: new columns and community_banners table exist', async () => {
    const cols = await db.prepare('PRAGMA table_info(conversations)').all<{ name: string }>();
    const names = cols.results.map((r) => r.name);
    expect(names).toContain('last_message_at');
    expect(names).toContain('is_banned');
    const table = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'community_banners'"
    ).first<{ name: string }>();
    expect(table?.name).toBe('community_banners');
  });

  it('orders public clubs by last activity, includes message-less clubs, paginates by cursor', async () => {
    const g1 = await createGroup('Alpha');
    const g2 = await createGroup('Beta');
    const g3 = await createGroup('Gamma'); // 永远不发消息

    // 固定 last_message_at：g2 最新，g1 次之，g3 为 NULL（回退 updated_at）
    await db.prepare('UPDATE conversations SET last_message_at = 1000, updated_at = 1000 WHERE id = ?').bind(g1.id).run();
    await db.prepare('UPDATE conversations SET last_message_at = 2000, updated_at = 2000 WHERE id = ?').bind(g2.id).run();
    await db.prepare('UPDATE conversations SET last_message_at = NULL, updated_at = 500 WHERE id = ?').bind(g3.id).run();

    const page1 = await app.request('/groups/public?limit=2', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(page1.status).toBe(200);
    const body1 = await page1.json() as any;
    expect(body1.groups.map((g: any) => g.id)).toEqual([g2.id, g1.id]);
    expect(body1.has_more).toBe(true);
    expect(typeof body1.next_cursor).toBe('string');
    expect(body1.groups[0].member_count).toBe(1);

    const page2 = await app.request(`/groups/public?limit=2&cursor=${encodeURIComponent(body1.next_cursor)}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    const body2 = await page2.json() as any;
    expect(body2.groups.map((g: any) => g.id)).toEqual([g3.id]);
    expect(body2.has_more).toBe(false);
    expect(body2.next_cursor).toBeNull();

    const badCursor = await app.request('/groups/public?cursor=not-a-cursor', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(badCursor.status).toBe(400);
    expect((await badCursor.json() as any).error).toBe('INVALID_CURSOR');
  });

  it('updates last_message_at when a user sends a message, but not on system events', async () => {
    const g = await createGroup('Active Group');
    const before = await db.prepare('SELECT last_message_at FROM conversations WHERE id = ?')
      .bind(g.id).first<{ last_message_at: number | null }>();
    expect(before?.last_message_at ?? null).toBeNull();

    await sendMessage(aliceToken, g.id, 'hello');
    const after = await db.prepare('SELECT last_message_at FROM conversations WHERE id = ?')
      .bind(g.id).first<{ last_message_at: number | null }>();
    expect(after?.last_message_at).toBeGreaterThan(0);

    // 系统消息（bob 加入触发 member_joined 事件）不刷新 last_message_at
    await app.request(`/groups/${g.id}/join`, {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    const afterJoin = await db.prepare('SELECT last_message_at FROM conversations WHERE id = ?')
      .bind(g.id).first<{ last_message_at: number | null }>();
    expect(afterJoin?.last_message_at).toBe(after?.last_message_at);
  });

  it('blocks joining when metadata.joinable=false with 403 GROUP_NOT_JOINABLE', async () => {
    const g = await createGroup('Closed Group', { joinable: false });
    const res = await app.request(`/groups/${g.id}/join`, {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe('GROUP_NOT_JOINABLE');
  });

  it('routes join through approval when metadata.join_requires_approval=true', async () => {
    const g = await createGroup('Approval Group', { join_requires_approval: true });

    const res = await app.request(`/groups/${g.id}/join`, {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.status).toBe('pending');
    expect(body.pending).toBe(true);
    expect(body.join_request.status).toBe('pending');
    expect(body.join_request.group_id).toBe(g.id);

    // 重复加入返回同一 pending 申请（幂等）
    const again = await app.request(`/groups/${g.id}/join`, {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(again.status).toBe(202);
    expect((await again.json() as any).join_request.id).toBe(body.join_request.id);

    // 群主批准后成为成员
    const approve = await app.request(`/groups/${g.id}/join-requests/${body.join_request.id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(approve.status).toBe(200);
    const member = await db.prepare(
      'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(g.id, body.join_request.user_id).first<{ role: string }>();
    expect(member?.role).toBe('member');
  });

  it('admin lists clubs, bans and unbans; banned clubs disappear from discovery', async () => {
    const g = await createGroup('Ban Me');

    const list = await adminCall('GET', '/internal/admin/community/groups');
    expect(list.status).toBe(200);
    const listBody = await list.json() as any;
    expect(listBody.total).toBe(1);
    expect(listBody.list[0].id).toBe(g.id);
    expect(listBody.list[0].is_banned).toBe(false);
    expect(listBody.list[0].owner_address).toBe(alice.address.toLowerCase());

    const banned = await adminCall('POST', `/internal/admin/community/groups/${encodeURIComponent(g.id)}/ban`, {
      reason: 'spam', actor: 'admin1',
    });
    expect(banned.status).toBe(200);
    const bannedBody = await banned.json() as any;
    expect(bannedBody.group.is_banned).toBe(true);
    expect(bannedBody.group.banned_reason).toBe('spam');

    // 封禁后公开搜索不可见
    const search = await app.request('/groups/public', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(((await search.json() as any).groups as any[]).map((x: any) => x.id)).not.toContain(g.id);

    // 管理端列表仍可见且带 banned_reason
    const listAfter = await (await adminCall('GET', '/internal/admin/community/groups?keyword=Ban')).json() as any;
    expect(listAfter.list[0].is_banned).toBe(true);
    expect(listAfter.list[0].banned_reason).toBe('spam');

    const unbanned = await adminCall('POST', `/internal/admin/community/groups/${encodeURIComponent(g.id)}/unban`, {});
    expect(unbanned.status).toBe(200);
    const unbannedBody = await unbanned.json() as any;
    expect(unbannedBody.group.is_banned).toBe(false);
    expect(unbannedBody.group.banned_reason).toBeNull();

    const search2 = await app.request('/groups/public', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(((await search2.json() as any).groups as any[]).map((x: any) => x.id)).toContain(g.id);

    const missing = await adminCall('POST', '/internal/admin/community/groups/no-such/ban', {});
    expect(missing.status).toBe(404);
  });

  it('banner CRUD via internal admin; public endpoint returns only enabled banners ordered by sort', async () => {
    const created = await adminCall('POST', '/internal/admin/community/banners', {
      title: 'Welcome', image_url: 'https://img.example.com/a.png', link_url: 'https://example.com', sort: 10,
    });
    expect(created.status).toBe(201);
    const banner = (await created.json() as any).banner;
    expect(banner.enabled).toBe(1);
    expect(banner.sort).toBe(10);

    const second = await adminCall('POST', '/internal/admin/community/banners', {
      image_url: 'https://img.example.com/b.png', sort: 5, enabled: false,
    });
    const banner2 = (await second.json() as any).banner;
    expect(banner2.enabled).toBe(0);

    const missingImage = await adminCall('POST', '/internal/admin/community/banners', { title: 'x' });
    expect(missingImage.status).toBe(400);

    // 管理端列表含禁用项
    const adminList = await (await adminCall('GET', '/internal/admin/community/banners')).json() as any;
    expect(adminList.banners).toHaveLength(2);
    expect(adminList.banners.map((b: any) => b.sort)).toEqual([5, 10]);

    // 公开端只返回启用项
    const publicList = await app.request('/community/banners', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(publicList.status).toBe(200);
    const publicBody = await publicList.json() as any;
    expect(publicBody.banners).toHaveLength(1);
    expect(publicBody.banners[0].id).toBe(banner.id);

    const updated = await adminCall('PUT', `/internal/admin/community/banners/${banner2.id}`, {
      enabled: true, sort: 1,
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).banner.enabled).toBe(1);

    const publicList2 = await (await app.request('/community/banners', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env)).json() as any;
    expect(publicList2.banners.map((b: any) => b.id)).toEqual([banner2.id, banner.id]);

    const del = await adminCall('DELETE', `/internal/admin/community/banners/${banner.id}`);
    expect(del.status).toBe(200);
    const delAgain = await adminCall('DELETE', `/internal/admin/community/banners/${banner.id}`);
    expect(delAgain.status).toBe(404);

    const noAuth = await app.request('/community/banners', {}, env);
    expect(noAuth.status).toBe(401);
  });
});
