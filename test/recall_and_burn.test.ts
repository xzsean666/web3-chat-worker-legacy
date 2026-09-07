import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { MockR2Bucket } from './helpers/r2';
import { createTestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Message Recall & 30-Second Burn-on-Read Viewing Window (TASK-015)', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;

  beforeEach(() => {
    db = createMockD1Database(true);
    r2 = new MockR2Bucket();
    env = {
      DB: db,
      VOICE_BUCKET: r2 as unknown as R2Bucket,
      MESSAGE_RECALL_WINDOW_SECONDS: 30,
    };
  });

  async function loginUser(wallet: ReturnType<typeof createTestWallet>) {
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
      body: JSON.stringify({
        wallet_address: wallet.address,
        signature,
        nonce: nonceData.nonce,
      }),
    }, env);

    const data = (await verifyRes.json()) as { token: string; user: any };
    return { token: data.token, user: data.user, wallet };
  }

  it('allows sender to recall a message within 30 seconds', async () => {
    const aliceWallet = createTestWallet();
    const bobWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);
    const bob = await loginUser(bobWallet);

    // Create 1:1 conversation
    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ target_wallet_address: bob.wallet.address }),
    }, env);
    const conv = (await convRes.json()) as { id: string };

    // Alice sends a message
    const msgRes = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ content: 'Hello Bob! Secret message' }),
    }, env);
    const msg = (await msgRes.json()) as { id: string };

    // Alice recalls the message within 30s
    const recallRes = await app.request(`/messages/${msg.id}/recall`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
      },
    }, env);
    expect(recallRes.status).toBe(200);
    const recallData = (await recallRes.json()) as { success: boolean; recalled_at: number };
    expect(recallData.success).toBe(true);
    expect(recallData.recalled_at).toBeGreaterThan(0);

    // When Bob fetches conversation messages, message is marked as recalled
    const bobFetchRes = await app.request(`/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    const bobFetchData = (await bobFetchRes.json()) as { messages: any[] };
    expect(bobFetchData.messages.length).toBe(1);
    expect(bobFetchData.messages[0].is_recalled).toBe(true);
    expect(bobFetchData.messages[0].content).toBe('[Message recalled]');
  });

  it('rejects recall attempt from non-sender or after 30 seconds', async () => {
    const aliceWallet = createTestWallet();
    const bobWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);
    const bob = await loginUser(bobWallet);

    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ target_wallet_address: bob.wallet.address }),
    }, env);
    const conv = (await convRes.json()) as { id: string };

    const msgRes = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ content: 'Hi Bob' }),
    }, env);
    const msg = (await msgRes.json()) as { id: string };

    // Bob attempts to recall Alice's message -> 403
    const bobRecallRes = await app.request(`/messages/${msg.id}/recall`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bob.token}`,
      },
    }, env);
    expect(bobRecallRes.status).toBe(403);

    // Manually age the message by 35 seconds to simulate recall window expiration
    const oldTimestamp = Date.now() - 35000;
    await db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').bind(oldTimestamp, msg.id).run();

    // Alice attempts to recall after 35s -> 400
    const expiredRecallRes = await app.request(`/messages/${msg.id}/recall`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
      },
    }, env);
    expect(expiredRecallRes.status).toBe(400);
    const errData = (await expiredRecallRes.json()) as { error: string };
    expect(errData.error).toContain('Recall window has expired');
  });

  it('purges R2 binary object immediately upon message recall', async () => {
    const aliceWallet = createTestWallet();
    const bobWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);
    const bob = await loginUser(bobWallet);

    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ target_wallet_address: bob.wallet.address }),
    }, env);
    const conv = (await convRes.json()) as { id: string };

    // Alice uploads image message
    const imageBase64 = Buffer.from('confidential-image-data').toString('base64');
    const uploadRes = await app.request('/images/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        conversation_id: conv.id,
        image_base64: imageBase64,
        mime_type: 'image/png',
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as { message: { id: string } };

    // Verify Bob can download image before recall
    const bobDownloadBefore = await app.request(`/images/${uploadData.message.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(bobDownloadBefore.status).toBe(200);

    // Alice recalls image message
    const recallRes = await app.request(`/messages/${uploadData.message.id}/recall`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(recallRes.status).toBe(200);

    // Bob can no longer download image after recall -> 404
    const bobDownloadAfter = await app.request(`/images/${uploadData.message.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(bobDownloadAfter.status).toBe(404);
  });

  it('guarantees burn-on-read messages remain readable for at least 30 seconds after read ACK', async () => {
    const aliceWallet = createTestWallet();
    const bobWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);
    const bob = await loginUser(bobWallet);

    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ target_wallet_address: bob.wallet.address }),
    }, env);
    const conv = (await convRes.json()) as { id: string };

    // Alice sends burn-on-read message
    const sendRes = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        content: 'This message burns 30s after reading',
        retention: 'on_read',
        burn_after_seconds: 30,
      }),
    }, env);
    const sendData = (await sendRes.json()) as { id: string; burn_after_seconds: number };
    expect(sendData.burn_after_seconds).toBe(30);

    // Bob reads the message
    const readRes = await app.request(`/messages/${sendData.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(readRes.status).toBe(200);

    // Within 30 seconds (e.g. immediate or 5s later): Bob STILL sees the message!
    const bobFetchWithin30s = await app.request(`/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    const bobData1 = (await bobFetchWithin30s.json()) as { messages: any[] };
    expect(bobData1.messages.some((m) => m.id === sendData.id)).toBe(true);

    // Delta sync also still returns the message within the 30s window
    const syncRes = await app.request('/sync', {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    const syncData = (await syncRes.json()) as { messages: any[] };
    expect(syncData.messages.some((m) => m.id === sendData.id)).toBe(true);

    // Now simulate passage of 35 seconds by aging the read receipt timestamp
    const oldReadTime = Date.now() - 35000;
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND status = 'read'")
      .bind(oldReadTime, sendData.id).run();

    // After 35s (> 30s): Bob NO LONGER sees the message!
    const bobFetchAfter30s = await app.request(`/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    const bobData2 = (await bobFetchAfter30s.json()) as { messages: any[] };
    expect(bobData2.messages.some((m) => m.id === sendData.id)).toBe(false);

    // Cron cleanup purges the message from D1
    const cleanupRes = await app.request('/admin/cleanup', {
      method: 'POST',
    }, env);
    expect(cleanupRes.status).toBe(200);
    const cleanupData = (await cleanupRes.json()) as { purged_messages: number };
    expect(cleanupData.purged_messages).toBeGreaterThanOrEqual(1);

    const checkMsg = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(sendData.id).first();
    expect(checkMsg).toBeNull();
  });
});
