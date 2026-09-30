// 指南审计补测：阶段4③ /sync (created_at, id) 全序决胜游标防漏单；
// 阶段9 ack/read 批量接口的幂等与 last_read 语义（created_at 最大者）。

import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

let db: D1Database;
let env: Env;
let alice: TestWallet;
let bob: TestWallet;
let aliceToken: string;
let bobToken: string;
let groupId: string;

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

// 以固定 created_at 直接 SQL 插入消息（构造同毫秒场景）
async function insertMessage(id: string, senderId: string, createdAt: number, content: string): Promise<void> {
  await db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at, burn_after_seconds, mentions)
    VALUES (?, ?, ?, 'text', ?, 'permanent', 'pending', ?, ?, NULL, '[]')
  `).bind(id, groupId, senderId, content, createdAt + 86_400_000, createdAt).run();
}

beforeEach(async () => {
  db = createMockD1Database(true);
  env = { DB: db, VOICE_BUCKET: {} as R2Bucket };
  alice = createTestWallet();
  bob = createTestWallet();
  aliceToken = await login(alice);
  bobToken = await login(bob);
  const res = await app.request('/groups', {
    method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sync Test', member_ids: [bob.address] }),
  }, env);
  expect(res.status).toBe(201);
  groupId = ((await res.json()) as any).id;
});

describe('/sync 全序决胜游标（指南 阶段4③）', () => {
  it('同一毫秒的 3 条消息分页拉取不丢单（limit=2 + next_cursor 续拉）', async () => {
    const ts = Date.now() - 1000;
    // id 按字典序构造，消除随机性
    await insertMessage('00000000-0000-0000-0000-000000000001', alice.address, ts, 'm1');
    await insertMessage('00000000-0000-0000-0000-000000000002', alice.address, ts, 'm2');
    await insertMessage('00000000-0000-0000-0000-000000000003', alice.address, ts, 'm3');

    const page1 = await app.request(`/sync?since=${ts - 1}&limit=2`, { headers: { Authorization: `Bearer ${bobToken}` } }, env);
    expect(page1.status).toBe(200);
    const d1 = (await page1.json()) as any;
    expect(d1.messages.map((m: any) => m.content)).toEqual(['m1', 'm2']);
    expect(d1.has_more).toBe(true);
    expect(d1.next_cursor).toEqual({ ts, id: '00000000-0000-0000-0000-000000000002' });

    // 用 (ts, id) 决胜游标续拉：同毫秒剩余消息不丢
    const page2 = await app.request(`/sync?since=${d1.next_cursor.ts}&since_id=${d1.next_cursor.id}&limit=2`, { headers: { Authorization: `Bearer ${bobToken}` } }, env);
    const d2 = (await page2.json()) as any;
    expect(d2.messages.map((m: any) => m.content)).toEqual(['m3']);
    expect(d2.has_more).toBe(false);

    // 再次以最后游标拉取为空（幂等无重复）
    const page3 = await app.request(`/sync?since=${d2.next_cursor.ts}&since_id=${d2.next_cursor.id}`, { headers: { Authorization: `Bearer ${bobToken}` } }, env);
    const d3 = (await page3.json()) as any;
    expect(d3.messages).toEqual([]);
    expect(d3.next_cursor).toBeNull();
  });

  it('向后兼容：只传 since 的旧客户端仍按 created_at > since 工作', async () => {
    const ts = Date.now() - 1000;
    await insertMessage(crypto.randomUUID(), alice.address, ts, 'old');
    await insertMessage(crypto.randomUUID(), alice.address, ts + 5, 'new');

    const res = await app.request(`/sync?since=${ts}`, { headers: { Authorization: `Bearer ${bobToken}` } }, env);
    const data = (await res.json()) as any;
    // 无 since_id 时 created_at == since 的消息不返回（旧语义），>since 的正常返回
    expect(data.messages.map((m: any) => m.content)).toEqual(['new']);
    expect(typeof data.sync_timestamp).toBe('number');
  });
});

describe('批量 ACK 幂等与语义（指南 阶段5/写压）', () => {
  async function sendTwo(): Promise<string[]> {
    const ids: string[] = [];
    for (const content of ['a', 'b']) {
      const res = await app.request(`/conversations/${groupId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }, env);
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as any).id);
    }
    return ids;
  }

  it('批量 delivery ACK 幂等：重复批量上报不产生重复回执行', async () => {
    const ids = await sendTwo();
    const r1 = await app.request('/messages/ack', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: ids }),
    }, env);
    expect(((await r1.json()) as any).acknowledged.sort()).toEqual([...ids].sort());

    const r2 = await app.request('/messages/ack', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: ids }),
    }, env);
    expect(((await r2.json()) as any).acknowledged.sort()).toEqual([...ids].sort());

    const count = await db.prepare("SELECT COUNT(*) AS n FROM message_receipts WHERE status = 'delivered'").first<{ n: number }>();
    expect(count!.n).toBe(2); // 两条消息各 1 行，无重复

    // 单聊全员送达 → delivered
    const statuses = await db.prepare('SELECT status FROM messages ORDER BY created_at').all<{ status: string }>();
    expect(statuses.results.every((m) => m.status === 'delivered')).toBe(true);

    // 自发消息 skip
    const self = await app.request('/messages/ack', {
      method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: ids }),
    }, env);
    expect(((await self.json()) as any).skipped.sort()).toEqual([...ids].sort());
  });

  it('批量 read ACK：last_read 取 created_at 最大者（与数组顺序无关），消息推进 read', async () => {
    const ids = await sendTwo();
    const ts1 = (await db.prepare('SELECT created_at FROM messages WHERE id = ?').bind(ids[0]).first<{ created_at: number }>())!.created_at;
    const ts2 = (await db.prepare('SELECT created_at FROM messages WHERE id = ?').bind(ids[1]).first<{ created_at: number }>())!.created_at;
    const [older, newer] = ts1 <= ts2 ? [ids[0], ids[1]] : [ids[1], ids[0]];
    const newerTs = Math.max(ts1, ts2);

    // 故意把更新的消息放数组前面
    const res = await app.request('/messages/read', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: [newer, older] }),
    }, env);
    const data = (await res.json()) as any;
    expect(data.read.sort()).toEqual([...ids].sort());
    expect(data.burned).toEqual([]);

    const member = await db.prepare('SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .bind(groupId, bob.address).first<{ last_read_message_id: string }>();
    expect(member!.last_read_message_id).toBe(newer);

    const readCount = await db.prepare("SELECT COUNT(*) AS n FROM message_receipts WHERE status = 'read'").first<{ n: number }>();
    expect(readCount!.n).toBe(2);
    const statuses = await db.prepare('SELECT status FROM messages').all<{ status: string }>();
    expect(statuses.results.every((m) => m.status === 'read')).toBe(true);
    void newerTs;
  });

  it('大批量（60 条，跨 IN 分块）delivery/read ACK 全部生效', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/conversations/${groupId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `bulk-${i}` }),
      }, env);
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as any).id);
    }

    const ackRes = await app.request('/messages/ack', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: ids }),
    }, env);
    expect(ackRes.status).toBe(200);
    expect(((await ackRes.json()) as any).acknowledged).toHaveLength(60);

    const readRes = await app.request('/messages/read', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: ids }),
    }, env);
    expect(readRes.status).toBe(200);
    expect(((await readRes.json()) as any).read).toHaveLength(60);

    const statuses = await db.prepare('SELECT status FROM messages').all<{ status: string }>();
    expect(statuses.results).toHaveLength(60);
    expect(statuses.results.every((m) => m.status === 'read')).toBe(true);
  });

  it('单请求超过 200 个 id 返回 400，200 个（边界）正常受理', async () => {
    const over = Array.from({ length: 201 }, () => crypto.randomUUID());
    const ackRes = await app.request('/messages/ack', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: over }),
    }, env);
    expect(ackRes.status).toBe(400);

    const readRes = await app.request('/messages/read', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: over }),
    }, env);
    expect(readRes.status).toBe(400);

    // 边界 200：id 均不存在 → 全部 skipped，但请求受理
    const atLimit = over.slice(0, 200);
    const okRes = await app.request('/messages/ack', {
      method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: atLimit }),
    }, env);
    expect(okRes.status).toBe(200);
    const okData = (await okRes.json()) as any;
    expect(okData.acknowledged).toEqual([]);
    expect(okData.skipped).toHaveLength(200);
  });
});
