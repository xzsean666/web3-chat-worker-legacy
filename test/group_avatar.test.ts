import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { MockR2Bucket } from './helpers/r2';
import { createTestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Group Avatar Upload & Change (owner only)', () => {
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

  async function setupGroup() {
    const owner = await loginUser(createTestWallet());
    const admin = await loginUser(createTestWallet());
    const member = await loginUser(createTestWallet());
    const outsider = await loginUser(createTestWallet());

    const createRes = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        name: 'Avatar Test Group',
        member_ids: [admin.wallet.address, member.wallet.address],
      }),
    }, env);
    expect(createRes.status).toBe(201);
    const group = (await createRes.json()) as any;

    // Promote admin
    const roleRes = await app.request(`/groups/${encodeURIComponent(group.id)}/members/${admin.wallet.address}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ role: 'admin' }),
    }, env);
    expect(roleRes.status).toBe(200);

    return { owner, admin, member, outsider, group };
  }

  function uploadAvatar(token: string, groupId: string, bytes: string, mime = 'image/png') {
    return app.request(`/groups/${encodeURIComponent(groupId)}/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ avatar_base64: Buffer.from(bytes).toString('base64'), mime_type: mime }),
    }, env);
  }

  it('allows the group owner to upload an avatar and exposes avatar_url in metadata', async () => {
    const { owner, member, group } = await setupGroup();

    const uploadRes = await uploadAvatar(owner.token, group.id, 'group-avatar-bytes-v1');
    expect(uploadRes.status).toBe(201);
    const uploadData = (await uploadRes.json()) as { avatar_url: string; avatar_updated_at: number };
    expect(uploadData.avatar_url).toBe(`/groups/${encodeURIComponent(group.id)}/avatar`);
    expect(uploadData.avatar_updated_at).toBeGreaterThan(0);

    // Conversation detail exposes avatar_url in metadata
    const detailRes = await app.request(`/conversations/${encodeURIComponent(group.id)}`, {
      headers: { Authorization: `Bearer ${member.token}` },
    }, env);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as any;
    expect(detail.metadata.avatar_url).toBe(uploadData.avatar_url);
    expect(detail.avatar_updated_at).toBe(uploadData.avatar_updated_at);

    // Conversation list also exposes it
    const listRes = await app.request('/conversations', {
      headers: { Authorization: `Bearer ${member.token}` },
    }, env);
    const list = (await listRes.json()) as any;
    const listed = list.conversations.find((c: any) => c.id === group.id);
    expect(listed.metadata.avatar_url).toBe(uploadData.avatar_url);
  });

  it('rejects avatar upload from admin or member (owner only)', async () => {
    const { admin, member, group } = await setupGroup();

    const adminRes = await uploadAvatar(admin.token, group.id, 'admin-attempt');
    expect(adminRes.status).toBe(403);

    const memberRes = await uploadAvatar(member.token, group.id, 'member-attempt');
    expect(memberRes.status).toBe(403);

    expect((await (r2 as any).list()).objects.length).toBe(0);
  });

  it('replaces the previous avatar in R2 when the owner uploads a new one', async () => {
    const { owner, group } = await setupGroup();

    const res1 = await uploadAvatar(owner.token, group.id, 'group-avatar-v1');
    expect(res1.status).toBe(201);
    const firstKey = (await (r2 as any).list()).objects[0].key;
    expect(firstKey.startsWith('group-avatars/')).toBe(true);

    const res2 = await uploadAvatar(owner.token, group.id, 'group-avatar-v2-new', 'image/jpeg');
    expect(res2.status).toBe(201);

    const objects = (await (r2 as any).list()).objects;
    expect(objects.length).toBe(1);
    expect(r2.hasKey(firstKey)).toBe(false);

    const getRes = await app.request(`/groups/${encodeURIComponent(group.id)}/avatar`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    }, env);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await getRes.text()).toBe('group-avatar-v2-new');
  });

  it('serves the avatar to group members and rejects non-members', async () => {
    const { owner, member, outsider, group } = await setupGroup();
    await uploadAvatar(owner.token, group.id, 'member-readable-avatar');

    const memberRes = await app.request(`/groups/${encodeURIComponent(group.id)}/avatar`, {
      headers: { Authorization: `Bearer ${member.token}` },
    }, env);
    expect(memberRes.status).toBe(200);
    expect(await memberRes.text()).toBe('member-readable-avatar');

    const outsiderRes = await app.request(`/groups/${encodeURIComponent(group.id)}/avatar`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    }, env);
    expect(outsiderRes.status).toBe(403);

    const anonRes = await app.request(`/groups/${encodeURIComponent(group.id)}/avatar`, {}, env);
    expect(anonRes.status).toBe(401);
  });

  it('rejects unsupported formats and empty payloads', async () => {
    const { owner, group } = await setupGroup();

    const pdfRes = await uploadAvatar(owner.token, group.id, 'pdf-content', 'application/pdf');
    expect(pdfRes.status).toBe(400);

    const emptyRes = await app.request(`/groups/${encodeURIComponent(group.id)}/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ avatar_base64: '', mime_type: 'image/png' }),
    }, env);
    expect(emptyRes.status).toBe(400);
  });

  it('supports multipart/form-data avatar upload', async () => {
    const { owner, group } = await setupGroup();

    const formData = new FormData();
    const blob = new Blob(['multipart-group-avatar'], { type: 'image/webp' });
    formData.append('file', blob, 'group.webp');

    const uploadRes = await app.request(`/groups/${encodeURIComponent(group.id)}/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: formData,
    }, env);
    expect(uploadRes.status).toBe(201);

    const getRes = await app.request(`/groups/${encodeURIComponent(group.id)}/avatar`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    }, env);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('image/webp');
    expect(await getRes.text()).toBe('multipart-group-avatar');
  });

  it('cleans up the avatar from R2 when the owner leaves and the group is deleted', async () => {
    const { owner, group } = await setupGroup();
    await uploadAvatar(owner.token, group.id, 'doomed-avatar');
    expect((await (r2 as any).list()).objects.length).toBe(1);

    const leaveRes = await app.request(`/groups/${encodeURIComponent(group.id)}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
    }, env);
    expect(leaveRes.status).toBe(200);
    const leaveData = (await leaveRes.json()) as { message: string };
    expect(leaveData.message).toBe('Group deleted as owner left');

    expect((await (r2 as any).list()).objects.length).toBe(0);
  });
});
