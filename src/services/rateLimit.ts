// 用户侧限流（契约 §6）：D1 固定窗口，bucket = '<action>:<wallet>:<windowStartEpochMin>'。
// allow() 返回 false 表示超限（调用方返回 429 {error:'RATE_LIMITED'}）。

export async function allow(
  db: D1Database,
  action: string,
  wallet: string,
  perMinute: number
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 60_000);
  const bucket = `${action}:${wallet.toLowerCase()}:${windowStart}`;

  await db
    .prepare(
      'INSERT INTO rate_limits (bucket, count) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1'
    )
    .bind(bucket)
    .run();
  const row = await db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(bucket).first<{ count: number }>();
  const count = row?.count ?? 0;

  // 顺带清理本 (action, wallet) 过期窗口的行。
  // 优化：仅在进入新窗口的首个请求 (count === 1) 时触发清理，避免每条请求冗余 DELETE 产生 D1 写锁争用。
  if (count === 1) {
    const prefix = `${action}:${wallet.toLowerCase()}:`;
    await db
      .prepare(
        "DELETE FROM rate_limits WHERE bucket >= ? AND bucket < ? AND CAST(substr(bucket, ?) AS INTEGER) < ?",
      )
      .bind(prefix, `${prefix}~`, prefix.length + 1, windowStart - 1)
      .run();
  }

  return count <= perMinute;
}
