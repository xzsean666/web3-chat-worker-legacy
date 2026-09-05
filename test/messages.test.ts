import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Messaging Pipeline & Incremental Sync Engine', () => {
  let db: D1Database;
  let env: Env;
  let aliceWallet: TestWallet;
  let bobWallet: TestWallet;
  let eveWallet: TestWallet;
  let aliceToken: string;
  let bobToken: string;
  let eveToken: string;
  let aliceUser: { id: string; wallet_address: string };
  let bobUser: { id: string; wallet_address: string };
  let eveUser: { id: string; wallet_address: string };
  let conversationId: string;

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
    eveWallet = createTestWallet();

    const aliceAuth = await loginUser(aliceWallet);
    aliceToken = aliceAuth.token;
    aliceUser = aliceAuth.user;

    const bobAuth = await loginUser(bobWallet);
    bobToken = bobAuth.token;
    bobUser = bobAuth.user;

    const eveAuth = await loginUser(eveWallet);
    eveToken = eveAuth.token;
    eveUser = eveAuth.user;

    // Create a direct conversation between Alice and Bob
    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ target_user_id: bobUser.id }),
    }, env);
    const convData = (await convRes.json()) as any;
    conversationId = convData.id;
  });

  it('rejects sending message from non-member', async () => {
    const res = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${eveToken}`,
      },
      body: JSON.stringify({ content: 'Eve sneaking in' }),
    }, env);

    expect(res.status).toBe(403);
  });

  it('sends message with default 24h expiration and pending status', async () => {
    const beforeTime = Date.now();
    const res = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ content: 'Hello Bob!' }),
    }, env);

    expect(res.status).toBe(201);
    const msg = (await res.json()) as any;
    expect(msg.id).toBeDefined();
    expect(msg.content).toBe('Hello Bob!');
    expect(msg.status).toBe('pending');
    expect(msg.retention).toBe('permanent');
    expect(msg.expires_at).toBeGreaterThanOrEqual(beforeTime + 24 * 60 * 60 * 1000 - 5000);
  });

  it('supports custom expires_in_seconds and on_read retention', async () => {
    const res = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        content: 'Secret burn message',
        retention: 'on_read',
        expires_in_seconds: 60,
      }),
    }, env);

    expect(res.status).toBe(201);
    const msg = (await res.json()) as any;
    expect(msg.retention).toBe('on_read');
    expect(msg.expires_at).toBeLessThanOrEqual(Date.now() + 65 * 1000);
  });

  it('rejects sending empty message text', async () => {
    const res = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ content: '   ' }),
    }, env);

    expect(res.status).toBe(400);
  });

  it('supports cursor-based incremental pagination (after_id)', async () => {
    // Alice sends 3 messages
    const res1 = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Message 1' }),
    }, env);
    const m1 = (await res1.json()) as any;

    const res2 = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Message 2' }),
    }, env);
    const m2 = (await res2.json()) as any;

    const res3 = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Message 3' }),
    }, env);
    const m3 = (await res3.json()) as any;

    // Bob pulls first page (limit = 2)
    const page1Res = await app.request(`/conversations/${conversationId}/messages?limit=2`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as any;
    expect(page1.messages.length).toBe(2);
    expect(page1.messages[0].id).toBe(m1.id);
    expect(page1.messages[1].id).toBe(m2.id);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBe(m2.id);

    // Bob pulls second page using after_id = m2.id
    const page2Res = await app.request(
      `/conversations/${conversationId}/messages?after_id=${page1.next_cursor}&limit=2`,
      { headers: { Authorization: `Bearer ${bobToken}` } },
      env
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as any;
    expect(page2.messages.length).toBe(1);
    expect(page2.messages[0].id).toBe(m3.id);
    expect(page2.has_more).toBe(false);
  });

  it('filters out expired messages on retrieval', async () => {
    // Insert an expired message directly
    const expiredTime = Date.now() - 1000;
    await db.prepare(`
      INSERT INTO messages (
        id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at
      ) VALUES (?, ?, ?, 'text', 'Old expired', 'permanent', 'pending', ?, ?)
    `).bind('expired_msg_1', conversationId, aliceUser.id, expiredTime, expiredTime - 10000).run();

    // Alice sends a valid active message
    await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Active message' }),
    }, env);

    const getRes = await app.request(`/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);

    const data = (await getRes.json()) as any;
    const msgIds = data.messages.map((m: any) => m.id);
    expect(msgIds).not.toContain('expired_msg_1');
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].content).toBe('Active message');
  });

  it('supports delta /sync across conversations', async () => {
    // Create another group chat with Alice and Eve
    const groupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ name: 'Alpha Chat', member_ids: [eveUser.id] }),
    }, env);
    const group = (await groupRes.json()) as any;

    const syncCheckpoint = Date.now();

    // Bob sends message in direct chat
    await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ content: 'Direct chat ping' }),
    }, env);

    // Eve sends message in group chat
    await app.request(`/conversations/${group.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${eveToken}` },
      body: JSON.stringify({ content: 'Group chat ping' }),
    }, env);

    // Alice calls /sync
    const syncRes = await app.request(`/sync?since=${syncCheckpoint - 100}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);

    expect(syncRes.status).toBe(200);
    const syncData = (await syncRes.json()) as any;
    expect(syncData.messages.length).toBe(2);
    expect(syncData.messages.map((m: any) => m.content)).toContain('Direct chat ping');
    expect(syncData.messages.map((m: any) => m.content)).toContain('Group chat ping');
  });
});
