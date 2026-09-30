import { describe, it, expect, beforeEach } from 'vitest';
import { createMockD1Database } from './helpers/db';
import {
  computeMembershipExpiry,
  computeQuote,
  diffPayloads,
  getActiveConfig,
  saveConfig,
  validateConfigPayload,
  type PaymentConfigPayload,
} from '../src/services/payments/config';

function validPayload(): PaymentConfigPayload {
  return {
    schemaVersion: 1,
    membershipEnabled: true,
    paymentsEnabled: true,
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
    recipientAddress: '0x1111111111111111111111111111111111111111',
    chains: [
      {
        chainId: 56,
        rpcUrls: ['https://bsc-mainnet.nodereal.io/v1/abc'],
        confirmations: 12,
        recipientAddress: '0x1111111111111111111111111111111111111111',
        token: { type: 'native', symbol: 'BNB', decimals: 18, address: null },
      },
    ],
  };
}

describe('validateConfigPayload', () => {
  it('accepts a valid payload', () => {
    expect(validateConfigPayload(validPayload())).toEqual([]);
  });

  it('rejects non-object payloads', () => {
    expect(validateConfigPayload(null).length).toBeGreaterThan(0);
    expect(validateConfigPayload('x').length).toBeGreaterThan(0);
  });

  it('rejects bad recipient address', () => {
    const p = validPayload();
    p.chains[0].recipientAddress = '0x1234';
    expect(validateConfigPayload(p).some((e) => e.includes('recipientAddress'))).toBe(true);
  });

  it('rejects missing capacity tiers', () => {
    const p = validPayload();
    p.capacityTiers = p.capacityTiers.slice(0, 4);
    expect(validateConfigPayload(p).some((e) => e.includes('capacityTiers'))).toBe(true);
  });

  it('rejects wrong tier values and non-monotonic prices', () => {
    const p = validPayload();
    p.capacityTiers[4].tier = 600;
    expect(validateConfigPayload(p).some((e) => e.includes('tier'))).toBe(true);

    const p2 = validPayload();
    p2.capacityTiers[2].price = '10000000000000000000'; // 300 档低于 200 档
    expect(validateConfigPayload(p2).some((e) => e.includes('monotonically'))).toBe(true);
  });

  it('rejects memberDiscountBps out of range or non-integer', () => {
    const p = validPayload();
    p.memberDiscountBps = 10001;
    expect(validateConfigPayload(p).some((e) => e.includes('memberDiscountBps'))).toBe(true);

    const p2 = validPayload();
    (p2 as any).memberDiscountBps = 1.5;
    expect(validateConfigPayload(p2).some((e) => e.includes('memberDiscountBps'))).toBe(true);
  });

  it('rejects non-integer or negative price strings', () => {
    const p = validPayload();
    p.membership.monthly.price = '1.5';
    expect(validateConfigPayload(p).some((e) => e.includes('monthly.price'))).toBe(true);

    const p2 = validPayload();
    p2.capacityTiers[0].price = '-5';
    expect(validateConfigPayload(p2).some((e) => e.includes('capacityTiers[0].price'))).toBe(true);
  });

  it('rejects bad durationDays', () => {
    const p = validPayload();
    (p.membership.monthly as any).durationDays = 31;
    expect(validateConfigPayload(p).some((e) => e.includes('durationDays'))).toBe(true);
  });

  it('rejects erc20 token without valid address and bad decimals', () => {
    const p = validPayload();
    p.chains[0].token = { type: 'erc20', symbol: 'USDT', decimals: 18, address: null };
    expect(validateConfigPayload(p).some((e) => e.includes('token.address'))).toBe(true);

    const p2 = validPayload();
    p2.chains[0].token = { type: 'erc20', symbol: 'USDT', decimals: 37, address: '0x2222222222222222222222222222222222222222' };
    expect(validateConfigPayload(p2).some((e) => e.includes('decimals'))).toBe(true);
  });

  it('rejects missing or invalid top-level recipientAddress', () => {
    const p = validPayload();
    delete (p as any).recipientAddress;
    expect(validateConfigPayload(p).some((e) => e.includes('recipientAddress'))).toBe(true);

    const p2 = validPayload();
    p2.recipientAddress = '0x1234';
    expect(validateConfigPayload(p2).some((e) => e.includes('recipientAddress'))).toBe(true);
  });

  it('accepts per-chain prices override and validates it', () => {
    const p = validPayload();
    p.chains.push({
      chainId: 56,
      rpcUrls: ['https://bsc.publicnode.com'],
      confirmations: 12,
      recipientAddress: '0x1111111111111111111111111111111111111111',
      token: { type: 'erc20', symbol: 'USDT', decimals: 18, address: '0x2222222222222222222222222222222222222222' },
      prices: {
        membership: { monthly: { price: '5000000' }, yearly: { price: '50000000' } },
        capacityTiers: [
          { tier: 100, price: '10000000' },
          { tier: 200, price: '25000000' },
          { tier: 300, price: '45000000' },
          { tier: 400, price: '70000000' },
          { tier: 500, price: '100000000' },
        ],
      },
    });
    expect(validateConfigPayload(p)).toEqual([]);

    const bad = validPayload();
    bad.chains[0].prices = {
      membership: { monthly: { price: '1.5' }, yearly: { price: '5' } },
      capacityTiers: [
        { tier: 100, price: '1' },
        { tier: 200, price: '2' },
        { tier: 300, price: '3' },
        { tier: 400, price: '4' },
        { tier: 500, price: '5' },
      ],
    };
    expect(validateConfigPayload(bad).some((e) => e.includes('prices.membership.monthly.price'))).toBe(true);

    const badTiers = validPayload();
    badTiers.chains[0].prices = {
      membership: { monthly: { price: '1' }, yearly: { price: '5' } },
      capacityTiers: [
        { tier: 100, price: '2' },
        { tier: 200, price: '1' },
        { tier: 300, price: '3' },
        { tier: 400, price: '4' },
        { tier: 500, price: '5' },
      ],
    };
    expect(validateConfigPayload(badTiers).some((e) => e.includes('prices.capacityTiers'))).toBe(true);
  });

  it('rejects bad chain fields', () => {
    const p = validPayload();
    p.chains[0].chainId = -1;
    expect(validateConfigPayload(p).some((e) => e.includes('chainId'))).toBe(true);

    const p2 = validPayload();
    p2.chains[0].rpcUrls = ['http://insecure.example.com'];
    expect(validateConfigPayload(p2).some((e) => e.includes('rpcUrls'))).toBe(true);

    const p3 = validPayload();
    p3.chains[0].rpcUrls = [];
    expect(validateConfigPayload(p3).some((e) => e.includes('rpcUrls'))).toBe(true);

    const p4 = validPayload();
    p4.chains[0].confirmations = 0;
    expect(validateConfigPayload(p4).some((e) => e.includes('confirmations'))).toBe(true);

    const p5 = validPayload();
    p5.chains[0].confirmations = 201;
    expect(validateConfigPayload(p5).some((e) => e.includes('confirmations'))).toBe(true);
  });
});

