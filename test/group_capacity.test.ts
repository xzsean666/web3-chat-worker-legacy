// 群容量强制执行测试（契约 §8）：免费 50 档边界、付费档、500 上限、五条入群路径、
// 幂等、老群超员不踢人、审批容量满保持 pending、撤销后暂停新增。

import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

let db: D1Database;
let env: Env;
let owner: TestWallet;
let ownerToken: string;

async function login(wallet: TestWallet): Promise<string> {
  const nonceRes = await app.request('/auth/nonce', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address }),
  }, env);
  const { message } = (await nonceRes.json()) as { message: string };
  const verifyRes = await app.request('/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address, signature: await wallet.signMessage(message) }),
  }, env);
  return ((await verifyRes.json()) as { token: string }).token;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function syntheticAddress(i: number): string {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

// 直接 SQL 批量造成员（含 users 行，FK 约束），返回实际插入数
async function fillMembers(groupId: string, count: number, startIndex = 1): Promise<void> {
  const now = Date.now();
  for (let i = startIndex; i < startIndex + count; i++) {
    const addr = syntheticAddress(i);
    await db.prepare('INSERT OR IGNORE INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(addr, addr, now, now).run();
    await db.prepare("INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)")
      .bind(`${groupId}:${addr}`, groupId, addr, now).run();
  }
}

async function memberCount(groupId: string): Promise<number> {
  return ((await db.prepare('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?').bind(groupId).first<{ n: number }>())!).n;
}

async function createGroupViaApi(metadata: Record<string, unknown> = {}, memberIds: string[] = []): Promise<Response> {
  return app.request('/groups', {
    method: 'POST',
    headers: auth(ownerToken),
    body: JSON.stringify({ name: 'Cap Group', metadata, member_ids: memberIds }),
  }, env);
}

async function setCapacity(groupId: string, tier: number): Promise<void> {
  await db.prepare(
    'INSERT INTO group_capacity_entitlements (group_id, capacity_tier, entitlement_version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(group_id) DO UPDATE SET capacity_tier = excluded.capacity_tier'
  ).bind(groupId, tier, new Date().toISOString()).run();
}

beforeEach(async () => {
  db = createMockD1Database(true);
  env = { DB: db, VOICE_BUCKET: {} as R2Bucket };
  owner = createTestWallet();
  ownerToken = await login(owner);
});

describe('免费 50 人档边界（joinPublicGroup 路径）', () => {
  it('第 50 人成功、第 51 人 403 GROUP_CAPACITY_REACHED（memberCount/capacity/nextTier）', async () => {
    const res = await createGroupViaApi({ group_type_public: true });
    // createGroup metadata 不含 group_type——用 SQL 置 public
    const group = (await res.json()) as any;
    await db.prepare("UPDATE conversations SET group_type = 'public' WHERE id = ?").bind(group.id).run();
    await fillMembers(group.id, 48); // owner + 48 = 49
    expect(await memberCount(group.id)).toBe(49);

    // 第 50 人
    const w50 = createTestWallet();
    const t50 = await login(w50);
    const ok = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(t50) }, env);
    expect(ok.status).toBe(201);
    expect(await memberCount(group.id)).toBe(50);

    // 第 51 人
    const w51 = createTestWallet();
    const t51 = await login(w51);
    const full = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(t51) }, env);
    expect(full.status).toBe(403);
    const body = (await full.json()) as any;
    expect(body.error).toBe('GROUP_CAPACITY_REACHED');
    expect(body.memberCount).toBe(50);
    expect(body.capacity).toBe(50);
    expect(body.nextTier).toBe(100);
    expect(await memberCount(group.id)).toBe(50);
  });

  it('幂等：同一用户重复加入返回 already_member，不占容量', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await db.prepare("UPDATE conversations SET group_type = 'public' WHERE id = ?").bind(group.id).run();
    await fillMembers(group.id, 49); // 满员 50
    const w = createTestWallet();
    const t = await login(w);
    // 先把 w 塞进去再重复 join
    const outsider = createTestWallet();
    const outsiderToken = await login(outsider);
    const full = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(outsiderToken) }, env);
    expect(full.status).toBe(403);

    // 已是成员的重复 join 不受容量影响
    const again = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(ownerToken) }, env);
    expect(again.status).toBe(201);
    expect(((await again.json()) as any).already_member).toBe(true);
    expect(await memberCount(group.id)).toBe(50);
    void w; void t;
  });
});

