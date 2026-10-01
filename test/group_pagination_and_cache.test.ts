import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { MockR2Bucket } from './helpers/r2';
import { GroupMasterDO } from '../src/durable/GroupMasterDO';
import { GroupBroadcasterDO } from '../src/durable/GroupBroadcasterDO';
import {
  MockDurableObjectState,
  MockDurableObjectNamespace,
} from './helpers/durable';
import { computeNextTier, getGroupCapacityInfo, insertMemberWithCapacity } from '../src/services/payments/capacity';
import type { Env } from '../src/types';

describe('Group Chat End-to-End Optimization: Cursor Pagination, Cache Invalidation & Supergroup Capacity', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;
  let masterNamespace: MockDurableObjectNamespace;
  let broadcasterNamespace: MockDurableObjectNamespace;

  let ownerWallet: TestWallet;
  let memberWallets: TestWallet[] = [];
  let ownerToken: string;
  let ownerUser: { id: string; wallet_address: string };

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
    r2 = new MockR2Bucket();

    env = {
      DB: db,
      VOICE_BUCKET: r2 as any,
    };

    masterNamespace = new MockDurableObjectNamespace(GroupMasterDO, () => env);
    broadcasterNamespace = new MockDurableObjectNamespace(GroupBroadcasterDO, () => env);

    env.GROUP_MASTER_DO = masterNamespace as any;
    env.GROUP_BROADCASTER_DO = broadcasterNamespace as any;

    ownerWallet = createTestWallet();
    const ownerAuth = await loginUser(ownerWallet);
    ownerToken = ownerAuth.token;
    ownerUser = ownerAuth.user;

    memberWallets = [
      createTestWallet(),
      createTestWallet(),
      createTestWallet(),
      createTestWallet(),
    ];
  });

  describe('1. Group Member Cursor Pagination (GET /groups/:id/members)', () => {
    it('paginates group members seamlessly with limit and cursor, maintaining total and ordering', async () => {
      // 1. Create a group
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ name: 'Pagination Test Group' }),
      }, env);
      expect(createRes.status).toBe(201);
      const group = (await createRes.json()) as any;

      // 2. Add 4 more members (total 5: owner + 4 members)
      for (let i = 0; i < memberWallets.length; i++) {
        const memberAuth = await loginUser(memberWallets[i]);
        const addRes = await app.request(`/groups/${group.id}/members`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerToken}`,
          },
          body: JSON.stringify({ wallet_address: memberWallets[i].address }),
        }, env);
        expect(addRes.status).toBe(201);
      }

      // 3. Test unpaginated fetch (backward compatibility)
      const allRes = await app.request(`/groups/${group.id}/members`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }, env);
      expect(allRes.status).toBe(200);
      const allData = (await allRes.json()) as any;
      expect(allData.members).toBeInstanceOf(Array);
      expect(allData.members.length).toBe(5);
      expect(allData.total).toBe(5);
      expect(allData.has_more).toBe(false);
      expect(allData.next_cursor).toBeNull();

      // 4. Page 1: limit = 2
      const page1Res = await app.request(`/groups/${group.id}/members?limit=2`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }, env);
      expect(page1Res.status).toBe(200);
      const page1 = (await page1Res.json()) as any;
      expect(page1.members.length).toBe(2);
      expect(page1.total).toBe(5);
      expect(page1.has_more).toBe(true);
      expect(page1.next_cursor).toBeTruthy();

      // 5. Page 2: limit = 2 with cursor from Page 1
      const page2Res = await app.request(`/groups/${group.id}/members?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }, env);
      expect(page2Res.status).toBe(200);
      const page2 = (await page2Res.json()) as any;
      expect(page2.members.length).toBe(2);
      expect(page2.total).toBe(5);
      expect(page2.has_more).toBe(true);
      expect(page2.next_cursor).toBeTruthy();

      // Assert no overlap between Page 1 and Page 2 members
      const page1Ids = page1.members.map((m: any) => m.user_id);
      const page2Ids = page2.members.map((m: any) => m.user_id);
      for (const id of page2Ids) {
        expect(page1Ids.includes(id)).toBe(false);
      }

      // 6. Page 3: limit = 2 with cursor from Page 2
      const page3Res = await app.request(`/groups/${group.id}/members?limit=2&cursor=${encodeURIComponent(page2.next_cursor)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }, env);
      expect(page3Res.status).toBe(200);
      const page3 = (await page3Res.json()) as any;
      expect(page3.members.length).toBe(1); // 5th member
      expect(page3.total).toBe(5);
      expect(page3.has_more).toBe(false);
      expect(page3.next_cursor).toBeNull();
    });
  });

  describe('2. MasterDO Instant In-Memory Cache Invalidation & Security Guard', () => {
    it('invalidates kicked users immediately in memory and rejects message posting', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      // Post a message initially -> succeeds
      const msg1 = await master.postMessage({
        conversationId: 'group_test_cache',
        senderId: '0xuser_alice',
        content: 'Hello World',
        skipD1WriteBack: true,
      });
      expect(msg1.seq).toBe(1);

      // Invalidate cache: kick user_alice
      master.invalidateUserCache('0xuser_alice', 'kick');

      // Attempt to post message -> blocked by in-memory kickedUsers guard
      await expect(
        master.postMessage({
          conversationId: 'group_test_cache',
          senderId: '0xuser_alice',
          content: 'I should be blocked',
          skipD1WriteBack: true,
        })
      ).rejects.toThrow('Unauthorized: you are not a member of this group');

      // User rejoins group
      master.invalidateUserCache('0xuser_alice', 'join');

      // Post message now succeeds
      const msg2 = await master.postMessage({
        conversationId: 'group_test_cache',
        senderId: '0xuser_alice',
        content: 'I am back',
        skipD1WriteBack: true,
      });
      expect(msg2.seq).toBe(2);
    });

    it('enforces group-wide and individual member mute via DO memory cache', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      // 1. Group-wide mute
      master.invalidateUserCache('*', 'mute', Date.now() + 60_000);

      // Normal member is rejected
      await expect(
        master.postMessage({
          conversationId: 'group_test_mute',
          senderId: '0xmember_1',
          content: 'Hello?',
          skipD1WriteBack: true,
        })
      ).rejects.toThrow('Group is muted');

      // Admin or owner bypasses group mute
      const adminMsg = await master.postMessage({
        conversationId: 'group_test_mute',
        senderId: '0xadmin_1',
        content: 'Admin announcement',
        isAdminOrOwner: true,
        skipD1WriteBack: true,
      });
      expect(adminMsg.seq).toBe(1);

      // Group unmuted
      master.invalidateUserCache('*', 'unmute');
      const normalMsg = await master.postMessage({
        conversationId: 'group_test_mute',
        senderId: '0xmember_1',
        content: 'I can speak now',
        skipD1WriteBack: true,
      });
      expect(normalMsg.seq).toBe(2);

      // 2. Individual member mute
      master.invalidateUserCache('0xmember_1', 'mute', -1);
      await expect(
        master.postMessage({
          conversationId: 'group_test_mute',
          senderId: '0xmember_1',
          content: 'Muted message',
          skipD1WriteBack: true,
        })
      ).rejects.toThrow('You are muted in this group');

      // Individual unmute
      master.invalidateUserCache('0xmember_1', 'unmute');
      const unmutedMsg = await master.postMessage({
        conversationId: 'group_test_mute',
        senderId: '0xmember_1',
        content: 'I was unmuted',
        skipD1WriteBack: true,
      });
      expect(unmutedMsg.seq).toBe(3);
    });

    it('serves POST /invalidate_cache over RPC fetch', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      const res = await master.fetch(
        new Request('http://internal/invalidate_cache', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: '0xbad_actor', action: 'kick' }),
        })
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);

      // Verify that 0xbad_actor is kicked in memory
      await expect(
        master.postMessage({
          conversationId: 'group_rpc_cache',
          senderId: '0xbad_actor',
          content: 'spam',
          skipD1WriteBack: true,
        })
      ).rejects.toThrow('Unauthorized: you are not a member of this group');
    });
  });

  describe('3. Supergroup Capacity Escalation Tiers', () => {
    it('computes standard tier escalation up to 500, and supergroup escalation up to 100K', async () => {
      // Standard group: 50 -> 100 -> 200 -> 300 -> 400 -> 500 -> null
      expect(await computeNextTier(db, 50)).toBe(100);
      expect(await computeNextTier(db, 100)).toBe(200);
      expect(await computeNextTier(db, 200)).toBe(300);
      expect(await computeNextTier(db, 300)).toBe(400);
      expect(await computeNextTier(db, 400)).toBe(500);
      expect(await computeNextTier(db, 500)).toBeNull(); // Standard ceiling

      // Supergroup escalation: 500 -> 1000 -> 2000 -> 5000 -> 10000 -> 50000 -> 100000 -> null
      expect(await computeNextTier(db, 500, true)).toBe(1000);
      expect(await computeNextTier(db, 1000, true)).toBe(2000);
      expect(await computeNextTier(db, 2000, true)).toBe(5000);
      expect(await computeNextTier(db, 5000, true)).toBe(10000);
      expect(await computeNextTier(db, 10000, true)).toBe(50000);
      expect(await computeNextTier(db, 50000, true)).toBe(100000);
      expect(await computeNextTier(db, 100000, true)).toBeNull(); // Supergroup ceiling
    });

    it('identifies supergroups via metadata is_supergroup and allows higher capacity tiers', async () => {
      // Create a supergroup
      const res = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          name: '100K Community Channel',
          metadata: { is_supergroup: true },
        }),
      }, env);
      expect(res.status).toBe(201);
      const group = (await res.json()) as any;

      // Check capacity info
      const info = await getGroupCapacityInfo(db, group.id);
      expect(info.isSupergroup).toBe(true);

      // Set capacity entitlement to 1000
      await db.prepare(
        'INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES (?, 1000, 1, ?)'
      ).bind(group.id, new Date().toISOString()).run();

      const updatedInfo = await getGroupCapacityInfo(db, group.id);
      expect(updatedInfo.capacity).toBe(1000);
      expect(updatedInfo.isSupergroup).toBe(true);

      const nextTier = await computeNextTier(db, updatedInfo.capacity, updatedInfo.isSupergroup);
      expect(nextTier).toBe(2000);
    });
  });
});