describe('saveConfig / getActiveConfig', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockD1Database(true);
  });

  it('saves v1 as active with null change_summary', async () => {
    const { version, changeSummary } = await saveConfig(db, validPayload(), 'admin1');
    expect(version).toBe(1);
    expect(changeSummary).toBeNull();

    const active = await getActiveConfig(db);
    expect(active).not.toBeNull();
    expect(active!.version).toBe(1);
    expect(active!.payload.memberDiscountBps).toBe(2000);
  });

  it('increments version, keeps active unique, and records field-level diff', async () => {
    await saveConfig(db, validPayload(), 'admin1');
    const p2 = validPayload();
    p2.memberDiscountBps = 3000;
    p2.membership.monthly.price = '6000000000000000000';
    const { version, changeSummary } = await saveConfig(db, p2, 'admin2');
    expect(version).toBe(2);

    const diff = JSON.parse(changeSummary!) as Record<string, { from?: unknown; to?: unknown }>;
    expect(diff['memberDiscountBps']).toEqual({ from: 2000, to: 3000 });
    expect(diff['membership.monthly.price']).toEqual({ from: '5000000000000000000', to: '6000000000000000000' });
    expect(Object.keys(diff)).toHaveLength(2);

    const activeRows = await db
      .prepare('SELECT COUNT(*) AS n FROM payment_config_versions WHERE is_active = 1')
      .first<{ n: number }>();
    expect(activeRows!.n).toBe(1);
    const active = await getActiveConfig(db);
    expect(active!.version).toBe(2);
    expect(active!.payload.memberDiscountBps).toBe(3000);
  });

  it('returns null when no config exists', async () => {
    expect(await getActiveConfig(db)).toBeNull();
  });
});

