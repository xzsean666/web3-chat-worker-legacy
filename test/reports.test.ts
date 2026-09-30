import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Private user reports and evidence uploads', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;
  let reporter: TestWallet;
  let target: TestWallet;
  let other: TestWallet;
  let reporterToken: string;
  let targetUser: { id: string; wallet_address: string };
  let otherToken: string;

  async function login(wallet: TestWallet) {
    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, env);
    const { message } = await nonceRes.json() as { message: string };
    const verifyRes = await app.request('/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address, signature: await wallet.signMessage(message) }),
    }, env);
    return await verifyRes.json() as { token: string; user: { id: string; wallet_address: string } };
  }

  beforeEach(async () => {
    db = createMockD1Database(true);
    r2 = createMockR2Bucket() as unknown as MockR2Bucket;
    env = { DB: db, VOICE_BUCKET: r2 as unknown as R2Bucket };
    reporter = createTestWallet();
    target = createTestWallet();
    other = createTestWallet();
    reporterToken = (await login(reporter)).token;
    targetUser = (await login(target)).user;
    otherToken = (await login(other)).token;
  });

  it('uploads private evidence without creating a conversation message, then attaches it to a report', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'evidence.png');
    const upload = await app.request('/reports/evidence', {
      method: 'POST', headers: { Authorization: `Bearer ${reporterToken}` }, body: form,
    }, env);
    expect(upload.status).toBe(201);
    const evidence = await upload.json() as any;
    expect(evidence.object_key).toMatch(/^report-evidence\//);
    expect(r2.hasKey(evidence.object_key)).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM messages').first<{ count: number }>('count')).toBe(0);

    const submitted = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({
        reported_user_id: targetUser.id,
        reported_wallet_address: targetUser.wallet_address,
        category: 'fraud',
        description: 'Requested a payment outside the app.',
        evidence_keys: [evidence.object_key],
      }),
    }, env);
    expect(submitted.status).toBe(201);
    const report = (await submitted.json() as any).report;
    expect(report.status).toBe('received');
    expect(report.evidence_keys).toEqual([evidence.object_key]);

    const list = await app.request('/reports', { headers: { Authorization: `Bearer ${reporterToken}` } }, env);
    expect(list.status).toBe(200);
    const reports = (await list.json() as any).reports;
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe(report.id);
    expect(reports[0].evidence_keys).toEqual([evidence.object_key]);
  });

  it('does not let another account attach the reporter’s private evidence', async () => {
    const form = new FormData();
    form.append('evidence', new Blob(['private material'], { type: 'image/jpeg' }), 'private.jpg');
    const upload = await app.request('/reports/evidence', {
      method: 'POST', headers: { Authorization: `Bearer ${reporterToken}` }, body: form,
    }, env);
    const { object_key } = await upload.json() as { object_key: string };

    const attempt = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({
        reported_wallet_address: target.address,
        category: 'harassment',
        evidence_keys: [object_key],
      }),
    }, env);
    expect(attempt.status).toBe(400);
    expect((await attempt.json() as any).error).toContain('do not belong to you');
  });

  it('rejects invalid report categories and requires multipart evidence uploads', async () => {
    const badCategory = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ reported_wallet_address: target.address, category: 'spam' }),
    }, env);
    expect(badCategory.status).toBe(400);

    const badUpload = await app.request('/reports/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ image_base64: 'AA==' }),
    }, env);
    expect(badUpload.status).toBe(400);
  });

  async function createGroup(memberIds: string[] = []) {
    const response = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ name: 'Report Test Group', member_ids: memberIds }),
    }, env);
    expect(response.status).toBe(201);
    return await response.json() as { id: string };
  }

  it('creates a group report without a wallet address and lists it', async () => {
    const group = await createGroup([targetUser.id]);
    const submitted = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({
        target_type: 'group',
        reported_group_id: group.id,
        category: 'fraud',
        description: 'Group promotes investment scams.',
      }),
    }, env);
    expect(submitted.status).toBe(201);
    const report = (await submitted.json() as any).report;
    expect(report.target_type).toBe('group');
    expect(report.reported_group_id).toBe(group.id);
    expect(report.reported_wallet_address).toBeNull();
    expect(report.reported_user_id).toBeNull();
    expect(report.status).toBe('received');

    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').bind(report.id).first<any>();
    expect(row.target_type).toBe('group');
    expect(row.reported_wallet_address).toBeNull();

    const list = await app.request('/reports', { headers: { Authorization: `Bearer ${reporterToken}` } }, env);
    const reports = (await list.json() as any).reports;
    expect(reports[0].target_type).toBe('group');
    expect(reports[0].reported_group_id).toBe(group.id);
  });

  it('rejects group reports from non-members and unknown groups', async () => {
    const group = await createGroup();
    // other 不在群里
    const notMember = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({ target_type: 'group', reported_group_id: group.id, category: 'harassment' }),
    }, env);
    expect(notMember.status).toBe(403);

    const missing = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ target_type: 'group', reported_group_id: '00000000-0000-0000-0000-000000000000', category: 'harassment' }),
    }, env);
    expect(missing.status).toBe(404);

    const noGroupId = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ target_type: 'group', category: 'harassment' }),
    }, env);
    expect(noGroupId.status).toBe(400);

    const badTargetType = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ target_type: 'channel', reported_wallet_address: target.address, category: 'harassment' }),
    }, env);
    expect(badTargetType.status).toBe(400);
  });

  it('defaults target_type to user and keeps user-report validation unchanged', async () => {
    const legacy = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ reported_wallet_address: target.address, category: 'impersonation' }),
    }, env);
    expect(legacy.status).toBe(201);
    const report = (await legacy.json() as any).report;
    expect(report.target_type).toBe('user');
    expect(report.reported_group_id).toBeNull();

    // 群举报不得绕过钱包地址以外的校验：user 目标仍要求合法钱包地址
    const noWallet = await app.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ category: 'impersonation' }),
    }, env);
    expect(noWallet.status).toBe(400);
  });
});
