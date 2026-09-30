// 支付配置服务（契约 §3）：append-only 配置版本、payload 校验、报价计算、会员到期计算。
// 所有金额计算使用 BigInt，禁止浮点。

import type { PaymentConfigVersionRow, WalletEntitlementRow } from '../../db/schema';
import type { PaymentOrderKind } from '../../db/schema';

export interface MembershipPlanConfig {
  price: string;
  durationDays: number;
}

export interface CapacityTierConfig {
  tier: number;
  price: string;
}

export interface PaymentChainTokenConfig {
  type: 'native' | 'erc20';
  symbol: string;
  decimals: number;
  address: string | null;
}

// 链级独立定价（双代币可选支付）：该 chains[] 项被选中报价时覆盖全局
// membership/capacityTiers 价格（durationDays 仍固定 30/365）。
export interface PaymentChainPriceConfig {
  membership: {
    monthly: { price: string };
    yearly: { price: string };
  };
  capacityTiers: CapacityTierConfig[];
}

export interface PaymentChainConfig {
  chainId: number;
  rpcUrls: string[];
  confirmations: number;
  recipientAddress: string;
  token: PaymentChainTokenConfig;
  // 可选：该代币独立定价（同一条链可配多项，如 BNB native + USDT erc20 各自定价）
  prices?: PaymentChainPriceConfig;
}

export interface PaymentConfigPayload {
  schemaVersion: number;
  membershipEnabled: boolean;
  paymentsEnabled: boolean;
  // 统一唯一收款地址：会员/扩群/付费进群/动态发布费全部用它。
  // 新配置必填（validateConfigPayload 校验）；旧版本配置可能缺省，
  // 报价侧用 resolveRecipientAddress 回退 chains[0].recipientAddress
  // （feed_post 回退 feedPost.recipientAddress），存量配置不炸。
  recipientAddress?: string;
  membership: {
    monthly: MembershipPlanConfig;
    yearly: MembershipPlanConfig;
  };
  capacityTiers: CapacityTierConfig[];
  memberDiscountBps: number;
  quoteTtlSeconds: number;
  chains: PaymentChainConfig[];
  // 契约 §13：白名单钱包（管理员开放全部功能）；saveConfig 归一化为小写去重
  whitelistWallets?: string[];
  // 动态发布付费（0023，可选段）：全员可发动态，每用户每社群免费
  // freeQuota 条，超出后每条按 price 支付（kind='feed_post'）。
  // chainId 必须存在于 chains[]（验款复用该链 RPC 与代币定义）。
  feedPost?: {
    enabled: boolean;
    price: string;
    freeQuota: number;
    chainId: number;
    recipientAddress: string;
    token: { type: 'native' | 'erc20'; symbol: string; decimals: number; address: string | null };
  };
}

export interface ActiveConfig {
  version: number;
  payload: PaymentConfigPayload;
}

