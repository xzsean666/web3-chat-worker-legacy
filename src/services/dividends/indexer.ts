// Dividend indexer tick: bounded, resumable chain scanning driven by the cron trigger.
// Each tick: (A) discover pairs/reward contracts from the factory, (B) incrementally
// scan FeeDeposited / RewardClaimed events per reward contract with a block cursor
// (single-address queries: many BSC public RPCs reject address arrays), (C) round-robin
// refresh pool balances / totalFees / reserves / totalMinted, (D) rebuild NFT holder
// sets by ownerOf enumeration (exact holder dedup, no archive-event history needed).

import type { Env } from '../../types';
import type { IdxPairRow, IdxSyncStateRow } from '../../db/schema';
import {
  ERC20_META_ABI,
  FACTORY_ABI,
  FEE_DEPOSITED_EVENT,
  NFT_ABI,
  PAIR_ABI,
  REWARD_ABI,
  REWARD_CLAIMED_EVENT,
  addUintStrings,
  createDividendChainClient,
  dayIndexOf,
  getDividendChains,
  isZeroAddress,
  normalizeAddr,
  type DividendChainClient,
  type DividendChainConfig,
  type IndexedLog,
} from './chain';

const DEFAULT_BUDGET = 44; // subrequest guard per invocation (Workers free tier: 50)
const NEW_PAIRS_PER_TICK = 4;
const RECHECK_PAIRS_PER_TICK = 2;
const REFRESH_POOLS_PER_TICK = 4;
const HOLDER_SCAN_CALLS_PER_TICK = 20;
const MAX_WINDOWS_PER_TICK = 8;
const MAX_PROBES_PER_TICK = 8;
const MAX_TS_FETCH_PER_WINDOW = 24;
const DEFAULT_WINDOW = 5_000;
const MAX_WINDOW = 50_000;
const MIN_WINDOW = 500;
const PROBE_MAX_WINDOW = 200_000;
const PRUNE_SKIP_START = 50_000;
const PRUNE_SKIP_MAX = 5_000_000;
const REWARD_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SYNC_SCOPE = 'events';
const D1_BATCH_CHUNK = 50;

class RpcBudget {
  remaining: number;
  constructor(max: number) {
    this.remaining = max;
  }
  tryUse(cost = 1): boolean {
    if (this.remaining < cost) return false;
    this.remaining -= cost;
    return true;
  }
}

export interface ChainTickStats {
  chainId: number;
  pairsAdded: number;
  rewardEvents: number;
  poolsRefreshed: number;
  holdersScanned: number;
  lastBlock: number;
  latestBlock: number;
  error?: string;
}

export interface DividendTickResult {
  ran: boolean;
  chains: ChainTickStats[];
  timestamp: number;
}

export interface TickOptions {
  budget?: number;
  clientFor?: (cfg: DividendChainConfig) => DividendChainClient;
}

