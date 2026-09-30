import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { insertClub } from './helpers/club';
import type { Env } from '../src/types';

describe('Group type, content protection, custom invite slugs, and public discovery', () => {
  let db: D1Database;
  let env: Env;
  let alice: TestWallet;
  let bob: TestWallet;
  let aliceToken: string;
  let bobToken: string;
  let bobUser: { id: string; wallet_address: string };

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

  async function createGroup(name = 'Typed Group', metadata: Record<string, unknown> = {}) {
    const response = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ name, metadata }),
    }, env);
    expect(response.status).toBe(201);
    return await response.json() as any;
  }

  // club 创建需会员钱包；发现页只服务 club
  async function grantMembership(address: string) {
    await db.prepare(
      "INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', ?, 1, ?)"
    ).bind(address.toLowerCase(), new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString()).run();
  }

  // 0020 起 club 直建关闭（申请制），测试夹具直接插库
  async function createClub(name: string, metadata: Record<string, unknown> = {}) {
    return insertClub(db, { ownerId: alice.address, name, metadata }) as Promise<any>;
  }

  beforeEach(async () => {
    db = createMockD1Database(true);
    env = { DB: db, VOICE_BUCKET: {} as R2Bucket };
    alice = createTestWallet();
    bob = createTestWallet();
    aliceToken = (await login(alice)).token;
    const bobAuth = await login(bob);
    bobToken = bobAuth.token;
    bobUser = bobAuth.user;
  });

  it('defaults new groups to private and unprotected, and owner can update both fields', async () => {
    const group = await createGroup();
    expect(group.group_type).toBe('private');
    expect(group.content_protected).toBe(0);

    const updated = await app.request(`/groups/${group.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ group_type: 'public', content_protected: true }),
    }, env);
    expect(updated.status).toBe(200);
    const updatedGroup = await updated.json() as any;
    expect(updatedGroup.group_type).toBe('public');
    expect(updatedGroup.content_protected).toBe(1);

    const detail = await app.request(`/groups/${group.id}`, { headers: { Authorization: `Bearer ${aliceToken}` } }, env);
    const detailGroup = await detail.json() as any;
    expect(detailGroup.group_type).toBe('public');
    expect(detailGroup.content_protected).toBe(1);
  });

  it('rejects invalid group_type and non-admin updates', async () => {
    const group = await createGroup();
    const invalid = await app.request(`/groups/${group.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ group_type: 'secret' }),
    }, env);
    expect(invalid.status).toBe(400);

    const forbidden = await app.request(`/groups/${group.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ group_type: 'public' }),
    }, env);
    expect(forbidden.status).toBe(403);
  });

  it('creates an invite link with a custom slug and accepts it in join-by-token', async () => {
    const group = await createGroup();
    const inviteRes = await app.request(`/groups/${group.id}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ slug: 'My_Team-01' }),
    }, env);
    expect(inviteRes.status).toBe(201);
    const invite = await inviteRes.json() as any;
    expect(invite.slug).toBe('my_team-01');
    expect(invite.url).toBe('https://api.chatnice.top/g/my_team-01');

    // Bob joins via the slug instead of the opaque token.
    const joined = await app.request('/groups/join-by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ token: 'my_team-01' }),
    }, env);
    expect(joined.status).toBe(201);
    const joinedData = await joined.json() as any;
    expect(joinedData.status).toBe('joined');
    expect(joinedData.conversation.id).toBe(group.id);

    // The opaque token keeps working too.
    const member = await db.prepare(
      'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(group.id, bobUser.id).first<{ role: string }>();
    expect(member?.role).toBe('member');
  });

  it('returns 409 on slug conflict, 400 on invalid slug, and is idempotent for the owning group', async () => {
    const groupA = await createGroup('Group A');
    const groupB = await createGroup('Group B');
    const first = await app.request(`/groups/${groupA.id}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ slug: 'taken-slug' }),
    }, env);
    expect(first.status).toBe(201);

    const conflict = await app.request(`/groups/${groupB.id}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ slug: 'taken-slug' }),
    }, env);
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as any).error).toContain('Slug already taken');

    // Same group re-requesting its own slug gets the original link back.
    const again = await app.request(`/groups/${groupA.id}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ slug: 'taken-slug' }),
    }, env);
    expect(again.status).toBe(201);
    expect((await again.json() as any).token).toBe((await first.json() as any).token);

    for (const bad of ['ab', 'x'.repeat(33), 'has space', '中文slug', 'UPPER!!']) {
      const invalid = await app.request(`/groups/${groupA.id}/invite-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
        body: JSON.stringify({ slug: bad }),
      }, env);
      expect(invalid.status).toBe(400);
    }
  });

  it('public groups join directly even when join_admin_only metadata is set', async () => {
    const group = await createGroup('Open Group', { join_admin_only: true });
    await app.request(`/groups/${group.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ group_type: 'public' }),
    }, env);

    const inviteRes = await app.request(`/groups/${group.id}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ slug: 'open-hub' }),
    }, env);
    const invite = await inviteRes.json() as any;

    const joined = await app.request('/groups/join-by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ token: invite.slug }),
    }, env);
    expect(joined.status).toBe(201);
    const joinedData = await joined.json() as any;
    expect(joinedData.status).toBe('joined');
    expect(joinedData.conversation.id).toBe(group.id);

    const strayRequests = await db.prepare(
      'SELECT COUNT(*) AS count FROM group_join_requests WHERE group_id = ?'
    ).bind(group.id).first<{ count: number }>();
    expect(strayRequests?.count).toBe(0);
  });

  it('searches only public clubs by keyword (discovery serves clubs only since 0019)', async () => {
    await grantMembership(alice.address);
    const publicGroup = await createClub('LHSwap 中文社区', { description: 'DeFi 讨论' });
    const privateGroup = await createGroup('LHSwap 私密群');

    const res = await app.request('/groups/public?keyword=LHSwap', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(res.status).toBe(200);
    const groups = (await res.json() as any).groups as any[];
    expect(groups.map((g) => g.id)).toContain(publicGroup.id);
    expect(groups.map((g) => g.id)).not.toContain(privateGroup.id);
    const found = groups.find((g) => g.id === publicGroup.id);
    expect(found.member_count).toBe(1);
    expect(found.description).toBe('DeFi 讨论');

    // Empty keyword lists all public groups; non-matching keyword returns none.
    const all = await app.request('/groups/public', { headers: { Authorization: `Bearer ${bobToken}` } }, env);
    expect(((await all.json() as any).groups as any[]).length).toBeGreaterThanOrEqual(1);
    const none = await app.request('/groups/public?keyword=no-such-group-xyz', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(((await none.json() as any).groups as any[])).toHaveLength(0);

    // The parameterized detail route still works (route ordering regression guard).
    const detail = await app.request(`/groups/${publicGroup.id}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(detail.status).toBe(200);
  });

  it('joins a public group directly by id, idempotent for members, forbidden for private groups', async () => {
    const publicGroup = await createGroup('Public Join Group');
    await app.request(`/groups/${publicGroup.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ group_type: 'public' }),
    }, env);

    const joined = await app.request(`/groups/${publicGroup.id}/join`, {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(joined.status).toBe(201);
    const joinedBody = await joined.json() as any;
    expect(joinedBody.status).toBe('joined');
    expect(joinedBody.conversation.id).toBe(publicGroup.id);
    expect(joinedBody.conversation.members.some((m: any) => m.user_id === bobUser.id)).toBe(true);

    // Idempotent: joining again reports already_member without duplicating rows.
    const again = await app.request(`/groups/${publicGroup.id}/join`, {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(again.status).toBe(201);
    expect((await again.json() as any).already_member).toBe(true);
    const memberCount = await db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(publicGroup.id, bobUser.id).first<{ count: number }>();
    expect(memberCount?.count).toBe(1);

    const privateGroup = await createGroup('Private Join Group');
    const forbidden = await app.request(`/groups/${privateGroup.id}/join`, {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(forbidden.status).toBe(403);

    const missing = await app.request('/groups/no-such-group/join', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(missing.status).toBe(404);
  });
});
