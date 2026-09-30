// 用户侧支付/权益 API（契约 §6 用户侧）。全部 authMiddleware + D1 固定窗口限流。
// 错误码（body {error: code}）：PAYMENTS_DISABLED / CONFIG_INCOMPLETE / NOT_GROUP_OWNER /
// INVALID_TIER / TIER_NOT_UPGRADE / ORDER_NOT_FOUND / ORDER_EXPIRED / TX_ALREADY_CLAIMED / RATE_LIMITED。

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import type { PaymentOrderRow } from '../db/schema';
import { authMiddleware } from '../middleware/auth';
import { allow } from '../services/rateLimit';
import {
  applyChainPriceOverride,
  computeQuote,
  getActiveConfig,
  isMemberWallet,
  isWhitelisted,
  pickChainForToken,
  resolveRecipientAddress,
  type ActiveConfig,
  type PaymentChainConfig,
  type PaymentConfigPayload,
  type QuoteResult,
} from '../services/payments/config';
import { enqueueOutbox, rebuildWalletSnapshot } from '../services/payments/outbox';
import { walletSnapshotKey, getEntitlementBucket } from '../services/payments/storage';
import { verifyAndMaybeGrant } from '../services/payments/flow';
import { grantOrder } from '../services/payments/grant';
import { writeAudit } from '../services/payments/audit';
import { parseJoinPrice } from '../services/clubs';

const paymentRoutes = new Hono<AppEnv>();

paymentRoutes.use('*', authMiddleware);

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const CAPACITY_TIERS = [100, 200, 300, 400, 500];

async function rateLimited(c: any, action: string, perMinute: number): Promise<Response | null> {
  const wallet = c.get('user').id as string;
  if (!(await allow(c.env.DB, action, wallet, perMinute))) {
    return c.json({ error: 'RATE_LIMITED' }, 429);
  }
  return null;
}

async function readBody(c: any): Promise<Record<string, any>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function orderJson(order: PaymentOrderRow): Record<string, unknown> {
  return { ...order };
}

// /payments/quote 与 /payments/quote-preview 共用的报价上下文（不落库）。
interface QuoteContext {
  kind: 'membership_month' | 'membership_year' | 'group_capacity' | 'club_join' | 'feed_post';
  wallet: string;
  active: ActiveConfig;
  config: PaymentConfigPayload;
  chain: PaymentChainConfig;
  whitelisted: boolean;
  quote: QuoteResult;
  durationDays: number | null;
  groupId: string | null;
  ownerAtOrder: string | null;
  fromTier: number | null;
  toTier: number | null;
}

