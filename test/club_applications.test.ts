// Club 创建申请制（0020）：会员申请、重复 pending 409、管理端 approve 实际创建 club、reject 流程。

import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

const SECRET = 'test-internal-secret';

let db: D1Database;
let bucket: MockR2Bucket;
let env: Env;
let alice: TestWallet; // 会员
let bob: TestWallet;   // 非会员
let aliceToken: string;
let bobToken: string;

async function login(wallet: TestWallet): Promise<string> {
  const nonceRes = await app.request('/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address }),
  }, env);
  const { message } = (await nonceRes.json()) as { message: string };
  const verifyRes = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address, signature: await wallet.signMessage(message) }),
  }, env);
  return ((await verifyRes.json()) as { token: string }).token;
}

function authed(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function grantMembership(address: string) {
  await db.prepare(
    "INSERT INTO wallet_entitlements (wallet_address, membership_tier, membership_expires_at, entitlement_version, updated_at) VALUES (?, 'month', ?, 1, ?)"
  ).bind(address.toLowerCase(), new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString()).run();
}

function sign(method: string, path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const message = `${ts}\n${nonce}\n${method}\n${path}\n${bodyHash}`;
  return {
    'X-Internal-Timestamp': ts,
    'X-Internal-Nonce': nonce,
    'X-Internal-Signature': createHmac('sha256', SECRET).update(message).digest('hex'),
  };
}

async function adminCall(method: string, path: string, body?: unknown): Promise<Response> {
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = sign(method, path.split('?')[0], bodyStr);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, { method, headers, body: body === undefined ? undefined : bodyStr }, env);
}

async function apply(token: string, body: Record<string, unknown>) {
  return app.request('/clubs/apply', { method: 'POST', headers: authed(token), body: JSON.stringify(body) }, env);
}

beforeEach(async () => {
  db = createMockD1Database(true);
  bucket = createMockR2Bucket() as MockR2Bucket;
  env = { DB: db, VOICE_BUCKET: bucket, INTERNAL_ADMIN_SECRET: SECRET };
  alice = createTestWallet();
  bob = createTestWallet();
  aliceToken = await login(alice);
  bobToken = await login(bob);
  await grantMembership(alice.address);
});

describe('POST /clubs/apply', () => {
  it('non-member gets 403 MEMBERSHIP_REQUIRED; member creates pending application', async () => {
    const denied = await apply(bobToken, { name: 'Bob Club' });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error).toBe('MEMBERSHIP_REQUIRED');

    const ok = await apply(aliceToken, {
      name: 'Alice Club',
      description: '量化交易交流',
      tags: ['DeFi', '量化'],
      message: '我想建立一个量化社群',
    });
    expect(ok.status).toBe(201);
    const { application } = (await ok.json()) as any;
    expect(application.status).toBe('pending');
    expect(application.applicant_id).toBe(alice.address);
    expect(application.name).toBe('Alice Club');
    expect(application.tags).toEqual(['DeFi', '量化']);
    expect(application.club_id).toBeNull();

    // my-application 返回最新一条
    const mine = await app.request('/clubs/my-application', { headers: authed(aliceToken) }, env);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as any).application.id).toBe(application.id);

    // 无申请 → null
    const none = await app.request('/clubs/my-application', { headers: authed(bobToken) }, env);
    expect(((await none.json()) as any).application).toBeNull();

    // 校验：缺 name / 非法 tags → 400
    expect((await apply(aliceToken, {})).status).toBe(400);
    const badTags = await app.request('/clubs/apply', {
      method: 'POST', headers: authed(bobToken), body: JSON.stringify({ name: 'x', tags: 'DeFi' }),
    }, env);
    expect(badTags.status).toBe(400);

    // 未登录 → 401
    const noAuth = await app.request('/clubs/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    }, env);
    expect(noAuth.status).toBe(401);
  });

  it('second pending application gets 409 APPLICATION_PENDING', async () => {
    expect((await apply(aliceToken, { name: 'Club One' })).status).toBe(201);
    const dup = await apply(aliceToken, { name: 'Club Two' });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).error).toBe('APPLICATION_PENDING');
  });
});

