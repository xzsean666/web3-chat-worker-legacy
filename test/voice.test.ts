import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { makeMutualFriends } from './helpers/friends';
import { sweepExpiredMessages } from '../src/services/cleanup';
import type { Env } from '../src/types';

describe('Voice Message Storage (R2) & Synchronized Cleanup', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;
  let aliceWallet: TestWallet;
  let bobWallet: TestWallet;
  let charlieWallet: TestWallet;
  let aliceToken: string;
  let bobToken: string;
  let charlieToken: string;
  let aliceUser: { id: string; wallet_address: string };
  let bobUser: { id: string; wallet_address: string };
  let charlieUser: { id: string; wallet_address: string };
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
    r2 = createMockR2Bucket() as unknown as MockR2Bucket;
    env = {
      DB: db,
      VOICE_BUCKET: r2 as unknown as R2Bucket,
    };

    aliceWallet = createTestWallet();
    bobWallet = createTestWallet();
    charlieWallet = createTestWallet();

    const aliceAuth = await loginUser(aliceWallet);
    aliceToken = aliceAuth.token;
    aliceUser = aliceAuth.user;

    const bobAuth = await loginUser(bobWallet);
    bobToken = bobAuth.token;
    bobUser = bobAuth.user;

    const charlieAuth = await loginUser(charlieWallet);
    charlieToken = charlieAuth.token;
    charlieUser = charlieAuth.user;

    // Direct conversation between Alice and Bob
    await makeMutualFriends(env, aliceToken, aliceUser.id, bobToken, bobUser.id);
    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ target_user_id: bobUser.id }),
    }, env);
    const convData = (await convRes.json()) as any;
    conversationId = convData.id;
  });

  it('uploads voice message and stores in both R2 and D1', async () => {
    // 100 bytes of dummy audio data encoded as base64
    const audioBytes = new Uint8Array(100).fill(42);
    const base64 = Buffer.from(audioBytes).toString('base64');

    const uploadRes = await app.request('/voice/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        audio_base64: base64,
        mime_type: 'audio/webm',
        duration: 5.4,
        retention: 'permanent',
      }),
    }, env);

    expect(uploadRes.status).toBe(201);
    const data = (await uploadRes.json()) as any;
    expect(data.message.id).toBeDefined();
    expect(data.message.type).toBe('voice');
    expect(data.voice.object_key).toMatch(/^voice\/.+\.webm$/);
    expect(data.voice.duration).toBe(5.4);
    expect(data.voice.size).toBe(100);

    // Verify file is in R2
    expect(r2.hasKey(data.voice.object_key)).toBe(true);

    // Verify DB records
    const voiceRow = await db.prepare('SELECT * FROM voice_messages WHERE message_id = ?').bind(data.message.id).first();
    expect(voiceRow).not.toBeNull();
  });

  it('streams voice audio binary for conversation members', async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const base64 = Buffer.from(audioBytes).toString('base64');

    const uploadRes = await app.request('/voice/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        audio_base64: base64,
        mime_type: 'audio/mp3',
        duration: 1.2,
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as any;
    const msgId = uploadData.message.id;

    // Bob (recipient member) downloads audio
    const getRes = await app.request(`/voice/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);

    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('audio/mp3');
    const downloadedBuf = await getRes.arrayBuffer();
    expect(new Uint8Array(downloadedBuf)).toEqual(audioBytes);

    // Charlie (non-member) is rejected
    const charlieRes = await app.request(`/voice/${msgId}`, {
      headers: { Authorization: `Bearer ${charlieToken}` },
    }, env);
    expect(charlieRes.status).toBe(403);
  });

  it('atomically destroys both D1 record and R2 audio on burn-on-read Read ACK', async () => {
    const audioBytes = new Uint8Array([9, 8, 7, 6, 5]);
    const base64 = Buffer.from(audioBytes).toString('base64');

    const uploadRes = await app.request('/voice/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        audio_base64: base64,
        mime_type: 'audio/webm',
        duration: 3.0,
        retention: 'on_read',
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as any;
    const msgId = uploadData.message.id;
    const objectKey = uploadData.voice.object_key;

    // File must initially exist in R2
    expect(r2.hasKey(objectKey)).toBe(true);

    // Bob reads the message
    const readRes = await app.request(`/messages/${msgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(readRes.status).toBe(200);
    const readData = (await readRes.json()) as any;
    expect(readData.status).toBe('burned');

    // Bob can still stream audio within 30s viewing window
    const listenWithin30s = await app.request(`/voice/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(listenWithin30s.status).toBe(200);

    // After 30s viewing window elapses, sweeper purges D1 and R2
    const oldTimestamp = Date.now() - 35000;
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND status = 'read'")
      .bind(oldTimestamp, msgId).run();
    // 公网 /admin/cleanup 端点已删除，测试直接调用清理服务
    await sweepExpiredMessages(db, r2);

    // Verify D1 message record is deleted
    const msgInDb = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
    expect(msgInDb).toBeNull();

    // Verify D1 voice_messages record is cascaded/deleted
    const voiceInDb = await db.prepare('SELECT * FROM voice_messages WHERE message_id = ?').bind(msgId).first();
    expect(voiceInDb).toBeNull();

    // Verify R2 audio object is deleted
    expect(r2.hasKey(objectKey)).toBe(false);

    // Subsequent call to GET /voice/:messageId returns 404
    const subsequentGet = await app.request(`/voice/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(subsequentGet.status).toBe(404);
  });

  it('rejects unsupported audio MIME formats', async () => {
    const audioBytes = new Uint8Array([1, 2, 3]);
    const base64 = Buffer.from(audioBytes).toString('base64');

    const res = await app.request('/voice/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        audio_base64: base64,
        mime_type: 'application/pdf',
        duration: 1,
      }),
    }, env);

    expect(res.status).toBe(400);
  });
});
