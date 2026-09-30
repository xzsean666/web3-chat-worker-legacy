import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';

describe('Telegram-like Bots Feature Test Suite', () => {
  let db: D1Database;
  let bucket: MockR2Bucket;
  let userA: { token: string; user: any; wallet: TestWallet };
  let userB: { token: string; user: any; wallet: TestWallet };
  let userC: { token: string; user: any; wallet: TestWallet };

  async function loginUser(wallet: TestWallet) {
    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, { DB: db, VOICE_BUCKET: bucket });
    const nonceData = (await nonceRes.json()) as { nonce: string; message: string };
    const signature = await wallet.signMessage(nonceData.message);

    const verifyRes = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address, signature }),
    }, { DB: db, VOICE_BUCKET: bucket });
    const data = (await verifyRes.json()) as { token: string; user: { id: string; wallet_address: string } };
    return { token: data.token, user: data.user, wallet };
  }

  beforeEach(async () => {
    db = createMockD1Database(true);
    bucket = new MockR2Bucket();

    // Setup 3 test users
    const walletA = createTestWallet();
    const walletB = createTestWallet();
    const walletC = createTestWallet();

    userA = await loginUser(walletA);
    userB = await loginUser(walletB);
    userC = await loginUser(walletC);
  });

  describe('1. Bot Registration & Management (/bots)', () => {
    it('allows any user to register their own bot and returns plaintext api_key', async () => {
      const res = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'My Helper Bot',
          username: 'helper_bot',
          description: 'A helpful bot for managing group chats',
          avatar_url: 'https://example.com/bot_avatar.png',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(res.status).toBe(201);
      const data = await res.json<any>();
      expect(data.bot).toBeDefined();
      expect(data.bot.id).toMatch(/^bot_[a-f0-9]{32}$/);
      expect(data.bot.owner_id).toBe(userA.user.id);
      expect(data.bot.name).toBe('My Helper Bot');
      expect(data.bot.username).toBe('helper_bot');
      expect(data.bot.api_key).toMatch(/^bot_sec_[a-f0-9]{64}$/);
      expect(data.bot.api_key_prefix).toBe(data.bot.api_key.substring(0, 15));
      expect(data.bot.status).toBe('active');

      // Verify virtual user record exists in users table
      const virtualUser = await db
        .prepare('SELECT * FROM users WHERE id = ?')
        .bind(data.bot.id)
        .first<any>();
      expect(virtualUser).toBeDefined();
      expect(virtualUser.username).toBe('helper_bot');
      const meta = JSON.parse(virtualUser.public_metadata);
      expect(meta.is_bot).toBe(true);
      expect(meta.nickname).toBe('My Helper Bot');
    });

    it('rejects duplicate or invalid usernames', async () => {
      // Create first bot
      await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'First Bot',
          username: 'cool_bot',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      // Duplicate username
      const dupRes = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userB.token}`,
        },
        body: JSON.stringify({
          name: 'Duplicate Bot',
          username: 'cool_bot',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(dupRes.status).toBe(400);
      const dupData = await dupRes.json<any>();
      expect(dupData.error).toContain('Username already taken');

      // Invalid username (too short or special chars)
      const invalidRes = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'Invalid Bot',
          username: 'a!',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(invalidRes.status).toBe(400);
    });

    it('lists user bots without leaking plaintext api_key', async () => {
      await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ name: 'Bot 1' }),
      }, { DB: db, VOICE_BUCKET: bucket });

      await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ name: 'Bot 2' }),
      }, { DB: db, VOICE_BUCKET: bucket });

      const listRes = await app.request('/bots', {
        method: 'GET',
        headers: { Authorization: `Bearer ${userA.token}` },
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(listRes.status).toBe(200);
      const data = await listRes.json<any>();
      expect(data.bots.length).toBe(2);
      expect(data.bots[0].api_key).toBeUndefined();
      expect(data.bots[0].api_key_prefix).toBeDefined();
    });

    it('supports bot details inspection, updates, key resets, and deletion', async () => {
      // 1. Create bot
      const createRes = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ name: 'Editable Bot' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const { bot } = await createRes.json<any>();
      const botId = bot.id;
      const initialKey = bot.api_key;

      // 2. User B cannot view or modify User A's bot
      const unauthRes = await app.request(`/bots/${botId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${userB.token}` },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(unauthRes.status).toBe(403);

      // 3. User A updates bot details
      const updateRes = await app.request(`/bots/${botId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'Renamed Bot',
          description: 'New Description',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(updateRes.status).toBe(200);
      const updateData = await updateRes.json<any>();
      expect(updateData.bot.name).toBe('Renamed Bot');
      expect(updateData.bot.description).toBe('New Description');

      // 4. Reset API key
      const resetRes = await app.request(`/bots/${botId}/reset-key`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.token}` },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(resetRes.status).toBe(200);
      const resetData = await resetRes.json<any>();
      expect(resetData.api_key).toBeDefined();
      expect(resetData.api_key).not.toBe(initialKey);

      // 5. Old key fails; new key succeeds
      const oldAuthRes = await app.request('/bot/me', {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': initialKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(oldAuthRes.status).toBe(401);

      const newAuthRes = await app.request('/bot/me', {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': resetData.api_key,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(newAuthRes.status).toBe(200);

      // 6. Delete bot
      const delRes = await app.request(`/bots/${botId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userA.token}` },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(delRes.status).toBe(200);

      // Deleted bot cannot be fetched
      const getDelRes = await app.request(`/bots/${botId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${userA.token}` },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(getDelRes.status).toBe(404);
    });
  });

  describe('2. Bot Authentication Strategies (/bot/*)', () => {
    let botId: string;
    let apiKey: string;

    beforeEach(async () => {
      const res = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ name: 'Auth Test Bot' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const data = await res.json<any>();
      botId = data.bot.id;
      apiKey = data.bot.api_key;
    });

    it('authenticates via X-Bot-Id & X-Bot-Key headers', async () => {
      const res = await app.request('/bot/me', {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.bot.id).toBe(botId);
    });

    it('authenticates via Telegram-style X-Bot-Token header (id:key)', async () => {
      const res = await app.request('/bot/me', {
        method: 'GET',
        headers: {
          'X-Bot-Token': `${botId}:${apiKey}`,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.bot.id).toBe(botId);
    });

    it('authenticates via Authorization: Bearer id:key', async () => {
      const res = await app.request('/bot/me', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${botId}:${apiKey}`,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(res.status).toBe(200);
    });

    it('authenticates via URL Query parameters ?bot_id=...&api_key=...', async () => {
      const res = await app.request(`/bot/me?bot_id=${encodeURIComponent(botId)}&api_key=${encodeURIComponent(apiKey)}`, {
        method: 'GET',
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(res.status).toBe(200);
    });

    it('authenticates via POST JSON body { bot_id, api_key }', async () => {
      const res = await app.request('/bot/groups/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_id: botId,
          api_key: apiKey,
          // empty join will return 400 parameter error after successful 200 auth
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      // Not 401 Unauthorized!
      expect(res.status).toBe(400);
      const data = await res.json<any>();
      expect(data.error).toContain('Either invite_token or group_id must be provided');
    });

    it('rejects unauthorized requests with 401', async () => {
      // Wrong key
      const wrongKeyRes = await app.request('/bot/me', {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': 'bot_sec_invalid',
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(wrongKeyRes.status).toBe(401);

      // Missing headers
      const missingRes = await app.request('/bot/me', {
        method: 'GET',
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(missingRes.status).toBe(401);
    });
  });

  describe('3. Bot Group Integration & Messaging', () => {
    let botId: string;
    let apiKey: string;
    let groupId: string;

    beforeEach(async () => {
      // 1. Create Bot
      const botRes = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'Manager Bot',
          username: 'manager_bot',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const botData = await botRes.json<any>();
      botId = botData.bot.id;
      apiKey = botData.bot.api_key;

      // 2. User A creates group with User B
      const grpRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'Super Squad',
          member_ids: [userB.user.id],
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const grpData = await grpRes.json<any>();
      groupId = grpData.id;
    });

    it('allows group owner to add bot to group via bot_id or username', async () => {
      // Add bot via bot_id
      const addRes = await app.request(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          user_id: botId,
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(addRes.status).toBe(201);

      // Bot can list its conversations/groups
      const botGrpsRes = await app.request('/bot/groups', {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(botGrpsRes.status).toBe(200);
      const { groups } = await botGrpsRes.json<any>();
      expect(groups.length).toBe(1);
      expect(groups[0].id).toBe(groupId);
      expect(groups[0].name).toBe('Super Squad');
      expect(groups[0].role).toBe('member');
    });

    it('allows bot to send message to group and users can read it', async () => {
      // Add bot
      await app.request(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ user_id: botId }),
      }, { DB: db, VOICE_BUCKET: bucket });

      // Bot sends message
      const sendRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: 'Hello everyone! I am Manager Bot.',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(sendRes.status).toBe(201);
      const sendData = await sendRes.json<any>();
      expect(sendData.message.sender_id).toBe(botId);
      expect(sendData.message.content).toBe('Hello everyone! I am Manager Bot.');

      // User B syncs messages and receives bot message
      const syncRes = await app.request('/sync', {
        method: 'GET',
        headers: { Authorization: `Bearer ${userB.token}` },
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(syncRes.status).toBe(200);
      const syncData = await syncRes.json<any>();
      const botMsg = syncData.messages.find((m: any) => m.sender_id === botId && m.type === 'text');
      expect(botMsg).toBeDefined();
      expect(botMsg.content).toBe('Hello everyone! I am Manager Bot.');

      // Bot reads conversation messages
      const botReadRes = await app.request(`/bot/conversations/${groupId}/messages`, {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(botReadRes.status).toBe(200);
      const botReadData = await botReadRes.json<any>();
      expect(botReadData.messages.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('4. Bot Group Administration (Kick, Mute, Update Group)', () => {
    let botId: string;
    let apiKey: string;
    let groupId: string;

    beforeEach(async () => {
      // 1. Create Bot
      const botRes = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ name: 'Admin Bot' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const botData = await botRes.json<any>();
      botId = botData.bot.id;
      apiKey = botData.bot.api_key;

      // 2. User A creates group with User B and User C
      const grpRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'Moderated Community',
          member_ids: [userB.user.id, userC.user.id],
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const grpData = await grpRes.json<any>();
      groupId = grpData.id;

      // 3. User A adds bot to group
      await app.request(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ user_id: botId }),
      }, { DB: db, VOICE_BUCKET: bucket });
    });

    it('forbids administrative actions when bot is only a normal member', async () => {
      // Bot tries to kick User C -> 403
      const kickRes = await app.request(`/bot/groups/${groupId}/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ user_id: userC.user.id }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(kickRes.status).toBe(403);

      // Bot tries to mute group -> 403
      const muteGrpRes = await app.request(`/bot/groups/${groupId}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ muted: true }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(muteGrpRes.status).toBe(403);

      // Bot tries to mute User C -> 403
      const muteMemberRes = await app.request(`/bot/groups/${groupId}/mute-member`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ user_id: userC.user.id, muted: true }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(muteMemberRes.status).toBe(403);
    });

    it('allows administrative actions after group owner promotes bot to admin', async () => {
      // 1. Group Owner (User A) promotes Bot to 'admin'
      const promoteRes = await app.request(`/groups/${groupId}/members/${botId}/role`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ role: 'admin' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(promoteRes.status).toBe(200);

      // 2. Bot inspects group details and members
      const membersRes = await app.request(`/bot/groups/${groupId}/members`, {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(membersRes.status).toBe(200);
      const membersData = await membersRes.json<any>();
      const botMember = membersData.members.find((m: any) => m.user_id === botId);
      expect(botMember.role).toBe('admin');

      // 3. Bot mutes single member (User C)
      const muteMemberRes = await app.request(`/bot/groups/${groupId}/mute-member`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          user_id: userC.user.id,
          muted: true,
          duration_seconds: 3600,
          reason: 'Spamming advertisement',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(muteMemberRes.status).toBe(200);

      // User C attempts to send message -> 403 Forbidden
      const userCSendRes = await app.request(`/conversations/${groupId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userC.token}`,
        },
        body: JSON.stringify({
          content: 'I want to spam!',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(userCSendRes.status).toBe(403);

      // 4. Bot mutes entire group
      const muteGrpRes = await app.request(`/bot/groups/${groupId}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ muted: true }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(muteGrpRes.status).toBe(200);

      // Normal User B cannot speak
      const userBSendRes = await app.request(`/conversations/${groupId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userB.token}`,
        },
        body: JSON.stringify({
          content: 'Can I talk?',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(userBSendRes.status).toBe(403);

      // But Admin Bot can still send broadcast message ("admin始终可以讲话")
      const botAdminSendRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: 'Attention: The group has been muted for maintenance.',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(botAdminSendRes.status).toBe(201);

      // 5. Bot unmutes the group
      const unmuteGrpRes = await app.request(`/bot/groups/${groupId}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ muted: false }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(unmuteGrpRes.status).toBe(200);

      // 6. Bot kicks member User C
      const kickRes = await app.request(`/bot/groups/${groupId}/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ user_id: userC.user.id }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(kickRes.status).toBe(200);

      // User C is no longer a member
      const checkMembersRes = await app.request(`/bot/groups/${groupId}/members`, {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      const checkData = await checkMembersRes.json<any>();
      expect(checkData.members.some((m: any) => m.user_id === userC.user.id)).toBe(false);

      // 7. Bot updates group title & announcement
      const patchGrpRes = await app.request(`/bot/groups/${groupId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          name: 'Clean & Safe Community',
          announcement: 'Be respectful and follow group rules.',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(patchGrpRes.status).toBe(200);
      const patchData = await patchGrpRes.json<any>();
      expect(patchData.name).toBe('Clean & Safe Community');

      // 8. Bot leaves the group
      const leaveRes = await app.request(`/bot/groups/${groupId}/leave`, {
        method: 'POST',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(leaveRes.status).toBe(200);

      // Verify Bot is no longer in group list
      const finalGrpsRes = await app.request('/bot/groups', {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      const finalGrps = await finalGrpsRes.json<any>();
      expect(finalGrps.groups.length).toBe(0);
    });

    it('prevents bot from kicking the group owner even if bot is admin', async () => {
      // Promote Bot to admin
      await app.request(`/groups/${groupId}/members/${botId}/role`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ role: 'admin' }),
      }, { DB: db, VOICE_BUCKET: bucket });

      // Bot attempts to kick Owner (User A) -> 403 Forbidden
      const kickOwnerRes = await app.request(`/bot/groups/${groupId}/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ user_id: userA.user.id }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(kickOwnerRes.status).toBe(403);
    });
  });

  describe('5. Bot Advanced Operations (Public Join, Invite Token Join, Direct Chat, Sync, Disabled Status)', () => {
    let botId: string;
    let apiKey: string;

    beforeEach(async () => {
      const res = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ name: 'Explorer Bot', username: 'explorer_bot' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const data = await res.json<any>();
      botId = data.bot.id;
      apiKey = data.bot.api_key;
    });

    it('allows bot to join a public group via group_id', async () => {
      // User B creates a public group
      const grpRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userB.token}`,
        },
        body: JSON.stringify({
          name: 'Public Hangout',
          type: 'group',
          metadata: { joinable: true },
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const grp = await grpRes.json<any>();

      // Update group to public
      await db.prepare("UPDATE conversations SET group_type = 'public' WHERE id = ?").bind(grp.id).run();

      // Bot joins public group
      const joinRes = await app.request('/bot/groups/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ group_id: grp.id }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(joinRes.status).toBe(200);

      // Verify bot is member
      const grpsRes = await app.request('/bot/groups', {
        method: 'GET',
        headers: { 'X-Bot-Id': botId, 'X-Bot-Key': apiKey },
      }, { DB: db, VOICE_BUCKET: bucket });
      const grpsData = await grpsRes.json<any>();
      expect(grpsData.groups.some((g: any) => g.id === grp.id)).toBe(true);
    });

    it('allows bot to join group via invite token', async () => {
      // User B creates private group
      const grpRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userB.token}`,
        },
        body: JSON.stringify({ name: 'Secret Club' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const grp = await grpRes.json<any>();

      // User B generates invite link
      const inviteRes = await app.request(`/groups/${grp.id}/invite-links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userB.token}`,
        },
        body: JSON.stringify({ expires_in_seconds: 3600 }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const inviteData = await inviteRes.json<any>();
      const token = inviteData.token;

      // Bot joins via invite token
      const joinRes = await app.request('/bot/groups/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({ invite_token: token }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(joinRes.status).toBe(200);
    });

    it('supports bot 1:1 direct chat and bot incremental sync (/bot/sync)', async () => {
      // User A initiates direct chat with Bot
      const directConvRes = await app.request('/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ target_user_id: botId }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(directConvRes.status).toBe(201);
      const conversation = await directConvRes.json<any>();

      // Bot sends reply in direct chat
      const replyRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: conversation.id,
          content: 'Hello creator! How can I assist you?',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(replyRes.status).toBe(201);

      // Bot calls /bot/sync
      const botSyncRes = await app.request('/bot/sync', {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(botSyncRes.status).toBe(200);
      const botSyncData = await botSyncRes.json<any>();
      expect(botSyncData.messages.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects bot authentication when bot is disabled', async () => {
      // Owner disables bot
      const disableRes = await app.request(`/bots/${botId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ status: 'disabled' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(disableRes.status).toBe(200);

      // Calling bot API returns 401
      const authRes = await app.request('/bot/me', {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(authRes.status).toBe(401);
    });
  });

  describe('6. Deep Edge Cases, Security Guards & Concurrent Messaging', () => {
    let botId: string;
    let apiKey: string;
    let groupId: string;

    beforeEach(async () => {
      // Create Bot
      const botRes = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ name: 'Sentinel Bot', username: 'sentinel_bot' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const botData = await botRes.json<any>();
      botId = botData.bot.id;
      apiKey = botData.bot.api_key;

      // User A creates group with User B
      const grpRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          name: 'Security Testing Lab',
          member_ids: [userB.user.id],
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const grpData = await grpRes.json<any>();
      groupId = grpData.id;
    });

    it('forbids bot from sending messages to groups it has not joined', async () => {
      // Bot is NOT in groupId yet
      const sendRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: 'I should not be able to talk here',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(sendRes.status).toBe(403);
      const data = await sendRes.json<any>();
      expect(data.error).toContain('not a member');
    });

    it('supports bot sending stickers and @mentions, and rejects empty messages', async () => {
      // Add bot to group
      await app.request(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ user_id: botId }),
      }, { DB: db, VOICE_BUCKET: bucket });

      // 1. Send sticker
      const stickerRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: 'animated/U+2764_1',
          type: 'sticker',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(stickerRes.status).toBe(201);
      const stickerData = await stickerRes.json<any>();
      expect(stickerData.message.type).toBe('sticker');
      expect(stickerData.message.content).toBe('animated/U+2764_1');

      // 2. Send message with @mentions
      const mentionRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: `Hello @${userB.user.wallet_address}, welcome to the group!`,
          mentions: [userB.user.wallet_address],
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(mentionRes.status).toBe(201);
      const mentionData = await mentionRes.json<any>();
      expect(mentionData.message.mentions).toContain(userB.user.wallet_address.toLowerCase());

      // 3. Reject empty content
      const emptyRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: '   ',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(emptyRes.status).toBe(400);
    });

    it('blocks bot from speaking if the bot is specifically muted by owner', async () => {
      // Add bot as normal member
      await app.request(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ user_id: botId }),
      }, { DB: db, VOICE_BUCKET: bucket });

      // Owner mutes the bot
      const muteBotRes = await app.request(`/groups/${groupId}/members/${botId}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({
          muted: true,
          duration_seconds: 3600,
          reason: 'Too noisy',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(muteBotRes.status).toBe(200);

      // Bot attempts to send message -> 403 Forbidden
      const botSendRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: 'Am I muted?',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(botSendRes.status).toBe(403);
      const err = await botSendRes.json<any>();
      expect(err.error).toContain('muted');
    });

    it('handles concurrent burst messaging by bot smoothly via D1 write batching', async () => {
      // Add bot to group
      await app.request(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ user_id: botId }),
      }, { DB: db, VOICE_BUCKET: bucket });

      // Send 10 messages concurrently
      const sends = Array.from({ length: 10 }).map((_, i) =>
        app.request('/bot/messages/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bot-Id': botId,
            'X-Bot-Key': apiKey,
          },
          body: JSON.stringify({
            conversation_id: groupId,
            content: `Concurrent Message #${i + 1}`,
          }),
        }, { DB: db, VOICE_BUCKET: bucket })
      );

      const results = await Promise.all(sends);
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      // Verify all 10 messages exist in conversation
      const readRes = await app.request(`/bot/conversations/${groupId}/messages?limit=50`, {
        method: 'GET',
        headers: {
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
      }, { DB: db, VOICE_BUCKET: bucket });

      expect(readRes.status).toBe(200);
      const readData = await readRes.json<any>();
      const concurrentMsgs = readData.messages.filter((m: any) =>
        typeof m.content === 'string' && m.content.startsWith('Concurrent Message #')
      );
      expect(concurrentMsgs.length).toBe(10);
    });

    it('supports two bots interacting within the same group', async () => {
      // 1. Create Bot 2
      const bot2Res = await app.request('/bots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userB.token}`,
        },
        body: JSON.stringify({ name: 'Echo Bot', username: 'echo_bot' }),
      }, { DB: db, VOICE_BUCKET: bucket });
      const bot2Data = await bot2Res.json<any>();
      const bot2Id = bot2Data.bot.id;
      const bot2Key = bot2Data.bot.api_key;

      // 2. Add both bots to group
      await app.request(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ user_id: botId }),
      }, { DB: db, VOICE_BUCKET: bucket });

      await app.request(`/groups/${groupId}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userA.token}`,
        },
        body: JSON.stringify({ user_id: bot2Id }),
      }, { DB: db, VOICE_BUCKET: bucket });

      // 3. Bot 1 sends query message
      const qRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': botId,
          'X-Bot-Key': apiKey,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: 'Ping from Sentinel Bot',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(qRes.status).toBe(201);

      // 4. Bot 2 syncs updates and sees Bot 1's ping
      const bot2SyncRes = await app.request('/bot/sync', {
        method: 'GET',
        headers: {
          'X-Bot-Id': bot2Id,
          'X-Bot-Key': bot2Key,
        },
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(bot2SyncRes.status).toBe(200);
      const bot2Sync = await bot2SyncRes.json<any>();
      const receivedPing = bot2Sync.messages.find((m: any) => m.content === 'Ping from Sentinel Bot');
      expect(receivedPing).toBeDefined();

      // 5. Bot 2 replies Pong
      const replyRes = await app.request('/bot/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': bot2Id,
          'X-Bot-Key': bot2Key,
        },
        body: JSON.stringify({
          conversation_id: groupId,
          content: 'Pong from Echo Bot',
        }),
      }, { DB: db, VOICE_BUCKET: bucket });
      expect(replyRes.status).toBe(201);
    });
  });
});
