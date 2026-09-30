import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { makeMutualFriends } from './helpers/friends';
import type { Env } from '../src/types';

describe('Public Sticker Static Route (/stickers/*)', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;

  beforeEach(() => {
    db = createMockD1Database(true);
    r2 = createMockR2Bucket() as unknown as MockR2Bucket;
    env = {
      DB: db,
      VOICE_BUCKET: r2 as unknown as R2Bucket,
    };
  });

  it('serves webp sticker binary from R2 with immutable cache headers and no auth', async () => {
    const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]); // RIFF header stub
    await r2.put('stickers/animated/U+2764_1.webp', webpBytes, {
      httpMetadata: { contentType: 'image/webp' },
    });

    const res = await app.request('/stickers/animated/U+2764_1.webp', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    const buf = await res.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(webpBytes);
  });

  it('serves index.json manifest as application/json', async () => {
    const manifest = JSON.stringify({ version: 1, categories: ['animated'], items: [{ k: 'animated/U+2764_1', e: '❤' }] });
    await r2.put('stickers/index.json', manifest, {
      httpMetadata: { contentType: 'application/json' },
    });

    const res = await app.request('/stickers/index.json', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const data = (await res.json()) as any;
    expect(data.version).toBe(1);
    expect(data.items[0].k).toBe('animated/U+2764_1');
  });

  it('returns 404 NOT_FOUND for missing objects', async () => {
    const res = await app.request('/stickers/animated/U+DEAD_9.webp', {}, env);
    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.error).toBe('NOT_FOUND');
  });

  it('rejects path traversal attempts containing ".."', async () => {
    // %2F is not a URL path separator, so the segment reaches the handler literally
    const res = await app.request('/stickers/..%2Fsecret.webp', {}, env);
    expect(res.status).toBe(404);
    const data = (await res.json()) as any;
    expect(data.error).toBe('NOT_FOUND');
  });
});

describe('Sticker Message Type (sendMessage)', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;
  let aliceWallet: TestWallet;
  let bobWallet: TestWallet;
  let aliceToken: string;
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
    r2 = createMockR2Bucket() as unknown as MockR2Bucket;
    env = {
      DB: db,
      VOICE_BUCKET: r2 as unknown as R2Bucket,
    };

    aliceWallet = createTestWallet();
    bobWallet = createTestWallet();

    const aliceAuth = await loginUser(aliceWallet);
    aliceToken = aliceAuth.token;
    const aliceUser = aliceAuth.user;

    const bobAuth = await loginUser(bobWallet);
    bobUser = bobAuth.user;

    await makeMutualFriends(env, aliceToken, aliceUser.id, bobAuth.token, bobUser.id);
    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ target_user_id: bobUser.id }),
    }, env);
    const convData = (await convRes.json()) as any;
    conversationId = convData.id;
  });

  function sendSticker(content: string | undefined) {
    return app.request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ type: 'sticker', content }),
    }, env);
  }

  it('accepts a valid sticker key and persists type=sticker', async () => {
    const res = await sendSticker('animated/U+2764_1');
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.type).toBe('sticker');
    expect(data.content).toBe('animated/U+2764_1');

    const row = await db.prepare('SELECT type, content FROM messages WHERE id = ?').bind(data.id).first<any>();
    expect(row.type).toBe('sticker');
    expect(row.content).toBe('animated/U+2764_1');
  });

  it('accepts flag-style keys', async () => {
    const res = await sendSticker('flags/CN');
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.type).toBe('sticker');
    expect(data.content).toBe('flags/CN');
  });

  it('rejects invalid sticker content with 400', async () => {
    for (const bad of [undefined, '', 'no-slash', '/U+2764_1', 'animated/', 'animated/a/b', 'Animated/U+2764_1', 'webp/animated/U+2764_1']) {
      const res = await sendSticker(bad);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain('Invalid sticker content');
    }
  });
});
