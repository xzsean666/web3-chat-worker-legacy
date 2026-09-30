// Dividend indexer chain access layer: viem-backed client + pure helpers.
// The ChainClient interface is intentionally minimal so tests can stub it.

import { createPublicClient, http, parseAbi, parseAbiItem, type Abi, type Chain } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import type { Env } from '../../types';

export const FACTORY_ABI = parseAbi([
  'function getAllPairs() view returns (address[])',
  'function getRewardContract(address pair) view returns (address)',
]);

export const PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

export const REWARD_ABI = parseAbi([
  'function nftContract() view returns (address)',
  'function getBalances() view returns (uint256 balance0, uint256 balance1)',
  'function totalFees(address) view returns (uint256)',
]);

export const NFT_ABI = parseAbi([
  'function totalMinted() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

export const ERC20_META_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

export const FEE_DEPOSITED_EVENT = parseAbiItem(
  'event FeeDeposited(address indexed token, uint256 amount)'
);
export const REWARD_CLAIMED_EVENT = parseAbiItem(
  'event RewardClaimed(address indexed user, address indexed token, uint256 amount, uint256 dayIndex)'
);

export interface IndexedLog {
  address: string;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface DividendChainClient {
  getBlockNumber(): Promise<number>;
  call<T = unknown>(
    address: string,
    abi: Abi | readonly unknown[],
    functionName: string,
    args?: readonly unknown[]
  ): Promise<T>;
  /** Single-contract log query (many BSC public RPCs reject address arrays). */
  getEventLogs(params: {
    address: string;
    events: readonly unknown[];
    fromBlock: number;
    toBlock: number;
  }): Promise<IndexedLog[]>;
  getBlockTimestamp(blockNumber: number): Promise<number>;
}

export interface DividendChainConfig {
  chainId: number;
  rpcUrl: string;
  factoryAddress: string;
  startBlock: number;
}

const DEFAULT_RPC: Record<number, string> = {
  56: 'https://bsc-dataseed.binance.org',
  97: 'https://data-seed-prebsc-1-s1.binance.org:8545',
};

export function getDividendChains(env: Env): DividendChainConfig[] {
  const chains: DividendChainConfig[] = [];
  const perChain: [number, string | undefined, string | undefined, string | undefined][] = [
    [56, env.DIVIDEND_RPC_56, env.DIVIDEND_FACTORY_56, env.DIVIDEND_START_BLOCK_56],
    [97, env.DIVIDEND_RPC_97, env.DIVIDEND_FACTORY_97, env.DIVIDEND_START_BLOCK_97],
  ];
  for (const [chainId, rpcEnv, factoryEnv, startRaw] of perChain) {
    if (!factoryEnv) continue;
    chains.push({
      chainId,
      rpcUrl: rpcEnv ?? DEFAULT_RPC[chainId],
      factoryAddress: factoryEnv.toLowerCase(),
      startBlock: startRaw ? Math.max(0, parseInt(startRaw, 10) || 0) : 0,
    });
  }
  return chains;
}

export function dividendIndexerEnabled(env: Env): boolean {
  const flag = env.DIVIDEND_INDEX_ENABLED;
  if (flag !== undefined && flag !== null && String(flag) !== '1' && String(flag).toLowerCase() !== 'true') {
    return false;
  }
  return getDividendChains(env).length > 0;
}

const clientCache = new Map<string, DividendChainClient>();

export function createDividendChainClient(cfg: DividendChainConfig): DividendChainClient {
  const cached = clientCache.get(`${cfg.chainId}:${cfg.rpcUrl}`);
  if (cached) return cached;

  const chain: Chain = cfg.chainId === 97 ? bscTestnet : bsc;
  const client = createPublicClient({
    chain: { ...chain, id: cfg.chainId },
    // No retries: the tick's own subrequest budget must account 1:1 per RPC call
    // (Workers free tier caps subrequests per invocation).
    transport: http(cfg.rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });

  const adapter: DividendChainClient = {
    async getBlockNumber() {
      return Number(await client.getBlockNumber());
    },
    async call<T>(address: string, abi: Abi | readonly unknown[], functionName: string, args?: readonly unknown[]) {
      const result = await client.readContract({
        address: address as `0x${string}`,
        abi: abi as Abi,
        functionName,
        args: args as readonly `0x${string}`[] | undefined,
      });
      return result as T;
    },
    async getEventLogs({ address, events, fromBlock, toBlock }) {
      const logs = (await client.getLogs({
        address: address as `0x${string}`,
        events: events as never,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
        strict: false,
      })) as unknown as {
        address: string;
        eventName?: string;
        args?: Record<string, unknown>;
        blockNumber?: bigint | number | null;
        transactionHash?: string | null;
        logIndex?: bigint | number | null;
      }[];
      return logs.map((l) => ({
        address: l.address.toLowerCase(),
        eventName: l.eventName ?? '',
        args: l.args ?? {},
        blockNumber: Number(l.blockNumber ?? 0),
        transactionHash: l.transactionHash ?? '',
        logIndex: Number(l.logIndex ?? 0),
      }));
    },
    async getBlockTimestamp(blockNumber) {
      const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
      return Number(block.timestamp);
    },
  };
  clientCache.set(`${cfg.chainId}:${cfg.rpcUrl}`, adapter);
  return adapter;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function isZeroAddress(address: string | null | undefined): boolean {
  return !address || address.toLowerCase() === ZERO_ADDRESS;
}

export function normalizeAddr(address: string): string {
  return address.trim().toLowerCase();
}

/** uint256 decimal-string addition (D1 TEXT columns, no 64-bit overflow). */
export function addUintStrings(a: string, b: string): string {
  return (BigInt(a || '0') + BigInt(b || '0')).toString(10);
}

/** Apply one holder balance delta to a balance map (mutates, clamps at 0). */
export function applyTransferDelta(
  balances: Map<string, number>,
  holder: string,
  delta: number
): void {
  const next = (balances.get(holder) ?? 0) + delta;
  balances.set(holder, next < 0 ? 0 : next);
}

export const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'USDB', 'TUSD', 'FDUSD']);

export function priceOfSymbol(mids: Record<string, number>, symbol: string): number {
  const sym = symbol.toUpperCase();
  if (STABLECOINS.has(sym)) return 1;
  const direct = mids[sym];
  return typeof direct === 'number' && direct > 0 ? direct : 0;
}

/** raw uint string → float token units */
export function rawToUnits(raw: string, decimals: number): number {
  if (!raw || raw === '0') return 0;
  const value = Number(raw) / 10 ** decimals;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Rolling annualized APR (%): fees over `windowDays` annualized against TVL.
 * Returns null when TVL or fee data is insufficient (frontend shows "--").
 */
export function computeAprPercent(
  feesUsdInWindow: number,
  windowDays: number,
  tvlUsd: number
): number | null {
  if (tvlUsd <= 0 || windowDays <= 0 || feesUsdInWindow <= 0) return null;
  return (feesUsdInWindow / windowDays) * 365 / tvlUsd * 100;
}

export function dayIndexOf(timestampSec: number): number {
  return Math.floor(timestampSec / 86400);
}
