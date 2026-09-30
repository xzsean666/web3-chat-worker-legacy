import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('Chat folders (per-user conversation tags)', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;
  let alice: TestWallet;
  let bob: TestWallet;
  let aliceToken: string;
  let bobToken: string;

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
    return await verifyRes.json() as { token: string };
  }

  function put(token: string, folders: unknown) {
    return app.request('/chat-folders', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(folders),
    }, env);
  }

  function get(token: string) {
    return app.request('/chat-folders', {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
  }

  const sampleFolders = [
    {
      id: '1700000000000000-0',
      name: '工程',
      type: 'all',
      hidden: false,
      sort_order: 0,
      member_based: true,
      member_conversation_ids: ['c1', 'g1'],
    },
    {
      id: '1700000000000001-1',
      name: '私信',
      type: 'direct',
      hidden: true,
      sort_order: 1,
      member_based: false,
      member_conversation_ids: [],
    },
  ];

  beforeEach(async () => {
    db = createMockD1Database(true);
    r2 = createMockR2Bucket() as unknown as MockR2Bucket;
    env = { DB: db, VOICE_BUCKET: r2 as unknown as R2Bucket };
    alice = createTestWallet();
    bob = createTestWallet();
    aliceToken = (await login(alice)).token;
    bobToken = (await login(bob)).token;
  });

  it('requires authentication on both endpoints', async () => {
    expect((await app.request('/chat-folders', {}, env)).status).toBe(401);
    expect(
      (await app.request('/chat-folders', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([]),
      }, env)).status,
    ).toBe(401);
    expect((await get('bad-token')).status).toBe(401);
  });

  it('saves a full snapshot and reads it back ordered by sort_order', async () => {
    const empty = await get(aliceToken);
    expect(empty.status).toBe(200);
    expect((await empty.json() as any).folders).toEqual([]);

    const saved = await put(aliceToken, { folders: [...sampleFolders].reverse() });
    expect(saved.status).toBe(200);
    const savedFolders = (await saved.json() as any).folders;
    expect(savedFolders.map((f: any) => f.id)).toEqual([
      '1700000000000000-0',
      '1700000000000001-1',
    ]);
    expect(savedFolders[0]).toMatchObject({
      name: '工程',
      type: 'all',
      hidden: false,
      sort_order: 0,
      member_based: true,
      member_conversation_ids: ['c1', 'g1'],
    });
    expect(savedFolders[1]).toMatchObject({ name: '私信', hidden: true, member_based: false });
    expect(savedFolders[0].created_at).toBeGreaterThan(0);
    expect(savedFolders[0].updated_at).toBeGreaterThan(0);

    const listed = await get(aliceToken);
    expect((await listed.json() as any).folders.map((f: any) => f.name)).toEqual(['工程', '私信']);
  });

  it('PUT replaces the whole set (updates, removals) and keeps created_at for surviving ids', async () => {
    await put(aliceToken, sampleFolders);
    const first = (await (await get(aliceToken)).json() as any).folders;
    const originalCreatedAt = first[0].created_at;

    const replacement = [
      { ...sampleFolders[1], name: '私信改', hidden: false, sort_order: 0 },
      {
        id: '1700000000000002-2',
        name: '群组',
        type: 'group',
        hidden: false,
        sort_order: 1,
        member_based: false,
        member_conversation_ids: [],
      },
    ];
    const res = await put(aliceToken, replacement);
    expect(res.status).toBe(200);
    const folders = (await res.json() as any).folders;
    expect(folders.map((f: any) => f.name)).toEqual(['私信改', '群组']);
    // 存活 id 的 created_at 保留；updated_at 刷新。
    expect(folders[0].created_at).toBe(originalCreatedAt);
    expect(folders[0].updated_at).toBeGreaterThanOrEqual(originalCreatedAt);

    const count = await db
      .prepare('SELECT COUNT(*) AS count FROM chat_folders')
      .first<{ count: number }>('count');
    expect(count).toBe(2);
  });

  it('PUT with an empty array deletes all folders', async () => {
    await put(aliceToken, sampleFolders);
    const res = await put(aliceToken, []);
    expect(res.status).toBe(200);
    expect((await res.json() as any).folders).toEqual([]);
    expect((await (await get(aliceToken)).json() as any).folders).toEqual([]);
  });

  it('isolates folders between users', async () => {
    await put(aliceToken, sampleFolders);
    expect((await (await get(bobToken)).json() as any).folders).toEqual([]);

    // Bob 的全量替换不影响 Alice 的数据。
    await put(bobToken, [sampleFolders[1]]);
    const aliceFolders = (await (await get(aliceToken)).json() as any).folders;
    expect(aliceFolders).toHaveLength(2);
    const bobFolders = (await (await get(bobToken)).json() as any).folders;
    expect(bobFolders).toHaveLength(1);
    expect(bobFolders[0].name).toBe('私信');
  });

  it('rejects invalid payloads with 400', async () => {
    expect((await put(aliceToken, { nope: true })).status).toBe(400);
    expect((await put(aliceToken, [{ ...sampleFolders[0], id: '' }])).status).toBe(400);
    expect((await put(aliceToken, [{ ...sampleFolders[0], name: '' }])).status).toBe(400);
    expect((await put(aliceToken, [{ ...sampleFolders[0], type: 'weird' }])).status).toBe(400);
    expect(
      (await put(aliceToken, [sampleFolders[0], sampleFolders[0]])).status,
    ).toBe(400);
  });
});
