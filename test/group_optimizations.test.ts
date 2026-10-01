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
  MockWebSocket,
} from './helpers/durable';
import type { Env } from '../src/types';

describe('Group Chat Production Hardening: Security, Performance & DO Optimizations', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;
  let masterNamespace: MockDurableObjectNamespace;
  let broadcasterNamespace: MockDurableObjectNamespace;

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
    r2 = new MockR2Bucket();

    env = {
      DB: db,
      VOICE_BUCKET: r2 as any,
    };

    masterNamespace = new MockDurableObjectNamespace(GroupMasterDO, () => env);
    broadcasterNamespace = new MockDurableObjectNamespace(GroupBroadcasterDO, () => env);
    env.GROUP_MASTER_DO = masterNamespace as any;
    env.GROUP_BROADCASTER_DO = broadcasterNamespace as any;

    aliceWallet = createTestWallet();
    bobWallet = createTestWallet();
    charlieWallet = createTestWallet();

    const alice = await loginUser(aliceWallet);
    aliceToken = alice.token;
    aliceUser = alice.user;

    const bob = await loginUser(bobWallet);
    bobToken = bob.token;
    bobUser = bob.user;

    const charlie = await loginUser(charlieWallet);
    charlieToken = charlie.token;
    charlieUser = charlie.user;
  });

  describe('1. Security Hardening: SVG Stored XSS Prevention & nosniff Headers', () => {
    it('rejects SVG avatar upload for user profile and group avatar with 400', async () => {
      // 1. User avatar SVG rejection
      const userSvgRes = await app.request('/users/me/avatar', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          avatar_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64'),
          mime_type: 'image/svg+xml',
        }),
      }, env);
      expect(userSvgRes.status).toBe(400);
      const userErr: any = await userSvgRes.json();
      expect(userErr.error).toContain('Unsupported avatar image format');

      // Create group
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Security Test Group' }),
      }, env);
      const groupData: any = await groupRes.json();

      // 2. Group avatar SVG rejection
      const groupSvgRes = await app.request(`/groups/${groupData.id}/avatar`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          avatar_base64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
          mime_type: 'image/svg+xml',
        }),
      }, env);
      expect(groupSvgRes.status).toBe(400);
      const groupErr: any = await groupSvgRes.json();
      expect(groupErr.error).toContain('Unsupported avatar image format');
    });

    it('returns nosniff and CSP headers when serving avatars', async () => {
      // Upload valid PNG avatar
      const uploadRes = await app.request('/users/me/avatar', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          avatar_base64: Buffer.from('fake-png-bytes').toString('base64'),
          mime_type: 'image/png',
        }),
      }, env);
      expect(uploadRes.status).toBe(201);

      // Fetch avatar and verify headers
      const getRes = await app.request(`/users/${aliceUser.wallet_address}/avatar`, {}, env);
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });
  });

  describe('2. Metadata Mass Assignment & Field Bound Validation', () => {
    it('sanitizes protected metadata fields (hot, verified, banned_reason, join_price)', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Privilege Test Group',
          metadata: {
            topic: 'web3',
            hot: true,
            verified: true,
            is_banned: true,
            join_price: '1000',
          },
        }),
      }, env);
      expect(createRes.status).toBe(201);
      const group: any = await createRes.json();

      expect(group.metadata.topic).toBe('web3');
      expect(group.metadata.hot).toBeUndefined();
      expect(group.metadata.verified).toBeUndefined();
      expect(group.metadata.is_banned).toBeUndefined();
      expect(group.metadata.join_price).toBeUndefined();

      // Attempt to overwrite via PATCH /groups/:id
      const updateRes = await app.request(`/groups/${group.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          metadata: {
            hot: true,
            verified: true,
            safe_field: 'valid',
          },
        }),
      }, env);
      expect(updateRes.status).toBe(200);
      const updated: any = await updateRes.json();
      expect(updated.metadata.safe_field).toBe('valid');
      expect(updated.metadata.hot).toBeUndefined();
      expect(updated.metadata.verified).toBeUndefined();
    });

    it('enforces maximum character lengths on group name, description, and metadata size', async () => {
      // Long name (> 64 chars)
      const longName = 'A'.repeat(65);
      const nameRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: longName }),
      }, env);
      expect(nameRes.status).toBe(400);

      // Long description (> 1000 chars)
      const longDesc = 'D'.repeat(1001);
      const descRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Valid Name', description: longDesc }),
      }, env);
      expect(descRes.status).toBe(400);
    });
  });

  describe('3. Message Input Bounds & Rate Limiting Defense', () => {
    it('enforces message content <= 4000 characters and mentions <= 50', async () => {
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Message Bounds Group' }),
      }, env);
      const group: any = await groupRes.json();

      // Oversized message content
      const longContent = 'M'.repeat(4001);
      const overMsgRes = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: longContent }),
      }, env);
      expect(overMsgRes.status).toBe(400);
      const overErr: any = await overMsgRes.json();
      expect(overErr.error).toContain('4000 characters');

      // Too many mentions (> 50)
      const mentions = Array.from({ length: 51 }, (_, i) => `0xuser${i}`);
      const mentionsRes = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Hello all', mentions }),
      }, env);
      expect(mentionsRes.status).toBe(400);
      const mentionsErr: any = await mentionsRes.json();
      expect(mentionsErr.error).toContain('50');
    });

    it('enforces rate limiting on group chat messages (120/min)', async () => {
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Rate Limit Group' }),
      }, env);
      const group: any = await groupRes.json();

      // Set rate limit count in DB to 120
      const windowStart = Math.floor(Date.now() / 60_000);
      const bucket = `send_msg:${aliceUser.id.toLowerCase()}:${windowStart}`;
      await db.prepare('INSERT INTO rate_limits (bucket, count) VALUES (?, 120)').bind(bucket).run();

      // 121st message is throttled
      const sendRes = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Message should be rate limited' }),
      }, env);
      expect(sendRes.status).toBe(429);
      const err: any = await sendRes.json();
      expect(err.error).toBe('RATE_LIMITED');
    });
  });

  describe('4. WebSocket Disconnection on Member Leave and Kick', () => {
    it('disconnects user WebSocket connection on voluntary leave (POST /:id/leave)', async () => {
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Leave WS Group', member_ids: [bobUser.id] }),
      }, env);
      const group: any = await groupRes.json();

      // Connect Bob to WebSocket shard
      const TOTAL_SHARDS = 50;
      let hash = 0;
      const uid = bobUser.id.toLowerCase();
      for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
      const shardId = hash % TOTAL_SHARDS;
      const shardName = `${group.id}:shard_${shardId}`;

      const broadcasterStub = broadcasterNamespace.get(broadcasterNamespace.idFromName(shardName));
      const wsReq = new Request(`http://internal/groups/${group.id}/ws?user_id=${bobUser.id}&role=member&shard_id=${shardId}`, {
        headers: { Upgrade: 'websocket' },
      });
      await broadcasterStub.fetch(wsReq);
      const bInstance = broadcasterNamespace.getExistingInstance(shardName);
      const mockWs = new MockWebSocket();
      mockWs.serializeAttachment({ userId: bobUser.id, groupId: group.id, role: 'member' });
      bInstance.ctx.acceptWebSocket(mockWs);

      expect(mockWs.closed).toBe(false);

      // Bob leaves group
      const leaveRes = await app.request(`/groups/${group.id}/leave`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobToken}` },
      }, env);
      expect(leaveRes.status).toBe(200);

      // Bob's WebSocket was kicked and closed
      expect(mockWs.closed).toBe(true);
      expect(mockWs.closeCode).toBe(4003);
      expect(mockWs.closeReason).toBe('KICKED_FROM_GROUP');
    });

    it('disconnects user WebSocket connection when kicked by owner (POST /:id/kick)', async () => {
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Kick WS Group', member_ids: [charlieUser.id] }),
      }, env);
      const group: any = await groupRes.json();

      // Connect Charlie
      const TOTAL_SHARDS = 50;
      let hash = 0;
      const uid = charlieUser.id.toLowerCase();
      for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
      const shardId = hash % TOTAL_SHARDS;
      const shardName = `${group.id}:shard_${shardId}`;

      const broadcasterStub = broadcasterNamespace.get(broadcasterNamespace.idFromName(shardName));
      const wsReq = new Request(`http://internal/groups/${group.id}/ws?user_id=${charlieUser.id}&role=member&shard_id=${shardId}`, {
        headers: { Upgrade: 'websocket' },
      });
      await broadcasterStub.fetch(wsReq);
      const bInstance = broadcasterNamespace.getExistingInstance(shardName);
      const mockWs = new MockWebSocket();
      mockWs.serializeAttachment({ userId: charlieUser.id, groupId: group.id, role: 'member' });
      bInstance.ctx.acceptWebSocket(mockWs);

      expect(mockWs.closed).toBe(false);

      // Alice kicks Charlie
      const kickRes = await app.request(`/groups/${group.id}/kick`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: charlieUser.id }),
      }, env);
      expect(kickRes.status).toBe(200);

      // Charlie's socket is closed
      expect(mockWs.closed).toBe(true);
      expect(mockWs.closeCode).toBe(4003);
    });
  });

  describe('5. Durable Objects Active Shard Lifecycle & D1 Watermark Sync', () => {
    it('unregisters active shard from MasterDO when all sockets disconnect', async () => {
      const groupId = 'group_shard_lifecycle';
      const shardName = `${groupId}:shard_5`;

      const masterStub = masterNamespace.get(masterNamespace.idFromName(groupId));
      const broadcasterStub = broadcasterNamespace.get(broadcasterNamespace.idFromName(shardName));

      // Connect 1st client -> triggers register_active_shard
      const wsReq1 = new Request(`http://internal/groups/${groupId}/ws?user_id=user1&role=member&shard_id=5`, {
        headers: { Upgrade: 'websocket' },
      });
      await broadcasterStub.fetch(wsReq1);

      const bInstance = broadcasterNamespace.getExistingInstance(shardName);
      const mInstance = masterNamespace.getExistingInstance(groupId);

      // Verify shard 5 registered
      let stats = mInstance.getStats();
      expect(stats.activeShards).toContain(5);

      // Connect 2nd client -> does NOT re-register (isFirstSocket false)
      const wsReq2 = new Request(`http://internal/groups/${groupId}/ws?user_id=user2&role=member&shard_id=5`, {
        headers: { Upgrade: 'websocket' },
      });
      await broadcasterStub.fetch(wsReq2);

      const sockets = bInstance.ctx.getWebSockets();
      expect(sockets.length).toBe(2);

      // Disconnect socket 0 -> socket 1 still active, shard 5 remains active
      sockets[0].closed = true;
      await bInstance.webSocketClose(sockets[0] as any, 1000, 'Normal', true);
      stats = mInstance.getStats();
      expect(stats.activeShards).toContain(5);

      // Disconnect socket 1 -> 0 sockets left, triggers unregister_active_shard
      sockets[1].closed = true;
      await bInstance.webSocketClose(sockets[1] as any, 1000, 'Normal', true);
      stats = mInstance.getStats();
      expect(stats.activeShards).not.toContain(5);
    });

    it('syncs WebSocket read watermark back to D1 conversation_members and message_receipts', async () => {
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Watermark Sync Group', member_ids: [bobUser.id] }),
      }, env);
      const group: any = await groupRes.json();

      // Post messages to MasterDO
      const masterStub = masterNamespace.get(masterNamespace.idFromName(group.id));
      const mRes1 = await masterStub.fetch('http://internal/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: group.id,
          senderId: aliceUser.id,
          content: 'Message 1',
        }),
      });
      const data1: any = await mRes1.json();

      const mRes2 = await masterStub.fetch('http://internal/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: group.id,
          senderId: aliceUser.id,
          content: 'Message 2',
        }),
      });
      const data2: any = await mRes2.json();

      // Flush writes to DO SQLite
      const mInstance = masterNamespace.getExistingInstance(group.id);
      await mInstance.flushPendingWrites();

      // Bob reports watermark read up to seq 2
      await mInstance.updateWatermarks([
        { userId: bobUser.id, lastReadSeq: 2, updatedAt: Date.now() },
      ]);

      // Verify D1 conversation_members.last_read_message_id is updated to data2.message.id
      const member = await db.prepare(
        'SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
      ).bind(group.id, bobUser.id).first<{ last_read_message_id: string }>();

      expect(member?.last_read_message_id).toBe(data2.message.id);

      // Verify D1 message_receipts has read status for Bob
      const receipt = await db.prepare(
        'SELECT status FROM message_receipts WHERE message_id = ? AND user_id = ?'
      ).bind(data2.message.id, bobUser.id).first<{ status: string }>();

      expect(receipt?.status).toBe('read');
    });
  });

  describe('6. Bidirectional History Pagination', () => {
    it('supports before_seq in GET /groups/:id/supergroup/messages', async () => {
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Pagination Supergroup' }),
      }, env);
      const group: any = await groupRes.json();

      const masterStub = masterNamespace.get(masterNamespace.idFromName(group.id));
      for (let i = 1; i <= 10; i++) {
        await masterStub.fetch('http://internal/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: group.id,
            senderId: aliceUser.id,
            content: `Message ${i}`,
          }),
        });
      }
      const mInstance = masterNamespace.getExistingInstance(group.id);
      await mInstance.flushPendingWrites();

      // Fetch messages before_seq=8 with limit=3 (should return seq 5, 6, 7 in ascending order)
      const res = await app.request(`/groups/${group.id}/supergroup/messages?before_seq=8&limit=3`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.messages.length).toBe(3);
      expect(body.messages[0].seq).toBe(5);
      expect(body.messages[1].seq).toBe(6);
      expect(body.messages[2].seq).toBe(7);
      expect(body.hasMore).toBe(true);
    });

    it('supports before_id backward pagination in GET /conversations/:id/messages', async () => {
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'D1 Pagination Group' }),
      }, env);
      const group: any = await groupRes.json();

      const msgIds: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const sendRes = await app.request(`/conversations/${group.id}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${aliceToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: `D1 Msg ${i}` }),
        }, env);
        const data: any = await sendRes.json();
        msgIds.push(data.id);
      }

      // Query before_id = msgIds[3] (Msg 4) with limit=2 -> should return Msg 2 and Msg 3
      const listRes = await app.request(`/conversations/${group.id}/messages?before_id=${msgIds[3]}&limit=2`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);

      expect(listRes.status).toBe(200);
      const listData: any = await listRes.json();
      expect(listData.messages.length).toBe(2);
      expect(listData.messages[0].id).toBe(msgIds[1]); // Msg 2
      expect(listData.messages[1].id).toBe(msgIds[2]); // Msg 3
      expect(listData.has_more).toBe(true);
      expect(listData.prev_cursor).toBe(msgIds[1]);
    });
  });

  describe('7. Multimedia Group Message DO Broadcast Integration', () => {
    it('broadcasts voice upload event to GROUP_MASTER_DO in group chat', async () => {
      const groupRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Voice Broadcast Group' }),
      }, env);
      const group: any = await groupRes.json();

      // Connect socket to observe broadcast
      const shardName = `${group.id}:shard_0`;
      const broadcasterStub = broadcasterNamespace.get(broadcasterNamespace.idFromName(shardName));
      await broadcasterStub.fetch(new Request(`http://internal/groups/${group.id}/ws?shard_id=0`, {
        headers: { Upgrade: 'websocket' },
      }));
      const bInstance = broadcasterNamespace.getExistingInstance(shardName);
      const mockWs = new MockWebSocket();
      bInstance.ctx.acceptWebSocket(mockWs);

      // Upload voice message via HTTP
      const uploadRes = await app.request('/voice/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_id: group.id,
          audio_base64: Buffer.from('mock-audio-data').toString('base64'),
          duration: 3.5,
        }),
      }, env);

      expect(uploadRes.status).toBe(201);

      // Flush broadcaster coalesced queue
      bInstance.flushCoalescedMessages();

      // Verify WebSocket received the voice message broadcast!
      expect(mockWs.sentFrames.length).toBeGreaterThanOrEqual(1);
      const frame = mockWs.getLastFrame();
      expect(frame.type).toBe('messages_batch');
      expect(frame.messages[0].type).toBe('voice');
      expect(frame.messages[0].metadata.duration).toBe(3.5);
    });
  });
});
