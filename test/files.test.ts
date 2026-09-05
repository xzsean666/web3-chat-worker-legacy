import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('File Message Storage (R2) & Synchronized Cleanup', () => {
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

    // Group conversation with Alice, Bob, and Charlie
    const groupRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        name: 'Dev DAO',
        member_ids: [bobUser.id, charlieUser.id],
      }),
    }, env);
    const groupData = (await groupRes.json()) as any;
    groupId = groupData.id;
  });

  it('uploads file message via JSON base64 and stores in R2 and D1', async () => {
    const dummyBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF header
    const base64 = Buffer.from(dummyBytes).toString('base64');

    const uploadRes = await app.request('/files/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        file_base64: base64,
        file_name: 'whitepaper.pdf',
        mime_type: 'application/pdf',
        caption: 'Latest Protocol Whitepaper',
        retention: 'permanent',
      }),
    }, env);

    expect(uploadRes.status).toBe(201);
    const data = (await uploadRes.json()) as any;
    expect(data.message.id).toBeDefined();
    expect(data.message.type).toBe('file');
    expect(data.message.content).toBe('Latest Protocol Whitepaper (whitepaper.pdf)');
    expect(data.file.object_key).toMatch(/^files\/.+\/whitepaper\.pdf$/);
    expect(data.file.file_name).toBe('whitepaper.pdf');
    expect(data.file.mime_type).toBe('application/pdf');
    expect(data.file.size).toBe(dummyBytes.byteLength);

    // Verify file is in R2
    expect(r2.hasKey(data.file.object_key)).toBe(true);

    // Verify DB records
    const fileRow = await db.prepare('SELECT * FROM file_messages WHERE message_id = ?').bind(data.message.id).first<any>();
    expect(fileRow).not.toBeNull();
    expect(fileRow.file_name).toBe('whitepaper.pdf');
  });

  it('uploads file via multipart/form-data with default caption', async () => {
    const dummyBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const formData = new FormData();
    formData.append('conversation_id', conversationId);
    formData.append('file', new Blob([dummyBytes], { type: 'application/zip' }), 'archive.zip');

    const uploadRes = await app.request('/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
      },
      body: formData,
    }, env);

    expect(uploadRes.status).toBe(201);
    const data = (await uploadRes.json()) as any;
    expect(data.message.type).toBe('file');
    expect(data.message.content).toBe('[File: archive.zip]');
    expect(data.file.file_name).toBe('archive.zip');
    expect(data.file.mime_type).toBe('application/zip');
  });

  it('streams file binary with attachment Content-Disposition and provides metadata endpoint', async () => {
    const dummyBytes = new Uint8Array([50, 60, 70, 80]);
    const base64 = Buffer.from(dummyBytes).toString('base64');

    const uploadRes = await app.request('/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        file_base64: base64,
        file_name: 'report.docx',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as any;
    const msgId = uploadData.message.id;

    // Bob (recipient member) queries metadata
    const metaRes = await app.request(`/files/${msgId}/meta`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(metaRes.status).toBe(200);
    const metaData = (await metaRes.json()) as any;
    expect(metaData.file_name).toBe('report.docx');
    expect(metaData.size).toBe(4);

    // Bob downloads binary
    const getRes = await app.request(`/files/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);

    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Disposition')).toContain('attachment');
    expect(getRes.headers.get('Content-Disposition')).toContain('report.docx');
    const downloadedBuf = await getRes.arrayBuffer();
    expect(new Uint8Array(downloadedBuf)).toEqual(dummyBytes);

    // Charlie (non-member) is rejected
    const charlieRes = await app.request(`/files/${msgId}`, {
      headers: { Authorization: `Bearer ${charlieToken}` },
    }, env);
    expect(charlieRes.status).toBe(403);
  });

  it('atomically destroys D1 record and R2 file on 1:1 burn-on-read Read ACK', async () => {
    const dummyBytes = new Uint8Array([11, 22, 33]);
    const base64 = Buffer.from(dummyBytes).toString('base64');

    const uploadRes = await app.request('/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        file_base64: base64,
        file_name: 'secret.key',
        retention: 'on_read',
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as any;
    const msgId = uploadData.message.id;
    const objectKey = uploadData.file.object_key;

    expect(r2.hasKey(objectKey)).toBe(true);

    // Bob reads the message
    const readRes = await app.request(`/messages/${msgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(readRes.status).toBe(200);
    expect((await readRes.json() as any).status).toBe('burned');

    // Verify D1 records deleted
    const msgInDb = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
    expect(msgInDb).toBeNull();
    const fileInDb = await db.prepare('SELECT * FROM file_messages WHERE message_id = ?').bind(msgId).first();
    expect(fileInDb).toBeNull();

    // Verify R2 object deleted
    expect(r2.hasKey(objectKey)).toBe(false);

    // Subsequent GET returns 404
    const subsequentGet = await app.request(`/files/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(subsequentGet.status).toBe(404);
  });

  it('handles group chat burn-on-read per-recipient protection and full destruction on all-read', async () => {
    const dummyBytes = new Uint8Array([99, 98, 97]);
    const base64 = Buffer.from(dummyBytes).toString('base64');

    const uploadRes = await app.request('/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: groupId,
        file_base64: base64,
        file_name: 'roadmap.pdf',
        retention: 'on_read',
      }),
    }, env);
    const uploadData = (await uploadRes.json()) as any;
    const msgId = uploadData.message.id;
    const objectKey = uploadData.file.object_key;

    // Bob downloads and reads the file
    const bobDownload = await app.request(`/files/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobDownload.status).toBe(200);

    const bobRead = await app.request(`/messages/${msgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobRead.status).toBe(200);
    expect((await bobRead.json() as any).status).toBe('burned');

    // Bob cannot download again
    const bobRepeat = await app.request(`/files/${msgId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    }, env);
    expect(bobRepeat.status).toBe(404);

    // Preserved in R2 for Charlie
    expect(r2.hasKey(objectKey)).toBe(true);

    // Charlie downloads and reads
    const charlieDownload = await app.request(`/files/${msgId}`, {
      headers: { Authorization: `Bearer ${charlieToken}` },
    }, env);
    expect(charlieDownload.status).toBe(200);

    const charlieRead = await app.request(`/messages/${msgId}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${charlieToken}` },
    }, env);
    expect(charlieRead.status).toBe(200);

    // All read -> purged from R2 and D1
    expect(r2.hasKey(objectKey)).toBe(false);
    const d1Msg = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(msgId).first();
    expect(d1Msg).toBeNull();
  });

  it('rejects empty files or missing filenames', async () => {
    const res1 = await app.request('/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        file_base64: Buffer.from('data').toString('base64'),
        file_name: '   ',
      }),
    }, env);
    expect(res1.status).toBe(400);

    const res2 = await app.request('/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        conversation_id: conversationId,
        file_base64: '',
        file_name: 'test.txt',
      }),
    }, env);
    expect(res2.status).toBe(400);
  });
});
