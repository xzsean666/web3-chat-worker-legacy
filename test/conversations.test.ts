import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Conversation & Group Management', () => {
  let db: D1Database;
  let env: Env;
  let aliceWallet: TestWallet;
  let bobWallet: TestWallet;
  let charlieWallet: TestWallet;
  let aliceToken: string;
  let bobToken: string;
  let charlieToken: string;
  let aliceUser: { id: string; wallet_address: string };
  let bobUser: { id: string; wallet_address: string };
  let charlieUser: { id: string; wallet_address: string };

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
      body: JSON.stringify({ wallet_address: wallet.address, signature }),
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

    aliceWallet = createTestWallet();
    bobWallet = createTestWallet();
    charlieWallet = createTestWallet();

    const aliceAuth = await loginUser(aliceWallet);
    aliceToken = aliceAuth.token;
    aliceUser = aliceAuth.user;

    const bobAuth = await loginUser(bobWallet);
    bobToken = bobAuth.token;
    bobUser = bobAuth.user;

    const charlieAuth = await loginUser(charlieWallet);
    charlieToken = charlieAuth.token;
    charlieUser = charlieAuth.user;
  });

  describe('Direct Conversations', () => {
    it('creates direct conversation between Alice and Bob', async () => {
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ target_user_id: bobUser.id }),
      }, env);

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.id).toBeDefined();
      expect(data.type).toBe('direct');
      expect(data.members.length).toBe(2);
      expect(data.members.map((m: any) => m.user_id)).toContain(aliceUser.id);
      expect(data.members.map((m: any) => m.user_id)).toContain(bobUser.id);
    });

    it('returns the same conversation when created again (idempotency)', async () => {
      const res1 = await app.request('/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ target_user_id: bobUser.id }),
      }, env);
      const conv1 = (await res1.json()) as any;

      const res2 = await app.request('/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({ target_user_id: aliceUser.id }),
      }, env);
      const conv2 = (await res2.json()) as any;

      expect(conv1.id).toBe(conv2.id);
    });

    it('rejects direct conversation with self', async () => {
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ target_user_id: aliceUser.id }),
      }, env);

      expect(res.status).toBe(400);
    });

    it('blocks non-members from viewing conversation details', async () => {
      const createRes = await app.request('/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ target_user_id: bobUser.id }),
      }, env);
      const conv = (await createRes.json()) as any;

      // Charlie attempts to view Alice and Bob's chat
      const res = await app.request(`/conversations/${conv.id}`, {
        headers: { Authorization: `Bearer ${charlieToken}` },
      }, env);

      expect(res.status).toBe(403);
    });
  });

  describe('Group Conversations', () => {
    it('creates group with creator as owner and allows listing', async () => {
      const res = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Core Team',
          member_ids: [bobUser.id],
        }),
      }, env);

      expect(res.status).toBe(201);
      const group = (await res.json()) as any;
      expect(group.name).toBe('Core Team');
      expect(group.type).toBe('group');
      expect(group.members.length).toBe(2);

      const owner = group.members.find((m: any) => m.user_id === aliceUser.id);
      expect(owner.role).toBe('owner');

      // Check listing
      const listRes = await app.request('/conversations', {
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);
      const listData = (await listRes.json()) as any;
      expect(listData.conversations.length).toBe(1);
      expect(listData.conversations[0].id).toBe(group.id);
    });

    it('allows owner to rename group, but forbids regular member', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Old Name',
          member_ids: [bobUser.id],
        }),
      }, env);
      const group = (await createRes.json()) as any;

      // Bob (member) attempts to rename
      const bobRes = await app.request(`/groups/${group.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({ name: 'Bob Hacked This' }),
      }, env);
      expect(bobRes.status).toBe(403);

      // Alice (owner) renames
      const aliceRes = await app.request(`/groups/${group.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ name: 'New Brand Name' }),
      }, env);
      expect(aliceRes.status).toBe(200);
      const updated = (await aliceRes.json()) as any;
      expect(updated.name).toBe('New Brand Name');
    });

    it('allows only owner to manage members, forbids non-owners, and allows members to leave', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ name: 'Devs' }),
      }, env);
      const group = (await createRes.json()) as any;
      expect(group.id).toMatch(new RegExp('^' + aliceUser.id + ':'));

      // Alice (owner) adds Bob
      const addBobRes = await app.request(`/groups/${group.id}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ user_id: bobUser.id }),
      }, env);
      expect(addBobRes.status).toBe(201);

      // Bob (member) attempts to add Charlie -> 403 Forbidden
      const addCharlieByBob = await app.request(`/groups/${group.id}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({ user_id: charlieUser.id }),
      }, env);
      expect(addCharlieByBob.status).toBe(403);

      // Alice (owner) adds Charlie -> 201
      const addCharlieByAlice = await app.request(`/groups/${group.id}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ user_id: charlieUser.id }),
      }, env);
      expect(addCharlieByAlice.status).toBe(201);

      // Charlie (regular member) tries to remove Bob -> 403
      const kickRes = await app.request(`/groups/${group.id}/members/${bobUser.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${charlieToken}` },
      }, env);
      expect(kickRes.status).toBe(403);

      // Charlie leaves voluntarily -> 200
      const leaveRes = await app.request(`/groups/${group.id}/members/${charlieUser.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${charlieToken}` },
      }, env);
      expect(leaveRes.status).toBe(200);

      // Alice (owner) leaves -> group is deleted (immutable ownership)
      const ownerLeaveRes = await app.request(`/groups/${group.id}/members/${aliceUser.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);
      expect(ownerLeaveRes.status).toBe(200);
      const ownerLeaveData = (await ownerLeaveRes.json()) as any;
      expect(ownerLeaveData.message).toContain('deleted as owner left');
    });
  });
});
