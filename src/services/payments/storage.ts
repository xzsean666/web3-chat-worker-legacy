// 权益快照 R2 存储（契约 §2）：
// 优先使用独立私有 bucket ENTITLEMENT_BUCKET（web3-chat-entitlements）；
// 未绑定时回退 VOICE_BUCKET，键统一带 entitlements/ 前缀（两个 bucket 均为私有）。

import type { Env } from '../../types';

export function getEntitlementBucket(env: Env): R2Bucket {
  return env.ENTITLEMENT_BUCKET ?? env.VOICE_BUCKET;
}

export function walletSnapshotKey(walletAddress: string): string {
  return `entitlements/wallets/${walletAddress.toLowerCase()}.json`;
}

export function groupSnapshotKey(groupId: string): string {
  return `entitlements/groups/${groupId}.json`;
}

export function orderReceiptKey(orderId: string): string {
  return `entitlements/orders/${orderId}.json`;
}