export async function runDividendIndexTick(env: Env, opts?: TickOptions): Promise<DividendTickResult> {
  const chains = getDividendChains(env);
  const result: DividendTickResult = { ran: true, chains: [], timestamp: Date.now() };
  if (chains.length === 0) {
    result.ran = false;
    return result;
  }
  const clientFor = opts?.clientFor ?? createDividendChainClient;
  // One shared subrequest budget across all chains: the Workers limit is per invocation.
  const budget = new RpcBudget(opts?.budget ?? DEFAULT_BUDGET);
  for (const cfg of chains) {
    const client = clientFor(cfg);
    const stats: ChainTickStats = {
      chainId: cfg.chainId,
      pairsAdded: 0,
      rewardEvents: 0,
      poolsRefreshed: 0,
      holdersScanned: 0,
      lastBlock: 0,
      latestBlock: 0,
    };
    try {
      await syncPairs(env.DB, cfg, client, budget, stats);
      await syncEvents(env.DB, cfg, client, budget, stats);
      await refreshPools(env.DB, cfg, client, budget, stats);
      await refreshHolders(env.DB, cfg, client, budget, stats);
    } catch (err) {
      stats.error = err instanceof Error ? err.message : String(err);
      console.error(`dividend indexer tick failed for chain ${cfg.chainId}:`, err);
    }
    result.chains.push(stats);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase A: pair / reward-contract discovery
// ---------------------------------------------------------------------------

async function syncPairs(
  db: D1Database,
  cfg: DividendChainConfig,
  client: DividendChainClient,
  budget: RpcBudget,
  stats: ChainTickStats
): Promise<void> {
  if (!budget.tryUse()) return;
  const allPairsRaw = await client.call<string[]>(cfg.factoryAddress, FACTORY_ABI, 'getAllPairs');
  const allPairs = (allPairsRaw ?? []).map((p) => normalizeAddr(String(p)));
  if (allPairs.length === 0) return;

  const existingRes = await db
    .prepare('SELECT * FROM idx_pairs WHERE chain_id = ?')
    .bind(cfg.chainId)
    .all<IdxPairRow>();
  const existing = new Map((existingRes.results ?? []).map((r) => [r.pair_address, r]));

  const now = Date.now();
  let added = 0;
  for (const pair of allPairs) {
    if (existing.has(pair) || added >= NEW_PAIRS_PER_TICK) continue;
    const row = await loadPairRow(db, cfg, client, budget, pair, now);
    if (!row) break; // budget exhausted mid-pair
    existing.set(pair, row);
    added++;
  }
  stats.pairsAdded = added;

  // Pairs created before their reward contract: re-check occasionally.
  let rechecked = 0;
  for (const row of existing.values()) {
    if (rechecked >= RECHECK_PAIRS_PER_TICK) break;
    if (row.reward_contract || row.recheck_after > now) continue;
    if (!budget.tryUse()) break;
    rechecked++;
    const rc = normalizeAddr(
      String(await client.call<string>(cfg.factoryAddress, FACTORY_ABI, 'getRewardContract', [row.pair_address]))
    );
    if (isZeroAddress(rc)) {
      await db
        .prepare('UPDATE idx_pairs SET recheck_after = ? WHERE chain_id = ? AND pair_address = ?')
        .bind(now + REWARD_RECHECK_INTERVAL_MS, cfg.chainId, row.pair_address)
        .run();
      continue;
    }
    await fillRewardColumns(db, cfg, client, budget, row.pair_address, rc, now);
  }
}

/** Discover reward contract / tokens / NFT contract for one pair and insert its row. */
async function loadPairRow(
  db: D1Database,
  cfg: DividendChainConfig,
  client: DividendChainClient,
  budget: RpcBudget,
  pair: string,
  now: number
): Promise<IdxPairRow | null> {
  if (!budget.tryUse()) return null;
  const rc = normalizeAddr(
    String(await client.call<string>(cfg.factoryAddress, FACTORY_ABI, 'getRewardContract', [pair]))
  );
  if (isZeroAddress(rc)) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO idx_pairs (chain_id, pair_address, reward_contract, recheck_after, created_at)
         VALUES (?, ?, NULL, ?, ?)`
      )
      .bind(cfg.chainId, pair, now + REWARD_RECHECK_INTERVAL_MS, now)
      .run();
    return (await getPairRow(db, cfg.chainId, pair)) ?? null;
  }
  await fillRewardColumns(db, cfg, client, budget, pair, rc, now);
  return (await getPairRow(db, cfg.chainId, pair)) ?? null;
}

async function fillRewardColumns(
  db: D1Database,
  cfg: DividendChainConfig,
  client: DividendChainClient,
  budget: RpcBudget,
  pair: string,
  rewardContract: string,
  now: number
): Promise<void> {
  if (!budget.tryUse(3)) return;
  const token0 = normalizeAddr(String(await client.call<string>(pair, PAIR_ABI, 'token0')));
  const token1 = normalizeAddr(String(await client.call<string>(pair, PAIR_ABI, 'token1')));
  const nft = normalizeAddr(String(await client.call<string>(rewardContract, REWARD_ABI, 'nftContract')));
  const nftContract = isZeroAddress(nft) ? null : nft;
  await db
    .prepare(
      `INSERT INTO idx_pairs (chain_id, pair_address, reward_contract, nft_contract, token0, token1, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, pair_address) DO UPDATE SET
         reward_contract = excluded.reward_contract,
         nft_contract = excluded.nft_contract,
         token0 = excluded.token0,
         token1 = excluded.token1`
    )
    .bind(cfg.chainId, pair, rewardContract, nftContract, token0, token1, now)
    .run();
  await ensureTokenMeta(db, cfg, client, budget, token0);
  await ensureTokenMeta(db, cfg, client, budget, token1);
}

async function ensureTokenMeta(
  db: D1Database,
  cfg: DividendChainConfig,
  client: DividendChainClient,
  budget: RpcBudget,
  token: string
): Promise<void> {
  const found = await db
    .prepare('SELECT token_address FROM idx_token_meta WHERE chain_id = ? AND token_address = ?')
    .bind(cfg.chainId, token)
    .first();
  if (found) return;
  if (!budget.tryUse(2)) return;
  let symbol = '';
  let decimals = 18;
  try {
    symbol = String(await client.call<string>(token, ERC20_META_ABI, 'symbol'));
    decimals = Number(await client.call<number>(token, ERC20_META_ABI, 'decimals'));
  } catch {
    return; // non-standard token: leave uncached, retry on a later tick
  }
  if (!symbol) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO idx_token_meta (chain_id, token_address, symbol, decimals, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(cfg.chainId, token, symbol, decimals, Date.now())
    .run();
}

async function getPairRow(db: D1Database, chainId: number, pair: string): Promise<IdxPairRow | null> {
  return db
    .prepare('SELECT * FROM idx_pairs WHERE chain_id = ? AND pair_address = ?')
    .bind(chainId, pair)
    .first<IdxPairRow>();
}

// ---------------------------------------------------------------------------
// Phase B: reward event scanning (FeeDeposited / RewardClaimed)
// ---------------------------------------------------------------------------

interface SyncMeta {
  window: number;
  bootstrapped?: boolean;
  probeTo?: number;
  probeWindow?: number;
  skipAhead?: number;
  lastError?: string;
}

function isRangeLimitError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('limit') || m.includes('too many') || m.includes('range');
}

function isPrunedError(message: string): boolean {
  return message.toLowerCase().includes('pruned');
}

async function syncEvents(
  db: D1Database,
  cfg: DividendChainConfig,
  client: DividendChainClient,
  budget: RpcBudget,
  stats: ChainTickStats
): Promise<void> {
  const pairsRes = await db
    .prepare('SELECT pair_address, reward_contract FROM idx_pairs WHERE chain_id = ? AND reward_contract IS NOT NULL')
    .bind(cfg.chainId)
    .all<Pick<IdxPairRow, 'pair_address' | 'reward_contract'>>();
  const pairs = pairsRes.results ?? [];
  const rewardToPair = new Map<string, string>();
  const rewardAddrs: string[] = [];
  for (const p of pairs) {
    rewardAddrs.push(p.reward_contract!);
    rewardToPair.set(p.reward_contract!, p.pair_address);
  }

  let state = await db
    .prepare('SELECT * FROM idx_sync_state WHERE chain_id = ? AND scope = ?')
    .bind(cfg.chainId, SYNC_SCOPE)
    .first<IdxSyncStateRow>();
  if (!state) {
    state = {
      chain_id: cfg.chainId,
      scope: SYNC_SCOPE,
      last_block: cfg.startBlock > 0 ? cfg.startBlock - 1 : 0,
      meta: '{}',
      updated_at: Date.now(),
    };
  }
  let meta: SyncMeta;
  try {
    meta = { window: DEFAULT_WINDOW, ...(JSON.parse(state.meta) as Partial<SyncMeta>) };
  } catch {
    meta = { window: DEFAULT_WINDOW };
  }
  let window = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, meta.window || DEFAULT_WINDOW));

  if (!budget.tryUse()) return;
  const latest = await client.getBlockNumber();
  stats.latestBlock = latest;

  // Nothing to index yet (no reward pools on this chain): pure cursor advance.
  if (rewardAddrs.length === 0) {
    await saveSyncState(db, cfg.chainId, latest, { window });
    stats.lastBlock = latest;
    return;
  }

  // Bootstrap: reward pools existed before the indexer ran. Probe backwards from the
  // chain head until the first event block, then forward-scan from there.
  if (state.last_block === 0 && cfg.startBlock === 0 && !meta.bootstrapped) {
    const boot = await bootstrapCursor(db, cfg, client, budget, rewardAddrs, meta, latest, stats);
    if (!boot.done) return; // probe continues next tick
    meta = boot.meta;
    state.last_block = boot.lastBlock;
    if (boot.error) stats.error = boot.error;
  }

  let lastBlock = state.last_block;

  for (let w = 0; w < MAX_WINDOWS_PER_TICK && lastBlock < latest; w++) {
    if (!budget.tryUse(rewardAddrs.length)) break;
    const from = lastBlock + 1;
    const to = Math.min(from + window - 1, latest);

    let logs: IndexedLog[] = [];
    try {
      // One getLogs per reward contract (single address), in parallel.
      const perContract = await Promise.all(
        rewardAddrs.map((addr) =>
          client.getEventLogs({
            address: addr,
            events: [FEE_DEPOSITED_EVENT, REWARD_CLAIMED_EVENT],
            fromBlock: from,
            toBlock: to,
          })
        )
      );
      logs = perContract.flat();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPrunedError(message)) {
        // Receipts below the RPC's retention horizon are gone forever: leap forward
        // (growing steps) until we reach queryable history.
        const skip = Math.min(meta.skipAhead ?? PRUNE_SKIP_START, PRUNE_SKIP_MAX);
        lastBlock = Math.min(to + skip, latest);
        meta = { ...meta, skipAhead: skip * 4, lastError: message };
        await saveSyncState(db, cfg.chainId, lastBlock, meta);
        stats.error = `pruned at ${from}-${to}, jumped to ${lastBlock}`;
        continue;
      }
      // RPC range/response limit: shrink window and retry next tick.
      if (isRangeLimitError(message)) window = Math.max(MIN_WINDOW, Math.floor(window / 2));
      await saveSyncState(db, cfg.chainId, lastBlock, { ...meta, window, lastError: message });
      stats.error = `getLogs ${from}-${to}: ${message}`;
      console.warn(`dividend indexer chain ${cfg.chainId}: getLogs failed, window -> ${window}`, err);
      break;
    }

    // Reward events need block timestamps (fee dayIndex, claim display time).
    const distinctBlocks = [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) => a - b);
    let effectiveTo = to;
    if (distinctBlocks.length > MAX_TS_FETCH_PER_WINDOW) {
      const cutoffBlock = distinctBlocks[MAX_TS_FETCH_PER_WINDOW - 1];
      effectiveTo = cutoffBlock;
      logs = logs.filter((l) => l.blockNumber <= cutoffBlock);
    }

    const tsByBlock = new Map<number, number>();
    const blocksToFetch = [...new Set(logs.map((l) => l.blockNumber))];
    if (blocksToFetch.length > 0) {
      if (!budget.tryUse(blocksToFetch.length)) break;
      const timestamps = await Promise.all(blocksToFetch.map((bn) => client.getBlockTimestamp(bn)));
      blocksToFetch.forEach((bn, i) => tsByBlock.set(bn, timestamps[i]));
    }

    await processRewardLogs(db, cfg.chainId, logs, rewardToPair, tsByBlock);
    stats.rewardEvents += logs.length;

    lastBlock = effectiveTo;
    if (logs.length === 0 && window < MAX_WINDOW) {
      window = Math.min(MAX_WINDOW, window * 2);
    }
    meta = { ...meta, window, lastError: undefined, skipAhead: undefined };
    await saveSyncState(db, cfg.chainId, lastBlock, meta);
    if (effectiveTo < to) break; // timestamp cap hit: continue next tick
  }
  stats.lastBlock = lastBlock;
}

interface BootstrapResult {
  done: boolean;
  lastBlock: number;
  meta: SyncMeta;
  error?: string;
}

/** Walk backwards from the chain head to locate the first reward-contract event. */
async function bootstrapCursor(
  db: D1Database,
  cfg: DividendChainConfig,
  client: DividendChainClient,
  budget: RpcBudget,
  rewardAddrs: string[],
  meta: SyncMeta,
  latest: number,
  stats: ChainTickStats
): Promise<BootstrapResult> {
  let probeTo = Math.min(meta.probeTo ?? latest, latest);
  let probeWindow = Math.min(PROBE_MAX_WINDOW, Math.max(MIN_WINDOW, meta.probeWindow ?? DEFAULT_WINDOW));

  for (let i = 0; i < MAX_PROBES_PER_TICK && probeTo > 0; i++) {
    if (!budget.tryUse(rewardAddrs.length)) break;
    const from = Math.max(1, probeTo - probeWindow + 1);
    let logs: IndexedLog[];
    try {
      const perContract = await Promise.all(
        rewardAddrs.map((addr) =>
          client.getEventLogs({
            address: addr,
            events: [FEE_DEPOSITED_EVENT, REWARD_CLAIMED_EVENT],
            fromBlock: from,
            toBlock: probeTo,
          })
        )
      );
      logs = perContract.flat();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPrunedError(message)) {
        // History below this point unavailable on the RPC: index from here forward.
        const nextMeta: SyncMeta = { ...meta, bootstrapped: true, lastError: `history pruned below ${from}` };
        await saveSyncState(db, cfg.chainId, from - 1, nextMeta);
        return {
          done: true,
          lastBlock: from - 1,
          meta: nextMeta,
          error: `history pruned below block ${from}; indexing starts there`,
        };
      }
      if (isRangeLimitError(message)) {
        probeWindow = Math.max(MIN_WINDOW, Math.floor(probeWindow / 2));
        await saveSyncState(db, cfg.chainId, 0, { ...meta, probeTo, probeWindow, lastError: message });
        stats.error = `bootstrap probe ${from}-${probeTo}: ${message}`;
        continue;
      }
      await saveSyncState(db, cfg.chainId, 0, { ...meta, probeTo, probeWindow, lastError: message });
      return { done: false, lastBlock: 0, meta, error: message };
    }

    if (logs.length > 0) {
      const firstBlock = Math.min(...logs.map((l) => l.blockNumber));
      const nextMeta: SyncMeta = { ...meta, bootstrapped: true, probeTo: undefined, probeWindow: undefined };
      await saveSyncState(db, cfg.chainId, firstBlock - 1, nextMeta);
      return { done: true, lastBlock: firstBlock - 1, meta: nextMeta };
    }
    // Empty range: step back, grow the probe window aggressively.
    probeTo = from - 1;
    probeWindow = Math.min(PROBE_MAX_WINDOW, probeWindow * 4);
  }

  if (probeTo <= 0) {
    // Reached genesis without any event: start a plain forward scan from block 0.
    const nextMeta: SyncMeta = { ...meta, bootstrapped: true, probeTo: undefined, probeWindow: undefined };
    await saveSyncState(db, cfg.chainId, 0, nextMeta);
    return { done: true, lastBlock: 0, meta: nextMeta };
  }
  await saveSyncState(db, cfg.chainId, 0, { ...meta, probeTo, probeWindow });
  stats.lastBlock = 0;
  return { done: false, lastBlock: 0, meta: { ...meta, probeTo, probeWindow } };
}

async function saveSyncState(db: D1Database, chainId: number, lastBlock: number, meta: SyncMeta): Promise<void> {
  const clean: SyncMeta = { window: meta.window };
  if (meta.bootstrapped) clean.bootstrapped = true;
  if (meta.probeTo !== undefined) clean.probeTo = meta.probeTo;
  if (meta.probeWindow !== undefined) clean.probeWindow = meta.probeWindow;
  if (meta.skipAhead !== undefined) clean.skipAhead = meta.skipAhead;
  if (meta.lastError) clean.lastError = meta.lastError;
  await db
    .prepare(
      `INSERT INTO idx_sync_state (chain_id, scope, last_block, meta, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, scope) DO UPDATE SET
         last_block = excluded.last_block, meta = excluded.meta, updated_at = excluded.updated_at`
    )
    .bind(chainId, SYNC_SCOPE, lastBlock, JSON.stringify(clean), Date.now())
    .run();
}

async function processRewardLogs(
  db: D1Database,
  chainId: number,
  logs: IndexedLog[],
  rewardToPair: Map<string, string>,
  tsByBlock: Map<number, number>
): Promise<void> {
  if (logs.length === 0) return;
  const now = Date.now();
  const feeAgg = new Map<string, { reward: string; day: number; token: string; amount: bigint }>();
  const statements: D1PreparedStatement[] = [];

  for (const log of logs) {
    const reward = normalizeAddr(log.address);
    const ts = tsByBlock.get(log.blockNumber) ?? 0;
    if (log.eventName === 'RewardClaimed') {
      const args = log.args as { user?: string; token?: string; amount?: bigint; dayIndex?: bigint };
      if (!args.user || !args.token || args.amount === undefined) continue;
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO idx_claim_events
             (chain_id, pair_address, reward_contract, tx_hash, log_index, user_address, token_address, amount, day_index, block_number, block_timestamp, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            chainId,
            rewardToPair.get(reward) ?? '',
            reward,
            log.transactionHash,
            log.logIndex,
            normalizeAddr(String(args.user)),
            normalizeAddr(String(args.token)),
            args.amount.toString(10),
            Number(args.dayIndex ?? (ts > 0 ? dayIndexOf(ts) : 0)),
            log.blockNumber,
            ts,
            now
          )
      );
    } else if (log.eventName === 'FeeDeposited') {
      const args = log.args as { token?: string; amount?: bigint };
      if (!args.token || args.amount === undefined || ts <= 0) continue;
      const token = normalizeAddr(String(args.token));
      const day = dayIndexOf(ts);
      const key = `${reward}|${day}|${token}`;
      const entry = feeAgg.get(key) ?? { reward, day, token, amount: 0n };
      entry.amount += args.amount;
      feeAgg.set(key, entry);
    }
  }

  // Fee daily aggregation: read current sums, write back merged (TEXT uint256).
  for (const entry of feeAgg.values()) {
    const existing = await db
      .prepare(
        `SELECT fee_amount FROM idx_fee_daily
         WHERE chain_id = ? AND reward_contract = ? AND day_index = ? AND token_address = ?`
      )
      .bind(chainId, entry.reward, entry.day, entry.token)
      .first<{ fee_amount: string }>();
    const merged = addUintStrings(existing?.fee_amount ?? '0', entry.amount.toString(10));
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO idx_fee_daily (chain_id, reward_contract, day_index, token_address, fee_amount)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(chainId, entry.reward, entry.day, entry.token, merged)
    );
  }

  for (let i = 0; i < statements.length; i += D1_BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + D1_BATCH_CHUNK));
  }
}

// ---------------------------------------------------------------------------
// Phase C: pool state refresh (balances / totalFees / reserves / totalMinted)
// ---------------------------------------------------------------------------

async function refreshPools(
  db: D1Database,
  cfg: DividendChainConfig,
  client: DividendChainClient,
  budget: RpcBudget,
  stats: ChainTickStats
): Promise<void> {
  const res = await db
    .prepare(
      `SELECT * FROM idx_pairs
       WHERE chain_id = ? AND reward_contract IS NOT NULL
       ORDER BY state_updated_at ASC LIMIT ?`
    )
    .bind(cfg.chainId, REFRESH_POOLS_PER_TICK)
    .all<IdxPairRow>();

  for (const row of res.results ?? []) {
    const cost = row.nft_contract ? 6 : 5;
    if (!budget.tryUse(cost)) break;
    try {
      const balances = await client.call<readonly [bigint, bigint] | { balance0: bigint; balance1: bigint }>(
        row.reward_contract!,
        REWARD_ABI,
        'getBalances'
      );
      const fees0 = await client.call<bigint>(row.reward_contract!, REWARD_ABI, 'totalFees', [row.token0!]);
      const fees1 = await client.call<bigint>(row.reward_contract!, REWARD_ABI, 'totalFees', [row.token1!]);
      const reserves = await client.call<readonly [bigint, bigint, number] | { reserve0: bigint; reserve1: bigint }>(
        row.pair_address,
        PAIR_ABI,
        'getReserves'
      );
      let totalMinted = row.nft_total_minted;
      if (row.nft_contract) {
        totalMinted = Number(await client.call<bigint>(row.nft_contract, NFT_ABI, 'totalMinted'));
      }
      const bal0 = tupleAt<bigint>(balances, 0, 'balance0');
      const bal1 = tupleAt<bigint>(balances, 1, 'balance1');
      const res0 = tupleAt<bigint>(reserves, 0, 'reserve0');
      const res1 = tupleAt<bigint>(reserves, 1, 'reserve1');
      await db
        .prepare(
          `UPDATE idx_pairs SET
             pool_balance0 = ?, pool_balance1 = ?, total_fees0 = ?, total_fees1 = ?,
             reserve0 = ?, reserve1 = ?, nft_total_minted = ?, state_updated_at = ?
           WHERE chain_id = ? AND pair_address = ?`
        )
        .bind(
          bal0.toString(10),
          bal1.toString(10),
          fees0.toString(10),
          fees1.toString(10),
          res0.toString(10),
          res1.toString(10),
          totalMinted,
          Date.now(),
          cfg.chainId,
          row.pair_address
        )
        .run();
      stats.poolsRefreshed++;
    } catch (err) {
      console.warn(`dividend indexer chain ${cfg.chainId}: refresh pool ${row.pair_address} failed`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase D: NFT holder sets via ownerOf enumeration (exact dedup, no archive logs)
// ---------------------------------------------------------------------------

interface HolderScanState {
  nextId: number;
  totalMinted: number;
  owners: Record<string, number>;
}

async function refreshHolders(
  db: D1Database,
  cfg: DividendChainConfig,
  client: DividendChainClient,
  budget: RpcBudget,
  stats: ChainTickStats
): Promise<void> {
  const res = await db
    .prepare(
      `SELECT nft_contract, nft_total_minted FROM idx_pairs
       WHERE chain_id = ? AND nft_contract IS NOT NULL`
    )
    .bind(cfg.chainId)
    .all<Pick<IdxPairRow, 'nft_contract' | 'nft_total_minted'>>();

  for (const row of res.results ?? []) {
    const nft = row.nft_contract!;
    const kvKey = `nftscan:${cfg.chainId}:${nft}`;
    const kv = await db.prepare('SELECT value FROM idx_kv WHERE key = ?').bind(kvKey).first<{ value: string }>();
    let scan: HolderScanState = { nextId: 1, totalMinted: row.nft_total_minted, owners: {} };
    if (kv) {
      try {
        const parsed = JSON.parse(kv.value) as HolderScanState;
        if (parsed.nextId > 1 && parsed.totalMinted === row.nft_total_minted) {
          scan = parsed; // resume an in-flight pass over an unchanged supply
        }
      } catch {
        // corrupted state: restart the pass
      }
    }
    // Supply changed or previous pass finished: restart from tokenId 1.
    if (scan.totalMinted !== row.nft_total_minted) {
      scan = { nextId: 1, totalMinted: row.nft_total_minted, owners: {} };
    }

    const end = Math.min(scan.nextId + HOLDER_SCAN_CALLS_PER_TICK - 1, scan.totalMinted);
    while (scan.nextId <= end && budget.tryUse()) {
      const tokenId = scan.nextId;
      try {
        const owner = normalizeAddr(String(await client.call<string>(nft, NFT_ABI, 'ownerOf', [BigInt(tokenId)])));
        if (!isZeroAddress(owner)) {
          scan.owners[owner] = (scan.owners[owner] ?? 0) + 1;
        }
      } catch {
        // burned / invalid tokenId: ownerOf reverts
      }
      scan.nextId++;
      stats.holdersScanned++;
    }

    const finished = scan.nextId > scan.totalMinted;
    if (finished) {
      const now = Date.now();
      const statements: D1PreparedStatement[] = [
        db.prepare('DELETE FROM idx_holders WHERE chain_id = ? AND nft_contract = ?').bind(cfg.chainId, nft),
      ];
      for (const [holder, balance] of Object.entries(scan.owners)) {
        statements.push(
          db
            .prepare(
              `INSERT INTO idx_holders (chain_id, nft_contract, holder, balance, updated_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .bind(cfg.chainId, nft, holder, balance, now)
        );
      }
      statements.push(
        db
          .prepare('UPDATE idx_pairs SET holder_count = ? WHERE chain_id = ? AND nft_contract = ?')
          .bind(Object.keys(scan.owners).length, cfg.chainId, nft)
      );
      await db.batch(statements);
      await db
        .prepare(
          `INSERT INTO idx_kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(kvKey, JSON.stringify({ nextId: 1, totalMinted: scan.totalMinted, owners: {} }), now)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO idx_kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(kvKey, JSON.stringify(scan), Date.now())
        .run();
    }
  }
}

/** viem returns tuples as arrays (or named objects when outputs are named). */
function tupleAt<T>(value: unknown, index: number, key: string): T {
  if (Array.isArray(value)) return value[index] as T;
  return (value as Record<string, T>)[key];
}