// 加载配置 + 全部校验 + isMember/白名单判定 + computeQuote。
// 返回 { error } 时调用方直接返回该响应；否则返回含冻结字段的上下文。
async function resolveQuoteContext(
  c: any,
  body: Record<string, any>
): Promise<{ error: Response } | { ctx: QuoteContext }> {
  const db: D1Database = c.env.DB;
  const wallet = c.get('user').id;
  const kind = body.kind;
  if (kind !== 'membership_month' && kind !== 'membership_year' && kind !== 'group_capacity' && kind !== 'club_join' && kind !== 'feed_post') {
    return { error: c.json({ error: 'INVALID_KIND' }, 400) };
  }

  const active = await getActiveConfig(db);
  if (!active) return { error: c.json({ error: 'CONFIG_INCOMPLETE' }, 503) };
  const config = active.payload;
  if (!config.paymentsEnabled) return { error: c.json({ error: 'PAYMENTS_DISABLED' }, 503) };
  if ((kind === 'membership_month' || kind === 'membership_year') && !config.membershipEnabled) {
    return { error: c.json({ error: 'PAYMENTS_DISABLED' }, 503) };
  }
  if (!Array.isArray(config.chains) || config.chains.length === 0) {
    return { error: c.json({ error: 'CONFIG_INCOMPLETE' }, 503) };
  }
  // 双代币可选支付：body.token（代币符号，如 "BNB"/"USDT"，大小写不敏感）
  // 匹配 chains[] 里的配置项；不传保持 chains[0] 旧行为。
  // feed_post 的代币由 feedPost 段固定（下方分支覆盖），token 参数不适用。
  const tokenParam = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
  let chain: PaymentChainConfig;
  if (kind !== 'feed_post' && tokenParam) {
    const match = pickChainForToken(config, tokenParam);
    if (!match) return { error: c.json({ error: 'TOKEN_NOT_SUPPORTED' }, 400) };
    chain = match;
  } else {
    chain = config.chains[0];
  }

  // 报价时会员是否有效（扩群折扣依据）；契约 §13：白名单钱包视为永久会员（统一判定收敛于 isMemberWallet）
  const whitelisted = isWhitelisted(config, wallet);
  const isMember = await isMemberWallet(db, wallet);

  let groupId: string | null = null;
  let ownerAtOrder: string | null = null;
  let fromTier: number | null = null;
  let toTier: number | null = null;
  let durationDays: number | null = null;
  let currentTier = 50;
  let quote: QuoteResult;
  // 双代币独立定价：选中链带 prices 段时，报价改用覆盖后的配置副本
  let quoteConfig = applyChainPriceOverride(config, chain);

  if (kind === 'club_join') {
    // 付费进 club：价格取该 club metadata.join_price，不走全局报价配置
    groupId =
      (typeof body.group_id === 'string' && body.group_id) ||
      (typeof body.groupId === 'string' && body.groupId) ||
      null;
    if (!groupId) return { error: c.json({ error: 'INVALID_REQUEST', details: ['group_id is required'] }, 400) };

    const club = await db.prepare("SELECT id, metadata FROM conversations WHERE id = ? AND type = 'club'")
      .bind(groupId)
      .first<{ id: string; metadata: string }>();
    if (!club) return { error: c.json({ error: 'GROUP_NOT_FOUND' }, 404) };

    let metadata: Record<string, any> = {};
    try {
      const parsed = JSON.parse(club.metadata);
      if (parsed && typeof parsed === 'object') metadata = parsed;
    } catch {
      // 非法 metadata 视为无 join_price
    }
    const joinPrice = parseJoinPrice(metadata);
    if (!joinPrice) return { error: c.json({ error: 'JOIN_PRICE_NOT_SET' }, 400) };

    quote = { listAmount: joinPrice.amount, amount: joinPrice.amount, discountBps: 0 };
  } else if (kind === 'feed_post') {
    // 动态发布付费：价格/收款地址/代币取 config.feedPost 段（社区管理
    // 「发表设置」可配），RPC 复用 chains[] 同 chainId 的链配置。
    groupId =
      (typeof body.group_id === 'string' && body.group_id) ||
      (typeof body.groupId === 'string' && body.groupId) ||
      null;
    if (!groupId) return { error: c.json({ error: 'INVALID_REQUEST', details: ['group_id is required'] }, 400) };
    const club = await db.prepare("SELECT id FROM conversations WHERE id = ? AND type = 'club'")
      .bind(groupId)
      .first<{ id: string }>();
    if (!club) return { error: c.json({ error: 'GROUP_NOT_FOUND' }, 404) };
    const feedPost = config.feedPost;
    if (!feedPost?.enabled) return { error: c.json({ error: 'FEED_POST_PAYMENT_DISABLED' }, 503) };
    const match = config.chains.find((item) => item.chainId === feedPost.chainId);
    if (!match) return { error: c.json({ error: 'CONFIG_INCOMPLETE' }, 503) };
    chain = { ...match, recipientAddress: feedPost.recipientAddress, token: feedPost.token };
    quoteConfig = applyChainPriceOverride(config, chain);
    quote = computeQuote(quoteConfig, kind, { isMember });
  } else if (kind === 'group_capacity') {
    groupId = typeof body.groupId === 'string' ? body.groupId : null;
    if (!groupId) return { error: c.json({ error: 'INVALID_REQUEST', details: ['groupId is required'] }, 400) };
    toTier = typeof body.toTier === 'number' ? body.toTier : NaN;
    if (!CAPACITY_TIERS.includes(toTier)) return { error: c.json({ error: 'INVALID_TIER' }, 400) };

    const conv = await db.prepare("SELECT id, owner_address FROM conversations WHERE id = ? AND type IN ('group','club')")
      .bind(groupId)
      .first<{ id: string; owner_address: string | null }>();
    if (!conv) return { error: c.json({ error: 'GROUP_NOT_FOUND' }, 404) };
    const membership = await db.prepare(
      "SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND role = 'owner'"
    )
      .bind(groupId, wallet)
      .first<{ role: string }>();
    if (!membership) return { error: c.json({ error: 'NOT_GROUP_OWNER' }, 403) };
    ownerAtOrder = conv.owner_address;

    const cap = await db.prepare('SELECT capacity_tier FROM group_capacity_entitlements WHERE group_id = ?')
      .bind(groupId)
      .first<{ capacity_tier: number }>();
    currentTier = cap?.capacity_tier ?? 50;
    if (toTier <= currentTier) return { error: c.json({ error: 'TIER_NOT_UPGRADE' }, 400) };
    fromTier = currentTier;
    quote = computeQuote(quoteConfig, kind, { currentTier, toTier, isMember });
  } else {
    durationDays = kind === 'membership_year' ? 365 : 30;
    quote = computeQuote(quoteConfig, kind, { currentTier, toTier: toTier ?? undefined, isMember });
  }

  // 统一收款地址：所有收费场景优先配置顶层 recipientAddress；旧版本配置缺省时
  // 回退（feed_post 回退 feedPost.recipientAddress，其余回退 chains[0].recipientAddress）。
  chain = {
    ...chain,
    recipientAddress: resolveRecipientAddress(config, kind === 'feed_post' ? config.feedPost?.recipientAddress : null),
  };

  if (whitelisted) {
    // 契约 §13：白名单免单——listAmount 保留原价，amount=0，discountBps=10000
    quote.amount = '0';
    quote.discountBps = 10000;
  }

  return { ctx: { kind, wallet, active, config, chain, whitelisted, quote, durationDays, groupId, ownerAtOrder, fromTier, toTier } };
}

