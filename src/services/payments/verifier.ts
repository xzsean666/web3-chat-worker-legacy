// 链上验款器（契约 §5）：Worker 独立执行，不信客户端金额。
// 使用订单 config_version 冻结的链配置（RPC/确认数/收款地址/代币），不用当前 active 配置。
// PaymentChainClient 接口刻意最小化，测试直接 stub；生产用 createPaymentChainClient（viem，逐 rpcUrl 轮换）。

import { createPublicClient, http, type Chain } from 'viem';
import { bsc } from 'viem/chains';
import type { PaymentOrderRow, PaymentTxClaimRow } from '../../db/schema';
import type { PaymentChainConfig, PaymentConfigPayload } from './config';

export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface ChainTx {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  blockNumber: number | null;
}

export interface ChainLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
}

export interface ChainReceipt {
  status: string; // '0x1' | '0x0'
  blockNumber: number;
  logs: ChainLog[];
}

export interface PaymentChainClient {
  getTransaction(txHash: string): Promise<ChainTx | null>;
  getTransactionReceipt(txHash: string): Promise<ChainReceipt | null>;
  getBlockNumber(): Promise<number>;
  getBlockTimestamp(blockNumber: number): Promise<number>;
}

// viem 适配：每个 RPC 调用逐 rpcUrl 轮换（retryCount: 0，与 dividends 一致），全部失败才抛出。
export function createPaymentChainClient(rpcUrls: string[], chainId: number): PaymentChainClient {
  const clients = rpcUrls.map((url) =>
    createPublicClient({
      chain: { ...bsc, id: chainId } as Chain,
      transport: http(url, { timeout: 15_000, retryCount: 0 }),
    })
  );
  if (clients.length === 0) throw new Error('no rpc urls configured');

  async function rotate<T>(fn: (client: (typeof clients)[number]) => Promise<T>): Promise<T> {
    let lastErr: unknown = null;
    for (const client of clients) {
      try {
        return await fn(client);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return {
    async getTransaction(txHash) {
      return rotate(async (client) => {
        try {
          const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
          return {
            hash: tx.hash,
            from: tx.from,
            to: tx.to ?? null,
            value: tx.value,
            blockNumber: tx.blockNumber === null ? null : Number(tx.blockNumber),
          };
        } catch (err: any) {
          if (err?.name === 'TransactionNotFoundError') return null;
          throw err;
        }
      });
    },
    async getTransactionReceipt(txHash) {
      return rotate(async (client) => {
        try {
          const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
          return {
            status: receipt.status === 'success' ? '0x1' : '0x0',
            blockNumber: Number(receipt.blockNumber),
            logs: receipt.logs.map((log) => ({
              address: log.address,
              topics: log.topics as unknown as string[],
              data: log.data,
              logIndex: log.logIndex,
            })),
          };
        } catch (err: any) {
          if (err?.name === 'TransactionReceiptNotFoundError') return null;
          throw err;
        }
      });
    },
    async getBlockNumber() {
      return rotate(async (client) => Number(await client.getBlockNumber()));
    },
    async getBlockTimestamp(blockNumber) {
      return rotate(async (client) => Number((await client.getBlock({ blockNumber: BigInt(blockNumber) })).timestamp));
    },
  };
}

// 按 chainId 取链配置；同一条链有多项（双代币）时，可用 tokenHint（订单冻结的
// 代币类型/合约地址）精确匹配对应项，无匹配回退该 chainId 的第一项（旧行为）。
export function pickChainConfig(
  config: PaymentConfigPayload,
  chainId: number,
  tokenHint?: { type: string; address: string | null }
): PaymentChainConfig | null {
  const candidates = config.chains.filter((c) => c.chainId === chainId);
  if (candidates.length === 0) return null;
  if (tokenHint) {
    const addr = (tokenHint.address ?? '').toLowerCase();
    const match = candidates.find((c) =>
      tokenHint.type === 'erc20'
        ? c.token.type === 'erc20' && (c.token.address ?? '').toLowerCase() === addr
        : c.token.type === 'native'
    );
    if (match) return match;
  }
  return candidates[0];
}

export type VerifyOutcome = 'verified' | 'confirming' | 'failed' | 'retry' | 'submitted';

export interface VerifyResult {
  outcome: VerifyOutcome;
  order: PaymentOrderRow;
  error?: string;
}

export async function writeVerifyAttempt(
  db: D1Database,
  orderId: string,
  result: 'ok' | 'retry' | 'failed',
  error: string | null,
  detail?: unknown
): Promise<void> {
  await db
    .prepare('INSERT INTO payment_verify_attempts (order_id, result, error, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(orderId, result, error, detail !== undefined ? JSON.stringify(detail) : null, new Date().toISOString())
    .run();
}

async function loadOrder(db: D1Database, id: string): Promise<PaymentOrderRow | null> {
  return db.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(id).first<PaymentOrderRow>();
}

async function transition(
  db: D1Database,
  order: PaymentOrderRow,
  status: PaymentOrderRow['status'],
  statusReason: string | null,
  extra?: { confirmed_at?: string; tx_block_number?: number }
): Promise<PaymentOrderRow> {
  const now = new Date().toISOString();
  await db
    .prepare('UPDATE payment_orders SET status = ?, status_reason = ?, updated_at = ?, confirmed_at = COALESCE(?, confirmed_at), tx_block_number = COALESCE(?, tx_block_number) WHERE id = ?')
    .bind(status, statusReason, now, extra?.confirmed_at ?? null, extra?.tx_block_number ?? null, order.id)
    .run();
  return (await loadOrder(db, order.id))!;
}

async function failOrder(
  db: D1Database,
  order: PaymentOrderRow,
  reason: string,
  detail?: unknown
): Promise<VerifyResult> {
  await writeVerifyAttempt(db, order.id, 'failed', reason, detail);
  return { outcome: 'failed', error: reason, order: await transition(db, order, 'failed', reason) };
}

// 契约 §5 验款主流程。client 必须由订单冻结链配置构造（路由/cron 负责）。
export async function verifyOrder(
  db: D1Database,
  order: PaymentOrderRow,
  chainConfig: PaymentChainConfig,
  client: PaymentChainClient,
  opts: { now?: Date } = {}
): Promise<VerifyResult> {
  const txHash = order.tx_hash;
  if (!txHash) return { outcome: 'retry', error: 'no_tx_hash', order };

  let tx: ChainTx | null;
  let receipt: ChainReceipt | null;
  let latestBlock: number;
  try {
    tx = await client.getTransaction(txHash);
    receipt = await client.getTransactionReceipt(txHash);
    latestBlock = await client.getBlockNumber();
  } catch (err: any) {
    // RPC 全挂：保持状态等 cron 重试
    await writeVerifyAttempt(db, order.id, 'retry', `rpc_error: ${err?.message ?? String(err)}`);
    return { outcome: 'retry', error: 'rpc_error', order };
  }

  // §5.7 收据消失（重组）→ 回退 submitted，不发放
  if (receipt === null) {
    if (order.status === 'confirming') {
      await writeVerifyAttempt(db, order.id, 'retry', 'receipt_disappeared_reorg');
      return { outcome: 'submitted', order: await transition(db, order, 'submitted', 'reorg_receipt_disappeared') };
    }
    await writeVerifyAttempt(db, order.id, 'retry', tx === null ? 'tx_not_found' : 'tx_pending');
    return { outcome: 'retry', error: 'tx_pending', order };
  }

  // §5.2 receipt.status == '0x1'
  if (receipt.status !== '0x1') {
    return failOrder(db, order, 'tx_failed');
  }

  // §5.2 确认数不足 → confirming
  const confirmations = latestBlock - receipt.blockNumber + 1;
  if (confirmations < chainConfig.confirmations) {
    await writeVerifyAttempt(db, order.id, 'retry', 'insufficient_confirmations', { confirmations, required: chainConfig.confirmations });
    return { outcome: 'confirming', order: await transition(db, order, 'confirming', null) };
  }

  // §5.3 付款人必须等于订单钱包
  if (!tx || tx.from.toLowerCase() !== order.wallet_address) {
    return failOrder(db, order, 'payer_mismatch', { from: tx?.from ?? null });
  }

  // §5.4 金额/收款人校验（BigInt）
  const required = BigInt(order.amount);
  const recipient = order.recipient_address.toLowerCase();
  let logIndex: number | null = null;
  if (order.token_type === 'native') {
    if (!tx.to || tx.to.toLowerCase() !== recipient) {
      return failOrder(db, order, 'recipient_mismatch', { to: tx.to });
    }
    if (tx.value < required) {
      return failOrder(db, order, 'amount_insufficient', { value: tx.value.toString(), required: order.amount });
    }
  } else {
    const tokenAddress = (order.token_address ?? '').toLowerCase();
    const recipientTopic = `0x${'0'.repeat(24)}${recipient.slice(2)}`;
    const match = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() === tokenAddress &&
        log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
        log.topics[2]?.toLowerCase() === recipientTopic &&
        BigInt(log.data) >= required
    );
    if (!match) {
      const fromToken = receipt.logs.some(
        (log) => log.address.toLowerCase() === tokenAddress && log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC
      );
      return failOrder(db, order, fromToken ? 'amount_insufficient' : 'recipient_mismatch');
    }
    logIndex = match.logIndex;
  }

  // §5.5 区块时间窗 [created_at − 600s, 提交时间（tx_claims.claimed_at）]
  let blockTimestamp: number;
  try {
    blockTimestamp = await client.getBlockTimestamp(receipt.blockNumber);
  } catch (err: any) {
    await writeVerifyAttempt(db, order.id, 'retry', `rpc_error: ${err?.message ?? String(err)}`);
    return { outcome: 'retry', error: 'rpc_error', order };
  }
  const claim = await db
    .prepare('SELECT * FROM payment_tx_claims WHERE chain_id = ? AND tx_hash = ?')
    .bind(order.chain_id, txHash)
    .first<PaymentTxClaimRow>();
  const createdMs = Date.parse(order.created_at);
  const claimedMs = claim ? Date.parse(claim.claimed_at) : Date.parse(order.updated_at);
  const blockMs = blockTimestamp * 1000;
  // §5.5 区块时间窗 [created_at − 600s, claimedMs + 120s]（容忍 EVM 节点 120s 未来时钟漂移）
  const MAX_CLOCK_SKEW_MS = 120_000;
  if (blockMs < createdMs - 600_000 || blockMs > claimedMs + MAX_CLOCK_SKEW_MS) {
    return failOrder(db, order, 'invalid_block_time', {
      blockTime: new Date(blockMs).toISOString(),
      window: [new Date(createdMs - 600_000).toISOString(), new Date(claimedMs + MAX_CLOCK_SKEW_MS).toISOString()],
    });
  }

  // 全部通过 → verified（记录 logIndex 供审计）
  if (logIndex !== null) {
    await db
      .prepare('UPDATE payment_tx_claims SET log_index = ? WHERE chain_id = ? AND tx_hash = ?')
      .bind(logIndex, order.chain_id, txHash)
      .run();
  }
  await writeVerifyAttempt(db, order.id, 'ok', null, { confirmations, blockNumber: receipt.blockNumber, logIndex });
  const verified = await transition(db, order, 'verified', null, {
    confirmed_at: (opts.now ?? new Date()).toISOString(),
    tx_block_number: receipt.blockNumber,
  });
  return { outcome: 'verified', order: verified };
}
