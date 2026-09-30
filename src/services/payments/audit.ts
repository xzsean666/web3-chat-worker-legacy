// 管理员操作审计（契约 §1 payment_audit_log）。

export async function writeAudit(
  db: D1Database,
  actor: string,
  action: string,
  target: string | null,
  detail?: unknown
): Promise<void> {
  await db
    .prepare('INSERT INTO payment_audit_log (actor, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(actor, action, target, detail !== undefined ? JSON.stringify(detail) : null, new Date().toISOString())
    .run();
}
