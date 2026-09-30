// Dividend query layer: aggregates indexed D1 data into API payloads.
// USD conversion uses Hyperliquid allMids (same source as the wallet app),
// cached in idx_kv for PRICE_TTL_MS.

import type { Env } from '../../types';
import type { IdxClaimEventRow, IdxFeeDailyRow, IdxPairRow, IdxTokenMetaRow } from '../../db/schema';
import {
  computeAprPercent,
  dayIndexOf,
  normalizeAddr,
  priceOfSymbol,
  rawToUnits,
} from './chain';

const PRICE_TTL_MS = 10 * 60 * 1000;
const PRICE_KV_KEY = 'prices:hyperliquid';
const DEFAULT_HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

export type PriceMap = Record<string, number>;

export async function getPrices(env: Env): Promise<{ prices: PriceMap; updatedAt: number }> {
  const cached = await env.DB.prepare('SELECT value, updated_at FROM idx_kv WHERE key = ?')
    .bind(PRICE_KV_KEY)
    .first<{ value: string; updated_at: number }>();
  const now = Date.now();
  if (cached && now - cached.updated_at < PRICE_TTL_MS) {
    try {
      return { prices: JSON.parse(cached.value) as PriceMap, updatedAt: cached.updated_at };
    } catch {
      // fall through to refetch
    }
  }
  const api = env.HYPERLIQUID_API ?? DEFAULT_HYPERLIQUID_API;
  try {
    const resp = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    });
    if (!resp.ok) throw new Error(`price api ${resp.status}`);
    const data = (await resp.json()) as Record<string, string>;
    const prices: PriceMap = {};
    for (const [k, v] of Object.entries(data)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) prices[k.toUpperCase()] = n;
    }
    if (Object.keys(prices).length > 0) {
      await env.DB.prepare(
        `INSERT INTO idx_kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
        .bind(PRICE_KV_KEY, JSON.stringify(prices), now)
        .run();
      return { prices, updatedAt: now };
    }
  } catch (err) {
    console.warn('dividend stats: price fetch failed', err);
  }
  if (cached) {
    try {
      return { prices: JSON.parse(cached.value) as PriceMap, updatedAt: cached.updated_at };
    } catch {
      // ignore
    }
  }
  return { prices: {}, updatedAt: 0 };
}

interface TokenMeta {
  symbol: string;
  decimals: number;
}

const UNKNOWN_META: TokenMeta = { symbol: 'UNKNOWN', decimals: 18 };

async function loadTokenMeta(db: D1Database, chainId: number): Promise<Map<string, TokenMeta>> {
  const res = await db
    .prepare('SELECT token_address, symbol, decimals FROM idx_token_meta WHERE chain_id = ?')
    .bind(chainId)
    .all<IdxTokenMetaRow>();
  return new Map((res.results ?? []).map((r) => [r.token_address, { symbol: r.symbol, decimals: r.decimals }]));
}

function usdOf(raw: string, meta: TokenMeta, prices: PriceMap): number | null {
  const amount = rawToUnits(raw, meta.decimals);
  if (amount <= 0) return 0;
  const price = priceOfSymbol(prices, meta.symbol);
  if (price <= 0) return null; // unpriced token: cannot contribute USD value
  return amount * price;
}

function tvlUsdOf(row: IdxPairRow, metas: Map<string, TokenMeta>, prices: PriceMap): number | null {
  const m0 = metas.get(row.token0 ?? '') ?? UNKNOWN_META;
  const m1 = metas.get(row.token1 ?? '') ?? UNKNOWN_META;
  const u0 = usdOf(row.reserve0, m0, prices);
  const u1 = usdOf(row.reserve1, m1, prices);
  if (u0 === null && u1 === null) return null;
  return (u0 ?? 0) + (u1 ?? 0);
}

/** Sum indexed fee USD for a pool over [fromDay, toDay] (UTC day indexes). */
async function feeUsdInWindow(
  db: D1Database,
  chainId: number,
  rewardContract: string,
  fromDay: number,
  toDay: number,
  metas: Map<string, TokenMeta>,
  prices: PriceMap
): Promise<{ usd: number; priced: boolean; daysWithFees: number }> {
  const res = await db
    .prepare(
      `SELECT day_index, token_address, fee_amount FROM idx_fee_daily
       WHERE chain_id = ? AND reward_contract = ? AND day_index >= ? AND day_index <= ?`
    )
    .bind(chainId, rewardContract, fromDay, toDay)
    .all<Pick<IdxFeeDailyRow, 'day_index' | 'token_address' | 'fee_amount'>>();
  let usd = 0;
  let priced = false;
  const days = new Set<number>();
  for (const row of res.results ?? []) {
    const meta = metas.get(row.token_address) ?? UNKNOWN_META;
    const part = usdOf(row.fee_amount, meta, prices);
    if (part === null) continue;
    if (part > 0) {
      usd += part;
      priced = true;
      days.add(row.day_index);
    }
  }
  return { usd, priced, daysWithFees: days.size };
}

export interface PairStatsPayload {
  pairAddress: string;
  rewardContract: string;
  nftContract: string | null;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  poolBalance0: string;
  poolBalance1: string;
  totalFees0: string;
  totalFees1: string;
  poolUsd: number | null;
  totalFeesUsd: number | null;
  tvlUsd: number | null;
  nftTotalMinted: number;
  holderCount: number;
  apr7d: number | null;
  apr30d: number | null;
  stateUpdatedAt: number;
}

async function buildPairPayload(
  db: D1Database,
  row: IdxPairRow,
  metas: Map<string, TokenMeta>,
  prices: PriceMap,
  today: number
): Promise<PairStatsPayload> {
  const m0 = metas.get(row.token0 ?? '') ?? UNKNOWN_META;
  const m1 = metas.get(row.token1 ?? '') ?? UNKNOWN_META;
  const pool0 = usdOf(row.pool_balance0, m0, prices);
  const pool1 = usdOf(row.pool_balance1, m1, prices);
  const fees0 = usdOf(row.total_fees0, m0, prices);
  const fees1 = usdOf(row.total_fees1, m1, prices);
  const tvlUsd = tvlUsdOf(row, metas, prices);
  const fee7 = await feeUsdInWindow(db, row.chain_id, row.reward_contract!, today - 6, today, metas, prices);
  const fee30 = await feeUsdInWindow(db, row.chain_id, row.reward_contract!, today - 29, today, metas, prices);
  return {
    pairAddress: row.pair_address,
    rewardContract: row.reward_contract!,
    nftContract: row.nft_contract,
    token0: { address: row.token0 ?? '', symbol: m0.symbol, decimals: m0.decimals },
    token1: { address: row.token1 ?? '', symbol: m1.symbol, decimals: m1.decimals },
    poolBalance0: row.pool_balance0,
    poolBalance1: row.pool_balance1,
    totalFees0: row.total_fees0,
    totalFees1: row.total_fees1,
    poolUsd: pool0 === null && pool1 === null ? null : (pool0 ?? 0) + (pool1 ?? 0),
    totalFeesUsd: fees0 === null && fees1 === null ? null : (fees0 ?? 0) + (fees1 ?? 0),
    tvlUsd,
    nftTotalMinted: row.nft_total_minted,
    holderCount: row.holder_count,
    apr7d: computeAprPercent(fee7.usd, 7, tvlUsd ?? 0),
    apr30d: computeAprPercent(fee30.usd, 30, tvlUsd ?? 0),
    stateUpdatedAt: row.state_updated_at,
  };
}

export interface DividendOverviewPayload {
  chainId: number;
  pairCount: number;
  holderCount: number;
  nftTotalMinted: number;
  totalPoolUsd: number | null;
  totalFeesUsd: number | null;
  pricesUpdatedAt: number;
  syncedBlock: number;
  updatedAt: number;
}

export async function getDividendOverview(env: Env, chainId: number): Promise<DividendOverviewPayload> {
  const { prices, updatedAt: pricesUpdatedAt } = await getPrices(env);
  const metas = await loadTokenMeta(env.DB, chainId);
  const rows = await env.DB.prepare(
    'SELECT * FROM idx_pairs WHERE chain_id = ? AND reward_contract IS NOT NULL'
  )
    .bind(chainId)
    .all<IdxPairRow>();

  const holderRow = await env.DB.prepare(
    'SELECT COUNT(DISTINCT holder) AS c FROM idx_holders WHERE chain_id = ? AND balance > 0'
  )
    .bind(chainId)
    .first<{ c: number }>();

  const syncRow = await env.DB.prepare(
    "SELECT last_block FROM idx_sync_state WHERE chain_id = ? AND scope = 'events'"
  )
    .bind(chainId)
    .first<{ last_block: number }>();

  let poolUsd = 0;
  let feesUsd = 0;
  let poolPriced = false;
  let feesPriced = false;
  let nftMinted = 0;
  let updatedAt = 0;
  for (const row of rows.results ?? []) {
    const m0 = metas.get(row.token0 ?? '') ?? UNKNOWN_META;
    const m1 = metas.get(row.token1 ?? '') ?? UNKNOWN_META;
    for (const [raw, meta, side] of [
      [row.pool_balance0, m0, 'pool'],
      [row.pool_balance1, m1, 'pool'],
      [row.total_fees0, m0, 'fees'],
      [row.total_fees1, m1, 'fees'],
    ] as const) {
      const usd = usdOf(raw, meta, prices);
      if (usd === null) continue;
      if (side === 'pool') {
        poolUsd += usd;
        if (usd > 0) poolPriced = true;
      } else {
        feesUsd += usd;
        if (usd > 0) feesPriced = true;
      }
    }
    nftMinted += row.nft_total_minted;
    if (row.state_updated_at > updatedAt) updatedAt = row.state_updated_at;
  }

  return {
    chainId,
    pairCount: rows.results?.length ?? 0,
    holderCount: holderRow?.c ?? 0,
    nftTotalMinted: nftMinted,
    totalPoolUsd: poolPriced ? poolUsd : null,
    totalFeesUsd: feesPriced ? feesUsd : null,
    pricesUpdatedAt,
    syncedBlock: syncRow?.last_block ?? 0,
    updatedAt,
  };
}

export async function listDividendPairs(
  env: Env,
  chainId: number
): Promise<{ pairs: PairStatsPayload[]; pricesUpdatedAt: number }> {
  const { prices, updatedAt } = await getPrices(env);
  const metas = await loadTokenMeta(env.DB, chainId);
  const rows = await env.DB.prepare(
    'SELECT * FROM idx_pairs WHERE chain_id = ? AND reward_contract IS NOT NULL ORDER BY created_at ASC'
  )
    .bind(chainId)
    .all<IdxPairRow>();
  const today = dayIndexOf(Math.floor(Date.now() / 1000));
  const pairs: PairStatsPayload[] = [];
  for (const row of rows.results ?? []) {
    pairs.push(await buildPairPayload(env.DB, row, metas, prices, today));
  }
  return { pairs, pricesUpdatedAt: updatedAt };
}

export async function getPairAprDetail(env: Env, chainId: number, pairAddress: string) {
  const pair = normalizeAddr(pairAddress);
  const row = await env.DB.prepare(
    'SELECT * FROM idx_pairs WHERE chain_id = ? AND pair_address = ? AND reward_contract IS NOT NULL'
  )
    .bind(chainId, pair)
    .first<IdxPairRow>();
  if (!row) return null;
  const { prices, updatedAt } = await getPrices(env);
  const metas = await loadTokenMeta(env.DB, chainId);
  const today = dayIndexOf(Math.floor(Date.now() / 1000));
  const payload = await buildPairPayload(env.DB, row, metas, prices, today);

  const dailyRows = await env.DB.prepare(
    `SELECT day_index, token_address, fee_amount FROM idx_fee_daily
     WHERE chain_id = ? AND reward_contract = ? AND day_index >= ?
     ORDER BY day_index ASC`
  )
    .bind(chainId, row.reward_contract!, today - 29)
    .all<Pick<IdxFeeDailyRow, 'day_index' | 'token_address' | 'fee_amount'>>();
  const byDay = new Map<number, { feesUsd: number; priced: boolean; tokens: Record<string, string> }>();
  for (const r of dailyRows.results ?? []) {
    const meta = metas.get(r.token_address) ?? UNKNOWN_META;
    const entry = byDay.get(r.day_index) ?? { feesUsd: 0, priced: false, tokens: {} };
    entry.tokens[r.token_address] = r.fee_amount;
    const usd = usdOf(r.fee_amount, meta, prices);
    if (usd !== null && usd > 0) {
      entry.feesUsd += usd;
      entry.priced = true;
    }
    byDay.set(r.day_index, entry);
  }
  const daily = [...byDay.entries()].map(([dayIndex, v]) => ({
    dayIndex,
    date: new Date(dayIndex * 86400 * 1000).toISOString().slice(0, 10),
    feesUsd: v.priced ? v.feesUsd : null,
    tokens: v.tokens,
  }));

  return { ...payload, daily, pricesUpdatedAt: updatedAt };
}

export interface ClaimListOptions {
  pair?: string;
  limit?: number;
  beforeBlock?: number;
}

export async function getClaimsForAddress(env: Env, chainId: number, address: string, opts: ClaimListOptions) {
  const user = normalizeAddr(address);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const clauses = ['chain_id = ?', 'user_address = ?'];
  const params: (string | number)[] = [chainId, user];
  if (opts.pair) {
    clauses.push('pair_address = ?');
    params.push(normalizeAddr(opts.pair));
  }
  if (opts.beforeBlock !== undefined && opts.beforeBlock > 0) {
    clauses.push('block_number < ?');
    params.push(opts.beforeBlock);
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM idx_claim_events WHERE ${clauses.join(' AND ')}
     ORDER BY block_number DESC, log_index DESC LIMIT ?`
  )
    .bind(...params, limit + 1)
    .all<IdxClaimEventRow>();

  const metas = await loadTokenMeta(env.DB, chainId);
  const results = rows.results ?? [];
  const hasMore = results.length > limit;
  const items = results.slice(0, limit).map((r) => {
    const meta = metas.get(r.token_address) ?? UNKNOWN_META;
    return {
      txHash: r.tx_hash,
      logIndex: r.log_index,
      pairAddress: r.pair_address,
      rewardContract: r.reward_contract,
      userAddress: r.user_address,
      tokenAddress: r.token_address,
      tokenSymbol: meta.symbol,
      tokenDecimals: meta.decimals,
      amount: r.amount,
      dayIndex: r.day_index,
      blockNumber: r.block_number,
      timestamp: r.block_timestamp > 0 ? r.block_timestamp * 1000 : 0,
    };
  });
  const nextBeforeBlock = hasMore && items.length > 0 ? items[items.length - 1].blockNumber : null;
  return { items, hasMore, nextBeforeBlock };
}

export async function getHolderPositions(env: Env, chainId: number, address: string) {
  const holder = normalizeAddr(address);
  const rows = await env.DB.prepare(
    `SELECT h.nft_contract, h.balance, p.pair_address, p.nft_total_minted, p.holder_count
     FROM idx_holders h
     LEFT JOIN idx_pairs p ON p.chain_id = h.chain_id AND p.nft_contract = h.nft_contract
     WHERE h.chain_id = ? AND h.holder = ? AND h.balance > 0`
  )
    .bind(chainId, holder)
    .all<{
      nft_contract: string;
      balance: number;
      pair_address: string | null;
      nft_total_minted: number | null;
      holder_count: number | null;
    }>();
  const positions = (rows.results ?? []).map((r) => ({
    nftContract: r.nft_contract,
    pairAddress: r.pair_address,
    balance: r.balance,
    nftTotalMinted: r.nft_total_minted ?? 0,
    holderCount: r.holder_count ?? 0,
  }));
  const totalBalance = positions.reduce((sum, p) => sum + p.balance, 0);
  return { address: holder, chainId, totalBalance, positions };
}
