import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Image Message Storage (R2) & Synchronized Cleanup', () => {
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
  let groupId: string;

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
    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ target_user_id: bobUser.id }),
    }, env);
    const convData = (await convRes.json()) as any;
    conversationId = convData.id;

    // Group conversation with Alice (owner), Bob, and Charlie
    const groupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        name: 'Design Crew',
        member_ids: [bobUser.id, charlieUser.id],
      }),
    }, env);
    const groupData = (await groupRes.json()) as any;
    groupId = groupData.id;
  });

  it('uploads image message via JSON base64 and stores in R2 and D1', async () => {
    const dummyBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
    const base64 = Buffer.from(dummyBytes).toString('base64');

    const uploadRes = await app.request('/images/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        image_base64: base64,
        mime_type: 'image/png',
        file_name: 'diagram.png',
        caption: 'Architecture Diagram',
        width: 1920,
        height: 1080,
        retention: 'permanent',
      }),
    }, env);

    expect(uploadRes.status).toBe(201);
    const data = (await uploadRes.json()) as any;
    expect(data.message.id).toBeDefined();
    expect(data.message.type).toBe('image');
    expect(data.message.content).toBe('Architecture Diagram');
    expect(data.image.object_key).toMatch(/^images\/.+\.png$/);
    expect(data.image.file_name).toBe('diagram.png');
    expect(data.image.width).toBe(1920);
    expect(data.image.height).toBe(1080);
    expect(data.image.size).toBe(dummyBytes.byteLength);

    // Verify file is in R2
    expect(r2.hasKey(data.image.object_key)).toBe(true);

    // Verify DB records
    const imgRow = await db.prepare('SELECT * FROM image_messages WHERE message_id = ?').bind(data.message.id).first<any>();
    expect(imgRow).not.toBeNull();
    expect(imgRow.mime_type).toBe('image/png');
    expect(imgRow.width).toBe(1920);
  });

  it('uploads image via multipart/form-data with default caption', async () => {
    const dummyBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG header
    const formData = new FormData();
    formData.append('conversation_id', conversationId);
    formData.append('width', '800');
    formData.append('height', '600');
    formData.append('file', new Blob([dummyBytes], { type: 'image/jpeg' }), 'photo.jpg');

    const uploadRes = await app.request('/images/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
      },
      body: formData,
    }, env);

    expect(uploadRes.status).toBe(201);
    const data = (await uploadRes.json()) as any;
    expect(data.message.type).toBe('image');
    expect(data.message.content).toBe('[Image: photo.jpg]');
    expect(data.image.object_key).toMatch(/^images\/.+\.jpg$/);
    expect(data.image.width).toBe(800);
    expect(data.image.height).toBe(600);
  });

  it('streams image binary and provides metadata endpoint for members', async () => {
    const dummyBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const base64 = Buffer.from(dummyBytes).toString('base64');

    const uploadRes = await app.request('/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        image_base64: base64,
        mime_type: 'image/webp',
        file_name: 'test.webp',
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as any;
    const msgId = uploadData.message.id;

    // Bob (recipient member) queries metadata
    const metaRes = await app.request(`/images/${msgId}/meta`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(metaRes.status).toBe(200);
    const metaData = (await metaRes.json()) as any;
    expect(metaData.mime_type).toBe('image/webp');
    expect(metaData.size).toBe(6);

    // Bob downloads binary
    const getRes = await app.request(`/images/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);

    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('image/webp');
    expect(getRes.headers.get('Content-Disposition')).toContain('inline');
    const downloadedBuf = await getRes.arrayBuffer();
    expect(new Uint8Array(downloadedBuf)).toEqual(dummyBytes);

    // Charlie (non-member) is rejected
    const charlieRes = await app.request(`/images/${msgId}`, {
      headers: { Authorization: `Bearer ${charlieToken}` },
    }, env);
    expect(charlieRes.status).toBe(403);
  });

  it('atomically destroys D1 record and R2 image on 1:1 burn-on-read Read ACK', async () => {
    const dummyBytes = new Uint8Array([10, 20, 30, 40]);
    const base64 = Buffer.from(dummyBytes).toString('base64');

    const uploadRes = await app.request('/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        image_base64: base64,
        mime_type: 'image/png',
        retention: 'on_read',
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as any;
    const msgId = uploadData.message.id;
    const objectKey = uploadData.image.object_key;

    // Initially in R2
    expect(r2.hasKey(objectKey)).toBe(true);

    // Bob reads the message
    const readRes = await app.request(`/messages/${msgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(readRes.status).toBe(200);
    const readData = (await readRes.json()) as any;
    expect(readData.status).toBe('burned');

    // Bob can still download image within 30s viewing window
    const downloadWithin30s = await app.request(`/images/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(downloadWithin30s.status).toBe(200);

    // After 30s viewing window elapses, sweeper purges D1 and R2
    const oldTimestamp = Date.now() - 35000;
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND status = 'read'")
      .bind(oldTimestamp, msgId).run();
    await app.request('/admin/cleanup', { method: 'POST' }, env);

    // Verify D1 records deleted
    const msgInDb = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
    expect(msgInDb).toBeNull();
    const imgInDb = await db.prepare('SELECT * FROM image_messages WHERE message_id = ?').bind(msgId).first();
    expect(imgInDb).toBeNull();

    // Verify R2 object deleted
    expect(r2.hasKey(objectKey)).toBe(false);

    // Subsequent GET returns 404
    const subsequentGet = await app.request(`/images/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(subsequentGet.status).toBe(404);
  });

  it('handles group chat burn-on-read per-recipient protection and full destruction on all-read', async () => {
    const dummyBytes = new Uint8Array([1, 1, 1]);
    const base64 = Buffer.from(dummyBytes).toString('base64');

    const uploadRes = await app.request('/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: groupId,
        image_base64: base64,
        mime_type: 'image/gif',
        retention: 'on_read',
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as any;
    const msgId = uploadData.message.id;
    const objectKey = uploadData.image.object_key;

    // Bob downloads and reads the image
    const bobDownload = await app.request(`/images/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobDownload.status).toBe(200);

    const bobRead = await app.request(`/messages/${msgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobRead.status).toBe(200);
    expect((await bobRead.json() as any).status).toBe('burned');

    // Bob can still download within 30s viewing window
    const bobRepeatWithin30s = await app.request(`/images/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobRepeatWithin30s.status).toBe(200);

    // After 35s (> 30s), Bob cannot download again (burned for Bob)
    const oldReadTime = Date.now() - 35000;
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND user_id = ? AND status = 'read'")
      .bind(oldReadTime, msgId, bobUser.id).run();

    const bobRepeat = await app.request(`/images/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobRepeat.status).toBe(404);

    // Still preserved in R2 for Charlie
    expect(r2.hasKey(objectKey)).toBe(true);

    // Charlie downloads and reads
    const charlieDownload = await app.request(`/images/${msgId}`, {
      headers: { Authorization: `Bearer ${charlieToken}` },
    }, env);
    expect(charlieDownload.status).toBe(200);

    const charlieRead = await app.request(`/messages/${msgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${charlieToken}` },
    }, env);
    expect(charlieRead.status).toBe(200);

    // Charlie still has 30s viewing window
    expect(r2.hasKey(objectKey)).toBe(true);

    // After Charlie's 30s viewing window elapses, sweeper purges from R2 and D1
    await db.prepare("UPDATE message_receipts SET timestamp = ? WHERE message_id = ? AND user_id = ? AND status = 'read'")
      .bind(oldReadTime, msgId, charlieUser.id).run();
    await app.request('/admin/cleanup', { method: 'POST' }, env);

    expect(r2.hasKey(objectKey)).toBe(false);
    const d1Msg = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
    expect(d1Msg).toBeNull();
  });

  it('rejects unsupported image MIME types and empty files', async () => {
    const res1 = await app.request('/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        image_base64: Buffer.from('test').toString('base64'),
        mime_type: 'application/pdf',
      }),
    }, env);
    expect(res1.status).toBe(400);

    const res2 = await app.request('/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        image_base64: '',
        mime_type: 'image/png',
      }),
    }, env);
    expect(res2.status).toBe(400);
  });
});