export interface QuoteResult {
  listAmount: string;
  amount: string;
  discountBps: number;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NON_NEG_INT_RE = /^(0|[1-9]\d*)$/;
const REQUIRED_TIERS = [100, 200, 300, 400, 500];
const FREE_TIER = 50;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonNegIntString(v: unknown): v is string {
  return typeof v === 'string' && NON_NEG_INT_RE.test(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

// 契约 §3 校验规则；返回错误列表（空数组 = 通过）。
export function validateConfigPayload(p: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(p)) return ['payload must be an object'];

  if ('schemaVersion' in p && p.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1');
  }
  for (const flag of ['membershipEnabled', 'paymentsEnabled'] as const) {
    if (flag in p && typeof p[flag] !== 'boolean') {
      errors.push(`${flag} must be a boolean`);
    }
  }

  // membership 月/年：价格非负整数字符串，durationDays 固定 30/365
  const membership = p.membership;
  if (!isRecord(membership)) {
    errors.push('membership is required');
  } else {
    const plans: Array<[string, unknown, number]> = [
      ['monthly', membership.monthly, 30],
      ['yearly', membership.yearly, 365],
    ];
    for (const [name, plan, expectedDays] of plans) {
      if (!isRecord(plan)) {
        errors.push(`membership.${name} is required`);
        continue;
      }
      if (!isNonNegIntString(plan.price)) {
        errors.push(`membership.${name}.price must be a non-negative integer decimal string`);
      }
      if (plan.durationDays !== expectedDays) {
        errors.push(`membership.${name}.durationDays must be ${expectedDays}`);
      }
    }
  }

  // capacityTiers 恰好 100/200/300/400/500，价格随档单调不减
  const tiers = p.capacityTiers;
  if (!Array.isArray(tiers) || tiers.length !== REQUIRED_TIERS.length) {
    errors.push('capacityTiers must contain exactly 5 tiers (100/200/300/400/500)');
  } else {
    let prevPrice: bigint | null = null;
    tiers.forEach((tier, i) => {
      if (!isRecord(tier)) {
        errors.push(`capacityTiers[${i}] must be an object`);
        return;
      }
      if (tier.tier !== REQUIRED_TIERS[i]) {
        errors.push(`capacityTiers[${i}].tier must be ${REQUIRED_TIERS[i]}`);
      }
      if (!isNonNegIntString(tier.price)) {
        errors.push(`capacityTiers[${i}].price must be a non-negative integer decimal string`);
        return;
      }
      const price = BigInt(tier.price);
      if (prevPrice !== null && price < prevPrice) {
        errors.push('capacityTiers prices must be monotonically non-decreasing');
      }
      prevPrice = price;
    });
  }

  if (!isInt(p.memberDiscountBps) || p.memberDiscountBps < 0 || p.memberDiscountBps > 10000) {
    errors.push('memberDiscountBps must be an integer in 0..10000');
  }

  if ('quoteTtlSeconds' in p && (!isInt(p.quoteTtlSeconds) || p.quoteTtlSeconds <= 0)) {
    errors.push('quoteTtlSeconds must be a positive integer');
  }

  // 统一唯一收款地址：新配置必填（旧版本配置不经过校验，报价侧有回退）
  if (typeof p.recipientAddress !== 'string' || !EVM_ADDRESS_RE.test(p.recipientAddress)) {
    errors.push('recipientAddress must be a valid EVM address');
  }

  // chains：允许空数组（报价时按 CONFIG_INCOMPLETE 拒绝），但每条必须合法
  const chains = p.chains;
  if (!Array.isArray(chains)) {
    errors.push('chains must be an array');
  } else {
    chains.forEach((chain, i) => {
      if (!isRecord(chain)) {
        errors.push(`chains[${i}] must be an object`);
        return;
      }
      if (!isInt(chain.chainId) || chain.chainId <= 0) {
        errors.push(`chains[${i}].chainId must be a positive integer`);
      }
      if (!Array.isArray(chain.rpcUrls) || chain.rpcUrls.length < 1) {
        errors.push(`chains[${i}].rpcUrls must contain at least 1 url`);
      } else if (chain.rpcUrls.some((u) => typeof u !== 'string' || !u.startsWith('https://'))) {
        errors.push(`chains[${i}].rpcUrls must all be https urls`);
      }
      if (!isInt(chain.confirmations) || chain.confirmations < 1 || chain.confirmations > 200) {
        errors.push(`chains[${i}].confirmations must be an integer in 1..200`);
      }
      if (typeof chain.recipientAddress !== 'string' || !EVM_ADDRESS_RE.test(chain.recipientAddress)) {
        errors.push(`chains[${i}].recipientAddress must be a valid EVM address`);
      }
      const token = chain.token;
      if (!isRecord(token)) {
        errors.push(`chains[${i}].token is required`);
      } else {
        if (token.type !== 'native' && token.type !== 'erc20') {
          errors.push(`chains[${i}].token.type must be native or erc20`);
        }
        if (token.type === 'erc20') {
          if (typeof token.address !== 'string' || !EVM_ADDRESS_RE.test(token.address)) {
            errors.push(`chains[${i}].token.address must be a valid EVM address for erc20`);
          }
        }
        if (!isInt(token.decimals) || token.decimals < 0 || token.decimals > 36) {
          errors.push(`chains[${i}].token.decimals must be an integer in 0..36`);
        }
      }
      // 链级独立定价（可选段）：存在时会员月/年价格必填，capacityTiers
      // 必须恰好 100/200/300/400/500 且单调不减（同全局规则）
      const prices = chain.prices;
      if (prices !== undefined) {
        if (!isRecord(prices)) {
          errors.push(`chains[${i}].prices must be an object`);
        } else {
          const pm = prices.membership;
          if (!isRecord(pm)) {
            errors.push(`chains[${i}].prices.membership is required`);
          } else {
            for (const name of ['monthly', 'yearly'] as const) {
              const plan = pm[name];
              if (!isRecord(plan) || !isNonNegIntString(plan.price)) {
                errors.push(`chains[${i}].prices.membership.${name}.price must be a non-negative integer decimal string`);
              }
            }
          }
          const pt = prices.capacityTiers;
          if (!Array.isArray(pt) || pt.length !== REQUIRED_TIERS.length) {
            errors.push(`chains[${i}].prices.capacityTiers must contain exactly 5 tiers (100/200/300/400/500)`);
          } else {
            let prevPrice: bigint | null = null;
            pt.forEach((tier, j) => {
              if (!isRecord(tier)) {
                errors.push(`chains[${i}].prices.capacityTiers[${j}] must be an object`);
                return;
              }
              if (tier.tier !== REQUIRED_TIERS[j]) {
                errors.push(`chains[${i}].prices.capacityTiers[${j}].tier must be ${REQUIRED_TIERS[j]}`);
              }
              if (!isNonNegIntString(tier.price)) {
                errors.push(`chains[${i}].prices.capacityTiers[${j}].price must be a non-negative integer decimal string`);
                return;
              }
              const price = BigInt(tier.price);
              if (prevPrice !== null && price < prevPrice) {
                errors.push(`chains[${i}].prices.capacityTiers prices must be monotonically non-decreasing`);
              }
              prevPrice = price;
            });
          }
        }
      }
    });
  }

  // 契约 §13：whitelistWallets 可选数组，每项必须 0x+40hex（大小写均可，saveConfig 统一小写去重）
  const whitelist = p.whitelistWallets;
  if (whitelist !== undefined) {
    if (!Array.isArray(whitelist)) {
      errors.push('whitelistWallets must be an array');
    } else {
      whitelist.forEach((addr, i) => {
        if (typeof addr !== 'string' || !EVM_ADDRESS_RE.test(addr)) {
          errors.push(`whitelistWallets[${i}] must be a valid EVM address`);
        }
      });
    }
  }

  // 动态发布付费（可选段）：chainId 必须存在于 chains[]（验款复用 RPC）
  const feedPost = p.feedPost;
  if (feedPost !== undefined) {
    if (!isRecord(feedPost)) {
      errors.push('feedPost must be an object');
    } else {
      if (typeof feedPost.enabled !== 'boolean') {
        errors.push('feedPost.enabled must be a boolean');
      }
      if (!isNonNegIntString(feedPost.price)) {
        errors.push('feedPost.price must be a non-negative integer decimal string');
      }
      if (!isInt(feedPost.freeQuota) || feedPost.freeQuota < 0) {
        errors.push('feedPost.freeQuota must be a non-negative integer');
      }
      if (!isInt(feedPost.chainId) || feedPost.chainId <= 0) {
        errors.push('feedPost.chainId must be a positive integer');
      } else if (
        Array.isArray(chains) &&
        !chains.some((chain) => isRecord(chain) && chain.chainId === feedPost.chainId)
      ) {
        errors.push('feedPost.chainId must exist in chains[]');
      }
      if (typeof feedPost.recipientAddress !== 'string' || !EVM_ADDRESS_RE.test(feedPost.recipientAddress)) {
        errors.push('feedPost.recipientAddress must be a valid EVM address');
      }
      const token = feedPost.token;
      if (!isRecord(token)) {
        errors.push('feedPost.token is required');
      } else {
        if (token.type !== 'native' && token.type !== 'erc20') {
          errors.push('feedPost.token.type must be native or erc20');
        }
        if (token.type === 'erc20') {
          if (typeof token.address !== 'string' || !EVM_ADDRESS_RE.test(token.address)) {
            errors.push('feedPost.token.address must be a valid EVM address for erc20');
          }
        }
        if (!isInt(token.decimals) || token.decimals < 0 || token.decimals > 36) {
          errors.push('feedPost.token.decimals must be an integer in 0..36');
        }
      }
    }
  }

  return errors;
}

// 契约 §13：白名单归一化（小写 + 去重），saveConfig 落库前调用
export function normalizeWhitelist(wallets: string[] | undefined): string[] {
  if (!Array.isArray(wallets)) return [];
  return [...new Set(wallets.map((w) => w.toLowerCase()))];
}

// 契约 §13：白名单判定（大小写不敏感）
export function isWhitelisted(payload: PaymentConfigPayload | null | undefined, wallet: string): boolean {
  if (!payload?.whitelistWallets) return false;
  const lower = wallet.toLowerCase();
  return payload.whitelistWallets.some((w) => w.toLowerCase() === lower);
}

// 会员有效性统一判定（契约 §13：白名单视为永久会员；否则 wallet_entitlements 未到期）。
// club 创建门禁与 payments 报价/折扣共用，避免内联复制漂移。
export async function isMemberWallet(db: D1Database, wallet: string): Promise<boolean> {
  const active = await getActiveConfig(db);
  if (isWhitelisted(active?.payload, wallet)) return true;
  const ent = await db
    .prepare('SELECT membership_tier, membership_expires_at FROM wallet_entitlements WHERE wallet_address = ?')
    .bind(wallet.toLowerCase())
    .first<Pick<WalletEntitlementRow, 'membership_tier' | 'membership_expires_at'>>();
  return !!ent?.membership_tier && !!ent.membership_expires_at && Date.parse(ent.membership_expires_at) > Date.now();
}

// 统一收款地址：优先顶层 recipientAddress；旧版本配置缺省时回退
// fallback（feed_post 场景传 feedPost.recipientAddress），再退 chains[0].recipientAddress。
export function resolveRecipientAddress(config: PaymentConfigPayload, fallback?: string | null): string {
  return config.recipientAddress ?? fallback ?? config.chains[0]?.recipientAddress ?? '';
}

// 双代币报价：按代币符号（大小写不敏感）匹配 chains[] 配置项；
// token 为空返回 chains[0]（旧行为）；传了但无匹配返回 null（路由转 TOKEN_NOT_SUPPORTED）。
export function pickChainForToken(config: PaymentConfigPayload, token?: string | null): PaymentChainConfig | null {
  if (config.chains.length === 0) return null;
  const symbol = token?.trim().toLowerCase();
  if (!symbol) return config.chains[0];
  return config.chains.find((c) => c.token.symbol.toLowerCase() === symbol) ?? null;
}

// 链级独立定价：选中链带 prices 段时，返回覆盖 membership/capacityTiers 后的
// 配置副本供 computeQuote 使用（durationDays 固定 30/365；feedPost 段不受影响）。
export function applyChainPriceOverride(config: PaymentConfigPayload, chain: PaymentChainConfig): PaymentConfigPayload {
  if (!chain.prices) return config;
  return {
    ...config,
    membership: {
      monthly: { price: chain.prices.membership.monthly.price, durationDays: 30 },
      yearly: { price: chain.prices.membership.yearly.price, durationDays: 365 },
    },
    capacityTiers: chain.prices.capacityTiers,
  };
}

// 白名单钱包的永久会员哨兵（契约 §13；客户端 expiresAt 年份 ≥ 9999 显示「永久（管理员授权）」）
export const WHITELIST_MEMBERSHIP = {
  tier: 'year',
  expiresAt: '9999-12-31T23:59:59.000Z',
  active: true,
} as const;

export async function getActiveConfig(db: D1Database): Promise<ActiveConfig | null> {
  const row = await db
    .prepare('SELECT * FROM payment_config_versions WHERE is_active = 1 ORDER BY version DESC LIMIT 1')
    .first<PaymentConfigVersionRow>();
  if (!row) return null;
  return { version: row.version, payload: JSON.parse(row.payload_json) as PaymentConfigPayload };
}

// 验款/发放必须使用订单冻结的 config_version，不用当前 active 配置（契约 §5）
export async function getConfigByVersion(db: D1Database, version: number): Promise<PaymentConfigPayload | null> {
  const row = await db
    .prepare('SELECT payload_json FROM payment_config_versions WHERE version = ?')
    .bind(version)
    .first<Pick<PaymentConfigVersionRow, 'payload_json'>>();
  if (!row) return null;
  return JSON.parse(row.payload_json) as PaymentConfigPayload;
}

function flatten(value: unknown, prefix: string, out: Record<string, unknown>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out[prefix] = [];
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) out[prefix] = {};
    for (const [key, v] of entries) flatten(v, prefix ? `${prefix}.${key}` : key, out);
    return;
  }
  out[prefix] = value;
}

