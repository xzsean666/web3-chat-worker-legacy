import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Group Features: Metadata, Moderation (Mute), Owner Kick, Member Leave (TASK-017)', () => {
  let db: D1Database;
  let env: Env;
  let aliceWallet: TestWallet;
  let bobWallet: TestWallet;
  let charlieWallet: TestWallet;
  let daveWallet: TestWallet;
  let aliceToken: string;
  let bobToken: string;
  let charlieToken: string;
  let daveToken: string;
  let aliceUser: { id: string; wallet_address: string };
  let bobUser: { id: string; wallet_address: string };
  let charlieUser: { id: string; wallet_address: string };
  let daveUser: { id: string; wallet_address: string };

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
    charlieWallet = createTestWallet();
    daveWallet = createTestWallet();

    const aliceAuth = await loginUser(aliceWallet);
    aliceToken = aliceAuth.token;
    aliceUser = aliceAuth.user;

    const bobAuth = await loginUser(bobWallet);
    bobToken = bobAuth.token;
    bobUser = bobAuth.user;

    const charlieAuth = await loginUser(charlieWallet);
    charlieToken = charlieAuth.token;
    charlieUser = charlieAuth.user;

    const daveAuth = await loginUser(daveWallet);
    daveToken = daveAuth.token;
    daveUser = daveAuth.user;
  });

  describe('Group Metadata (Name, Description, Top Marquee Scroll - Requirements ①, ②, ③)', () => {
    it('creates group with initial metadata, description, and marquee config', async () => {
      const res = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Web3 BUIDLers Club',
          description: 'The official group for Web3 builders and hackers.',
          announcement: 'Important: Hackathon demo day this Friday!',
          marquee: {
            enabled: true,
            text: 'Welcome builders! Hackathon demo day this Friday!',
            speed: 50,
          },
          member_ids: [bobUser.id],
        }),
      }, env);

      expect(res.status).toBe(201);
      const group = (await res.json()) as any;
      expect(group.name).toBe('Web3 BUIDLers Club');
      expect(group.metadata).toBeDefined();
      expect(group.metadata.name).toBe('Web3 BUIDLers Club');
      expect(group.metadata.description).toBe('The official group for Web3 builders and hackers.');
      expect(group.metadata.announcement).toBe('Important: Hackathon demo day this Friday!');
      expect(group.metadata.marquee).toEqual({
        enabled: true,
        text: 'Welcome builders! Hackathon demo day this Friday!',
        speed: 50,
      });
    });

    it('updates group name, description, and marquee scrolling configuration via PATCH /groups/:id', async () => {
      // Create initial group
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Old Alpha Name',
          member_ids: [bobUser.id],
        }),
      }, env);
      const group = (await createRes.json()) as any;

      // Alice updates group name, description, and marquee banner
      const updateRes = await app.request(`/groups/${group.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'New Alpha Title',
          description: 'Up-to-date market insights and alpha discussions.',
          marquee: {
            enabled: true,
            text: 'Breaking: New Alpha Title is live!',
          },
        }),
      }, env);

      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as any;
      expect(updated.name).toBe('New Alpha Title');
      expect(updated.metadata.name).toBe('New Alpha Title');
      expect(updated.metadata.description).toBe('Up-to-date market insights and alpha discussions.');
      expect(updated.metadata.marquee.enabled).toBe(true);
      expect(updated.metadata.marquee.text).toBe('Breaking: New Alpha Title is live!');

      // Verify retrieval via GET /conversations/:id returns parsed metadata
      const getRes = await app.request(`/conversations/${group.id}`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as any;
      expect(fetched.name).toBe('New Alpha Title');
      expect(fetched.metadata.description).toBe('Up-to-date market insights and alpha discussions.');
      expect(fetched.metadata.marquee.enabled).toBe(true);

      // Verify regular member cannot update group settings (403 Forbidden)
      const bobUpdateRes = await app.request(`/groups/${group.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({ name: 'Bob Hacked Name' }),
      }, env);
      expect(bobUpdateRes.status).toBe(403);
    });
  });

  describe('Member Management: Owner Kick & Voluntary Leave (Requirements ④, ⑤)', () => {
    it('allows member to voluntarily leave group via POST /groups/:id/leave', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Community DAO',
          member_ids: [bobUser.id, charlieUser.id],
        }),
      }, env);
      const group = (await createRes.json()) as any;
      expect(group.members.length).toBe(3);

      // Charlie voluntarily leaves the group
      const leaveRes = await app.request(`/groups/${group.id}/leave`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${charlieToken}` },
      }, env);
      expect(leaveRes.status).toBe(200);
      const leaveData = (await leaveRes.json()) as any;
      expect(leaveData.success).toBe(true);
      expect(leaveData.message).toContain('Left group successfully');

      // Verify Charlie is no longer in group members
      const checkRes = await app.request(`/conversations/${group.id}`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);
      const updatedGroup = (await checkRes.json()) as any;
      expect(updatedGroup.members.length).toBe(2);
      expect(updatedGroup.members.some((m: any) => m.user_id === charlieUser.id)).toBe(false);

      // Charlie trying to view conversation details gets 403 Forbidden
      const charlieView = await app.request(`/conversations/${group.id}`, {
        headers: { Authorization: `Bearer ${charlieToken}` },
      }, env);
      expect(charlieView.status).toBe(403);
    });

    it('allows owner to kick member via POST /groups/:id/kick, but forbids regular members from kicking', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Dev Council',
          member_ids: [bobUser.id, charlieUser.id],
        }),
      }, env);
      const group = (await createRes.json()) as any;

      // Bob (regular member) tries to kick Charlie -> 403 Forbidden
      const unauthorizedKick = await app.request(`/groups/${group.id}/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({ user_id: charlieUser.id }),
      }, env);
      expect(unauthorizedKick.status).toBe(403);

      // Alice (owner) kicks Charlie via POST /groups/:id/kick -> 200 OK
      const kickRes = await app.request(`/groups/${group.id}/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ wallet_address: charlieUser.wallet_address }),
      }, env);
      expect(kickRes.status).toBe(200);
      const kickData = (await kickRes.json()) as any;
      expect(kickData.success).toBe(true);
      expect(kickData.message).toContain('Member removed successfully');

      // Verify Charlie is removed
      const checkRes = await app.request(`/conversations/${group.id}`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);
      const updatedGroup = (await checkRes.json()) as any;
      expect(updatedGroup.members.length).toBe(2);
      expect(updatedGroup.members.some((m: any) => m.user_id === charlieUser.id)).toBe(false);
    });

    it('prevents a kicked member from sending or reading group messages', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Kick Chat Guard',
          member_ids: [bobUser.id, charlieUser.id],
        }),
      }, env);
      const group = (await createRes.json()) as any;

      // Charlie can chat while still a member
      const beforeKickRes = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${charlieToken}`,
        },
        body: JSON.stringify({ content: 'Hello everyone' }),
      }, env);
      expect(beforeKickRes.status).toBe(201);

      // Alice (owner) kicks Charlie
      const kickRes = await app.request(`/groups/${group.id}/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ user_id: charlieUser.id }),
      }, env);
      expect(kickRes.status).toBe(200);

      // Charlie can no longer send messages to the group
      const sendRes = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${charlieToken}`,
        },
        body: JSON.stringify({ content: 'Am I still here?' }),
      }, env);
      expect(sendRes.status).toBe(403);
      const sendErr = (await sendRes.json()) as { error: string };
      expect(sendErr.error).toContain('not a member');

      // Charlie can no longer read group messages
      const readRes = await app.request(`/conversations/${group.id}/messages`, {
        headers: { Authorization: `Bearer ${charlieToken}` },
      }, env);
      expect(readRes.status).toBe(403);

      // Charlie no longer receives the group via /sync
      const syncRes = await app.request('/sync?since=0', {
        headers: { Authorization: `Bearer ${charlieToken}` },
      }, env);
      const syncData = (await syncRes.json()) as any;
      expect(syncData.messages.some((m: any) => m.conversation_id === group.id)).toBe(false);
    });
  });

  describe('Admin Role Management & Speech Privilege (Requirement ⑥)', () => {
    it('allows owner to promote member to admin, and admin has management privileges', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'VIP Club',
          member_ids: [bobUser.id, charlieUser.id],
        }),
      }, env);
      const group = (await createRes.json()) as any;

      // Alice promotes Bob to admin
      const promoteRes = await app.request(`/groups/${group.id}/members/${bobUser.id}/role`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ role: 'admin' }),
      }, env);
      expect(promoteRes.status).toBe(200);
      const promoted = (await promoteRes.json()) as any;
      expect(promoted.role).toBe('admin');

      // Bob (now admin) updates group metadata
      const adminUpdate = await app.request(`/groups/${group.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({
          description: 'Updated by VIP Admin Bob',
        }),
      }, env);
      expect(adminUpdate.status).toBe(200);
      const adminUpdatedData = (await adminUpdate.json()) as any;
      expect(adminUpdatedData.metadata.description).toBe('Updated by VIP Admin Bob');
    });
  });

  describe('Group Mute (全员禁言) & Admin Always Can Speak (Requirement ⑥)', () => {
    it('enforces group mute on regular members while admins and owner can always speak', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Announcement Hall',
          member_ids: [bobUser.id, charlieUser.id],
        }),
      }, env);
      const group = (await createRes.json()) as any;

      // Promote Bob to admin
      await app.request(`/groups/${group.id}/members/${bobUser.id}/role`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ role: 'admin' }),
      }, env);

      // Alice activates group-wide mute
      const muteRes = await app.request(`/groups/${group.id}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ muted: true }),
      }, env);
      expect(muteRes.status).toBe(200);
      const muteData = (await muteRes.json()) as any;
      expect(muteData.is_muted).toBe(true);

      // Charlie (regular member) attempts to send text message -> 403 Forbidden
      const charlieMsg = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${charlieToken}`,
        },
        body: JSON.stringify({ content: 'Can I speak?' }),
      }, env);
      expect(charlieMsg.status).toBe(403);
      const errData = (await charlieMsg.json()) as any;
      expect(errData.error).toContain('Group chat is currently muted');

      // "admin始终可以讲话": Bob (admin) sends text message -> 201 Created
      const bobMsg = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({ content: 'Admin announcement: Attention everyone!' }),
      }, env);
      expect(bobMsg.status).toBe(201);

      // "admin始终可以讲话": Alice (owner) sends text message -> 201 Created
      const aliceMsg = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ content: 'Owner note: Welcome to the event!' }),
      }, env);
      expect(aliceMsg.status).toBe(201);

      // Alice un-mutes the group
      const unmuteRes = await app.request(`/groups/${group.id}/unmute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);
      expect(unmuteRes.status).toBe(200);

      // Charlie can speak again -> 201 Created
      const charlieMsgAfter = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${charlieToken}`,
        },
        body: JSON.stringify({ content: 'Thank you for unmuting!' }),
      }, env);
      expect(charlieMsgAfter.status).toBe(201);
    });
  });

  describe('Individual Member Mute List (单独某人禁言名单 - Requirement ⑥)', () => {
    it('mutes specific member, queries muted list, blocks messages, and allows unmuting', async () => {
      const createRes = await app.request('/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          name: 'Trading Chat',
          member_ids: [bobUser.id, charlieUser.id, daveUser.id],
        }),
      }, env);
      const group = (await createRes.json()) as any;

      // Alice mutes Charlie with a reason
      const muteCharlie = await app.request(`/groups/${group.id}/members/${charlieUser.id}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          muted: true,
          reason: 'Posting spam referral links',
        }),
      }, env);
      expect(muteCharlie.status).toBe(200);
      const muteCharlieData = (await muteCharlie.json()) as any;
      expect(muteCharlieData.is_muted).toBe(true);
      expect(muteCharlieData.mute_reason).toBe('Posting spam referral links');

      // Query muted list via GET /groups/:id/muted
      const mutedListRes = await app.request(`/groups/${group.id}/muted`, {
        headers: { Authorization: `Bearer ${bobToken}` },
      }, env);
      expect(mutedListRes.status).toBe(200);
      const mutedListData = (await mutedListRes.json()) as any;
      expect(mutedListData.muted_members.length).toBe(1);
      expect(mutedListData.muted_members[0].user_id).toBe(charlieUser.id);
      expect(mutedListData.muted_members[0].mute_reason).toBe('Posting spam referral links');

      // Charlie attempts to send message -> 403 Forbidden
      const charlieMsg = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${charlieToken}`,
        },
        body: JSON.stringify({ content: 'Check this link!' }),
      }, env);
      expect(charlieMsg.status).toBe(403);
      const charlieErr = (await charlieMsg.json()) as any;
      expect(charlieErr.error).toContain('You have been muted in this group');
      expect(charlieErr.error).toContain('Posting spam referral links');

      // Dave (unmuted regular member) can speak normally
      const daveMsg = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${daveToken}`,
        },
        body: JSON.stringify({ content: 'Hey guys, good morning!' }),
      }, env);
      expect(daveMsg.status).toBe(201);

      // Non-admin Bob attempting to mute someone returns 403 Forbidden
      const unauthorizedMute = await app.request(`/groups/${group.id}/members/${daveUser.id}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({ muted: true }),
      }, env);
      expect(unauthorizedMute.status).toBe(403);

      // Attempting to mute owner or admin is rejected (400 Bad Request)
      const tryMuteOwner = await app.request(`/groups/${group.id}/members/${aliceUser.id}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({ muted: true }),
      }, env);
      expect(tryMuteOwner.status).toBe(400);
      const tryMuteOwnerErr = (await tryMuteOwner.json()) as any;
      expect(tryMuteOwnerErr.error).toContain('Cannot mute group owner or admin');

      // Unmute Charlie
      const unmuteCharlie = await app.request(`/groups/${group.id}/members/${charlieUser.id}/unmute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}` },
      }, env);
      expect(unmuteCharlie.status).toBe(200);

      // Charlie can send message again
      const charlieMsgSuccess = await app.request(`/conversations/${group.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${charlieToken}`,
        },
        body: JSON.stringify({ content: 'I promise not to spam again.' }),
      }, env);
      expect(charlieMsgSuccess.status).toBe(201);
    });
  });
});
