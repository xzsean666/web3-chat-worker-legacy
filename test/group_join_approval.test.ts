import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Group join approval, invite links, and ownership transfer', () => {
  let db: D1Database;
  let env: Env;
  let alice: TestWallet;
  let bob: TestWallet;
  let charlie: TestWallet;
  let aliceToken: string;
  let bobToken: string;
  let charlieToken: string;
  let aliceUser: { id: string; wallet_address: string };
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

  async function createGroup(metadata: Record<string, unknown> = {}, memberIds: string[] = []) {
    const response = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ name: 'Approval Test Group', metadata, member_ids: memberIds }),
    }, env);
    expect(response.status).toBe(201);
    return await response.json() as any;
  }

  beforeEach(async () => {
    db = createMockD1Database(true);
    env = { DB: db, VOICE_BUCKET: {} as R2Bucket };
    alice = createTestWallet();
    bob = createTestWallet();
    charlie = createTestWallet();
    const aliceAuth = await login(alice);
    const bobAuth = await login(bob);
    const charlieAuth = await login(charlie);
    aliceToken = aliceAuth.token;
    bobToken = bobAuth.token;
    charlieToken = charlieAuth.token;
    aliceUser = aliceAuth.user;
    bobUser = bobAuth.user;
  });

  it('turns an invite redemption into a pending application and lets an owner approve it', async () => {
    const group = await createGroup({ join_admin_only: true }, [bobUser.id]);
    await db.prepare('UPDATE conversations SET avatar_key = ?, avatar_updated_at = ? WHERE id = ?')
      .bind('group-avatars/preview.png', 1790044619673, group.id).run();
    const inviteRes = await app.request(`/groups/${group.id}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ max_uses: 2, expires_in_seconds: 60 }),
    }, env);
    expect(inviteRes.status).toBe(201);
    const invite = await inviteRes.json() as any;
    expect(invite.url).toBe(`https://api.chatnice.top/g/${invite.token}`);

    const redeem = await app.request('/groups/join-by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlieToken}` },
      body: JSON.stringify({ token: invite.token, message: 'Please let me join' }),
    }, env);
    expect(redeem.status).toBe(202);
    const pending = await redeem.json() as any;
    expect(pending.status).toBe('pending');
    expect(pending.pending).toBe(true);
    expect(pending.request.id).toBe(pending.join_request.id);
    expect(pending.group).toMatchObject({
      id: group.id,
      name: 'Approval Test Group',
      member_count: 2,
      avatar_updated_at: 1790044619673,
      metadata: { join_admin_only: true },
    });
    expect(pending.group.avatar_url).toContain(`/groups/${encodeURIComponent(group.id)}/avatar`);

    // Refreshing the landing page does not consume another use or create another application.
    const pendingRefresh = await app.request('/groups/join-by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlieToken}` },
      body: JSON.stringify({ token: invite.token }),
    }, env);
    expect(pendingRefresh.status).toBe(202);
    expect((await pendingRefresh.json() as any).request.id).toBe(pending.request.id);
    const linkUsage = await db.prepare('SELECT uses_count FROM group_invite_links WHERE token = ?').bind(invite.token).first<{ uses_count: number }>();
    expect(linkUsage?.uses_count).toBe(1);

    const list = await app.request(`/groups/${group.id}/join-requests?status=pending`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(list.status).toBe(200);
    const requests = (await list.json() as any).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0].wallet_address).toBe(charlie.address.toLowerCase());
    expect(requests[0].message).toBe('Please let me join');

    const approved = await app.request(`/groups/${group.id}/join-requests/${requests[0].id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(approved.status).toBe(200);
    expect((await approved.json() as any).status).toBe('approved');

    const detail = await app.request(`/groups/${group.id}`, { headers: { Authorization: `Bearer ${charlieToken}` } }, env);
    expect(detail.status).toBe(200);
    expect((await detail.json() as any).members.some((m: any) => m.wallet_address === charlie.address.toLowerCase())).toBe(true);

    // Once approved, the same deep link returns a usable full conversation instead of an error.
    const joined = await app.request('/groups/join-by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlieToken}` },
      body: JSON.stringify({ token: invite.token }),
    }, env);
    expect(joined.status).toBe(201);
    const joinedData = await joined.json() as any;
    expect(joinedData.status).toBe('joined');
    expect(joinedData.already_member).toBe(true);
    expect(joinedData.conversation.id).toBe(group.id);

    const messages = await app.request(`/conversations/${group.id}/messages`, { headers: { Authorization: `Bearer ${aliceToken}` } }, env);
    expect((await messages.json() as any).messages.filter((m: any) => m.type === 'system').length).toBeGreaterThanOrEqual(2);
  });

  it('returns rejected without silently reapplying, then accepts an explicit retry', async () => {
    const group = await createGroup({ join_admin_only: true });
    const inviteRes = await app.request(`/groups/${group.id}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ max_uses: 1 }),
    }, env);
    const invite = await inviteRes.json() as any;
    const initial = await app.request('/groups/join-by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlieToken}` },
      body: JSON.stringify({ token: invite.token }),
    }, env);
    const initialRequest = (await initial.json() as any).request;
    const reject = await app.request(`/groups/${group.id}/join-requests/${initialRequest.id}/reject`, {
      method: 'POST', headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(reject.status).toBe(200);

    const rejected = await app.request('/groups/join-by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlieToken}` },
      body: JSON.stringify({ token: invite.token }),
    }, env);
    expect(rejected.status).toBe(200);
    const rejectedData = await rejected.json() as any;
    expect(rejectedData).toMatchObject({ status: 'rejected', pending: false, group: { id: group.id } });
    expect(rejectedData.request.id).toBe(initialRequest.id);

    const retry = await app.request('/groups/join-by-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlieToken}` },
      body: JSON.stringify({ token: invite.token, retry: true, message: 'Please review again' }),
    }, env);
    expect(retry.status).toBe(202);
    const retryData = await retry.json() as any;
    expect(retryData.status).toBe('pending');
    expect(retryData.request.id).not.toBe(initialRequest.id);
    expect(retryData.request.message).toBe('Please review again');
    const linkUsage = await db.prepare('SELECT uses_count FROM group_invite_links WHERE token = ?').bind(invite.token).first<{ uses_count: number }>();
    expect(linkUsage?.uses_count).toBe(1);
  });

  it('enforces invite usage limits and enforces join_admin_only for the legacy add-member route', async () => {
    const group = await createGroup({ join_admin_only: true });
    const directAdd = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ wallet_address: charlie.address }),
    }, env);
    expect(directAdd.status).toBe(403);
    expect((await directAdd.json() as any).error).toContain('approval');

    const openGroup = await createGroup();
    const inviteRes = await app.request(`/groups/${openGroup.id}/invite-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ max_uses: 1 }),
    }, env);
    const invite = await inviteRes.json() as any;
    const first = await app.request('/groups/join-by-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ token: invite.token }),
    }, env);
    expect(first.status).toBe(201);
    const second = await app.request('/groups/join-by-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlieToken}` },
      body: JSON.stringify({ token: invite.token }),
    }, env);
    expect(second.status).toBe(429);
  });

  it('transfers ownership atomically, demotes the old owner to admin, and permits that user to leave', async () => {
    const group = await createGroup({}, [bobUser.id]);
    const transfer = await app.request(`/groups/${group.id}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ new_owner_user_id: bobUser.id }),
    }, env);
    expect(transfer.status).toBe(200);
    expect((await transfer.json() as any).owner_address).toBe(bobUser.wallet_address);

    const after = await app.request(`/groups/${group.id}`, { headers: { Authorization: `Bearer ${bobToken}` } }, env);
    const members = (await after.json() as any).members;
    expect(members.find((m: any) => m.user_id === bobUser.id).role).toBe('owner');
    expect(members.find((m: any) => m.user_id === aliceUser.id).role).toBe('admin');

    const leave = await app.request(`/groups/${group.id}/leave`, {
      method: 'POST', headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(leave.status).toBe(200);
    expect((await leave.json() as any).message).toContain('Left group successfully');
  });
});