// POST /payments/quote — 创建订单（awaiting_payment），冻结价格/链/代币/收款地址/有效期/配置版本
paymentRoutes.post('/payments/quote', async (c) => {
  const limited = await rateLimited(c, 'quote', 20);
  if (limited) return limited;

  const body = await readBody(c);
  const result = await resolveQuoteContext(c, body);
  if ('error' in result) return result.error;
  const { kind, wallet, active, config, chain, whitelisted, quote, durationDays, groupId, ownerAtOrder, fromTier, toTier } =
    result.ctx;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + (config.quoteTtlSeconds ?? 1800) * 1000);
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO payment_orders (
      id, wallet_address, kind, group_id, owner_at_order, from_tier, to_tier, duration_days,
      amount, list_amount, discount_bps, chain_id, token_type, token_address, token_symbol,
      token_decimals, recipient_address, config_version, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?)`
  )
    .bind(
      id,
      wallet,
      kind,
      groupId,
      ownerAtOrder,
      fromTier,
      toTier,
      durationDays,
      quote.amount,
      quote.listAmount,
      quote.discountBps,
      chain.chainId,
      chain.token.type,
      chain.token.type === 'erc20' ? (chain.token.address ?? '').toLowerCase() : null,
      chain.token.symbol,
      chain.token.decimals,
      chain.recipientAddress.toLowerCase(),
      active.version,
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString()
    )
    .run();

  const order = (await c.env.DB.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(id).first<PaymentOrderRow>())!;

  // 契约 §13：白名单免单订单不等待链上付款，直接 verified → grant 完整管线（D1 权益 + outbox + R2）→ active
  let finalOrder = order;
  if (whitelisted) {
    const nowIso = new Date().toISOString();
    await c.env.DB.prepare("UPDATE payment_orders SET status = 'verified', confirmed_at = ?, updated_at = ? WHERE id = ?")
      .bind(nowIso, nowIso, id)
      .run();
    await writeAudit(c.env.DB, 'system', 'whitelist_grant', id, {
      wallet,
      kind,
      groupId,
      reason: 'whitelist_free_order',
      listAmount: quote.listAmount,
    });
    finalOrder = (await grantOrder(c.env.DB, c.env, id)).order;
  }

  return c.json({
    order: orderJson(finalOrder),
    payment: {
      chainId: chain.chainId,
      tokenType: chain.token.type,
      tokenAddress: chain.token.type === 'erc20' ? chain.token.address : null,
      tokenSymbol: chain.token.symbol,
      tokenDecimals: chain.token.decimals,
      recipientAddress: chain.recipientAddress.toLowerCase(),
      amount: quote.amount,
      expiresAt: expiresAt.toISOString(),
      note: whitelisted ? '白名单免单（管理员授权）' : quote.discountBps > 0 ? `会员折扣已生效（-${quote.discountBps / 100}%）` : null,
    },
  });
});

// POST /payments/quote-preview — 纯报价：校验与计算和 /payments/quote 完全一致，
// 但不 INSERT payment_orders、不写 audit、不走 grant 管线（会员中心展示价格用，避免假订单）。
paymentRoutes.post('/payments/quote-preview', async (c) => {
  const limited = await rateLimited(c, 'quote_preview', 60);
  if (limited) return limited;

  const body = await readBody(c);
  const result = await resolveQuoteContext(c, body);
  if ('error' in result) return result.error;
  const { kind, chain, quote, durationDays } = result.ctx;

  return c.json({
    kind,
    amount: quote.amount,
    listAmount: quote.listAmount,
    discountBps: quote.discountBps,
    durationDays,
    chainId: chain.chainId,
    tokenType: chain.token.type,
    tokenAddress: chain.token.type === 'erc20' ? chain.token.address : null,
    tokenSymbol: chain.token.symbol,
    tokenDecimals: chain.token.decimals,
    recipientAddress: chain.recipientAddress.toLowerCase(),
  });
});

// POST /payments/orders/:id/submit — 认领 txHash + submitted + 即时验款（幂等）
paymentRoutes.post('/payments/orders/:id/submit', async (c) => {
  const limited = await rateLimited(c, 'submit', 30);
  if (limited) return limited;

  const wallet = c.get('user').id;
  const order = await c.env.DB.prepare('SELECT * FROM payment_orders WHERE id = ?')
    .bind(c.req.param('id'))
    .first<PaymentOrderRow>();
  if (!order || order.wallet_address !== wallet) return c.json({ error: 'ORDER_NOT_FOUND' }, 404);

  const body = await readBody(c);
  const txHash = typeof body.txHash === 'string' ? body.txHash.toLowerCase() : '';
  if (!TX_HASH_RE.test(txHash)) return c.json({ error: 'INVALID_TX_HASH' }, 400);

  // 幂等：同订单同 tx 重复提交返回当前状态
  if (order.tx_hash === txHash && order.status !== 'awaiting_payment') {
    return c.json({ order: orderJson(order) });
  }
  // 契约 §13：白名单免单订单（无 tx）已发放/发放中，重复提交幂等返回当前状态
  if (order.tx_hash === null && ['verified', 'granting', 'active'].includes(order.status)) {
    return c.json({ order: orderJson(order) });
  }
  if (order.status !== 'awaiting_payment') {
    return c.json({ error: 'INVALID_ORDER_STATE', status: order.status }, 409);
  }
  if (Date.parse(order.expires_at) <= Date.now()) {
    await c.env.DB.prepare("UPDATE payment_orders SET status = 'expired', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), order.id)
      .run();
    return c.json({ error: 'ORDER_EXPIRED' }, 400);
  }

  // 唯一认领（防一 tx 多单）
  const claim = await c.env.DB.prepare(
    'INSERT INTO payment_tx_claims (chain_id, tx_hash, order_id, claimed_at) VALUES (?, ?, ?, ?) ON CONFLICT(chain_id, tx_hash) DO NOTHING'
  )
    .bind(order.chain_id, txHash, order.id, new Date().toISOString())
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    await c.env.DB.prepare("UPDATE payment_orders SET status = 'failed', status_reason = 'tx_already_claimed', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), order.id)
      .run();
    return c.json({ error: 'TX_ALREADY_CLAIMED' }, 409);
  }

  await c.env.DB.prepare("UPDATE payment_orders SET status = 'submitted', tx_hash = ?, updated_at = ? WHERE id = ?")
    .bind(txHash, new Date().toISOString(), order.id)
    .run();

  // 即时验款 + 发放（RPC 故障不阻塞响应，cron 兜底）
  const fresh = (await c.env.DB.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(order.id).first<PaymentOrderRow>())!;
  try {
    const result = await verifyAndMaybeGrant(c.env.DB, c.env, fresh);
    return c.json({ order: orderJson(result?.order ?? fresh) });
  } catch {
    return c.json({ order: orderJson(fresh) });
  }
});

// GET /payments/orders/:id — 仅本人订单
paymentRoutes.get('/payments/orders/:id', async (c) => {
  const limited = await rateLimited(c, 'orders', 60);
  if (limited) return limited;
  const order = await c.env.DB.prepare('SELECT * FROM payment_orders WHERE id = ?')
    .bind(c.req.param('id'))
    .first<PaymentOrderRow>();
  if (!order || order.wallet_address !== c.get('user').id) return c.json({ error: 'ORDER_NOT_FOUND' }, 404);
  return c.json({ order: orderJson(order) });
});

// GET /payments/orders?status=&page=&limit= — 本人订单分页（倒序）
paymentRoutes.get('/payments/orders', async (c) => {
  const limited = await rateLimited(c, 'orders', 60);
  if (limited) return limited;
  const wallet = c.get('user').id;
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));
  const status = c.req.query('status');
  const clauses = ['wallet_address = ?'];
  const params: unknown[] = [wallet];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM payment_orders ${where}`).bind(...params).first<{ n: number }>())
      ?.n ?? 0;
  const rows = await c.env.DB.prepare(
    `SELECT * FROM payment_orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, (page - 1) * limit)
    .all<PaymentOrderRow>();
  return c.json({ orders: rows.results.map(orderJson), total, page, limit });
});

// GET /entitlements/me — 读 R2 钱包快照；miss 时从 D1 重建并回写 outbox
paymentRoutes.get('/entitlements/me', async (c) => {
  const limited = await rateLimited(c, 'entitlements', 60);
  if (limited) return limited;
  const wallet = c.get('user').id;
  const key = walletSnapshotKey(wallet);
  const cached = await getEntitlementBucket(c.env).get(key);
  if (cached) {
    try {
      return c.json(JSON.parse(await cached.text()));
    } catch {
      // 快照损坏 → 走重建
    }
  }
  const snapshot = await rebuildWalletSnapshot(c.env.DB, wallet);
  await enqueueOutbox(c.env.DB, 'wallet_snapshot', wallet, snapshot);
  return c.json(snapshot);
});

// GET /groups/:id/capacity — 成员可读容量信息（展示用价格）
paymentRoutes.get('/groups/:id/capacity', async (c) => {
  const limited = await rateLimited(c, 'entitlements', 60);
  if (limited) return limited;
  const wallet = c.get('user').id;
  const groupId = c.req.param('id');

  const member = await c.env.DB.prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(groupId, wallet)
    .first<{ role: string }>();
  if (!member) return c.json({ error: 'FORBIDDEN' }, 403);

  const memberCount =
    (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?')
      .bind(groupId)
      .first<{ n: number }>())?.n ?? 0;
  const cap = await c.env.DB.prepare('SELECT capacity_tier FROM group_capacity_entitlements WHERE group_id = ?')
    .bind(groupId)
    .first<{ capacity_tier: number }>();
  const capacity = cap?.capacity_tier ?? 50;

  const active = await getActiveConfig(c.env.DB);
  const config = active?.payload ?? null;
  const tiers = (config?.capacityTiers ?? []).map((t) => ({ tier: t.tier, price: t.price }));
  const next = tiers.find((t) => t.tier > capacity)?.tier ?? null;

  const whitelisted = isWhitelisted(config, wallet);
  const isMember = await isMemberWallet(c.env.DB, wallet);

  let payableForNextTier: { amount: string; listAmount: string; discountBps: number } | null = null;
  if (config && next !== null) {
    const quote = computeQuote(config, 'group_capacity', { currentTier: capacity, toTier: next, isMember });
    // 契约 §13：白名单钱包下一档应付 0（与 quote 免单一致）
    payableForNextTier = whitelisted
      ? { amount: '0', listAmount: quote.listAmount, discountBps: 10000 }
      : { amount: quote.amount, listAmount: quote.listAmount, discountBps: quote.discountBps };
  }

  return c.json({
    groupId,
    memberCount,
    capacity,
    tier: capacity,
    nextTier: next,
    tiers,
    memberDiscountBps: config?.memberDiscountBps ?? null,
    payableForNextTier,
  });
});

export { paymentRoutes };
