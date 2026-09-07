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

    // Within 30s viewing window, message is still readable by Bob
    const getWithin30s = await app.request(`/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    const getDataWithin30s = (await getWithin30s.json()) as any;
    expect(getDataWithin30s.messages.length).toBe(1);

    // After 30s viewing window elapses, message is burned and purged
    const oldTimestamp = Date.now() - 35000;
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND status = 'read'")
      .bind(oldTimestamp, msg.id).run();
    await app.request('/admin/cleanup', { method: 'POST' }, env);

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

  it('tracks per-recipient delivery in group chat and transitions message status only when all recipients ACK', async () => {
    const charlieWallet = createTestWallet();
    const charlieAuth = await loginUser(charlieWallet);

    // Alice creates group with Bob and Charlie
    const groupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        name: 'Receipts Test Group',
        member_ids: [bobUser.id, charlieAuth.user.id],
      }),
    }, env);
    expect(groupRes.status).toBe(201);
    const group = (await groupRes.json()) as any;

    // Alice sends a message to group
    const sendRes = await app.request(`/conversations/${group.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Group update' }),
    }, env);
    const msg = (await sendRes.json()) as any;
    expect(msg.status).toBe('pending');

    // Bob ACKs delivery (1 of 2 recipients)
    const bobAckRes = await app.request(`/messages/${msg.id}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobAckRes.status).toBe(200);

    // Message status in DB should STILL be pending (Charlie hasn't received yet)
    let inDb = await db.prepare('SELECT status, delivered_at FROM messages WHERE id = ?').bind(msg.id).first<any>();
    expect(inDb.status).toBe('pending');
    expect(inDb.delivered_at).toBeNull();

    // Query receipts endpoint via GET /messages/:id/receipts
    const receiptsRes1 = await app.request(`/messages/${msg.id}/receipts`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(receiptsRes1.status).toBe(200);
    const receipts1 = (await receiptsRes1.json()) as any;
    expect(receipts1.total_recipients).toBe(2);
    expect(receipts1.delivered_count).toBe(1);
    expect(receipts1.all_delivered).toBe(false);

    const bobReceipt1 = receipts1.receipts.find((r: any) => r.user_id === bobUser.id);
    const charlieReceipt1 = receipts1.receipts.find((r: any) => r.user_id === charlieAuth.user.id);
    expect(bobReceipt1.status).toBe('delivered');
    expect(charlieReceipt1.status).toBe('pending');

    // Charlie now ACKs delivery (2 of 2 recipients)
    const charlieAckRes = await app.request(`/messages/${msg.id}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${charlieAuth.token}` },
    }, env);
    expect(charlieAckRes.status).toBe(200);

    // Now message status should transition to delivered
    inDb = await db.prepare('SELECT status, delivered_at FROM messages WHERE id = ?').bind(msg.id).first<any>();
    expect(inDb.status).toBe('delivered');
    expect(inDb.delivered_at).toBeGreaterThan(0);

    // Receipts summary reflects all delivered
    const receiptsRes2 = await app.request(`/messages/${msg.id}/receipts`, {
      headers: { Authorization: `Bearer ${charlieAuth.token}` },
    }, env);
    const receipts2 = (await receiptsRes2.json()) as any;
    expect(receipts2.total_recipients).toBe(2);
    expect(receipts2.delivered_count).toBe(2);
    expect(receipts2.all_delivered).toBe(true);
  });

  it('delays burn-on-read in group chat until all recipients have read the message', async () => {
    const charlieWallet = createTestWallet();
    const charlieAuth = await loginUser(charlieWallet);

    // Alice creates group with Bob and Charlie
    const groupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        name: 'Ephemeral Group',
        member_ids: [bobUser.id, charlieAuth.user.id],
      }),
    }, env);
    const group = (await groupRes.json()) as any;

    // Alice sends ephemeral message
    const sendRes = await app.request(`/conversations/${group.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Confidential group secret', retention: 'on_read' }),
    }, env);
    const msg = (await sendRes.json()) as any;

    // Bob reads first -> returns burned for Bob, but message preserved in DB until all read
    const bobReadRes = await app.request(`/messages/${msg.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobReadRes.status).toBe(200);
    const bobReadData = (await bobReadRes.json()) as any;
    expect(bobReadData.status).toBe('burned'); // Burned for Bob!

    // Message must still exist in DB so Charlie can read it
    let inDb = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msg.id).first();
    expect(inDb).not.toBeNull();

    // Bob can still fetch the read on_read message within 30s viewing window
    let bobMessagesRes = await app.request(`/conversations/${group.id}/messages`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    let bobMessagesData = (await bobMessagesRes.json()) as any;
    expect(bobMessagesData.messages.some((m: any) => m.id === msg.id)).toBe(true);

    // After 35s (> 30s), Bob cannot fetch the read on_read message anymore (filtered out)
    const oldReadTime = Date.now() - 35000;
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND user_id = ? AND status = 'read'")
      .bind(oldReadTime, msg.id, bobUser.id).run();

    bobMessagesRes = await app.request(`/conversations/${group.id}/messages`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    bobMessagesData = (await bobMessagesRes.json()) as any;
    expect(bobMessagesData.messages.some((m: any) => m.id === msg.id)).toBe(false);

    // Charlie has not read yet, so Charlie CAN still fetch it
    const charlieMessagesRes = await app.request(`/conversations/${group.id}/messages`, {
      headers: { Authorization: `Bearer ${charlieAuth.token}` },
    }, env);
    const charlieMessagesData = (await charlieMessagesRes.json()) as any;
    expect(charlieMessagesData.messages.some((m: any) => m.id === msg.id)).toBe(true);

    // Check receipts: Bob read, Charlie pending
    const receiptsRes = await app.request(`/messages/${msg.id}/receipts`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    const receipts = (await receiptsRes.json()) as any;
    expect(receipts.read_count).toBe(1);
    expect(receipts.all_read).toBe(false);

    // Charlie reads second (all recipients have now read)
    const charlieReadRes = await app.request(`/messages/${msg.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${charlieAuth.token}` },
    }, env);
    expect(charlieReadRes.status).toBe(200);
    const charlieReadData = (await charlieReadRes.json()) as any;
    expect(charlieReadData.status).toBe('burned'); // Burned triggered!

    // Charlie still has 30s viewing window
    inDb = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msg.id).first();
    expect(inDb).not.toBeNull();

    // After 35s (> 30s), both viewing windows elapsed -> sweeper purges from D1
    const oldReadTime2 = Date.now() - 35000;
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND status = 'read'")
      .bind(oldReadTime2, msg.id).run();
    await app.request('/admin/cleanup', { method: 'POST' }, env);

    // Message must now be purged from D1
    inDb = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msg.id).first();
    expect(inDb).toBeNull();

    // Query receipts on destroyed message returns 404
    const deadReceiptsRes = await app.request(`/messages/${msg.id}/receipts`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    }, env);
    expect(deadReceiptsRes.status).toBe(404);
  });

  it('rejects receipts query for non-members with HTTP 403', async () => {
    const charlieWallet = createTestWallet();
    const charlieAuth = await loginUser(charlieWallet);

    // Alice sends direct message to Bob
    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Private direct message' }),
    }, env);
    const msg = (await sendRes.json()) as any;

    // Charlie (non-member of direct chat) attempts to view receipts
    const receiptsRes = await app.request(`/messages/${msg.id}/receipts`, {
      headers: { Authorization: `Bearer ${charlieAuth.token}` },
    }, env);
    expect(receiptsRes.status).toBe(403);
  });

  it('filters read on_read messages in incremental sync endpoint /sync for reading user', async () => {
    const charlieWallet = createTestWallet();
    const charlieAuth = await loginUser(charlieWallet);

    // Alice creates group with Bob and Charlie
    const groupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        name: 'Sync Ephemeral Group',
        member_ids: [bobUser.id, charlieAuth.user.id],
      }),
    }, env);
    const group = (await groupRes.json()) as any;

    const sendRes = await app.request(`/conversations/${group.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ content: 'Sync secret', retention: 'on_read' }),
    }, env);
    const msg = (await sendRes.json()) as any;

    // Bob syncs before reading -> sees the message
    let bobSync = await app.request('/sync', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    let bobSyncData = (await bobSync.json()) as any;
    expect(bobSyncData.messages.some((m: any) => m.id === msg.id)).toBe(true);

    // Bob reads the message -> status: burned
    const bobRead = await app.request(`/messages/${msg.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect((await bobRead.json() as any).status).toBe('burned');

    // Bob syncs after reading -> within 30s viewing window, message is still returned
    bobSync = await app.request('/sync', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    bobSyncData = (await bobSync.json()) as any;
    expect(bobSyncData.messages.some((m: any) => m.id === msg.id)).toBe(true);

    // After 35s (> 30s), message is filtered out from sync for Bob
    const oldTimestamp = Date.now() - 35000;
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND user_id = ? AND status = 'read'")
      .bind(oldTimestamp, msg.id, bobUser.id).run();

    bobSync = await app.request('/sync', {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    bobSyncData = (await bobSync.json()) as any;
    expect(bobSyncData.messages.some((m: any) => m.id === msg.id)).toBe(false);

    // Charlie has not read -> Charlie still sees the message in sync
    const charlieSync = await app.request('/sync', {
      headers: { Authorization: `Bearer ${charlieAuth.token}` },
    }, env);
    const charlieSyncData = (await charlieSync.json()) as any;
    expect(charlieSyncData.messages.some((m: any) => m.id === msg.id)).toBe(true);
  });
});
