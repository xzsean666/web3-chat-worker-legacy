import { describe, it, expect, beforeEach } from 'vitest';
import { createMockD1Database } from './helpers/db';
import { app } from '../src/index';
import {
  addUintStrings,
  applyTransferDelta,
  computeAprPercent,
  dayIndexOf,
  priceOfSymbol,
  rawToUnits,
  type DividendChainClient,
  type IndexedLog,
} from '../src/services/dividends/chain';
import { runDividendIndexTick } from '../src/services/dividends/indexer';
import {
  getClaimsForAddress,
  getDividendOverview,
  getHolderPositions,
  getPairAprDetail,
} from '../src/services/dividends/stats';
import type { Env } from '../src/types';

const FACTORY = '0x00000000000000000000000000000000000000fa';
const PAIR = '0x0000000000000000000000000000000000000aa1';
const REWARD = '0x0000000000000000000000000000000000000bb1';
const NFT = '0x0000000000000000000000000000000000000cc1';
const TOKEN0 = '0x0000000000000000000000000000000000000d01'; // USDT (stable)
const TOKEN1 = '0x0000000000000000000000000000000000000d02'; // BNB
const HOLDER_A = '0x0000000000000000000000000000000000000e01';
const HOLDER_B = '0x0000000000000000000000000000000000000e02';

function makeLog(partial: Partial<IndexedLog> & Pick<IndexedLog, 'eventName' | 'blockNumber'>): IndexedLog {
  return {
    address: REWARD,
    args: {},
    transactionHash: `0xtx${partial.blockNumber}${partial.logIndex ?? 0}`,
    logIndex: 0,
    ...partial,
  };
}