describe('付费档生效与 500 上限', () => {
  it('100 人档：第 51-100 人成功、第 101 人 403（nextTier=200）', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await db.prepare("UPDATE conversations SET group_type = 'public' WHERE id = ?").bind(group.id).run();
    await setCapacity(group.id, 100);
    await fillMembers(group.id, 98); // owner + 98 = 99

    const w100 = createTestWallet();
    const ok = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(await login(w100)) }, env);
    expect(ok.status).toBe(201);
    expect(await memberCount(group.id)).toBe(100);

    const w101 = createTestWallet();
    const full = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(await login(w101)) }, env);
    expect(full.status).toBe(403);
    const body = (await full.json()) as any;
    expect(body.capacity).toBe(100);
    expect(body.nextTier).toBe(200);
  });

  it('500 为绝对上限：nextTier 为 null', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await db.prepare("UPDATE conversations SET group_type = 'public' WHERE id = ?").bind(group.id).run();
    await setCapacity(group.id, 500);
    await fillMembers(group.id, 499); // 满 500
    const w = createTestWallet();
    const full = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(await login(w)) }, env);
    expect(full.status).toBe(403);
    expect(((await full.json()) as any).nextTier).toBeNull();
  });
});

describe('addGroupMember 路径', () => {
  it('容量满时群主拉人 403；有容量时 201', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await fillMembers(group.id, 49); // 满 50

    const w = createTestWallet();
    const full = await app.request(`/groups/${group.id}/members`, {
      method: 'POST', headers: auth(ownerToken), body: JSON.stringify({ wallet_address: w.address }),
    }, env);
    expect(full.status).toBe(403);
    expect(((await full.json()) as any).error).toBe('GROUP_CAPACITY_REACHED');

    await setCapacity(group.id, 100);
    const ok = await app.request(`/groups/${group.id}/members`, {
      method: 'POST', headers: auth(ownerToken), body: JSON.stringify({ wallet_address: w.address }),
    }, env);
    expect(ok.status).toBe(201);
    expect(await memberCount(group.id)).toBe(51);
  });
});

describe('joinGroupByInviteToken 路径', () => {
  async function makeInvite(groupId: string): Promise<string> {
    const res = await app.request(`/groups/${groupId}/invite-links`, {
      method: 'POST', headers: auth(ownerToken), body: JSON.stringify({}),
    }, env);
    expect(res.status).toBe(201);
    return ((await res.json()) as any).token;
  }

  it('私密群直进：容量满 403 且不消耗 uses_count', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await fillMembers(group.id, 49); // 满 50
    const token = await makeInvite(group.id);

    const w = createTestWallet();
    const full = await app.request('/groups/join-by-token', {
      method: 'POST', headers: auth(await login(w)), body: JSON.stringify({ token }),
    }, env);
    expect(full.status).toBe(403);
    expect(((await full.json()) as any).error).toBe('GROUP_CAPACITY_REACHED');
    const link = await db.prepare('SELECT uses_count FROM group_invite_links WHERE token = ?').bind(token).first<{ uses_count: number }>();
    expect(link!.uses_count).toBe(0);

    // 扩容后同一链接可用，且正常消耗
    await setCapacity(group.id, 100);
    const ok = await app.request('/groups/join-by-token', {
      method: 'POST', headers: auth(await login(w)), body: JSON.stringify({ token }),
    }, env);
    expect(ok.status).toBe(201);
    const link2 = await db.prepare('SELECT uses_count FROM group_invite_links WHERE token = ?').bind(token).first<{ uses_count: number }>();
    expect(link2!.uses_count).toBe(1);
  });

  it('公开群经邀请链接：容量满 403', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await db.prepare("UPDATE conversations SET group_type = 'public' WHERE id = ?").bind(group.id).run();
    await fillMembers(group.id, 49);
    const token = await makeInvite(group.id);

    const w = createTestWallet();
    const full = await app.request('/groups/join-by-token', {
      method: 'POST', headers: auth(await login(w)), body: JSON.stringify({ token }),
    }, env);
    expect(full.status).toBe(403);
    expect(((await full.json()) as any).error).toBe('GROUP_CAPACITY_REACHED');
  });

  it('已是成员的幂等重试不受容量影响', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await fillMembers(group.id, 48); // owner+48=49
    const token = await makeInvite(group.id);
    const w = createTestWallet();
    const t = await login(w);
    const first = await app.request('/groups/join-by-token', { method: 'POST', headers: auth(t), body: JSON.stringify({ token }) }, env);
    expect(first.status).toBe(201); // 第 50 人
    const again = await app.request('/groups/join-by-token', { method: 'POST', headers: auth(t), body: JSON.stringify({ token }) }, env);
    expect(again.status).toBe(201);
    expect(((await again.json()) as any).already_member).toBe(true);
  });
});

