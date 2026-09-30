import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { makeMutualFriends } from './helpers/friends';
import type { Env } from '../src/types';

describe('Group Member Nickname (group_nickname on member-group relation)', () => {
  let db: D1Database;
  let env: Env;
  let aliceToken: string;
  let bobToken: string;
  let charlieToken: string;
  let aliceUser: { id: string; wallet_address: string };
  let bobUser: { id: string; wallet_address: string };
  let charlieUser: { id: string; wallet_address: string };
  let groupId: string;

  async function loginUser(wallet: TestWallet) {
    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, env);
    const nonceData = (await nonceRes.json()) as { nonce: string; message: string };
    const signature = await wallet.signMessage(nonceData.message);

    const verifyRes = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address, signature, nonce: nonceData.nonce }),
    }, env);
    const data = (await verifyRes.json()) as { token: string; user: { id: string; wallet_address: string } };
    return { token: data.token, user: data.user };
  }

  beforeEach(async () => {
    db = createMockD1Database(true);
    env = {
      DB: db,
      VOICE_BUCKET: {} as any,
    };

    const aliceAuth = await loginUser(createTestWallet());
    aliceToken = aliceAuth.token;
    aliceUser = aliceAuth.user;

    const bobAuth = await loginUser(createTestWallet());
    bobToken = bobAuth.token;
    bobUser = bobAuth.user;

    const charlieAuth = await loginUser(createTestWallet());
    charlieToken = charlieAuth.token;
    charlieUser = charlieAuth.user;

    // Group: Alice (owner), Bob and Charlie (members)
    const groupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ name: 'Nickname Club', member_ids: [bobUser.id, charlieUser.id] }),
    }, env);
    const group = (await groupRes.json()) as { id: string };
    groupId = group.id;
  });

  it('lets a member set their own per-group nickname and returns it everywhere', async () => {
    // Bob sets his nickname in this group
    const patchRes = await app.request(`/groups/${groupId}/members/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ group_nickname: '  Bobby in this group  ' }),
    }, env);
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as any;
    expect(patched.user_id).toBe(bobUser.id);
    expect(patched.group_nickname).toBe('Bobby in this group'); // trimmed

    // GET /groups/:id -> members carry group_nickname
    const detailRes = await app.request(`/groups/${groupId}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as any;
    expect(detail.type).toBe('group');
    const bobInDetail = detail.members.find((m: any) => m.user_id === bobUser.id);
    expect(bobInDetail.group_nickname).toBe('Bobby in this group');
    const aliceInDetail = detail.members.find((m: any) => m.user_id === aliceUser.id);
    expect(aliceInDetail.group_nickname).toBeNull();

    // GET /groups/:id/members -> same data
    const membersRes = await app.request(`/groups/${groupId}/members`, {
      headers: { Authorization: `Bearer ${charlieToken}` },
    }, env);
    expect(membersRes.status).toBe(200);
    const membersData = (await membersRes.json()) as any;
    const bobInMembers = membersData.members.find((m: any) => m.user_id === bobUser.id);
    expect(bobInMembers.group_nickname).toBe('Bobby in this group');

    // GET /conversations -> each entry carries MY nickname in that group
    const bobListRes = await app.request('/conversations', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    const bobList = (await bobListRes.json()) as any;
    const bobGroupEntry = bobList.conversations.find((c: any) => c.id === groupId);
    expect(bobGroupEntry.group_nickname).toBe('Bobby in this group');

    const aliceListRes = await app.request('/conversations', {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    const aliceList = (await aliceListRes.json()) as any;
    const aliceGroupEntry = aliceList.conversations.find((c: any) => c.id === groupId);
    expect(aliceGroupEntry.group_nickname).toBeNull();

    // GET /conversations/:id (existing detail endpoint) also includes nicknames
    const convDetailRes = await app.request(`/conversations/${groupId}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    const convDetail = (await convDetailRes.json()) as any;
    expect(convDetail.members.find((m: any) => m.user_id === bobUser.id).group_nickname)
      .toBe('Bobby in this group');
  });

  it('clears the nickname with null or empty string', async () => {
    await app.request(`/groups/${groupId}/members/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ group_nickname: 'Temp Nick' }),
    }, env);

    const clearRes = await app.request(`/groups/${groupId}/members/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ group_nickname: '   ' }),
    }, env);
    expect(clearRes.status).toBe(200);
    const cleared = (await clearRes.json()) as any;
    expect(cleared.group_nickname).toBeNull();
  });

  it('rejects invalid usage', async () => {
    // Missing field -> 400
    const missingRes = await app.request(`/groups/${groupId}/members/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({}),
    }, env);
    expect(missingRes.status).toBe(400);

    // Too long -> 400
    const longRes = await app.request(`/groups/${groupId}/members/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ group_nickname: 'x'.repeat(65) }),
    }, env);
    expect(longRes.status).toBe(400);

    // Non-member cannot set nickname -> 403
    const eveAuth = await loginUser(createTestWallet());
    const nonMemberRes = await app.request(`/groups/${groupId}/members/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${eveAuth.token}` },
      body: JSON.stringify({ group_nickname: 'Intruder' }),
    }, env);
    expect(nonMemberRes.status).toBe(403);

    // Non-member cannot list members -> 403
    const nonMemberList = await app.request(`/groups/${groupId}/members`, {
      headers: { Authorization: `Bearer ${eveAuth.token}` },
    }, env);
    expect(nonMemberList.status).toBe(403);

    // Direct conversation is not a group -> 404
    await makeMutualFriends(env, aliceToken, aliceUser.id, bobToken, bobUser.id);
    const directRes = await app.request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ target_user_id: bobUser.id }),
    }, env);
    const direct = (await directRes.json()) as { id: string };

    const directPatch = await app.request(`/groups/${direct.id}/members/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ group_nickname: 'Nope' }),
    }, env);
    expect(directPatch.status).toBe(404);

    const directGet = await app.request(`/groups/${direct.id}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(directGet.status).toBe(404);
  });
});
