// 内部管理 API 鉴权（契约 §7）：HMAC-SHA256(secret, `${ts}\n${nonce}\n${METHOD}\n${path}\n${sha256hex(body)}`)
// - X-Internal-Timestamp：unix 秒，|now−ts| ≤ 300s
// - X-Internal-Nonce：写 internal_nonces 防重放，冲突即拒绝；顺带清理 >10min 的旧 nonce
// - X-Internal-Signature：hex HMAC，常量时间比较
// - secret 缺失（未配置 INTERNAL_ADMIN_SECRET）→ 503，内部 API 不可用

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';

const MAX_SKEW_SECONDS = 300;
const NONCE_TTL_MS = 10 * 60 * 1000;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

export const internalAuth = createMiddleware<AppEnv>(async (c, next) => {
  const secret = c.env.INTERNAL_ADMIN_SECRET;
  if (!secret) {
    return c.json({ error: 'INTERNAL_AUTH_NOT_CONFIGURED' }, 503);
  }

  const ts = c.req.header('X-Internal-Timestamp');
  const nonce = c.req.header('X-Internal-Nonce');
  const signature = c.req.header('X-Internal-Signature');
  if (!ts || !nonce || !signature) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }

  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > MAX_SKEW_SECONDS) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }
  if (nonce.length > 128) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }

  const body = await c.req.raw.clone().arrayBuffer();
  const bodyHash = toHex(await crypto.subtle.digest('SHA-256', body));
  const message = `${ts}\n${nonce}\n${c.req.method.toUpperCase()}\n${c.req.path}\n${bodyHash}`;
  const expected = await hmacSha256Hex(secret, message);
  if (!timingSafeEqual(expected, signature.toLowerCase())) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }

  const now = new Date();
  const inserted = await c.env.DB.prepare(
    'INSERT INTO internal_nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING'
  )
    .bind(nonce, now.toISOString())
    .run();
  if ((inserted.meta.changes ?? 0) === 0) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }

  // 顺带清理超过 10 分钟的旧 nonce（内部 API 调用频率低，逐请求清理成本可忽略）
  const cutoff = new Date(now.getTime() - NONCE_TTL_MS).toISOString();
  await c.env.DB.prepare('DELETE FROM internal_nonces WHERE seen_at < ?').bind(cutoff).run();

  await next();
});
