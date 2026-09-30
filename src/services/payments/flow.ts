// 验款 → 发放编排：submit 即时调用与 cron 重试共用。
// 使用订单 config_version 冻结的链配置（契约 §5）。

import type { Env } from '../../types';
import type { PaymentOrderRow } from '../../db/schema';
import { getConfigByVersion } from './config';
import type { PaymentChainClient } from './verifier';
import { createPaymentChainClient, pickChainConfig, verifyOrder, writeVerifyAttempt, type VerifyResult } from './verifier';
import { grantOrder } from './grant';

// 测试注入缝：覆盖链客户端工厂（生产为 null，走 viem 真实 RPC）。
let clientFactoryOverride: ((rpcUrls: string[], chainId: number) => PaymentChainClient) | null = null;
export function setPaymentChainClientFactoryForTests(
  factory: ((rpcUrls: string[], chainId: number) => PaymentChainClient) | null
): void {
  clientFactoryOverride = factory;
}

function makeClient(rpcUrls: string[], chainId: number): PaymentChainClient {
  return clientFactoryOverride ? clientFactoryOverride(rpcUrls, chainId) : createPaymentChainClient(rpcUrls, chainId);
}

// 对单个订单验款；verified 则紧接着发放。任何 RPC/配置异常都不向外抛（写 verify_attempts 等 cron）。
export async function verifyAndMaybeGrant(db: D1Database, env: Env, order: PaymentOrderRow): Promise<VerifyResult | null> {
  const config = await getConfigByVersion(db, order.config_version);
  // 双代币：同 chainId 可能有多项链配置，用订单冻结的代币精确匹配（RPC/确认数按该项）
  const chain = config
    ? pickChainConfig(config, order.chain_id, { type: order.token_type, address: order.token_address })
    : null;
  if (!config || !chain) {
    await writeVerifyAttempt(db, order.id, 'retry', 'chain_not_in_config', { configVersion: order.config_version });
    return null;
  }
  const result = await verifyOrder(db, order, chain, makeClient(chain.rpcUrls, chain.chainId));
  if (result.outcome === 'verified') {
    const grant = await grantOrder(db, env, result.order.id);
    return { ...result, order: grant.order };
  }
  return result;
}