describe('handleGroupJoinRequest 审批路径', () => {
  it('容量满时 approve 403，申请保持 pending；扩容后可批准', async () => {
    const res = await createGroupViaApi({ join_admin_only: true });
    const group = (await res.json()) as any;
    const token = await (async () => {
      const r = await app.request(`/groups/${group.id}/invite-links`, { method: 'POST', headers: auth(ownerToken), body: JSON.stringify({}) }, env);
      return ((await r.json()) as any).token;
    })();

    const w = createTestWallet();
    const wt = await login(w);
    const redeem = await app.request('/groups/join-by-token', { method: 'POST', headers: auth(wt), body: JSON.stringify({ token }) }, env);
    expect(redeem.status).toBe(202);
    const requestId = ((await redeem.json()) as any).join_request.id;

    await fillMembers(group.id, 49); // 满 50
    const deny = await app.request(`/groups/${group.id}/join-requests/${requestId}/approve`, { method: 'POST', headers: auth(ownerToken) }, env);
    expect(deny.status).toBe(403);
    expect(((await deny.json()) as any).error).toBe('GROUP_CAPACITY_REACHED');
    const req = await db.prepare('SELECT status FROM group_join_requests WHERE id = ?').bind(requestId).first<{ status: string }>();
    expect(req!.status).toBe('pending');

    await setCapacity(group.id, 100);
    const ok = await app.request(`/groups/${group.id}/join-requests/${requestId}/approve`, { method: 'POST', headers: auth(ownerToken) }, env);
    expect(ok.status).toBe(200);
    expect((await db.prepare('SELECT status FROM group_join_requests WHERE id = ?').bind(requestId).first<{ status: string }>())!.status).toBe('approved');
    expect(await memberCount(group.id)).toBe(51);
  });
});

describe('createGroup 初始成员上限', () => {
  it('创建者 + 51 初始成员 = 52 > 50 → 整单拒绝不入库；50 人整单成功', async () => {
    const ids51 = Array.from({ length: 51 }, (_, i) => syntheticAddress(1000 + i));
    const deny = await createGroupViaApi({}, ids51);
    expect(deny.status).toBe(403);
    const body = (await deny.json()) as any;
    expect(body.error).toBe('GROUP_CAPACITY_REACHED');
    expect(body.capacity).toBe(50);
    expect(body.nextTier).toBe(100);
    const convCount = await db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE owner_address = ?").bind(owner.address).first<{ n: number }>();
    expect(convCount!.n).toBe(0);

    const ids49 = Array.from({ length: 49 }, (_, i) => syntheticAddress(2000 + i));
    const ok = await createGroupViaApi({}, ids49);
    expect(ok.status).toBe(201);
    const group = (await ok.json()) as any;
    expect(await memberCount(group.id)).toBe(50);
  });
});

describe('老群超员与撤销', () => {
  it('60 人无权益行老群：新增 403，既有成员发言/查询不受影响', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await db.prepare("UPDATE conversations SET group_type = 'public' WHERE id = ?").bind(group.id).run();
    await fillMembers(group.id, 59); // owner + 59 = 60（老群超员，无权益行）
    expect(await memberCount(group.id)).toBe(60);

    const w = createTestWallet();
    const full = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(await login(w)) }, env);
    expect(full.status).toBe(403);
    const body = (await full.json()) as any;
    expect(body.memberCount).toBe(60);
    expect(body.capacity).toBe(50);

    // 既有成员发言与查询正常
    const msg = await app.request(`/conversations/${group.id}/messages`, {
      method: 'POST', headers: auth(ownerToken), body: JSON.stringify({ type: 'text', content: 'hello' }),
    }, env);
    expect(msg.status).toBe(201);
    const detail = await app.request(`/groups/${group.id}`, { headers: auth(ownerToken) }, env);
    expect(detail.status).toBe(200);
  });

  it('撤销后（capacity_tier 回 50）超员群暂停新增', async () => {
    const res = await createGroupViaApi();
    const group = (await res.json()) as any;
    await db.prepare("UPDATE conversations SET group_type = 'public' WHERE id = ?").bind(group.id).run();
    await setCapacity(group.id, 100);
    await fillMembers(group.id, 59); // 60 人，100 档内合法

    // 撤销：回 50 档
    await db.prepare("UPDATE group_capacity_entitlements SET capacity_tier = 50, revoked_at = ?, revoke_reason = 'fraud' WHERE group_id = ?")
      .bind(new Date().toISOString(), group.id).run();

    const w = createTestWallet();
    const full = await app.request(`/groups/${group.id}/join`, { method: 'POST', headers: auth(await login(w)) }, env);
    expect(full.status).toBe(403);
    expect(((await full.json()) as any).capacity).toBe(50);
    expect(await memberCount(group.id)).toBe(60); // 不踢人
  });
});
