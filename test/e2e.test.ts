import { describe, it, expect, beforeEach } from 'vitest';
import worker, { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('End-to-End Integration Suite', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;
  let aliceWallet: TestWallet;
  let bobWallet: TestWallet;
  let charlieWallet: TestWallet;

  async function authenticate(wallet: TestWallet) {
    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, env);
    expect(nonceRes.status).toBe(200);
    const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };

    const signature = await wallet.signMessage(message);

    const verifyRes = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address, signature, nonce }),
    }, env);
    expect(verifyRes.status).toBe(200);
    const data = (await verifyRes.json()) as { token: string; user: { id: string; wallet_address: string } };

    return { token: data.token, user: data.user };
  }

  beforeEach(() => {
    db = createMockD1Database(true);
    r2 = createMockR2Bucket() as unknown as MockR2Bucket;
    env = {
      DB: db,
      VOICE_BUCKET: r2 as unknown as R2Bucket,
    };

    aliceWallet = createTestWallet();
    bobWallet = createTestWallet();
    charlieWallet = createTestWallet();
  });

  it('executes full user journey: Auth -> 1:1 Chat -> ACK -> Group Chat -> Voice Burn-on-Read -> Cron Expiry -> Logout', async () => {
    // -------------------------------------------------------------------------
    // 1. EVM Authentication for Alice, Bob, and Charlie
    // -------------------------------------------------------------------------
    const alice = await authenticate(aliceWallet);
    const bob = await authenticate(bobWallet);
    const charlie = await authenticate(charlieWallet);

    const aliceMeRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(aliceMeRes.status).toBe(200);
    const aliceMe = (await aliceMeRes.json()) as any;
    expect(aliceMe.user.wallet_address).toBe(aliceWallet.address);

    // -------------------------------------------------------------------------
    // 2. Direct 1-on-1 Conversation Lifecycle & Explicit Delivery/Read ACK
    // -------------------------------------------------------------------------
    // Alice starts direct chat with Bob
    const directRes = await app.request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ target_user_id: bob.user.id }),
    }, env);
    expect(directRes.status).toBe(201);
    const directChat = (await directRes.json()) as any;

    // Bob creates direct chat with Alice -> gets same conversation (idempotent)
    const bobDirectRes = await app.request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ target_user_id: alice.user.id }),
    }, env);
    const bobDirectChat = (await bobDirectRes.json()) as any;
    expect(bobDirectChat.id).toBe(directChat.id);

    // Alice sends permanent text message
    const sendRes1 = await app.request(`/conversations/${directChat.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ content: 'Hey Bob, ready for Devcon?' }),
    }, env);
    expect(sendRes1.status).toBe(201);
    const msg1 = (await sendRes1.json()) as any;
    expect(msg1.status).toBe('pending');

    // Bob pulls messages via incremental cursor sync
    const bobPullRes = await app.request(`/conversations/${directChat.id}/messages`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(bobPullRes.status).toBe(200);
    const bobPull = (await bobPullRes.json()) as any;
    expect(bobPull.messages.length).toBe(1);
    expect(bobPull.messages[0].id).toBe(msg1.id);

    // Bob sends explicit delivery ACK
    const ackRes = await app.request(`/messages/${msg1.id}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(ackRes.status).toBe(200);

    // Verify status transitioned to delivered
    const msgAfterAck = await db.prepare('SELECT status, delivered_at FROM messages WHERE id = ?').bind(msg1.id).first<any>();
    expect(msgAfterAck.status).toBe('delivered');
    expect(msgAfterAck.delivered_at).toBeGreaterThan(0);

    // Bob reads the message
    const readRes = await app.request(`/messages/${msg1.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(readRes.status).toBe(200);

    // Verify status transitioned to read
    const msgAfterRead = await db.prepare('SELECT status, read_at FROM messages WHERE id = ?').bind(msg1.id).first<any>();
    expect(msgAfterRead.status).toBe('read');
    expect(msgAfterRead.read_at).toBeGreaterThan(0);

    // -------------------------------------------------------------------------
    // 3. Group Chat & Voice Message with Burn-on-Read Destruction
    // -------------------------------------------------------------------------
    // Alice creates group chat "Web3 Core" with Bob and Charlie
    const groupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        name: 'Web3 Core',
        member_ids: [bob.user.id, charlie.user.id],
      }),
    }, env);
    expect(groupRes.status).toBe(201);
    const group = (await groupRes.json()) as any;
    expect(group.members.length).toBe(3);

    // Alice uploads an audio message with retention: 'on_read'
    const audioBytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const audioBase64 = Buffer.from(audioBytes).toString('base64');

    const voiceUploadRes = await app.request('/voice/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        conversation_id: group.id,
        audio_base64: audioBase64,
        mime_type: 'audio/webm',
        duration: 4.2,
        retention: 'on_read',
      }),
    }, env);
    expect(voiceUploadRes.status).toBe(201);
    const voiceData = (await voiceUploadRes.json()) as any;
    const voiceMsgId = voiceData.message.id;
    const voiceKey = voiceData.voice.object_key;

    // File is present in R2
    expect(r2.hasKey(voiceKey)).toBe(true);

    // Charlie pulls delta updates via /sync
    const charlieSyncRes = await app.request('/sync?since=0', {
      headers: { Authorization: `Bearer ${charlie.token}` },
    }, env);
    expect(charlieSyncRes.status).toBe(200);
    const charlieSync = (await charlieSyncRes.json()) as any;
    expect(charlieSync.messages.map((m: any) => m.id)).toContain(voiceMsgId);

    // Charlie downloads audio binary
    const downloadAudioRes = await app.request(`/voice/${voiceMsgId}`, {
      headers: { Authorization: `Bearer ${charlie.token}` },
    }, env);
    expect(downloadAudioRes.status).toBe(200);
    expect(downloadAudioRes.headers.get('Content-Type')).toBe('audio/webm');
    const downloadedBytes = new Uint8Array(await downloadAudioRes.arrayBuffer());
    expect(downloadedBytes).toEqual(audioBytes);

    // Charlie reads the ephemeral voice message (1 of 2 group recipients read)
    const charlieReadRes = await app.request(`/messages/${voiceMsgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${charlie.token}` },
    }, env);
    expect(charlieReadRes.status).toBe(200);
    const charlieReadData = (await charlieReadRes.json()) as any;
    expect(charlieReadData.status).toBe('read'); // Not burned yet, waiting for Bob!

    // Alice checks message receipts to see per-recipient delivery & read progress
    const receiptsRes = await app.request(`/messages/${voiceMsgId}/receipts`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(receiptsRes.status).toBe(200);
    const receiptsData = (await receiptsRes.json()) as any;
    expect(receiptsData.total_recipients).toBe(2);
    expect(receiptsData.read_count).toBe(1);
    expect(receiptsData.all_read).toBe(false);
    const charlieRec = receiptsData.receipts.find((r: any) => r.user_id === charlie.user.id);
    const bobRec = receiptsData.receipts.find((r: any) => r.user_id === bob.user.id);
    expect(charlieRec.status).toBe('read');
    expect(bobRec.status).toBe('pending');

    // File is still preserved in R2 for Bob
    expect(r2.hasKey(voiceKey)).toBe(true);

    // Bob downloads and reads the ephemeral voice message (2 of 2 recipients -> all read -> burn triggered!)
    const bobDownloadRes = await app.request(`/voice/${voiceMsgId}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(bobDownloadRes.status).toBe(200);

    const bobReadRes = await app.request(`/messages/${voiceMsgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(bobReadRes.status).toBe(200);
    const bobReadData = (await bobReadRes.json()) as any;
    expect(bobReadData.status).toBe('burned');

    // Dual-Storage Destruction verification:
    // 1) Audio binary removed from R2
    expect(r2.hasKey(voiceKey)).toBe(false);
    // 2) Message row removed from D1
    const d1Msg = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(voiceMsgId).first();
    expect(d1Msg).toBeNull();
    // 3) Voice metadata removed from D1
    const d1Voice = await db.prepare('SELECT * FROM voice_messages WHERE message_id = ?').bind(voiceMsgId).first();
    expect(d1Voice).toBeNull();

    // Subsequent download attempt returns 404
    const subsequentDownload = await app.request(`/voice/${voiceMsgId}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(subsequentDownload.status).toBe(404);

    // -------------------------------------------------------------------------
    // 4. Message Expiration & Scheduled Sweeper Cleanup
    // -------------------------------------------------------------------------
    // Alice sends a message with 1 second TTL
    const shortLivedRes = await app.request(`/conversations/${directChat.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        content: 'Self-expiring message in 1s',
        expires_in_seconds: 1,
      }),
    }, env);
    const shortLivedMsg = (await shortLivedRes.json()) as any;

    // Fast-forward or sleep 1.1s to exceed expires_at
    await new Promise((r) => setTimeout(r, 1100));

    // Bob attempts to fetch messages -> expired message is lazily excluded
    const lazyFetchRes = await app.request(`/conversations/${directChat.id}/messages`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    const lazyFetch = (await lazyFetchRes.json()) as any;
    expect(lazyFetch.messages.map((m: any) => m.id)).not.toContain(shortLivedMsg.id);

    // Trigger scheduled cleanup
    const cleanupRes = await app.request('/admin/cleanup', { method: 'POST' }, env);
    expect(cleanupRes.status).toBe(200);
    const cleanupData = (await cleanupRes.json()) as any;
    expect(cleanupData.purged_messages).toBeGreaterThanOrEqual(1);

    // Confirm completely deleted from D1
    const expiredInDb = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(shortLivedMsg.id).first();
    expect(expiredInDb).toBeNull();

    // -------------------------------------------------------------------------
    // 5. Session Logout & Revocation
    // -------------------------------------------------------------------------
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(logoutRes.status).toBe(200);

    const revokedMeRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(revokedMeRes.status).toBe(401);
  });
});