describe('diffPayloads', () => {
  it('detects added and removed fields', () => {
    const diff = diffPayloads({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(diff['b']).toEqual({ from: 2 });
    expect(diff['c']).toEqual({ to: 3 });
  });
});

describe('computeQuote', () => {
  const config = validPayload();

  it('prices membership month/year at list price with no discount', () => {
    const month = computeQuote(config, 'membership_month', { isMember: true });
    expect(month).toEqual({ listAmount: '5000000000000000000', amount: '5000000000000000000', discountBps: 0 });
    const year = computeQuote(config, 'membership_year');
    expect(year.amount).toBe('50000000000000000000');
    expect(year.discountBps).toBe(0);
  });

  it('computes diff from the free 50 tier (P=0)', () => {
    const q = computeQuote(config, 'group_capacity', { currentTier: 50, toTier: 100 });
    expect(q.listAmount).toBe('10000000000000000000');
    expect(q.amount).toBe('10000000000000000000');
    expect(q.discountBps).toBe(0);
  });

  it('defaults currentTier to the free 50 tier', () => {
    const q = computeQuote(config, 'group_capacity', { toTier: 200 });
    expect(q.listAmount).toBe('25000000000000000000');
  });

  it('computes cross-tier diff', () => {
    const q = computeQuote(config, 'group_capacity', { currentTier: 100, toTier: 300 });
    expect(q.listAmount).toBe('35000000000000000000'); // 45 - 10
    expect(q.amount).toBe('35000000000000000000');
  });

  it('applies member discount with BigInt ceil', () => {
    const q = computeQuote(config, 'group_capacity', { currentTier: 50, toTier: 100, isMember: true });
    expect(q.discountBps).toBe(2000);
    expect(q.amount).toBe('8000000000000000000'); // 10e18 * 0.8 整除
  });

  it('rounds up at minimal-unit boundaries', () => {
    const tiny: PaymentConfigPayload = {
      ...validPayload(),
      capacityTiers: [
        { tier: 100, price: '1' },
        { tier: 200, price: '2' },
        { tier: 300, price: '3' },
        { tier: 400, price: '4' },
        { tier: 500, price: '5' },
      ],
      memberDiscountBps: 1,
    };
    // diff = 1，bps = 1 → ceil(1 * 9999 / 10000) = 1（不打折到 0）
    const q = computeQuote(tiny, 'group_capacity', { currentTier: 50, toTier: 100, isMember: true });
    expect(q.amount).toBe('1');
    // 非会员无折扣
    const q2 = computeQuote(tiny, 'group_capacity', { currentTier: 50, toTier: 100 });
    expect(q2.amount).toBe('1');
    expect(q2.discountBps).toBe(0);
  });

  it('clamps negative diff to 0', () => {
    const q = computeQuote(config, 'group_capacity', { currentTier: 500, toTier: 100 });
    expect(q.listAmount).toBe('0');
    expect(q.amount).toBe('0');
  });

  it('throws INVALID_TIER for unknown tiers', () => {
    expect(() => computeQuote(config, 'group_capacity', { currentTier: 50, toTier: 150 })).toThrow('INVALID_TIER');
    expect(() => computeQuote(config, 'group_capacity', { currentTier: 150, toTier: 200 })).toThrow('INVALID_TIER');
  });
});

describe('computeMembershipExpiry', () => {
  it('extends from current expiry when still active (续费顺延)', () => {
    const result = computeMembershipExpiry('2026-09-26T00:00:00.000Z', '2026-10-10T00:00:00.000Z', 30);
    expect(result).toBe('2026-11-09T00:00:00.000Z');
  });

  it('starts from now when no current membership', () => {
    const result = computeMembershipExpiry('2026-09-26T12:00:00.000Z', null, 30);
    expect(result).toBe('2026-10-26T12:00:00.000Z');
  });

  it('starts from now when membership already expired', () => {
    const result = computeMembershipExpiry('2026-09-26T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 365);
    expect(result).toBe('2027-09-26T00:00:00.000Z');
  });

  it('handles leap-year February correctly (UTC)', () => {
    // 2028 为闰年：2/28 + 30 天 = 3/29
    expect(computeMembershipExpiry('2028-02-28T00:00:00.000Z', null, 30)).toBe('2028-03-29T00:00:00.000Z');
    // 2027 非闰年：2/28 + 30 天 = 3/30
    expect(computeMembershipExpiry('2027-02-28T00:00:00.000Z', null, 30)).toBe('2027-03-30T00:00:00.000Z');
  });

  it('handles month-end boundaries', () => {
    // 1/31 + 30 天 = 3/2（2026 非闰年 2 月 28 天）
    expect(computeMembershipExpiry('2026-01-31T00:00:00.000Z', null, 30)).toBe('2026-03-02T00:00:00.000Z');
    // 年末跨年
    expect(computeMembershipExpiry('2026-12-15T00:00:00.000Z', null, 30)).toBe('2027-01-14T00:00:00.000Z');
  });
});
