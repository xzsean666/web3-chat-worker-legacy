import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Social System: Friends, Tags & Blacklist Enforcement (TASK-016)', () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    db = createMockD1Database(true);
    env = {
      DB: db,
      VOICE_BUCKET: {} as any,
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

  it('manages friends list, aliases, and tag categories', async () => {
    const aliceWallet = createTestWallet();
    const bobWallet = createTestWallet();
    const charlieWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);
    const bob = await loginUser(bobWallet);
    const charlie = await loginUser(charlieWallet);

    // 1. Alice adds Bob with alias and tags
    const addBobRes = await app.request('/friends', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        friend_address: bob.wallet.address,
        alias: 'Bobby Tables',
        tags: ['defi', 'whale', 'dev'],
      }),
    }, env);
    expect(addBobRes.status).toBe(201);
    const bobFriend = (await addBobRes.json()) as { friend: any };
    expect(bobFriend.friend.friend_address).toBe(bob.wallet.address.toLowerCase());
    expect(bobFriend.friend.alias).toBe('Bobby Tables');
    expect(bobFriend.friend.tags).toEqual(['defi', 'whale', 'dev']);

    // 2. Alice adds Charlie with tag 'dev'
    const addCharlieRes = await app.request('/friends', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        friend_address: charlie.wallet.address,
        alias: 'Charlie Brown',
        tags: ['dev', 'alpha'],
      }),
    }, env);
    expect(addCharlieRes.status).toBe(201);

    // 3. Query all tags
    const tagsRes = await app.request('/friends/tags', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(tagsRes.status).toBe(200);
    const tagsData = (await tagsRes.json()) as { tags: string[] };
    expect(tagsData.tags).toEqual(['alpha', 'defi', 'dev', 'whale']);

    // 4. Filter friends by tag: 'whale' -> only Bob
    const whaleFriendsRes = await app.request('/friends?tag=whale', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(whaleFriendsRes.status).toBe(200);
    const whaleData = (await whaleFriendsRes.json()) as { friends: any[] };
    expect(whaleData.friends.length).toBe(1);
    expect(whaleData.friends[0].friend_address).toBe(bob.wallet.address.toLowerCase());

    // 5. Filter friends by tag: 'dev' -> both Bob and Charlie
    const devFriendsRes = await app.request('/friends?tag=dev', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    const devData = (await devFriendsRes.json()) as { friends: any[] };
    expect(devData.friends.length).toBe(2);

    // 6. Update tags for Bob via dedicated tag endpoint
    const updateTagsRes = await app.request(`/friends/${bob.wallet.address}/tags`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        tags: ['vip', 'defi'],
      }),
    }, env);
    expect(updateTagsRes.status).toBe(200);
    const updatedBob = (await updateTagsRes.json()) as { friend: any };
    expect(updatedBob.friend.tags).toEqual(['vip', 'defi']);

    // 7. Remove Charlie from friends
    const deleteRes = await app.request(`/friends/${charlie.wallet.address}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(deleteRes.status).toBe(200);

    const checkFriendsRes = await app.request('/friends', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    const checkFriendsData = (await checkFriendsRes.json()) as { friends: any[] };
    expect(checkFriendsData.friends.length).toBe(1);
    expect(checkFriendsData.friends[0].friend_address).toBe(bob.wallet.address.toLowerCase());
  });

  it('manages blacklist and enforces chat blocking in 1:1 direct conversations', async () => {
    const aliceWallet = createTestWallet();
    const bobWallet = createTestWallet();
    const alice = await loginUser(aliceWallet);
    const bob = await loginUser(bobWallet);

    // Alice and Bob start a 1:1 conversation
    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ target_wallet_address: bob.wallet.address }),
    }, env);
    const conv = (await convRes.json()) as { id: string };

    // Alice can send message before being blocked
    const msg1Res = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ content: 'Hey Bob!' }),
    }, env);
    expect(msg1Res.status).toBe(201);

    // Bob blocks Alice
    const blockRes = await app.request('/blacklist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bob.token}`,
      },
      body: JSON.stringify({
        blocked_address: alice.wallet.address,
        reason: 'Spamming messages',
      }),
    }, env);
    expect(blockRes.status).toBe(201);

    // Verify Bob's blacklist listing
    const listRes = await app.request('/blacklist', {
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    const listData = (await listRes.json()) as { blocked: any[] };
    expect(listData.blocked.length).toBe(1);
    expect(listData.blocked[0].blocked_address).toBe(alice.wallet.address.toLowerCase());
    expect(listData.blocked[0].reason).toBe('Spamming messages');

    // Alice tries to send message to Bob in their 1:1 chat -> 403 Forbidden!
    const msg2Res = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ content: 'Are you there Bob?' }),
    }, env);
    expect(msg2Res.status).toBe(403);
    const errData = (await msg2Res.json()) as { error: string };
    expect(errData.error).toContain('blocked');

    // Alice also cannot create another direct conversation with Bob
    const newConvRes = await app.request('/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ target_wallet_address: bob.wallet.address }),
    }, env);
    expect(newConvRes.status).toBe(403);

    // Bob unblocks Alice
    const unblockRes = await app.request(`/blacklist/${alice.wallet.address}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(unblockRes.status).toBe(200);

    // Alice can send message again after being unblocked
    const msg3Res = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ content: 'Thanks for unblocking me!' }),
    }, env);
    expect(msg3Res.status).toBe(201);
  });

  it('supports message mentions / friend tagging in messages', async () => {
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

    const sendRes = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        content: `Hey @${bob.wallet.address}, check this out!`,
        mentions: [bob.wallet.address],
      }),
    }, env);
    expect(sendRes.status).toBe(201);
    const sendData = (await sendRes.json()) as { id: string; mentions: string };
    expect(sendData.mentions).toContain(bob.wallet.address.toLowerCase());
  });
});
