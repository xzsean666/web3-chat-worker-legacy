// 双代币可选支付 + 统一收款地址（2026-10 需求）：
// - quote / quote-preview 接受可选 body.token（代币符号），按符号匹配 chains[] 配置项；
//   不传保持 chains[0] 旧行为；传了但无匹配 → 400 TOKEN_NOT_SUPPORTED。
// - 链级 prices 段提供该代币独立定价（覆盖全局 membership/capacityTiers）。
// - 配置顶层 recipientAddress 为统一唯一收款地址，所有收费场景下发它；
//   旧版本配置缺省时回退 chains[0].recipientAddress（feed_post 回退 feedPost.recipientAddress）。

import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, MockR2Bucket } from './helpers/r2';
import { createTestWallet, type TestWallet } from './helpers/wallet';
import { saveConfig, type PaymentConfigPayload } from '../src/services/payments/config';
import type { Env } from '../src/types';

const UNIFIED = '0x9999999999999999999999999999999999999999';
const CHAIN_RECIPIENT = '0x1111111111111111111111111111111111111111';
const FEED_RECIPIENT = '0x2222222222222222222222222222222222222222';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

let db: D1Database;
let bucket: MockR2Bucket;
let env: Env;

// 双代币配置：同一条 BSC 链两项——BNB(native) 与 USDT(erc20)，各自 prices 独立定价。
function dualPayload(overrides: Partial<PaymentConfigPayload> = {}): PaymentConfigPayload {
  return {
    schemaVersion: 1,
    membershipEnabled: true,
    paymentsEnabled: true,
    recipientAddress: UNIFIED,
    membership: {
      monthly: { price: '5000000000000000000', durationDays: 30 },
      yearly: { price: '50000000000000000000', durationDays: 365 },
    },
    capacityTiers: [
      { tier: 100, price: '10000000000000000000' },
      { tier: 200, price: '25000000000000000000' },
      { tier: 300, price: '45000000000000000000' },
      { tier: 400, price: '70000000000000000000' },
      { tier: 500, price: '100000000000000000000' },
    ],
    memberDiscountBps: 2000,
    quoteTtlSeconds: 1800,
    chains: [
      {
        chainId: 56,
        rpcUrls: ['http://127.0.0.1:9'],
        confirmations: 12,
        recipientAddress: CHAIN_RECIPIENT,
        token: { type: 'native', symbol: 'BNB', decimals: 18, address: null },
        prices: {
          membership: { monthly: { price: '3000000000000000000' }, yearly: { price: '30000000000000000000' } },
          capacityTiers: [
            { tier: 100, price: '6000000000000000000' },
            { tier: 200, price: '15000000000000000000' },
            { tier: 300, price: '27000000000000000000' },
            { tier: 400, price: '42000000000000000000' },
            { tier: 500, price: '60000000000000000000' },
          ],
        },
      },
      {
        chainId: 56,
        rpcUrls: ['http://127.0.0.1:9'],
        confirmations: 12,
        recipientAddress: CHAIN_RECIPIENT,
        token: { type: 'erc20', symbol: 'USDT', decimals: 18, address: USDT_ADDRESS },
        prices: {
          membership: { monthly: { price: '10000000000000000000' }, yearly: { price: '100000000000000000000' } },
          capacityTiers: [
            { tier: 100, price: '20000000000000000000' },
            { tier: 200, price: '50000000000000000000' },
            { tier: 300, price: '90000000000000000000' },
            { tier: 400, price: '140000000000000000000' },
            { tier: 500, price: '200000000000000000000' },
          ],
        },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  db = createMockD1Database(true);
  bucket = createMockR2Bucket() as MockR2Bucket;
  env = { DB: db, VOICE_BUCKET: bucket };
});

async function login(wallet: TestWallet): Promise<string> {
  const nonceRes = await app.request('/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address }),
  }, env);
  const { message } = (await nonceRes.json()) as { message: string };
  const signature = await wallet.signMessage(message);
  const verifyRes = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: wallet.address, signature }),
  }, env);
  return ((await verifyRes.json()) as { token: string }).token;
}