/** Scripted chain client: returns canned answers per contract/function. */
function makeStubClient(opts: { nowSec: number }): DividendChainClient {
  const ts: Record<number, number> = {
    10: opts.nowSec - 3 * 86400, // fee deposit 3 days ago
    11: opts.nowSec - 3 * 86400,
    12: opts.nowSec - 2 * 86400,
    20: opts.nowSec - 86400, // claim yesterday
  };
  const owners: Record<number, string> = { 1: HOLDER_B, 2: HOLDER_B }; // tokenId -> owner
  return {
    async getBlockNumber() {
      return 100;
    },
    async call<T>(_address: string, _abi: unknown, functionName: string, args?: readonly unknown[]): Promise<T> {
      switch (functionName) {
        case 'getAllPairs':
          return [PAIR] as T;
        case 'getRewardContract':
          return REWARD as T;
        case 'token0':
          return TOKEN0 as T;
        case 'token1':
          return TOKEN1 as T;
        case 'nftContract':
          return NFT as T;
        case 'symbol':
          return (_address === TOKEN0 ? 'USDT' : 'BNB') as T;
        case 'decimals':
          return 18 as T;
        case 'getBalances':
          return [1_000n * 10n ** 18n, 2n * 10n ** 18n] as T;
        case 'totalFees':
          return 500n * 10n ** 18n as T;
        case 'getReserves':
          return [100_000n * 10n ** 18n, 500n * 10n ** 18n, 0] as T;
        case 'totalMinted':
          return 2n as T;
        case 'ownerOf': {
          const id = Number(args?.[0]);
          const owner = owners[id];
          if (!owner) throw new Error('LHSwapNFT: INVALID_TOKEN');
          return owner as T;
        }
        default:
          throw new Error(`stub: unexpected call ${functionName} on ${_address}`);
      }
    },
    async getEventLogs({ address, fromBlock, toBlock }) {
      if (address !== REWARD) return [];
      const all = [
        makeLog({
          eventName: 'FeeDeposited',
          blockNumber: 10,
          args: { token: TOKEN0, amount: 10n * 10n ** 18n },
        }),
        makeLog({
          eventName: 'RewardClaimed',
          blockNumber: 20,
          logIndex: 3,
          transactionHash: '0xclaimtx',
          args: { user: HOLDER_A, token: TOKEN0, amount: 3n * 10n ** 18n, dayIndex: BigInt(dayIndexOf(ts[20])) },
        }),
      ];
      return all.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    async getBlockTimestamp(blockNumber: number) {
      const t = ts[blockNumber];
      if (t === undefined) throw new Error(`stub: no timestamp for block ${blockNumber}`);
      return t;
    },
  };
}

function makeEnv(db: D1Database, rpcUrl = 'http://stub-rpc'): Env {
  return {
    DB: db,
    VOICE_BUCKET: undefined as unknown as R2Bucket,
    DIVIDEND_INDEX_ENABLED: '1',
    DIVIDEND_FACTORY_56: FACTORY,
    DIVIDEND_RPC_56: rpcUrl,
    DIVIDEND_FACTORY_97: '', // disable second chain in tests
  } as Env;
}

describe('dividend chain helpers', () => {
  it('addUintStrings adds uint256 decimal strings', () => {
    expect(addUintStrings('0', '0')).toBe('0');
    expect(addUintStrings('9007199254740993', '9007199254740993')).toBe('18014398509481986');
    expect(addUintStrings('', '5')).toBe('5');
  });

  it('applyTransferDelta clamps balances at zero', () => {
    const m = new Map<string, number>();
    applyTransferDelta(m, 'a', 1);
    applyTransferDelta(m, 'a', 1);
    applyTransferDelta(m, 'a', -5);
    expect(m.get('a')).toBe(0);
  });

  it('computeAprPercent annualizes window fees against TVL', () => {
    // 70 USD fees over 7 days on 3650 USD TVL => 10 USD/day => 3650/yr => 100%
    expect(computeAprPercent(70, 7, 3650)).toBeCloseTo(100);
    expect(computeAprPercent(0, 7, 3650)).toBeNull();
    expect(computeAprPercent(70, 7, 0)).toBeNull();
  });

  it('priceOfSymbol treats stablecoins as 1 USD', () => {
    expect(priceOfSymbol({}, 'usdt')).toBe(1);
    expect(priceOfSymbol({ BNB: 600 }, 'bnb')).toBe(600);
    expect(priceOfSymbol({}, 'BNB')).toBe(0);
  });

  it('rawToUnits converts raw uint to token units', () => {
    expect(rawToUnits('1500000000000000000', 18)).toBeCloseTo(1.5);
    expect(rawToUnits('0', 18)).toBe(0);
  });
});

describe('dividend indexer tick', () => {
  let db: D1Database;
  let env: Env;
  const nowSec = Math.floor(Date.now() / 1000);

  beforeEach(async () => {
    db = createMockD1Database();
    env = makeEnv(db);
    // Seed a fresh price cache so stats never hit the network in tests.
    await db
      .prepare('INSERT INTO idx_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .bind('prices:hyperliquid', JSON.stringify({ BNB: 600 }), Date.now())
      .run();
    const client = makeStubClient({ nowSec });
    const result = await runDividendIndexTick(env, { clientFor: () => client });
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0].error).toBeUndefined();
  });

  it('registers pair with reward + nft contracts and token meta', async () => {
    const row = await db
      .prepare('SELECT * FROM idx_pairs WHERE chain_id = 56 AND pair_address = ?')
      .bind(PAIR)
      .first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    expect(row!.reward_contract).toBe(REWARD);
    expect(row!.nft_contract).toBe(NFT);
    expect(row!.nft_total_minted).toBe(2);
    expect(row!.pool_balance0).toBe((1_000n * 10n ** 18n).toString());
    const meta = await db
      .prepare('SELECT symbol FROM idx_token_meta WHERE chain_id = 56 AND token_address = ?')
      .bind(TOKEN0)
      .first<{ symbol: string }>();
    expect(meta?.symbol).toBe('USDT');
  });

  it('dedupes holders via ownerOf enumeration', async () => {
    const holders = await db
      .prepare('SELECT holder, balance FROM idx_holders WHERE chain_id = 56 ORDER BY holder')
      .bind()
      .all<{ holder: string; balance: number }>();
    const byHolder = new Map((holders.results ?? []).map((r) => [r.holder, r.balance]));
    expect(byHolder.has(HOLDER_A)).toBe(false);
    expect(byHolder.get(HOLDER_B)).toBe(2);
    const pair = await db
      .prepare('SELECT holder_count FROM idx_pairs WHERE chain_id = 56 AND pair_address = ?')
      .bind(PAIR)
      .first<{ holder_count: number }>();
    expect(pair?.holder_count).toBe(1);
  });

  it('indexes RewardClaimed into claim events with pair + timestamp', async () => {
    const rows = await db
      .prepare('SELECT * FROM idx_claim_events WHERE chain_id = 56')
      .bind()
      .all<{ tx_hash: string; amount: string; pair_address: string; block_timestamp: number }>();
    expect(rows.results).toHaveLength(1);
    const row = rows.results![0];
    expect(row.tx_hash).toBe('0xclaimtx');
    expect(row.amount).toBe((3n * 10n ** 18n).toString());
    expect(row.pair_address).toBe(PAIR);
    expect(row.block_timestamp).toBeGreaterThan(0);
  });

  it('aggregates FeeDeposited into daily fee sums', async () => {
    const row = await db
      .prepare('SELECT fee_amount, day_index FROM idx_fee_daily WHERE chain_id = 56')
      .bind()
      .first<{ fee_amount: string; day_index: number }>();
    expect(row?.fee_amount).toBe((10n * 10n ** 18n).toString());
    expect(row?.day_index).toBe(dayIndexOf(nowSec - 3 * 86400));
  });

  it('serves overview with global deduped holder count and USD totals', async () => {
    const overview = await getDividendOverview(env, 56);
    expect(overview.pairCount).toBe(1);
    expect(overview.holderCount).toBe(1);
    expect(overview.nftTotalMinted).toBe(2);
    // pool: 1000 USDT + 2 BNB*600 = 2200 USD
    expect(overview.totalPoolUsd).toBeCloseTo(2200);
    // fees: 500 USDT + 500 BNB*600 = 300500 USD
    expect(overview.totalFeesUsd).toBeCloseTo(300500);
    expect(overview.syncedBlock).toBe(100);
  });

  it('serves cross-device claim history with token symbols', async () => {
    const claims = await getClaimsForAddress(env, 56, HOLDER_A, {});
    expect(claims.items).toHaveLength(1);
    expect(claims.items[0].tokenSymbol).toBe('USDT');
    expect(claims.items[0].timestamp).toBeGreaterThan(0);
    expect(claims.hasMore).toBe(false);
  });

  it('computes rolling APR from indexed fees and reserves', async () => {
    const detail = await getPairAprDetail(env, 56, PAIR);
    expect(detail).toBeTruthy();
    // TVL = 100k USDT + 500 BNB*600 = 400k USD; 7d fees = 10 USDT
    expect(detail!.tvlUsd).toBeCloseTo(400_000);
    expect(detail!.apr7d).toBeCloseTo((10 / 7) * 365 / 400_000 * 100);
    expect(detail!.daily.length).toBeGreaterThan(0);
  });

  it('serves holder positions across devices', async () => {
    const positions = await getHolderPositions(env, 56, HOLDER_B);
    expect(positions.totalBalance).toBe(2);
    expect(positions.positions[0].pairAddress).toBe(PAIR);
    const empty = await getHolderPositions(env, 56, HOLDER_A);
    expect(empty.totalBalance).toBe(0);
  });

  it('is idempotent across repeated ticks', async () => {
    const client = makeStubClient({ nowSec });
    await runDividendIndexTick(env, { clientFor: () => client });
    const claims = await db.prepare('SELECT COUNT(*) AS c FROM idx_claim_events').bind().first<{ c: number }>();
    expect(claims?.c).toBe(1);
    const holders = await db
      .prepare('SELECT balance FROM idx_holders WHERE holder = ?')
      .bind(HOLDER_B)
      .first<{ balance: number }>();
    expect(holders?.balance).toBe(2);
  });
});

