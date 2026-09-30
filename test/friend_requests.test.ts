import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { makeMutualFriends } from './helpers/friends';
import type { Env } from '../src/types';

describe('Friend Requests: Send, Incoming List, Accept, Reject, Unread Badge', () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    db = createMockD1Database(true);
    env = {
      DB: db,
      VOICE_BUCKET: {} as any,
    };
  });

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
      body: JSON.stringify({ wallet_address: wallet.address, signature, nonce: nonceData.nonce }),
    }, env);
    const data = (await verifyRes.json()) as { token: string; user: { id: string; wallet_address: string } };
    return { token: data.token, user: data.user, wallet };
  }

  async function sendRequest(token: string, toAddress: string, message?: string) {
    return app.request('/friend-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to_address: toAddress, message }),
    }, env);
  }

  async function getIncoming(token: string) {
    const res = await app.request('/friend-requests?direction=incoming', {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    return (await res.json()) as { requests: any[]; unread_count: number };
  }

  async function getUnreadCount(token: string): Promise<number> {
    const res = await app.request('/friend-requests/unread-count', {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    const data = (await res.json()) as { unread_count: number };
    return data.unread_count;
  }

  async function areFriends(token: string, address: string): Promise<boolean> {
    const res = await app.request(`/friends/${address}`, {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    return res.status === 200;
  }

  it('runs the full flow: send with message -> incoming unread -> accept -> mutual friends -> chat works', async () => {
    const alice = await loginUser(createTestWallet());
    const bob = await loginUser(createTestWallet());

    // Before acceptance they cannot chat (mutual friendship required)
    const convRes = await app.request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ target_user_id: bob.user.id }),
    }, env);
    const conv = (await convRes.json()) as { id: string };

    const earlyMsgRes = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ content: 'Hello?' }),
    }, env);
    expect(earlyMsgRes.status).toBe(403);

    // Alice submits a friend request with a verification message
    const sendRes = await sendRequest(alice.token, bob.wallet.address, 'Hi, we met at Devcon!');
    expect(sendRes.status).toBe(201);
    const sendData = (await sendRes.json()) as { request: any };
    expect(sendData.request.status).toBe('pending');
    expect(sendData.request.message).toBe('Hi, we met at Devcon!');
    expect(sendData.request.from_address).toBe(alice.wallet.address.toLowerCase());
    expect(sendData.request.to_address).toBe(bob.wallet.address.toLowerCase());

    // Bob's unread badge shows 1
    expect(await getUnreadCount(bob.token)).toBe(1);
    expect(await getUnreadCount(alice.token)).toBe(0);

    // Bob fetches incoming requests: sees it, unread_count reported as 1
    const incoming = await getIncoming(bob.token);
    expect(incoming.requests.length).toBe(1);
    expect(incoming.requests[0].id).toBe(sendData.request.id);
    expect(incoming.requests[0].message).toBe('Hi, we met at Devcon!');
    expect(incoming.unread_count).toBe(1);

    // After fetching the list, the badge clears (requests marked as read)
    expect(await getUnreadCount(bob.token)).toBe(0);

    // Bob accepts -> mutual friendship established in both directions
    const acceptRes = await app.request(`/friend-requests/${sendData.request.id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(acceptRes.status).toBe(200);
    const acceptData = (await acceptRes.json()) as { success: boolean; friend_address: string };
    expect(acceptData.success).toBe(true);
    expect(acceptData.friend_address).toBe(alice.wallet.address.toLowerCase());

    expect(await areFriends(alice.token, bob.wallet.address)).toBe(true);
    expect(await areFriends(bob.token, alice.wallet.address)).toBe(true);

    // Alice sees the accepted status in her outgoing list
    const outgoingRes = await app.request('/friend-requests?direction=outgoing', {
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    const outgoing = (await outgoingRes.json()) as { requests: any[] };
    expect(outgoing.requests.length).toBe(1);
    expect(outgoing.requests[0].status).toBe('accepted');

    // Now they can chat
    const msgRes = await app.request(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ content: 'Thanks for accepting!' }),
    }, env);
    expect(msgRes.status).toBe(201);
  });

  it('rejects a request and allows the sender to re-apply afterwards', async () => {
    const alice = await loginUser(createTestWallet());
    const bob = await loginUser(createTestWallet());

    const sendRes = await sendRequest(alice.token, bob.wallet.address);
    expect(sendRes.status).toBe(201);
    const { request } = (await sendRes.json()) as { request: any };

    const rejectRes = await app.request(`/friend-requests/${request.id}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(rejectRes.status).toBe(200);

    // No friendship created
    expect(await areFriends(alice.token, bob.wallet.address)).toBe(false);
    expect(await areFriends(bob.token, alice.wallet.address)).toBe(false);

    // Rejected request no longer appears in Bob's incoming pending list
    const incoming = await getIncoming(bob.token);
    expect(incoming.requests.length).toBe(0);

    // Alice can send a new request after being rejected
    const resendRes = await sendRequest(alice.token, bob.wallet.address, 'Please reconsider');
    expect(resendRes.status).toBe(201);

    const incoming2 = await getIncoming(bob.token);
    expect(incoming2.requests.length).toBe(1);
    expect(incoming2.requests[0].message).toBe('Please reconsider');
    expect(incoming2.unread_count).toBe(1);
  });

  it('validates input and state transitions', async () => {
    const alice = await loginUser(createTestWallet());
    const bob = await loginUser(createTestWallet());
    const charlie = await loginUser(createTestWallet());

    // Self request -> 400
    const selfRes = await sendRequest(alice.token, alice.wallet.address);
    expect(selfRes.status).toBe(400);

    // Invalid address -> 400
    const invalidRes = await sendRequest(alice.token, 'not-an-address');
    expect(invalidRes.status).toBe(400);

    // Missing target -> 400
    const missingRes = await app.request('/friend-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ message: 'no target' }),
    }, env);
    expect(missingRes.status).toBe(400);

    // Duplicate pending request -> 400
    const firstRes = await sendRequest(alice.token, bob.wallet.address);
    expect(firstRes.status).toBe(201);
    const { request } = (await firstRes.json()) as { request: any };

    const dupRes = await sendRequest(alice.token, bob.wallet.address);
    expect(dupRes.status).toBe(400);
    const dupErr = (await dupRes.json()) as { error: string };
    expect(dupErr.error).toContain('already pending');

    // Non-recipient cannot accept -> 403
    const strangerAccept = await app.request(`/friend-requests/${request.id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${charlie.token}` },
    }, env);
    expect(strangerAccept.status).toBe(403);

    // Sender cannot accept their own request -> 403
    const senderAccept = await app.request(`/friend-requests/${request.id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
    }, env);
    expect(senderAccept.status).toBe(403);

    // Unknown request id -> 404
    const unknownRes = await app.request('/friend-requests/does-not-exist/accept', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(unknownRes.status).toBe(404);

    // Reject -> then accept again fails with 400 (already rejected)
    await app.request(`/friend-requests/${request.id}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    const acceptAfterReject = await app.request(`/friend-requests/${request.id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    expect(acceptAfterReject.status).toBe(400);
  });

  it('blocks requests when either side has blacklisted the other, and when already friends', async () => {
    const alice = await loginUser(createTestWallet());
    const bob = await loginUser(createTestWallet());

    // Bob blocks Alice -> Alice's request is rejected with 403
    await app.request('/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ blocked_address: alice.wallet.address }),
    }, env);

    const blockedRes = await sendRequest(alice.token, bob.wallet.address);
    expect(blockedRes.status).toBe(403);
    const blockedErr = (await blockedRes.json()) as { error: string };
    expect(blockedErr.error).toContain('blocked');

    // Unblock, become friends -> sending a request now fails as "already friends"
    await app.request(`/blacklist/${alice.wallet.address}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bob.token}` },
    }, env);
    await makeMutualFriends(env, alice.token, alice.user.id, bob.token, bob.user.id);

    const friendsRes = await sendRequest(alice.token, bob.wallet.address);
    expect(friendsRes.status).toBe(400);
    const friendsErr = (await friendsRes.json()) as { error: string };
    expect(friendsErr.error).toContain('already friends');
  });
});