function authed(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function makeClub(clubId: string, ownerWallet: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare("INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, created_at, updated_at) VALUES (?, 'club', ?, 'c', '{}', 0, NULL, ?, ?)")
    .bind(clubId, ownerWallet, now, now)
    .run();
}

async function preview(token: string, body: Record<string, unknown>) {
  return app.request('/payments/quote-preview', { method: 'POST', headers: authed(token), body: JSON.stringify(body) }, env);
}

async function quote(token: string, body: Record<string, unknown>) {
  return app.request('/payments/quote', { method: 'POST', headers: authed(token), body: JSON.stringify(body) }, env);
}

describe('双代币报价（body.token 可选）', () => {
  it('token=USDT 走 USDT 链配置与独立定价；token=bnb 大小写不敏感；不传保持 chains[0]', async () => {
    await saveConfig(db, dualPayload(), 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);

    const usdt = await preview(token, { kind: 'membership_month', token: 'USDT' });
    expect(usdt.status).toBe(200);
    const u = (await usdt.json()) as any;
    expect(u.tokenType).toBe('erc20');
    expect(u.tokenSymbol).toBe('USDT');
    expect(u.tokenAddress).toBe(USDT_ADDRESS);
    expect(u.tokenDecimals).toBe(18);
    expect(u.amount).toBe('10000000000000000000'); // USDT 独立月价 10 USDT
    // 统一收款地址：顶层 recipientAddress 优先于链级
    expect(u.recipientAddress).toBe(UNIFIED);

    const bnb = await preview(token, { kind: 'membership_month', token: 'bnb' });
    expect(bnb.status).toBe(200);
    const b = (await bnb.json()) as any;
    expect(b.tokenType).toBe('native');
    expect(b.tokenSymbol).toBe('BNB');
    expect(b.tokenAddress).toBeNull();
    expect(b.amount).toBe('3000000000000000000'); // BNB 独立月价 3 BNB
    expect(b.recipientAddress).toBe(UNIFIED);

    const legacy = await preview(token, { kind: 'membership_month' });
    const l = (await legacy.json()) as any;
    expect(l.tokenSymbol).toBe('BNB'); // 不传 → chains[0] 旧行为
    expect(l.amount).toBe('3000000000000000000');

    const bad = await preview(token, { kind: 'membership_month', token: 'DOGE' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('TOKEN_NOT_SUPPORTED');
  });

  it('链级 prices 缺省时回落全局价格（旧配置行为不变）', async () => {
    const p = dualPayload();
    delete p.chains[0].prices;
    delete p.chains[1].prices;
    await saveConfig(db, p, 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);

    const usdt = await preview(token, { kind: 'membership_month', token: 'USDT' });
    const u = (await usdt.json()) as any;
    expect(u.tokenSymbol).toBe('USDT');
    expect(u.amount).toBe('5000000000000000000'); // 全局月价
  });

  it('quote 建单：订单冻结 USDT 代币字段与统一收款地址', async () => {
    await saveConfig(db, dualPayload(), 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);

    const res = await quote(token, { kind: 'membership_year', token: 'USDT' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.payment.tokenType).toBe('erc20');
    expect(data.payment.tokenSymbol).toBe('USDT');
    expect(data.payment.tokenAddress).toBe(USDT_ADDRESS);
    expect(data.payment.recipientAddress).toBe(UNIFIED);
    expect(data.payment.amount).toBe('100000000000000000000'); // USDT 独立年价

    const order = data.order;
    expect(order.token_type).toBe('erc20');
    expect(order.token_address).toBe(USDT_ADDRESS.toLowerCase());
    expect(order.token_symbol).toBe('USDT');
    expect(order.recipient_address).toBe(UNIFIED);
    expect(order.amount).toBe('100000000000000000000');
  });
});

describe('统一收款地址', () => {
  it('feed_post：顶层地址优先；旧配置缺省时回退 feedPost.recipientAddress', async () => {
    const wallet = createTestWallet();
    const token = await login(wallet);
    await makeClub('club1', wallet.address);

    // 新配置：顶层统一地址优先于 feedPost.recipientAddress
    await saveConfig(
      db,
      dualPayload({
        feedPost: {
          enabled: true,
          price: '1000000000000000000',
          freeQuota: 5,
          chainId: 56,
          recipientAddress: FEED_RECIPIENT,
          token: { type: 'native', symbol: 'BNB', decimals: 18, address: null },
        },
      }),
      'tester'
    );
    const res = await preview(token, { kind: 'feed_post', group_id: 'club1' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.recipientAddress).toBe(UNIFIED);
    expect(data.tokenSymbol).toBe('BNB'); // feed_post 代币仍由 feedPost 段固定

    // 旧配置（无顶层 recipientAddress）：回退 feedPost.recipientAddress
    const legacy = dualPayload({
      feedPost: {
        enabled: true,
        price: '1000000000000000000',
        freeQuota: 5,
        chainId: 56,
        recipientAddress: FEED_RECIPIENT,
        token: { type: 'native', symbol: 'BNB', decimals: 18, address: null },
      },
    });
    delete (legacy as any).recipientAddress;
    await saveConfig(db, legacy, 'tester');
    const res2 = await preview(token, { kind: 'feed_post', group_id: 'club1' });
    expect(((await res2.json()) as any).recipientAddress).toBe(FEED_RECIPIENT);
  });

  it('旧配置（无顶层地址）：会员/扩群回退 chains[0].recipientAddress', async () => {
    const legacy = dualPayload();
    delete (legacy as any).recipientAddress;
    await saveConfig(db, legacy, 'tester');
    const wallet = createTestWallet();
    const token = await login(wallet);

    const res = await preview(token, { kind: 'membership_month', token: 'USDT' });
    const data = (await res.json()) as any;
    expect(data.recipientAddress).toBe(CHAIN_RECIPIENT);
    // 代币匹配不受缺省顶层地址影响
    expect(data.tokenSymbol).toBe('USDT');
    expect(data.amount).toBe('10000000000000000000');
  });
});
