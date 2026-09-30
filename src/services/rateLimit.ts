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
  // 注意：D1 对 LIKE 模式长度有限制（实测长前缀直接报
  // "LIKE or GLOB pattern too complex"，node:sqlite 测试环境无此限制，
  // 属典型 mock/生产分歧点）——改用字符串范围比较（bucket 前缀相同即
  // 落在 [prefix, prefix+'~') 区间，'~'(0x7E) 大于窗口数字段所有字符）。
  const prefix = `${action}:${wallet.toLowerCase()}:`;
  await db
    .prepare(
      "DELETE FROM rate_limits WHERE bucket >= ? AND bucket < ? AND CAST(substr(bucket, ?) AS INTEGER) < ?",
    )
    .bind(prefix, `${prefix}~`, prefix.length + 1, windowStart - 1)
    .run();

  return count <= perMinute;
}