// 字段级 diff：{ 'membership.monthly.price': { from, to }, ... }；新增字段无 from，删除字段无 to。
export function diffPayloads(prev: unknown, next: unknown): Record<string, { from?: unknown; to?: unknown }> {
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  flatten(prev, '', a);
  flatten(next, '', b);
  const diff: Record<string, { from?: unknown; to?: unknown }> = {};
  for (const key of Object.keys(a)) {
    if (!(key in b)) {
      diff[key] = { from: a[key] };
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diff[key] = { from: a[key], to: b[key] };
    }
  }
  for (const key of Object.keys(b)) {
    if (!(key in a)) diff[key] = { to: b[key] };
  }
  return diff;
}

// 保存新版本：version = 上一版 + 1，同事务置 active（旧版本 is_active=0），写字段级 diff。
// whitelistWallets 落库前归一化（小写去重，契约 §13）。
export async function saveConfig(
  db: D1Database,
  payload: PaymentConfigPayload,
  createdBy: string
): Promise<{ version: number; changeSummary: string | null }> {
  const normalized: PaymentConfigPayload = {
    ...payload,
    whitelistWallets: normalizeWhitelist(payload.whitelistWallets),
  };
  const prev = await db
    .prepare('SELECT * FROM payment_config_versions ORDER BY version DESC LIMIT 1')
    .first<PaymentConfigVersionRow>();
  const version = (prev?.version ?? 0) + 1;
  const changeSummary = prev ? JSON.stringify(diffPayloads(JSON.parse(prev.payload_json), normalized)) : null;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE payment_config_versions SET is_active = 0 WHERE is_active = 1'),
    db
      .prepare(
        'INSERT INTO payment_config_versions (version, payload_json, change_summary, created_by, created_at, is_active) VALUES (?, ?, ?, ?, ?, 1)'
      )
      .bind(version, JSON.stringify(normalized), changeSummary, createdBy, now),
  ]);
  return { version, changeSummary };
}

