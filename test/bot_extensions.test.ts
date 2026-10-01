import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { runBotTasksTick } from '../src/services/bots';

describe('Bot Extensions & Automation API Test Suite (Document Compliance)', () => {
  let db: D1Database;
  let bucket: MockR2Bucket;
  let owner: { token: string; user: any; wallet: TestWallet };
  let memberUser: { token: string; user: any; wallet: TestWallet };
  let newApplicant: { token: string; user: any; wallet: TestWallet };
  let botId: string;
  let botApiKey: string;
  let groupId: string;

  async function loginUser(wallet: TestWallet) {
    const nonceRes = await app.request(
      '/auth/nonce',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: wallet.address }),
      },
      { DB: db, VOICE_BUCKET: bucket }
    );
    const nonceData = (await nonceRes.json()) as { nonce: string; message: string };
    const signature = await wallet.signMessage(nonceData.message);

    const verifyRes = await app.request(
      '/auth/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: wallet.address, signature }),
      },
      { DB: db, VOICE_BUCKET: bucket }
    );
    const data = (await verifyRes.json()) as { token: string; user: { id: string; wallet_address: string } };
    return { token: data.token, user: data.user, wallet };
  }

  beforeEach(async () => {
    db = createMockD1Database(true);
    bucket = new MockR2Bucket();

    owner = await loginUser(createTestWallet());
    memberUser = await loginUser(createTestWallet());
    newApplicant = await loginUser(createTestWallet());

    // 1. Create a bot owned by owner
    const botRes = await app.request(
      '/bots',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({
          name: 'Super Bot',
          username: 'super_bot',
          description: 'A community bot',
        }),
      },
      { DB: db, VOICE_BUCKET: bucket }
    );
    const botData = await botRes.json<any>();
    botId = botData.bot.id;
    botApiKey = botData.bot.api_key;

    // 2. Create a group
    const grpRes = await app.request(
      '/groups',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({
          name: 'Decentralized Community',
          group_type: 'public',
        }),
      },
      { DB: db, VOICE_BUCKET: bucket }
    );
    const grpData = await grpRes.json<any>();
    groupId = grpData.id;

    // 3. Add bot to group
    await app.request(
      `/groups/${groupId}/members`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({ user_id: botId }),
      },
      { DB: db, VOICE_BUCKET: bucket }
    );

    // 4. Promote bot to admin
    await app.request(
      `/groups/${groupId}/members/${botId}/role`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({ role: 'admin' }),
      },
      { DB: db, VOICE_BUCKET: bucket }
    );
  });

  describe('1. Message Sending & Metadata (POST /bot/message/send & B-R1, B-R4)', () => {
    it('supports POST /bot/message/send with sender_type: "bot" in response', async () => {
      const res = await app.request(
        '/bot/message/send',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            conversation_id: groupId,
            content: 'Hello community from bot!',
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      expect(res.status).toBe(201);
      const data = await res.json<any>();
      expect(data.message.sender_type).toBe('bot');
      expect(data.message.content).toBe('Hello community from bot!');
    });

    it('supports sending media_url in message', async () => {
      const res = await app.request(
        '/bot/message/send',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            conversation_id: groupId,
            content: 'Daily photo update',
            media_url: 'https://r2.example.com/daily.jpg',
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      expect(res.status).toBe(201);
      const data = await res.json<any>();
      expect(data.message.content).toContain('https://r2.example.com/daily.jpg');
    });

    it('enforces B-R4 rate limit (≤3 messages/min per bot per group) when enabled', async () => {
      // Send 3 messages successfully
      for (let i = 1; i <= 3; i++) {
        const res = await app.request(
          '/bot/message/send',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Bot-Id': botId,
              'X-Bot-Key': botApiKey,
              'X-Enforce-Rate-Limit': 'true',
            },
            body: JSON.stringify({
              conversation_id: groupId,
              content: `Message ${i}`,
            }),
          },
          { DB: db, VOICE_BUCKET: bucket }
        );
        expect(res.status).toBe(201);
      }

      // 4th message in same minute should be rejected with 429
      const overLimitRes = await app.request(
        '/bot/message/send',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
            'X-Enforce-Rate-Limit': 'true',
          },
          body: JSON.stringify({
            conversation_id: groupId,
            content: 'Message 4 (should be rate limited)',
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(overLimitRes.status).toBe(429);
      const err = await overLimitRes.json<any>();
      expect(err.error).toBe('RATE_LIMITED');
    });

    it('enforces general flood protection (120 messages/min) by default without X-Enforce-Rate-Limit', async () => {
      // Artificially fill the rate limit bucket for the bot to 120
      const windowStart = Math.floor(Date.now() / 60_000);
      const bucketKey = `bot_msg_general:${botId.toLowerCase()}:${windowStart}`;
      await db.prepare('INSERT INTO rate_limits (bucket, count) VALUES (?, 120)').bind(bucketKey).run();

      const floodRes = await app.request(
        '/bot/message/send',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            conversation_id: groupId,
            content: 'Flood attempt message',
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(floodRes.status).toBe(429);
      const err = await floodRes.json<any>();
      expect(err.error).toBe('RATE_LIMITED');
      expect(err.message).toContain('flood protection');
    });
  });

  describe('2. Inviting/Adding Members (POST /bot/group/invite, Requirements 2 & 3)', () => {
    it('allows bot admin to invite member with nickname and avatar', async () => {
      const inviteRes = await app.request(
        '/bot/group/invite',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: newApplicant.user.id,
            nickname: 'Web3 Explorer',
            avatar_url: 'https://example.com/avatar1.png',
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      expect(inviteRes.status).toBe(201);
      const data = await inviteRes.json<any>();
      expect(data.member.user_id).toBe(newApplicant.user.id);
      expect(data.member.group_nickname).toBe('Web3 Explorer');
      expect(data.user.nickname).toBe('Web3 Explorer');
      expect(data.user.avatar_url).toBe('https://example.com/avatar1.png');

      // Verify audit log recorded
      const auditRes = await app.request(
        `/bot/audit-logs?group_id=${groupId}`,
        {
          method: 'GET',
          headers: {
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      const auditData = await auditRes.json<any>();
      expect(auditData.logs.some((l: any) => l.action === 'invite_member')).toBe(true);
    });

    it('rejects duplicate member invite with 409', async () => {
      // First invite
      await app.request(
        '/bot/group/invite',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: memberUser.user.id,
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      // Second invite -> 409 already a member
      const dupRes = await app.request(
        '/bot/group/invite',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: memberUser.user.id,
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(dupRes.status).toBe(409);
    });
  });

  describe('3. Group Capacity Management (POST /bot/group/capacity, Requirement 2)', () => {
    it('sets fixed member capacity for group and rejects joins beyond capacity', async () => {
      // Currently in group: owner (1) + bot (1) = 2 members
      // Bot sets capacity to 2
      const capRes = await app.request(
        '/bot/group/capacity',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            capacity: 2,
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      expect(capRes.status).toBe(200);
      const capData = await capRes.json<any>();
      expect(capData.capacity).toBe(2);
      expect(capData.max_members).toBe(2);

      // Now attempting to invite a 3rd member should fail with GROUP_CAPACITY_REACHED (403)
      const overflowRes = await app.request(
        '/bot/group/invite',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: memberUser.user.id,
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      expect(overflowRes.status).toBe(403);
      const err = await overflowRes.json<any>();
      expect(err.error).toContain('GROUP_CAPACITY_REACHED');

      // Expand capacity to 10
      const expandRes = await app.request(
        '/bot/group/capacity',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            capacity: 10,
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(expandRes.status).toBe(200);

      // Now invite succeeds
      const retryRes = await app.request(
        '/bot/group/invite',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: memberUser.user.id,
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(retryRes.status).toBe(201);
    });
  });

  describe('4. Unified Moderation (POST /bot/group/moderate, Requirement 1 & §4.7)', () => {
    it('supports mute_group, mute_member, and set_announcement via moderate', async () => {
      // 1. Mute group
      const muteGroupRes = await app.request(
        '/bot/group/moderate',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            action: 'mute_group',
            muted: true,
            duration_seconds: 3600,
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(muteGroupRes.status).toBe(200);

      // 2. Set Announcement
      const annoRes = await app.request(
        '/bot/group/moderate',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            action: 'set_announcement',
            announcement: 'Welcome everyone, follow community guidelines!',
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(annoRes.status).toBe(200);

      // 3. Verify audit log captures all moderation actions
      const auditRes = await app.request(
        `/bot/audit-logs?group_id=${groupId}`,
        {
          method: 'GET',
          headers: {
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      const auditData = await auditRes.json<any>();
      const actions = auditData.logs.map((l: any) => l.action);
      expect(actions).toContain('mute_group');
      expect(actions).toContain('set_announcement');
    });
  });

  describe('5. Group Event Stream Subscription (GET /bot/group/events, Requirements 4 & 5)', () => {
    it('receives member_joined event with full user profile details for welcome bots', async () => {
      // Bot invites new member
      await app.request(
        '/bot/group/invite',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            user_id: newApplicant.user.id,
            nickname: 'CryptoPioneer',
            avatar_url: 'https://example.com/pioneer.png',
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      // Query event stream
      const eventsRes = await app.request(
        `/bot/group/events?group_id=${groupId}`,
        {
          method: 'GET',
          headers: {
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      expect(eventsRes.status).toBe(200);
      const data = await eventsRes.json<any>();
      expect(Array.isArray(data.events)).toBe(true);

      const joinEvent = data.events.find(
        (e: any) => e.event === 'member_joined' && e.user?.id === newApplicant.user.id
      );
      expect(joinEvent).toBeDefined();
      expect(joinEvent.group_id).toBe(groupId);
      expect(joinEvent.user).toBeDefined();
      expect(joinEvent.user.wallet_address.toLowerCase()).toBe(newApplicant.wallet.address.toLowerCase());
      expect(joinEvent.user.nickname).toBe('CryptoPioneer');
      expect(joinEvent.user.avatar_url).toBe('https://example.com/pioneer.png');
    });
  });

  describe('6. Scheduled Content Publishing (POST /bot/tasks, Requirement 6 & M5)', () => {
    it('creates, lists, cancels and executes scheduled content tasks', async () => {
      const now = Date.now();

      // 1. Create task scheduled for 10 minutes later
      const createRes = await app.request(
        '/bot/tasks',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            type: 'image',
            content: 'Upcoming AMM launch banner',
            media_url: 'https://r2.example.com/launch.png',
            schedule_time: now + 600_000,
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );

      expect(createRes.status).toBe(201);
      const createData = await createRes.json<any>();
      const taskId = createData.task.id;
      expect(createData.task.status).toBe('pending');
      expect(createData.task.type).toBe('image');

      // 2. List tasks
      const listRes = await app.request(
        `/bot/tasks?group_id=${groupId}`,
        {
          method: 'GET',
          headers: {
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(listRes.status).toBe(200);
      const listData = await listRes.json<any>();
      expect(listData.tasks.some((t: any) => t.id === taskId)).toBe(true);

      // 3. Cancel task
      const cancelRes = await app.request(
        `/bot/tasks/${taskId}`,
        {
          method: 'DELETE',
          headers: {
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(cancelRes.status).toBe(200);
      const cancelData = await cancelRes.json<any>();
      expect(cancelData.task.status).toBe('cancelled');

      // 4. Create an immediately executable task (schedule_time <= now) and run executor tick
      const readyRes = await app.request(
        '/bot/tasks',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
          body: JSON.stringify({
            group_id: groupId,
            type: 'text',
            content: 'Scheduled announcement: Welcome to our daily discussion!',
            schedule_time: now - 1000, // Due immediately
          }),
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(readyRes.status).toBe(201);
      const readyTaskId = (await readyRes.json<any>()).task.id;

      // Run background scheduled tick
      const tickResult = await runBotTasksTick({ DB: db });
      expect(tickResult.executed).toBeGreaterThanOrEqual(1);

      // Verify task status updated to executed
      const checkRes = await app.request(
        `/bot/tasks/${readyTaskId}`,
        {
          method: 'GET',
          headers: {
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      expect(checkRes.status).toBe(200);
      const checkData = await checkRes.json<any>();
      expect(checkData.task.status).toBe('executed');

      // Verify message was delivered to conversation
      const msgsRes = await app.request(
        `/bot/conversations/${groupId}/messages`,
        {
          method: 'GET',
          headers: {
            'X-Bot-Id': botId,
            'X-Bot-Key': botApiKey,
          },
        },
        { DB: db, VOICE_BUCKET: bucket }
      );
      const msgsData = await msgsRes.json<any>();
      expect(
        msgsData.messages.some((m: any) =>
          typeof m.content === 'string' && m.content.includes('Scheduled announcement: Welcome to our daily discussion!')
        )
      ).toBe(true);
    });
  });
});
