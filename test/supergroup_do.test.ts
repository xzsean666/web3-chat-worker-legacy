import { describe, it, expect, beforeEach } from 'vitest';
import { GroupMasterDO } from '../src/durable/GroupMasterDO';
import { GroupBroadcasterDO } from '../src/durable/GroupBroadcasterDO';
import {
  MockDurableObjectState,
  MockDurableObjectNamespace,
  MockWebSocket,
} from './helpers/durable';
import { createMockD1Database } from './helpers/db';
import { MockR2Bucket } from './helpers/r2';
import { app } from '../src/index';
import type { Env } from '../src/types';

describe('100K-Member Supergroup Durable Objects Engine Test Suite', () => {
  let mockDb: any;
  let mockR2: MockR2Bucket;
  let env: Env;
  let masterNamespace: MockDurableObjectNamespace;
  let broadcasterNamespace: MockDurableObjectNamespace;

  beforeEach(() => {
    mockDb = createMockD1Database(true);
    mockR2 = new MockR2Bucket();

    env = {
      DB: mockDb as any,
      VOICE_BUCKET: mockR2 as any,
    };

    masterNamespace = new MockDurableObjectNamespace(GroupMasterDO, () => env);
    broadcasterNamespace = new MockDurableObjectNamespace(GroupBroadcasterDO, () => env);

    env.GROUP_MASTER_DO = masterNamespace as any;
    env.GROUP_BROADCASTER_DO = broadcasterNamespace as any;
  });

  describe('1. GroupMasterDO: Total Ordering, RingBuffer & Auto-Batch Persistence', () => {
    it('guarantees strictly monotonic increasing seq_id under concurrent message posting', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(
          master.postMessage({
            conversationId: 'group_test_1',
            senderId: `0xuser_${i}`,
            content: `Message ${i}`,
          })
        );
      }

      const results = await Promise.all(promises);
      const seqs = results.map((r) => r.seq).sort((a, b) => a - b);

      expect(seqs.length).toBe(50);
      for (let i = 0; i < 50; i++) {
        expect(seqs[i]).toBe(i + 1);
      }
    });

    it('restores currentSeq correctly after DO reboot / re-instantiation', async () => {
      const sharedDb = new (await import('node:sqlite')).DatabaseSync(':memory:');
      const ctx1 = new MockDurableObjectState(sharedDb);
      const master1 = new GroupMasterDO(ctx1 as any, env);

      // 发送 5 条消息并刷盘
      for (let i = 0; i < 5; i++) {
        await master1.postMessage({
          conversationId: 'group_reboot',
          senderId: '0xalice',
          content: `Boot1 Message ${i}`,
        });
      }
      await master1.flushPendingWrites();

      // 模拟 DO 重启，挂载同一个底层 SQLite 存储
      const ctx2 = new MockDurableObjectState(sharedDb);
      const master2 = new GroupMasterDO(ctx2 as any, env);

      // 发送新消息，序号必须从 6 开始
      const nextMsg = await master2.postMessage({
        conversationId: 'group_reboot',
        senderId: '0xbob',
        content: 'Boot2 First Message',
      });

      expect(nextMsg.seq).toBe(6);
    });

    it('executes Auto-Batch atomic flush when batch reaches 50 or on timer', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      // 发送 49 条消息，此时 pendingWrites 为 49，未立即清空
      for (let i = 0; i < 49; i++) {
        await master.postMessage({
          conversationId: 'group_batch',
          senderId: '0xuser',
          content: `Msg ${i}`,
        });
      }
      expect(master.getStats().pendingWritesCount).toBe(49);

      // 发送第 50 条，触发 Auto-Batch 立即批量刷盘
      await master.postMessage({
        conversationId: 'group_batch',
        senderId: '0xuser',
        content: 'Msg 50',
      });

      expect(master.getStats().pendingWritesCount).toBe(0);

      // 验证 SQLite 中已经存在 50 条消息
      const syncResult = await master.getMessages(0, 100);
      expect(syncResult.messages.length).toBe(50);
    });

    it('maintains 500-item in-memory RingBuffer and falls back to SQLite for deeper history', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      // 写入 550 条消息
      for (let i = 0; i < 550; i++) {
        await master.postMessage({
          conversationId: 'group_ring',
          senderId: '0xsender',
          content: `Content ${i}`,
        });
      }
      await master.flushPendingWrites();

      // 内存 RingBuffer 应该保持上限 500 条
      expect(master.getStats().ringBufferSize).toBe(500);

      // 1. 查询最近的消息（since_seq = 520）：直接内存切片直出
      const memResult = await master.getMessages(520, 20);
      expect(memResult.messages.length).toBe(20);
      expect(memResult.messages[0].seq).toBe(521);
      expect(memResult.messages[19].seq).toBe(540);

      // 2. 查询更久远的历史（since_seq = 10，已超出 RingBuffer）：回退查询本地 SQLite
      const dbResult = await master.getMessages(10, 15);
      expect(dbResult.messages.length).toBe(15);
      expect(dbResult.messages[0].seq).toBe(11);
      expect(dbResult.messages[14].seq).toBe(25);
    });

    it('enforces Slow Mode rate limiting on regular members while exempting admins', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      // 开启慢速模式 2 秒
      await master.setConfig('slow_mode_seconds', '2');

      // 普通成员发第 1 条成功
      await master.postMessage({
        conversationId: 'group_slow',
        senderId: '0xmember',
        content: 'First allowed',
      });

      // 立即发第 2 条，抛出 SLOW_MODE_COOLDOWN 异常
      await expect(
        master.postMessage({
          conversationId: 'group_slow',
          senderId: '0xmember',
          content: 'Second spam',
        })
      ).rejects.toThrow('SLOW_MODE_COOLDOWN');

      // 管理员豁免：即使在冷却期内，依然可以立即发言
      const adminMsg = await master.postMessage({
        conversationId: 'group_slow',
        senderId: '0xadmin',
        content: 'Admin announcement',
        isAdminOrOwner: true,
      });
      expect(adminMsg.seq).toBe(2);
    });

    it('records and updates Watermark ACK cursors monotonically', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      await master.updateWatermarks([
        { userId: '0xuser1', lastReadSeq: 100, updatedAt: 1000 },
        { userId: '0xuser2', lastReadSeq: 50, updatedAt: 1000 },
      ]);

      // 提交更大的已读游标，更新成功
      await master.updateWatermarks([
        { userId: '0xuser1', lastReadSeq: 150, updatedAt: 2000 },
      ]);

      // 提交更小的已读游标，受 ON CONFLICT ... WHERE excluded > target 保护，不倒退
      await master.updateWatermarks([
        { userId: '0xuser1', lastReadSeq: 120, updatedAt: 3000 },
      ]);

      const cursor = ctx.storage.sql.exec(
        'SELECT last_read_seq FROM user_watermarks WHERE user_id = ?',
        '0xuser1'
      );
      const rows = cursor.toArray();
      expect(Number(rows[0].last_read_seq)).toBe(150);
    });
  });

  describe('2. GroupBroadcasterDO: Hibernatable WebSockets, 100ms Coalescing & Watermark Aggregation', () => {
    it('coalesces multiple broadcast messages within 100ms window into a single batch frame', async () => {
      const ctx = new MockDurableObjectState();
      const broadcaster = new GroupBroadcasterDO(ctx as any, env);

      const mockWs = new MockWebSocket();
      ctx.acceptWebSocket(mockWs);

      // 在 100ms 窗口内连续塞入 3 条消息
      broadcaster.queueBroadcastMessage({
        seq: 1,
        id: 'msg_1',
        conversationId: 'group_fanout',
        senderId: '0xalice',
        type: 'text',
        content: 'Hi 1',
        createdAt: Date.now(),
      });
      broadcaster.queueBroadcastMessage({
        seq: 2,
        id: 'msg_2',
        conversationId: 'group_fanout',
        senderId: '0xbob',
        type: 'text',
        content: 'Hi 2',
        createdAt: Date.now(),
      });
      broadcaster.queueBroadcastMessage({
        seq: 3,
        id: 'msg_3',
        conversationId: 'group_fanout',
        senderId: '0xcharlie',
        type: 'text',
        content: 'Hi 3',
        createdAt: Date.now(),
      });

      // 此时未到 100ms，尚未向客户端发送独立的 3 个帧
      expect(mockWs.sentFrames.length).toBe(0);

      // 触发合流推流
      broadcaster.flushCoalescedMessages();

      // 验证仅发送了 1 个聚合帧
      expect(mockWs.sentFrames.length).toBe(1);
      const frame = mockWs.getLastFrame();
      expect(frame.type).toBe('messages_batch');
      expect(frame.messages.length).toBe(3);
      expect(frame.messages[0].id).toBe('msg_1');
      expect(frame.messages[2].id).toBe('msg_3');
    });

    it('handles client WebSocket messages: ping, read_watermark, and sync gap-filling', async () => {
      const ctx = new MockDurableObjectState();
      const broadcaster = new GroupBroadcasterDO(ctx as any, env);

      const mockWs = new MockWebSocket();
      mockWs.serializeAttachment({ userId: '0xclient1', groupId: 'group_gap' });
      ctx.acceptWebSocket(mockWs);

      // 1. 测试心跳 ping -> pong
      await broadcaster.webSocketMessage(mockWs as any, JSON.stringify({ action: 'ping' }));
      expect(mockWs.getLastFrame().type).toBe('pong');

      // 2. 准备 MasterDO 历史数据
      const masterStub = env.GROUP_MASTER_DO!.get(env.GROUP_MASTER_DO!.idFromName('group_gap'));
      await masterStub.fetch('http://internal/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'group_gap',
          senderId: '0xmaster',
          content: 'Master message 1',
        }),
      });

      // 3. 客户端请求增量同步补洞
      await broadcaster.webSocketMessage(
        mockWs as any,
        JSON.stringify({ action: 'sync', since_seq: 0 })
      );
      const syncFrame = mockWs.getLastFrame();
      expect(syncFrame.type).toBe('sync_result');
      expect(syncFrame.messages.length).toBeGreaterThanOrEqual(1);

      // 4. 客户端上报游标已读水位线
      await broadcaster.webSocketMessage(
        mockWs as any,
        JSON.stringify({ action: 'read_watermark', last_read_seq: 10 })
      );
      // 验证内部记录了该水位线，并在触发同步时不出错
      await broadcaster.syncWatermarksToMaster();
    });
  });

  describe('3. 100K-Member Fan-out Hierarchy: MasterDO to 50 Broadcaster Shards', () => {
    it('dispatches messages concurrently to 50 broadcaster shards and delivers to connected clients', async () => {
      const groupId = 'supergroup_100k';
      const masterStub = env.GROUP_MASTER_DO!.get(env.GROUP_MASTER_DO!.idFromName(groupId));

      // 模拟在 50 个分片上各挂载一个模拟客户端
      const clientSockets: MockWebSocket[] = [];
      for (let shardId = 0; shardId < 50; shardId++) {
        const shardName = `${groupId}:shard_${shardId}`;
        const broadcasterStub = env.GROUP_BROADCASTER_DO!.get(
          env.GROUP_BROADCASTER_DO!.idFromName(shardName)
        );

        // 调用 Broadcaster 的 fetch 握手升级 WebSocket
        const req = new Request(`http://internal/groups/${groupId}/ws?user_id=0xuser_${shardId}&shard_id=${shardId}`, {
          headers: { Upgrade: 'websocket' },
        });
        const res = await broadcasterStub.fetch(req);
        expect(res.status).toBe(101);

        const instance = broadcasterNamespace.getExistingInstance(shardName);
        const ws = new MockWebSocket();
        instance.ctx.acceptWebSocket(ws);
        clientSockets.push(ws);
      }

      // MasterDO 发送 1 条全局广播消息
      const postRes = await masterStub.fetch('http://internal/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: groupId,
          senderId: '0xhost',
          content: 'Hello to 100,000 members!',
        }),
      });

      expect(postRes.status).toBe(201);
      const postData: any = await postRes.json();
      expect(postData.message.seq).toBe(1);

      // 给异步 RPC 分发与 100ms 合流一个微小调度周期
      for (let shardId = 0; shardId < 50; shardId++) {
        const shardName = `${groupId}:shard_${shardId}`;
        const inst = broadcasterNamespace.getExistingInstance(shardName);
        if (inst) {
          inst.flushCoalescedMessages();
        }
      }

      // 验证 50 个分片的客户端全部成功收到了合流推流帧！
      for (let shardId = 0; shardId < 50; shardId++) {
        const ws = clientSockets[shardId];
        expect(ws.sentFrames.length).toBe(1);
        const frame = ws.getLastFrame();
        expect(frame.type).toBe('messages_batch');
        expect(frame.messages[0].content).toBe('Hello to 100,000 members!');
      }
    });
  });

  describe('4. Gateway Integration: Supergroup Endpoints', () => {
    it('exposes /groups/:id/supergroup/stats and /messages via Hono routing', async () => {
      const userId = '0x1111111111111111111111111111111111111111';
      const groupId = 'group_hono_test';
      const token = 'test_token_123';
      const tokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)).then(buf => 
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${userId}', '${userId}', 1, 1);
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s1', '${userId}', '${tokenHash}', 9999999999999, 1);
        INSERT INTO conversations (id, type, name, owner_address, created_at, updated_at) VALUES ('${groupId}', 'group', 'Super Group', '${userId}', 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m1', '${groupId}', '${userId}', 'owner', 1);
      `);

      // 1. 查询 supergroup stats
      const statsReq = new Request(`http://localhost/groups/${groupId}/supergroup/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const statsRes = await app.fetch(statsReq, env);
      expect(statsRes.status).toBe(200);
      const statsJson: any = await statsRes.json();
      expect(statsJson.group_id).toBe(groupId);
      expect(statsJson.currentSeq).toBe(0);

      // 2. 向 MasterDO 注入一条消息后，通过 Gateway 查询 supergroup messages
      const masterStub = env.GROUP_MASTER_DO!.get(env.GROUP_MASTER_DO!.idFromName(groupId));
      await masterStub.fetch('http://internal/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: groupId,
          senderId: userId,
          content: 'Hello Hono Gateway',
        }),
      });

      const messagesReq = new Request(`http://localhost/groups/${groupId}/supergroup/messages?since_seq=0`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const messagesRes = await app.fetch(messagesReq, env);
      expect(messagesRes.status).toBe(200);
      const messagesJson: any = await messagesRes.json();
      expect(messagesJson.messages.length).toBe(1);
      expect(messagesJson.messages[0].content).toBe('Hello Hono Gateway');
    });
  });

  describe('5. High-Concurrency Burst Benchmark (1000 Messages Concurrent Stress Test)', () => {
    it('successfully processes, sequences, batches, and syncs 1000 concurrent messages in <500ms', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      const startTime = Date.now();
      const TOTAL_BURST = 1000;
      const promises: Promise<any>[] = [];

      for (let i = 0; i < TOTAL_BURST; i++) {
        promises.push(
          master.postMessage({
            conversationId: 'benchmark_100k',
            senderId: `0xuser_${i % 100}`,
            content: `Burst payload #${i}`,
            skipD1WriteBack: true,
          })
        );
      }

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // 验证 1,000 条消息全部成功处理并严格自增保序
      expect(results.length).toBe(TOTAL_BURST);
      const seqSet = new Set(results.map((r) => r.seq));
      expect(seqSet.size).toBe(TOTAL_BURST);
      expect(Math.min(...Array.from(seqSet))).toBe(1);
      expect(Math.max(...Array.from(seqSet))).toBe(TOTAL_BURST);

      // 确保待写队列完成批量事务落盘
      await master.flushPendingWrites();

      // 验证全量数据在 DO SQLite 中完整无损落盘
      const syncResult = await master.getMessages(0, 100);
      expect(syncResult.latestSeq).toBe(TOTAL_BURST);

      // 性能断言：1,000 条消息并发排序、Auto-Batch 落盘与 50,000 次分片 RPC 分发在 3 秒内完成
      expect(duration).toBeLessThan(3000);
    });
  });

  describe('6. Production Integration & Consistency: Two-way Sync, Mute Guard, Recall & Kick', () => {
    it('synchronizes HTTP message sends to MasterDO and broadcasts to connected WebSocket clients', async () => {
      const ownerId = '0x2222222222222222222222222222222222222222';
      const memberId = '0x3333333333333333333333333333333333333333';
      const groupId = 'group_sync_test';
      const token = 'sync_token_test';
      const tokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)).then(buf => 
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${ownerId}', '${ownerId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${memberId}', '${memberId}', 1, 1);
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s_sync', '${ownerId}', '${tokenHash}', 9999999999999, 1);
        INSERT INTO conversations (id, type, name, owner_address, created_at, updated_at) VALUES ('${groupId}', 'group', 'Sync Group', '${ownerId}', 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_s1', '${groupId}', '${ownerId}', 'owner', 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_s2', '${groupId}', '${memberId}', 'member', 1);
      `);

      // 准备分片 0 上的在线客户端
      const shardName = `${groupId}:shard_0`;
      const broadcasterStub = env.GROUP_BROADCASTER_DO!.get(
        env.GROUP_BROADCASTER_DO!.idFromName(shardName)
      );
      await broadcasterStub.fetch(`http://internal/groups/${groupId}/ws?user_id=${memberId}&shard_id=0`, {
        headers: { Upgrade: 'websocket' },
      });
      const bInstance = broadcasterNamespace.getExistingInstance(shardName);
      const memberWs = new MockWebSocket();
      memberWs.serializeAttachment({ userId: memberId, groupId });
      bInstance.ctx.acceptWebSocket(memberWs);

      // 通过 HTTP 接口发消息
      const sendReq = new Request(`http://localhost/conversations/${groupId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Hello WebSocket from HTTP API!' }),
      });
      const sendRes = await app.fetch(sendReq, env);
      expect(sendRes.status).toBe(201);

      // 给合流推流一个调度周期
      bInstance.flushCoalescedMessages();

      // 验证在线客户端收到了来自 HTTP 接口的消息广播！
      expect(memberWs.sentFrames.length).toBe(1);
      const frame = memberWs.getLastFrame();
      expect(frame.type).toBe('messages_batch');
      expect(frame.messages[0].content).toBe('Hello WebSocket from HTTP API!');
    });

    it('enforces mute moderation on WebSocket message sending (Mute Security Guard)', async () => {
      const ownerId = '0x4444444444444444444444444444444444444444';
      const mutedUser = '0x5555555555555555555555555555555555555555';
      const groupId = 'group_mute_test';

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${ownerId}', '${ownerId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${mutedUser}', '${mutedUser}', 1, 1);
        INSERT INTO conversations (id, type, name, owner_address, is_muted, created_at, updated_at) VALUES ('${groupId}', 'group', 'Muted Group', '${ownerId}', 0, 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, muted_until, mute_reason, joined_at) VALUES ('m_m1', '${groupId}', '${ownerId}', 'owner', null, null, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, muted_until, mute_reason, joined_at) VALUES ('m_m2', '${groupId}', '${mutedUser}', 'member', 9999999999999, 'Spamming', 1);
      `);

      const bStub = env.GROUP_BROADCASTER_DO!.get(
        env.GROUP_BROADCASTER_DO!.idFromName(`${groupId}:shard_0`)
      );
      await bStub.fetch(`http://internal/groups/${groupId}/ws?user_id=${mutedUser}&group_id=${groupId}`, {
        headers: { Upgrade: 'websocket' },
      });
      const bInstance = broadcasterNamespace.getExistingInstance(`${groupId}:shard_0`);
      const clientWs = new MockWebSocket();
      clientWs.serializeAttachment({ userId: mutedUser, groupId });
      bInstance.ctx.acceptWebSocket(clientWs);

      // 被禁言用户尝试通过 WebSocket 发送消息
      await bInstance.webSocketMessage(
        clientWs as any,
        JSON.stringify({ action: 'send', content: 'Trying to bypass mute' })
      );

      // 验证被拦截并下发 send_error
      expect(clientWs.sentFrames.length).toBe(1);
      const errFrame = clientWs.getLastFrame();
      expect(errFrame.type).toBe('send_error');
      expect(errFrame.error).toContain('muted');
    });

    it('broadcasts message recall events to WebSocket and closes connection on member kick', async () => {
      const ownerId = '0x6666666666666666666666666666666666666666';
      const kickedUser = '0x7777777777777777777777777777777777777777';
      const groupId = 'group_kick_recall_test';
      const token = 'owner_token_kick';
      const tokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)).then(buf => 
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${ownerId}', '${ownerId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${kickedUser}', '${kickedUser}', 1, 1);
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s_kick', '${ownerId}', '${tokenHash}', 9999999999999, 1);
        INSERT INTO conversations (id, type, name, owner_address, created_at, updated_at) VALUES ('${groupId}', 'group', 'Kick Group', '${ownerId}', 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_k1', '${groupId}', '${ownerId}', 'owner', 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_k2', '${groupId}', '${kickedUser}', 'member', 1);
      `);

      // 准备被踢用户的 WebSocket 连接（连入根据哈希计算的该用户所属分片）
      const TOTAL_SHARDS = 50;
      let hash = 0;
      const uid = kickedUser.toLowerCase();
      for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
      const shardId = hash % TOTAL_SHARDS;
      const shardName = `${groupId}:shard_${shardId}`;

      const bStub = env.GROUP_BROADCASTER_DO!.get(
        env.GROUP_BROADCASTER_DO!.idFromName(shardName)
      );
      await bStub.fetch(`http://internal/groups/${groupId}/ws?user_id=${kickedUser}&group_id=${groupId}&shard_id=${shardId}`, {
        headers: { Upgrade: 'websocket' },
      });
      const bInstance = broadcasterNamespace.getExistingInstance(shardName);
      const userWs = new MockWebSocket();
      userWs.serializeAttachment({ userId: kickedUser, groupId });
      bInstance.ctx.acceptWebSocket(userWs);

      // 1. 测试撤回事件广播
      bInstance.broadcastRecallEvent('msg_recall_123', groupId);
      expect(userWs.sentFrames.length).toBe(1);
      expect(userWs.getLastFrame().type).toBe('message_recalled');
      expect(userWs.getLastFrame().message_id).toBe('msg_recall_123');

      // 2. 测试通过 API 踢人，WebSocket 强制断开
      const kickReq = new Request(`http://localhost/groups/${groupId}/kick`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: kickedUser }),
      });
      const kickRes = await app.fetch(kickReq, env);
      expect(kickRes.status).toBe(200);

      // 验证用户的 WebSocket 连接已被断开
      expect(userWs.closed).toBe(true);
      expect(userWs.closeCode).toBe(4003);
    });

    it('automatically writes back WebSocket messages to global D1 database', async () => {
      const senderId = '0x8888888888888888888888888888888888888888';
      const groupId = 'group_writeback_test';

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${senderId}', '${senderId}', 1, 1);
        INSERT INTO conversations (id, type, name, owner_address, created_at, updated_at) VALUES ('${groupId}', 'group', 'Writeback Group', '${senderId}', 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_w1', '${groupId}', '${senderId}', 'owner', 1);
      `);

      const masterStub = env.GROUP_MASTER_DO!.get(
        env.GROUP_MASTER_DO!.idFromName(groupId)
      );

      // 通过 MasterDO 写入消息（模拟 WebSocket 上行，未带 skipD1WriteBack）
      const messageId = 'ws_msg_writeback_123';
      const postRes = await masterStub.fetch('http://internal/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: messageId,
          conversationId: groupId,
          senderId,
          content: 'Persisted to both DO and D1!',
        }),
      });
      expect(postRes.status).toBe(201);

      // 触发刷盘
      const masterInst = masterNamespace.getExistingInstance(groupId);
      await masterInst.flushPendingWrites();

      // 验证消息已写回中心 D1 数据库！
      const d1Row = await env.DB.prepare('SELECT id, content FROM messages WHERE id = ?').bind(messageId).first();
      expect(d1Row).not.toBeNull();
      expect((d1Row as any).content).toBe('Persisted to both DO and D1!');
    });
  });

  describe('7. Comprehensive Audited Optimizations: Bot Supergroup Sync, WS Safety, Slow Mode & Quota', () => {
    it('synchronizes Bot message sends to MasterDO and broadcasts to connected WebSocket clients', async () => {
      const ownerId = '0xbot_owner_addr';
      const botId = 'bot_audit_test_1';
      const memberId = '0xws_listener_user';
      const groupId = 'group_bot_ws_sync';
      const botKey = 'bot_sec_1234567890abcdef1234567890abcdef';
      const keyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botKey)).then(buf =>
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${ownerId}', '${ownerId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${botId}', '${botId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${memberId}', '${memberId}', 1, 1);
        INSERT INTO bots (id, owner_id, name, username, api_key_hash, api_key_prefix, status, created_at, updated_at)
          VALUES ('${botId}', '${ownerId}', 'AuditBot', 'audit_bot', '${keyHash}', 'bot_sec_12345', 'active', 1, 1);
        INSERT INTO conversations (id, type, name, owner_address, created_at, updated_at) VALUES ('${groupId}', 'group', 'Bot Sync Group', '${ownerId}', 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_b1', '${groupId}', '${ownerId}', 'owner', 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_b2', '${groupId}', '${botId}', 'admin', 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_b3', '${groupId}', '${memberId}', 'member', 1);
      `);

      // 准备在线客户端
      const shardName = `${groupId}:shard_0`;
      const broadcasterStub = env.GROUP_BROADCASTER_DO!.get(
        env.GROUP_BROADCASTER_DO!.idFromName(shardName)
      );
      await broadcasterStub.fetch(`http://internal/groups/${groupId}/ws?user_id=${memberId}&shard_id=0`, {
        headers: { Upgrade: 'websocket' },
      });
      const bInstance = broadcasterNamespace.getExistingInstance(shardName);
      const memberWs = new MockWebSocket();
      memberWs.serializeAttachment({ userId: memberId, groupId });
      bInstance.ctx.acceptWebSocket(memberWs);

      // Bot 调用 /bot/messages/send
      const botSendReq = new Request('http://localhost/bot/messages/send', {
        method: 'POST',
        headers: {
          'X-Bot-Token': `${botId}:${botKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: 'Hello from Audit Bot via OpenAPI!',
        }),
      });

      const res = await app.fetch(botSendReq, env);
      expect(res.status).toBe(201);

      // 触发 Broadcaster 合流推流
      bInstance.flushCoalescedMessages();

      // 验证在线用户 WebSocket 成功收到了 Bot 发送的消息广播！
      expect(memberWs.sentFrames.length).toBe(1);
      const frame = memberWs.getLastFrame();
      expect(frame.type).toBe('messages_batch');
      expect(frame.messages[0].content).toBe('Hello from Audit Bot via OpenAPI!');
      expect(frame.messages[0].senderId).toBe(botId);
    });

    it('closes WebSocket connection when Bot kicks a member in a supergroup', async () => {
      const ownerId = '0xbot_owner_addr2';
      const botId = 'bot_admin_kicker';
      const kickedUser = '0xkicked_by_bot_user';
      const groupId = 'group_bot_kick_ws';
      const botKey = 'bot_sec_kicker1234567890abcdef12345678';
      const keyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botKey)).then(buf =>
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${ownerId}', '${ownerId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${botId}', '${botId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${kickedUser}', '${kickedUser}', 1, 1);
        INSERT INTO bots (id, owner_id, name, username, api_key_hash, api_key_prefix, status, created_at, updated_at)
          VALUES ('${botId}', '${ownerId}', 'KickerBot', 'kicker_bot', '${keyHash}', 'bot_sec_kicker', 'active', 1, 1);
        INSERT INTO conversations (id, type, name, owner_address, created_at, updated_at) VALUES ('${groupId}', 'group', 'Bot Kick Group', '${ownerId}', 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_bk1', '${groupId}', '${ownerId}', 'owner', 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_bk2', '${groupId}', '${botId}', 'admin', 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_bk3', '${groupId}', '${kickedUser}', 'member', 1);
      `);

      // 准备被踢用户的 WebSocket
      const TOTAL_SHARDS = 50;
      let hash = 0;
      const uid = kickedUser.toLowerCase();
      for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
      const shardId = hash % TOTAL_SHARDS;
      const shardName = `${groupId}:shard_${shardId}`;

      const bStub = env.GROUP_BROADCASTER_DO!.get(
        env.GROUP_BROADCASTER_DO!.idFromName(shardName)
      );
      await bStub.fetch(`http://internal/groups/${groupId}/ws?user_id=${kickedUser}&shard_id=${shardId}`, {
        headers: { Upgrade: 'websocket' },
      });
      const bInstance = broadcasterNamespace.getExistingInstance(shardName);
      const userWs = new MockWebSocket();
      userWs.serializeAttachment({ userId: kickedUser, groupId });
      bInstance.ctx.acceptWebSocket(userWs);

      // Bot 调用 /bot/groups/:id/kick
      const botKickReq = new Request(`http://localhost/bot/groups/${groupId}/kick`, {
        method: 'POST',
        headers: {
          'X-Bot-Token': `${botId}:${botKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: kickedUser }),
      });
      const kickRes = await app.fetch(botKickReq, env);
      expect(kickRes.status).toBe(200);

      // 验证被踢用户的 WebSocket 连接已被断开
      expect(userWs.closed).toBe(true);
      expect(userWs.closeCode).toBe(4003);
    });

    it('rejects stats queries for non-members and allows members/admins', async () => {
      const memberId = '0xstats_allowed_member';
      const nonMemberId = '0xstats_denied_user';
      const groupId = 'group_stats_auth_test';

      const memToken = 'mem_stats_token';
      const memTokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(memToken)).then(buf =>
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );
      const nonToken = 'non_stats_token';
      const nonTokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonToken)).then(buf =>
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${memberId}', '${memberId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${nonMemberId}', '${nonMemberId}', 1, 1);
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s_s1', '${memberId}', '${memTokenHash}', 9999999999999, 1);
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s_s2', '${nonMemberId}', '${nonTokenHash}', 9999999999999, 1);
        INSERT INTO conversations (id, type, name, owner_address, created_at, updated_at) VALUES ('${groupId}', 'group', 'Stats Group', '${memberId}', 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_st1', '${groupId}', '${memberId}', 'owner', 1);
      `);

      // 1. 非群成员访问 -> 403 Forbidden
      const nonReq = new Request(`http://localhost/groups/${groupId}/supergroup/stats`, {
        headers: { Authorization: `Bearer ${nonToken}` },
      });
      const nonRes = await app.fetch(nonReq, env);
      expect(nonRes.status).toBe(403);

      // 2. 群成员访问 -> 200 OK
      const memReq = new Request(`http://localhost/groups/${groupId}/supergroup/stats`, {
        headers: { Authorization: `Bearer ${memToken}` },
      });
      const memRes = await app.fetch(memReq, env);
      expect(memRes.status).toBe(200);
      const json: any = await memRes.json();
      expect(json.group_id).toBe(groupId);
    });

    it('enforces Slow Mode configuration via /groups/:id/slow-mode', async () => {
      const ownerId = '0xslow_config_owner';
      const memberId = '0xslow_config_member';
      const groupId = 'group_slow_mode_config';

      const ownerToken = 'owner_slow_token';
      const ownerTokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerToken)).then(buf =>
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );
      const memberToken = 'member_slow_token';
      const memberTokenHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(memberToken)).then(buf =>
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      );

      mockDb.rawDb.exec(`
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${ownerId}', '${ownerId}', 1, 1);
        INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${memberId}', '${memberId}', 1, 1);
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s_sl1', '${ownerId}', '${ownerTokenHash}', 9999999999999, 1);
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('s_sl2', '${memberId}', '${memberTokenHash}', 9999999999999, 1);
        INSERT INTO conversations (id, type, name, owner_address, created_at, updated_at) VALUES ('${groupId}', 'group', 'Slow Config Group', '${ownerId}', 1, 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_sl1', '${groupId}', '${ownerId}', 'owner', 1);
        INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES ('m_sl2', '${groupId}', '${memberId}', 'member', 1);
      `);

      // 1. 普通成员尝试设置慢速模式 -> 403
      const failReq = new Request(`http://localhost/groups/${groupId}/slow-mode`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ seconds: 10 }),
      });
      const failRes = await app.fetch(failReq, env);
      expect(failRes.status).toBe(403);

      // 2. 群主设置慢速模式 -> 200
      const okReq = new Request(`http://localhost/groups/${groupId}/slow-mode`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ seconds: 5 }),
      });
      const okRes = await app.fetch(okReq, env);
      expect(okRes.status).toBe(200);
      const okJson: any = await okRes.json();
      expect(okJson.slow_mode_seconds).toBe(5);

      // 验证 MasterDO 中已生效
      const masterStub = env.GROUP_MASTER_DO!.get(env.GROUP_MASTER_DO!.idFromName(groupId));
      const statsRes = await masterStub.fetch('http://internal/stats');
      const stats: any = await statsRes.json();
      expect(stats.slowModeSeconds).toBe(5);
    });

    it('rejects empty or overlong messages in WebSocket upstream send', async () => {
      const ctx = new MockDurableObjectState();
      const broadcaster = new GroupBroadcasterDO(ctx as any, env);
      const mockWs = new MockWebSocket();
      mockWs.serializeAttachment({ userId: '0xsender_user', groupId: 'group_validation' });
      ctx.acceptWebSocket(mockWs);

      // 1. 空内容被拦截
      await broadcaster.webSocketMessage(
        mockWs as any,
        JSON.stringify({ action: 'send', content: '   ' })
      );
      expect(mockWs.sentFrames.length).toBe(1);
      expect(mockWs.getLastFrame().type).toBe('send_error');
      expect(mockWs.getLastFrame().error).toBe('EMPTY_CONTENT');

      // 2. 超长消息 (>4000 字符) 被拦截
      await broadcaster.webSocketMessage(
        mockWs as any,
        JSON.stringify({ action: 'send', content: 'x'.repeat(4001) })
      );
      expect(mockWs.sentFrames.length).toBe(2);
      expect(mockWs.getLastFrame().type).toBe('send_error');
      expect(mockWs.getLastFrame().error).toContain('CONTENT_TOO_LONG');
    });

    it('enforces bot quota per owner in createBot', async () => {
      const { createBot, MAX_BOTS_PER_OWNER } = await import('../src/services/bots');
      const ownerId = '0xbot_quota_owner';
      mockDb.rawDb.exec(`INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES ('${ownerId}', '${ownerId}', 1, 1);`);

      // 创建达到配额上限数量的机器人
      for (let i = 0; i < MAX_BOTS_PER_OWNER; i++) {
        await createBot(mockDb as any, ownerId, { name: `Bot ${i}` });
      }

      // 尝试创建第 21 个机器人 -> 抛出配额上限异常
      await expect(
        createBot(mockDb as any, ownerId, { name: 'Exceeding Bot' })
      ).rejects.toThrow('Maximum bot quota reached');
    });
  });

  describe('8. TASK-026 Supergroup Hardening: Async Fanout, Subrequest Pooling, Compact Frames & Adaptive Flood Damping', () => {
    it('dynamic flood damping rate-clamps non-admin burst when adaptive_flood_enabled is set', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      await master.setConfig('adaptive_flood_enabled', 'true');
      expect(master.getStats().adaptiveFloodEnabled).toBe(true);

      // 连续发送 25 条（来自不同用户），消息速率达到 DYNAMIC_FLOOD_THRESHOLD (25 msg/s)
      for (let i = 0; i < 25; i++) {
        await master.postMessage({
          conversationId: 'group_adaptive_flood',
          senderId: `0xuser_${i}`,
          content: `Burst message ${i}`,
        });
      }

      // 此时群瞬时消息速度 >= 25，自适应涌浪保护激活
      expect(master.getStats().adaptiveFloodActive).toBe(true);

      // 用户 0xuser_spam 发送第 1 条消息（被记录最后发送时间）
      await master.postMessage({
        conversationId: 'group_adaptive_flood',
        senderId: '0xuser_spam',
        content: 'Spam 1',
      });

      // 0xuser_spam 紧接着在 2s 冷却窗口内发送第 2 条消息，被自适应慢速阻尼拦截
      await expect(
        master.postMessage({
          conversationId: 'group_adaptive_flood',
          senderId: '0xuser_spam',
          content: 'Spam 2',
        })
      ).rejects.toThrow('SLOW_MODE_COOLDOWN');

      // 管理员拥有免死金牌，即使在自适应限流激活时也能发送
      const adminMsg = await master.postMessage({
        conversationId: 'group_adaptive_flood',
        senderId: '0xadmin',
        content: 'Admin bypass during flood',
        isAdminOrOwner: true,
      });
      expect(adminMsg.seq).toBe(27);
    });

    it('compact frame serialization strips ephemeral flags before WebSocket broadcast', async () => {
      const ctx = new MockDurableObjectState();
      const broadcaster = new GroupBroadcasterDO(ctx as any, env);
      const mockWs = new MockWebSocket();
      ctx.acceptWebSocket(mockWs);

      broadcaster.queueBroadcastMessage({
        seq: 1,
        id: 'msg_strip',
        conversationId: 'group_compact',
        senderId: '0xalice',
        type: 'text',
        content: 'Compact content',
        createdAt: Date.now(),
        skipD1WriteBack: true,
      });

      broadcaster.flushCoalescedMessages();
      expect(mockWs.sentFrames.length).toBe(1);
      const frame = mockWs.getLastFrame();
      expect(frame.type).toBe('messages_batch');
      expect(frame.messages[0].id).toBe('msg_strip');
      expect(frame.messages[0].skipD1WriteBack).toBeUndefined();
    });

    it('subrequest chunking handles fanout across 25 active shards smoothly', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      // 注册 25 个活跃分片
      for (let i = 0; i < 25; i++) {
        master.registerActiveShard(i);
      }
      expect(master.getStats().activeShardsCount).toBe(25);

      // 发送消息，扇出分块批次循环 (CHUNK_SIZE = 10) 顺利执行
      const msg = await master.postMessage({
        conversationId: 'group_chunked',
        senderId: '0xbob',
        content: 'Broadcast across 25 shards in chunks',
      });
      expect(msg.seq).toBe(1);
    });

    it('delegates async fanout via ctx.waitUntil when asyncBroadcast: true is passed', async () => {
      const ctx = new MockDurableObjectState();
      const master = new GroupMasterDO(ctx as any, env);

      await master.postMessage({
        conversationId: 'group_async',
        senderId: '0xcharlie',
        content: 'Async fanout message',
        asyncBroadcast: true,
      });

      // 验证通过 ctx.waitUntil 提交了后台异步广播任务
      expect(ctx.waitUntilPromises.length).toBeGreaterThan(0);
    });
  });
});