describe('admin review', () => {
  it('lists applications with applicant wallet; approve creates real club owned by applicant', async () => {
    const created = await apply(aliceToken, {
      name: 'Alice Club', description: '量化交易交流', tags: ['DeFi'],
    });
    const { application } = (await created.json()) as any;

    // 列表（含申请人地址）
    const list = await adminCall('GET', '/internal/admin/community/applications?status=pending');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as any;
    expect(listBody.total).toBe(1);
    expect(listBody.list[0].id).toBe(application.id);
    expect(listBody.list[0].applicant_wallet_address).toBe(alice.address);
    expect(listBody.list[0].tags).toEqual(['DeFi']);

    // 非法 status → 400
    expect((await adminCall('GET', '/internal/admin/community/applications?status=weird')).status).toBe(400);

    // approve → 实际创建 club，owner=申请人
    const approve = await adminCall('POST', `/internal/admin/community/applications/${application.id}/approve`, { actor: 'ops1' });
    expect(approve.status).toBe(200);
    const approveBody = (await approve.json()) as any;
    expect(approveBody.application.status).toBe('approved');
    expect(approveBody.application.handled_by).toBe('ops1');
    expect(approveBody.application.handled_at).toBeTruthy();
    expect(approveBody.application.club_id).toBe(approveBody.club.id);
    expect(approveBody.club.type).toBe('club');
    expect(approveBody.club.name).toBe('Alice Club');
    expect(approveBody.club.metadata.description).toBe('量化交易交流');
    expect(approveBody.club.metadata.tags).toEqual(['DeFi']);
    expect(approveBody.club.owner_address).toBe(alice.address);
    expect(approveBody.club.my_role).toBe('owner');

    // club 真实存在且出现在发现页
    const conv = await db.prepare("SELECT type, group_type FROM conversations WHERE id = ?")
      .bind(approveBody.club.id).first<{ type: string; group_type: string }>();
    expect(conv).toMatchObject({ type: 'club', group_type: 'public' });
    const ownerRow = await db.prepare(
      "SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?"
    ).bind(approveBody.club.id, alice.address).first<{ role: string }>();
    expect(ownerRow?.role).toBe('owner');
    const discover = await app.request('/clubs?keyword=Alice', { headers: authed(bobToken) }, env);
    expect(((await discover.json()) as any).groups.map((g: any) => g.id)).toContain(approveBody.club.id);

    // 审计
    const audit = await db.prepare(
      "SELECT action, target FROM payment_audit_log WHERE action = 'club_application_approve'"
    ).first<{ action: string; target: string }>();
    expect(audit?.target).toBe(application.id);

    // 重复 approve → 409
    const again = await adminCall('POST', `/internal/admin/community/applications/${application.id}/approve`, {});
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error).toBe('APPLICATION_ALREADY_HANDLED');

    // 已处理后可再次申请（部分唯一索引只约束 pending）
    expect((await apply(aliceToken, { name: 'Second Club' })).status).toBe(201);

    // 不存在的申请 → 404
    const missing = await adminCall('POST', '/internal/admin/community/applications/no-such/approve', {});
    expect(missing.status).toBe(404);

    // 无签名 → 401
    const noAuth = await app.request(`/internal/admin/community/applications/${application.id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, env);
    expect(noAuth.status).toBe(401);
  });

  it('reject sets status/review_reason/handled_* with audit; applicant can re-apply', async () => {
    const created = await apply(aliceToken, { name: 'Rejected Club' });
    const { application } = (await created.json()) as any;

    const reject = await adminCall('POST', `/internal/admin/community/applications/${application.id}/reject`, {
      actor: 'ops2', reason: '名称违规',
    });
    expect(reject.status).toBe(200);
    const body = (await reject.json()) as any;
    expect(body.application.status).toBe('rejected');
    expect(body.application.review_reason).toBe('名称违规');
    expect(body.application.handled_by).toBe('ops2');
    expect(body.application.club_id).toBeNull();

    // 未创建任何 club
    const clubs = await db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE type = 'club'").first<{ n: number }>();
    expect(clubs?.n).toBe(0);

    const audit = await db.prepare(
      "SELECT action FROM payment_audit_log WHERE action = 'club_application_reject'"
    ).first<{ action: string }>();
    expect(audit?.action).toBe('club_application_reject');

    // my-application 返回 rejected 最新一条；拒绝后可重新申请
    const mine = await app.request('/clubs/my-application', { headers: authed(aliceToken) }, env);
    expect(((await mine.json()) as any).application.status).toBe('rejected');
    expect((await apply(aliceToken, { name: 'New Try' })).status).toBe(201);

    // 重复 reject → 409
    const again = await adminCall('POST', `/internal/admin/community/applications/${application.id}/reject`, {});
    expect(again.status).toBe(409);
  });
});
