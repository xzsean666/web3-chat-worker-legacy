import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Explicit Delivery ACK & Burn-on-Read Lifecycle', () => {
  let db: D1Database;
  let env: Env;
  let aliceWallet: TestWallet;
  let bobWallet: TestWallet;
  let aliceToken: string;
  let bobToken: string;
  let aliceUser: { id: string; wallet_address: string };
  let bobUser: { id: string; wallet_address: string };
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

    const aliceAuth = await loginUser(aliceWallet);
    aliceToken = aliceAuth.token;
    aliceUser = aliceAuth.user;

    const bobAuth = await loginUser(bobWallet);
    bobToken = bobAuth.token;
    bobUser = bobAuth.user;

    // Create direct conversation
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

  it('progresses message status from pending to delivered on client ACK', async () => {
    // Alice sends message
    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Hello Bob' }),
    }, env);
    const msg = (await sendRes.json()) as any;
    expect(msg.status).toBe('pending');

    // Bob acknowledges delivery
    const ackRes = await app.request(`/messages/${msg.id}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(ackRes.status).toBe(200);

    // Verify status in DB
    const updated = await db.prepare('SELECT status, delivered_at FROM messages WHERE id = ?').bind(msg.id).first<any>();
    expect(updated.status).toBe('delivered');
    expect(updated.delivered_at).toBeGreaterThan(0);

    // Verify message receipt in DB
    const receipt = await db.prepare('SELECT * FROM message_receipts WHERE message_id = ? AND user_id = ?').bind(msg.id, bobUser.id).first<any>();
    expect(receipt).not.toBeNull();
    expect(receipt.status).toBe('delivered');
  });

  it('prevents sender from acknowledging delivery of their own message', async () => {
    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Self ping' }),
    }, env);
    const msg = (await sendRes.json()) as any;

    // Alice tries to ACK her own message
    const ackRes = await app.request(`/messages/${msg.id}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(ackRes.status).toBe(400);
  });

  it('marks permanent message as read on read ACK', async () => {
    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Read me', retention: 'permanent' }),
    }, env);
    const msg = (await sendRes.json()) as any;

    // Bob marks as read
    const readRes = await app.request(`/messages/${msg.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(readRes.status).toBe(200);
    const readData = (await readRes.json()) as any;
    expect(readData.status).toBe('read');

    // Verify DB
    const updated = await db.prepare('SELECT status, read_at FROM messages WHERE id = ?').bind(msg.id).first<any>();
    expect(updated.status).toBe('read');
    expect(updated.read_at).toBeGreaterThan(0);
  });

  it('destroys message immediately upon read when retention is on_read (burn-on-read)', async () => {
    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'This message will self-destruct', retention: 'on_read' }),
    }, env);
    const msg = (await sendRes.json()) as any;
    expect(msg.retention).toBe('on_read');

    // Bob reads the message
    const readRes = await app.request(`/messages/${msg.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(readRes.status).toBe(200);
    const readData = (await readRes.json()) as any;
    expect(readData.status).toBe('burned');

    // Verify message is gone from D1
    const inDb = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msg.id).first();
    expect(inDb).toBeNull();

    // Subsequent retrieval contains 0 messages
    const getRes = await app.request(`/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    const getData = (await getRes.json()) as any;
    expect(getData.messages.length).toBe(0);
  });

  it('supports batch delivery and batch read ACK endpoints', async () => {
    const res1 = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Batch 1' }),
    }, env);
    const m1 = (await res1.json()) as any;

    const res2 = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Batch 2' }),
    }, env);
    const m2 = (await res2.json()) as any;

    // Batch delivery ACK
    const batchAckRes = await app.request('/messages/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ message_ids: [m1.id, m2.id] }),
    }, env);
    expect(batchAckRes.status).toBe(200);
    const batchAckData = (await batchAckRes.json()) as any;
    expect(batchAckData.acknowledged).toContain(m1.id);
    expect(batchAckData.acknowledged).toContain(m2.id);

    // Batch read ACK
    const batchReadRes = await app.request('/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ message_ids: [m1.id, m2.id] }),
    }, env);
    expect(batchReadRes.status).toBe(200);
    const batchReadData = (await batchReadRes.json()) as any;
    expect(batchReadData.read).toContain(m1.id);
    expect(batchReadData.read).toContain(m2.id);
  });
});