describe('dividend routes registration (public, not behind IM auth)', () => {
  it('GET /dividends/overview responds without auth header', async () => {
    const env = makeEnv(createMockD1Database());
    const res = await app.request('/dividends/overview?chainId=56', {}, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { chainId: number; holderCount: number };
    expect(data.chainId).toBe(56);
    expect(data.holderCount).toBe(0);
  });

  it('POST /dividends/sync responds without auth header', async () => {
    // RPC pointed at a closed port so the tick fails fast and reports the per-chain error.
    const env = makeEnv(createMockD1Database(), 'http://127.0.0.1:9');
    const res = await app.request('/dividends/sync', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ran: boolean; chains: { chainId: number; error?: string }[] };
    expect(data.ran).toBe(true);
    expect(data.chains[0].error).toBeTruthy();
  });

  it('IM routes still require auth', async () => {
    const env = makeEnv(createMockD1Database());
    const res = await app.request('/messages/ack', { method: 'POST' }, env);
    expect(res.status).toBe(401);
  });
});

describe('dividend indexer prune handling', () => {
  it('leaps forward over pruned history until queryable range', async () => {
    const db = createMockD1Database();
    const env = makeEnv(db);
    const prunedBoundary = 90; // blocks < boundary are pruned
    const client: DividendChainClient = {
      async getBlockNumber() {
        return 100;
      },
      async call<T>(_a: string, _abi: unknown, fn: string, args?: readonly unknown[]): Promise<T> {
        switch (fn) {
          case 'getAllPairs':
            return [PAIR] as T;
          case 'getRewardContract':
            return REWARD as T;
          case 'token0':
            return TOKEN0 as T;
          case 'token1':
            return TOKEN1 as T;
          case 'nftContract':
            return NFT as T;
          case 'symbol':
            return 'USDT' as T;
          case 'decimals':
            return 18 as T;
          case 'getBalances':
            return [0n, 0n] as T;
          case 'totalFees':
            return 0n as T;
          case 'getReserves':
            return [0n, 0n, 0] as T;
          case 'totalMinted':
            return 0n as T;
          case 'ownerOf':
            throw new Error('INVALID_TOKEN');
          default:
            throw new Error(`unexpected ${fn}`);
        }
      },
      async getEventLogs({ fromBlock }) {
        if (fromBlock < prunedBoundary) {
          throw new Error('History has been pruned for this block');
        }
        return [];
      },
      async getBlockTimestamp() {
        return 0;
      },
    };
    // Several ticks: each tick leaps with growing steps past pruned ranges.
    let lastBlock = 0;
    for (let i = 0; i < 10 && lastBlock < 100; i++) {
      const res = await runDividendIndexTick(env, { clientFor: () => client });
      lastBlock = res.chains[0].lastBlock;
    }
    expect(lastBlock).toBeGreaterThanOrEqual(prunedBoundary);
    const state = await db
      .prepare("SELECT last_block FROM idx_sync_state WHERE chain_id = 56 AND scope = 'events'")
      .bind()
      .first<{ last_block: number }>();
    expect(state!.last_block).toBe(lastBlock);
  });
});
