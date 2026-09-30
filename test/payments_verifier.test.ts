// 验款器单元测试（契约 §5 全分支）：PaymentChainClient 注入式 stub，不打真实 RPC。

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockD1Database } from './helpers/db';
import { saveConfig, type PaymentConfigPayload, type PaymentChainConfig } from '../src/services/payments/config';
import {
  verifyOrder,
  pickChainConfig,
  ERC20_TRANSFER_TOPIC,
  type ChainReceipt,
  type ChainTx,
  type PaymentChainClient,
} from '../src/services/payments/verifier';
import type { PaymentOrderRow } from '../src/db/schema';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const TX_HASH = '0x' + 'ab'.repeat(32);

let db: D1Database;
let chain: PaymentChainConfig;

function payload(): PaymentConfigPayload {
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
    chains: [
      {
        chainId: 56,
        rpcUrls: ['https://rpc1.example.com'],
        confirmations: 12,
        recipientAddress: RECIPIENT,
        token: { type: 'native', symbol: 'BNB', decimals: 18, address: null },
      },
    ],
  };
}

beforeEach(async () => {
  db = createMockD1Database(true);
  await saveConfig(db, payload(), 'tester');
  chain = pickChainConfig(payload(), 56)!;
});

async function makeOrder(overrides: Partial<PaymentOrderRow> = {}): Promise<PaymentOrderRow> {
  const now = new Date();
  const id = overrides.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO payment_orders (id, wallet_address, kind, amount, list_amount, chain_id, token_type, token_address, token_symbol, token_decimals, recipient_address, config_version, status, tx_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 56, ?, ?, 'BNB', 18, ?, 1, 'submitted', ?, ?, ?, ?)`
    )
    .bind(
      id,
      overrides.wallet_address ?? WALLET,
      overrides.kind ?? 'membership_month',
      overrides.amount ?? '5000000000000000000',
      overrides.list_amount ?? '5000000000000000000',
      overrides.token_type ?? 'native',
      overrides.token_address ?? null,
      overrides.recipient_address ?? RECIPIENT,
      overrides.tx_hash ?? TX_HASH,
      overrides.expires_at ?? new Date(now.getTime() + 1800_000).toISOString(),
      overrides.created_at ?? now.toISOString(),
      now.toISOString()
    )
    .run();
  await db
    .prepare('INSERT INTO payment_tx_claims (chain_id, tx_hash, order_id, claimed_at) VALUES (56, ?, ?, ?)')
    .bind(overrides.tx_hash ?? TX_HASH, id, now.toISOString())
    .run();
  return (await db.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(id).first<PaymentOrderRow>())!;
}

function stubClient(over: Partial<PaymentChainClient>): PaymentChainClient {
  const nowSec = Math.floor(Date.now() / 1000);
  const tx: ChainTx = { hash: TX_HASH, from: WALLET, to: RECIPIENT, value: 5000000000000000000n, blockNumber: 90 };
  const receipt: ChainReceipt = { status: '0x1', blockNumber: 90, logs: [] };
  return {
    getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => 110, // confirmations = 110-90+1 = 21 ≥ 12
    getBlockTimestamp: async () => nowSec,
    ...over,
  };
}

async function lastAttempt(orderId: string): Promise<{ result: string; error: string | null }> {
  return (await db
    .prepare('SELECT result, error FROM payment_verify_attempts WHERE order_id = ? ORDER BY id DESC LIMIT 1')
    .bind(orderId)
    .first<{ result: string; error: string | null }>())!;
}

describe('verifyOrder (契约 §5)', () => {
  it('happy path: native payment verified, confirmed_at/blockNumber set, attempt ok', async () => {
    const order = await makeOrder();
    const res = await verifyOrder(db, order, chain, stubClient({}));
    expect(res.outcome).toBe('verified');
    expect(res.order.status).toBe('verified');
    expect(res.order.confirmed_at).not.toBeNull();
    expect(res.order.tx_block_number).toBe(90);
    expect((await lastAttempt(order.id)).result).toBe('ok');
  });

  it('tx not found → retry, stays submitted', async () => {
    const order = await makeOrder();
    const res = await verifyOrder(db, order, chain, stubClient({ getTransaction: async () => null, getTransactionReceipt: async () => null }));
    expect(res.outcome).toBe('retry');
    expect(res.order.status).toBe('submitted');
    expect((await lastAttempt(order.id)).error).toBe('tx_not_found');
  });

  it('receipt disappeared while confirming → back to submitted (reorg, §5.7)', async () => {
    let order = await makeOrder();
    await db.prepare("UPDATE payment_orders SET status = 'confirming' WHERE id = ?").bind(order.id).run();
    order = (await db.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(order.id).first<PaymentOrderRow>())!;
    const res = await verifyOrder(db, order, chain, stubClient({ getTransactionReceipt: async () => null }));
    expect(res.outcome).toBe('submitted');
    expect(res.order.status).toBe('submitted');
    expect((await lastAttempt(order.id)).error).toBe('receipt_disappeared_reorg');
  });

  it('receipt status != 0x1 → failed(tx_failed)', async () => {
    const order = await makeOrder();
    const res = await verifyOrder(db, order, chain, stubClient({ getTransactionReceipt: async () => ({ status: '0x0', blockNumber: 90, logs: [] }) }));
    expect(res.outcome).toBe('failed');
    expect(res.order.status).toBe('failed');
    expect(res.order.status_reason).toBe('tx_failed');
  });

  it('insufficient confirmations → confirming', async () => {
    const order = await makeOrder();
    const res = await verifyOrder(db, order, chain, stubClient({ getBlockNumber: async () => 95 })); // conf = 6 < 12
    expect(res.outcome).toBe('confirming');
    expect(res.order.status).toBe('confirming');
    expect((await lastAttempt(order.id)).error).toBe('insufficient_confirmations');
  });

  it('payer mismatch → failed(payer_mismatch)', async () => {
    const order = await makeOrder();
    const res = await verifyOrder(
      db,
      order,
      chain,
      stubClient({ getTransaction: async () => ({ hash: TX_HASH, from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', to: RECIPIENT, value: 5000000000000000000n, blockNumber: 90 }) })
    );
    expect(res.outcome).toBe('failed');
    expect(res.order.status_reason).toBe('payer_mismatch');
  });

  it('native recipient mismatch → failed(recipient_mismatch)', async () => {
    const order = await makeOrder();
    const res = await verifyOrder(
      db,
      order,
      chain,
      stubClient({ getTransaction: async () => ({ hash: TX_HASH, from: WALLET, to: '0x3333333333333333333333333333333333333333', value: 5000000000000000000n, blockNumber: 90 }) })
    );
    expect(res.order.status_reason).toBe('recipient_mismatch');
  });

  it('native amount insufficient → failed(amount_insufficient), BigInt compare', async () => {
    const order = await makeOrder();
    const res = await verifyOrder(
      db,
      order,
      chain,
      stubClient({ getTransaction: async () => ({ hash: TX_HASH, from: WALLET, to: RECIPIENT, value: 4999999999999999999n, blockNumber: 90 }) })
    );
    expect(res.order.status_reason).toBe('amount_insufficient');
  });

  it('erc20: matching Transfer log → verified, log_index recorded', async () => {
    const order = await makeOrder({ token_type: 'erc20', token_address: TOKEN });
    const toTopic = `0x${'0'.repeat(24)}${RECIPIENT.slice(2)}`;
    const logs = [
      // 干扰 log：别的代币合约
      { address: '0x4444444444444444444444444444444444444444', topics: [ERC20_TRANSFER_TOPIC, '0x', toTopic], data: '0xde0b6b3a7640000', logIndex: 0 },
      // 匹配 log：金额恰好等于应付
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, '0x', toTopic], data: '0x4563918244f40000', logIndex: 3 },
    ];
    const res = await verifyOrder(db, order, chain, stubClient({ getTransactionReceipt: async () => ({ status: '0x1', blockNumber: 90, logs }) }));
    expect(res.outcome).toBe('verified');
    const claim = await db.prepare('SELECT log_index FROM payment_tx_claims WHERE order_id = ?').bind(order.id).first<{ log_index: number }>();
    expect(claim!.log_index).toBe(3);
  });

  it('erc20: no matching log → failed(recipient_mismatch)', async () => {
    const order = await makeOrder({ token_type: 'erc20', token_address: TOKEN });
    const res = await verifyOrder(db, order, chain, stubClient({}));
    expect(res.outcome).toBe('failed');
    expect(res.order.status_reason).toBe('recipient_mismatch');
  });

  it('erc20: transfer to recipient but amount too small → failed(amount_insufficient)', async () => {
    const order = await makeOrder({ token_type: 'erc20', token_address: TOKEN });
    const toTopic = `0x${'0'.repeat(24)}${RECIPIENT.slice(2)}`;
    const logs = [{ address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, '0x', toTopic], data: '0x1', logIndex: 0 }];
    const res = await verifyOrder(db, order, chain, stubClient({ getTransactionReceipt: async () => ({ status: '0x1', blockNumber: 90, logs }) }));
    expect(res.order.status_reason).toBe('amount_insufficient');
  });

  it('block time outside window → failed(invalid_block_time)', async () => {
    const order = await makeOrder();
    const oldSec = Math.floor((Date.parse(order.created_at) - 1200_000) / 1000); // 早于 created_at−600s
    const res = await verifyOrder(db, order, chain, stubClient({ getBlockTimestamp: async () => oldSec }));
    expect(res.outcome).toBe('failed');
    expect(res.order.status_reason).toBe('invalid_block_time');
  });

  it('block time at window lower bound (created_at−600s) is accepted', async () => {
    const order = await makeOrder();
    const boundSec = Math.ceil((Date.parse(order.created_at) - 600_000) / 1000); // 秒级向上取整，落在下界内
    const res = await verifyOrder(db, order, chain, stubClient({ getBlockTimestamp: async () => boundSec }));
    expect(res.outcome).toBe('verified');
  });

  it('all RPCs down → retry, status unchanged', async () => {
    const order = await makeOrder();
    const broken: PaymentChainClient = {
      getTransaction: async () => { throw new Error('connection refused'); },
      getTransactionReceipt: async () => { throw new Error('connection refused'); },
      getBlockNumber: async () => { throw new Error('connection refused'); },
      getBlockTimestamp: async () => { throw new Error('connection refused'); },
    };
    const res = await verifyOrder(db, order, chain, broken);
    expect(res.outcome).toBe('retry');
    expect(res.order.status).toBe('submitted');
    expect((await lastAttempt(order.id)).error).toContain('rpc_error');
  });
});
