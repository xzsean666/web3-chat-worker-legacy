import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('User Dual-Metadata & Avatar Storage (TASK-014)', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;

  beforeEach(() => {
    db = createMockD1Database(true);
    r2 = new MockR2Bucket();
    env = {
      DB: db,
      VOICE_BUCKET: r2 as unknown as R2Bucket,
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

  it('allows user to read and update their public and private metadata', async () => {
    const aliceWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);

    // Initial check via /users/me
    const meRes1 = await app.request('/users/me', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(meRes1.status).toBe(200);
    const meData1 = (await meRes1.json()) as { user: any };
    expect(meData1.user.public_metadata).toEqual({});
    expect(meData1.user.private_metadata).toEqual({});

    // Update metadata
    const updateRes = await app.request('/users/me/metadata', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        public_metadata: { nickname: 'Alice In Wonderland', bio: 'Crypto Enthusiast' },
        private_metadata: { email: 'alice@example.com', theme: 'dark' },
      }),
    }, env);
    expect(updateRes.status).toBe(200);
    const updateData = (await updateRes.json()) as { user: any };
    expect(updateData.user.public_metadata).toEqual({
      nickname: 'Alice In Wonderland',
      bio: 'Crypto Enthusiast',
    });
    expect(updateData.user.private_metadata).toEqual({
      email: 'alice@example.com',
      theme: 'dark',
    });

    // Also verify via /auth/me
    const authMeRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    const authMeData = (await authMeRes.json()) as { user: any };
    expect(authMeData.user.public_metadata).toEqual({
      nickname: 'Alice In Wonderland',
      bio: 'Crypto Enthusiast',
    });
    expect(authMeData.user.private_metadata).toEqual({
      email: 'alice@example.com',
      theme: 'dark',
    });
  });

  it('allows others to read public metadata, but strictly conceals private metadata', async () => {
    const aliceWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);

    const bobWallet = createTestWallet();
    const bob = await loginUser(bobWallet);

    // Alice updates public & private metadata
    await app.request('/users/me/metadata', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        public_metadata: { twitter: '@alice_eth', telegram: 'alice123' },
        private_metadata: { secret_seed_note: 'keep_this_safe' },
      }),
    }, env);

    // Bob reads Alice's profile via /users/:address
    const bobReadRes = await app.request(`/users/${alice.wallet.address}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(bobReadRes.status).toBe(200);
    const bobReadData = (await bobReadRes.json()) as { user: any };

    expect(bobReadData.user.wallet_address).toBe(alice.wallet.address.toLowerCase());
    expect(bobReadData.user.public_metadata).toEqual({
      twitter: '@alice_eth',
      telegram: 'alice123',
    });
    // Strict privacy guarantee: private_metadata is undefined / not exposed!
    expect(bobReadData.user.private_metadata).toBeUndefined();

    // Anonymous visitor can also read public profile
    const anonRes = await app.request(`/users/${alice.wallet.address}`, {}, env);
    expect(anonRes.status).toBe(200);
    const anonData = (await anonRes.json()) as { user: any };
    expect(anonData.user.public_metadata.twitter).toBe('@alice_eth');
    expect(anonData.user.private_metadata).toBeUndefined();
  });

  it('allows uploading avatar and enforces single avatar constraint (replacing old avatar in R2)', async () => {
    const aliceWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);

    // 1. Upload first avatar via JSON Base64
    const firstAvatarBase64 = Buffer.from('fake-avatar-bytes-v1').toString('base64');
    const uploadRes1 = await app.request('/users/me/avatar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        avatar_base64: firstAvatarBase64,
        mime_type: 'image/png',
      }),
    }, env);
    expect(uploadRes1.status).toBe(201);
    const uploadData1 = (await uploadRes1.json()) as { avatar_url: string; avatar_updated_at: number };
    expect(uploadData1.avatar_url).toBe(`/users/${alice.wallet.address.toLowerCase()}/avatar`);

    // Check avatar in R2
    const r2KeysAfterFirst = (await (r2 as any).list()).objects;
    expect(r2KeysAfterFirst.length).toBe(1);
    const firstKey = r2KeysAfterFirst[0].key;

    // 2. Fetch avatar publicly without auth
    const fetchAvatarRes1 = await app.request(`/users/${alice.wallet.address}/avatar`, {}, env);
    expect(fetchAvatarRes1.status).toBe(200);
    expect(fetchAvatarRes1.headers.get('Content-Type')).toBe('image/png');
    const avatarBody1 = await fetchAvatarRes1.text();
    expect(avatarBody1).toBe('fake-avatar-bytes-v1');

    // 3. Upload second avatar to replace the first
    const secondAvatarBase64 = Buffer.from('fake-avatar-bytes-v2-new-image').toString('base64');
    const uploadRes2 = await app.request('/users/me/avatar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        avatar_base64: secondAvatarBase64,
        mime_type: 'image/jpeg',
      }),
    }, env);
    expect(uploadRes2.status).toBe(201);

    // Ensure previous avatar in R2 was deleted, maintaining single avatar constraint
    const r2KeysAfterSecond = (await (r2 as any).list()).objects;
    expect(r2KeysAfterSecond.length).toBe(1);
    expect(r2.hasKey(firstKey)).toBe(false);

    // 4. Fetch updated avatar publicly
    const fetchAvatarRes2 = await app.request(`/users/${alice.wallet.address}/avatar`, {}, env);
    expect(fetchAvatarRes2.status).toBe(200);
    expect(fetchAvatarRes2.headers.get('Content-Type')).toBe('image/jpeg');
    const avatarBody2 = await fetchAvatarRes2.text();
    expect(avatarBody2).toBe('fake-avatar-bytes-v2-new-image');
  });

  it('supports multipart/form-data avatar upload', async () => {
    const aliceWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);

    const formData = new FormData();
    const blob = new Blob(['sample-png-content'], { type: 'image/png' });
    formData.append('file', blob, 'my_avatar.png');

    const uploadRes = await app.request('/users/me/avatar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
      },
      body: formData,
    }, env);

    expect(uploadRes.status).toBe(201);
    const getRes = await app.request(`/users/${alice.wallet.address}/avatar`, {}, env);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('sample-png-content');
  });

  it('rejects unsupported avatar MIME types or empty files', async () => {
    const aliceWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);

    const res1 = await app.request('/users/me/avatar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        avatar_base64: Buffer.from('pdf-content').toString('base64'),
        mime_type: 'application/pdf',
      }),
    }, env);
    expect(res1.status).toBe(400);

    const res2 = await app.request('/users/me/avatar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        avatar_base64: '',
        mime_type: 'image/png',
      }),
    }, env);
    expect(res2.status).toBe(400);
  });

  it('supports globally unique usernames: set, conflict, lookup, availability, search', async () => {
    const aliceWallet = createTestWallet();
    const bobWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);
    const bob = await loginUser(bobWallet);

    // Alice sets a username (mixed case + @ prefix get normalized)
    const setRes = await app.request('/users/me/username', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ username: '@Alice_Wang' }),
    }, env);
    expect(setRes.status).toBe(200);
    const setData = (await setRes.json()) as { user: any };
    expect(setData.user.username).toBe('alice_wang');

    // Invalid format is rejected
    const badRes = await app.request('/users/me/username', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ username: 'a!' }),
    }, env);
    expect(badRes.status).toBe(400);

    // Bob cannot take the same username
    const conflictRes = await app.request('/users/me/username', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bob.token}`,
      },
      body: JSON.stringify({ username: 'alice_wang' }),
    }, env);
    expect(conflictRes.status).toBe(409);

    // Availability check reflects both states
    const takenCheck = await app.request('/users/check-username/alice_wang', {}, env);
    expect(((await takenCheck.json()) as any).available).toBe(false);
    const freeCheck = await app.request('/users/check-username/bob_2026', {}, env);
    expect(((await freeCheck.json()) as any).available).toBe(true);

    // Exact lookup by username returns Alice's public profile (no auth needed)
    const lookupRes = await app.request('/users/by-username/alice_wang', {}, env);
    expect(lookupRes.status).toBe(200);
    const lookupData = (await lookupRes.json()) as { user: any };
    expect(lookupData.user.wallet_address).toBe(alice.wallet.address.toLowerCase());
    expect(lookupData.user.username).toBe('alice_wang');
    expect(lookupData.user.private_metadata).toBeUndefined();

    // Username also works as a friend-search keyword
    const searchRes = await app.request('/friends/recommendations?q=alice_wang', {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(searchRes.status).toBe(200);
    const searchData = (await searchRes.json()) as { recommendations: any[] };
    const found = searchData.recommendations.find((r) => r.username === 'alice_wang');
    expect(found).toBeDefined();
    expect(found.address).toBe(alice.wallet.address.toLowerCase());
  });
});