function tierPrice(config: PaymentConfigPayload, tier: number): bigint {
  if (tier === FREE_TIER) return 0n;
  const found = config.capacityTiers.find((t) => t.tier === tier);
  if (!found) throw new Error('INVALID_TIER');
  return BigInt(found.price);
}

// 纯报价函数（契约 §0/§3）：
// - 会员月/年：amount = listAmount = 配置价，无折扣；
// - 扩群：差价 = P(目标档) − P(当前已购档)（免费 50 档 P=0，差价 clamp 到 0）；
//   会员折扣 ceil(diff * (10000 - bps) / 10000)，BigInt 向上取整。
export function computeQuote(
  config: PaymentConfigPayload,
  kind: PaymentOrderKind,
  opts: { currentTier?: number; toTier?: number; isMember?: boolean } = {}
): QuoteResult {
  if (kind === 'membership_month') {
    return { listAmount: config.membership.monthly.price, amount: config.membership.monthly.price, discountBps: 0 };
  }
  if (kind === 'membership_year') {
    return { listAmount: config.membership.yearly.price, amount: config.membership.yearly.price, discountBps: 0 };
  }
  // 动态发布付费：固定配置价，无折扣无差价语义。
  if (kind === 'feed_post') {
    if (!config.feedPost?.enabled) throw new Error('FEED_POST_PAYMENT_DISABLED');
    return {
      listAmount: config.feedPost.price,
      amount: config.feedPost.price,
      discountBps: 0,
    };
  }
  if (opts.toTier === undefined) throw new Error('INVALID_TIER');
  const diff = tierPrice(config, opts.toTier) - tierPrice(config, opts.currentTier ?? FREE_TIER);
  const listAmount = diff > 0n ? diff : 0n;
  const bps = opts.isMember ? config.memberDiscountBps : 0;
  const amount = (listAmount * BigInt(10000 - bps) + 9999n) / 10000n;
  return { listAmount: listAmount.toString(), amount: amount.toString(), discountBps: bps };
}

// 会员到期：从 max(now, 当前到期) 顺延 durationDays 天（UTC，ISO 字符串）。
export function computeMembershipExpiry(
  nowIso: string,
  currentExpiresAtIso: string | null,
  durationDays: number
): string {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error('invalid nowIso');
  const currentMs = currentExpiresAtIso ? Date.parse(currentExpiresAtIso) : NaN;
  const baseMs = Number.isFinite(currentMs) && currentMs > nowMs ? currentMs : nowMs;
  return new Date(baseMs + durationDays * 86_400_000).toISOString();
}
