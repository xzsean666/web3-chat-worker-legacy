// 内部管理 API（契约 §6 内部侧，前缀 /internal/admin，全部 internalAuth HMAC 鉴权）。
// 审计 actor 从 body.actor 取（Go 侧传管理员用户名），缺省 'system'。

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import type {
  GroupCapacityEntitlementRow,
  PaymentConfigVersionRow,
  PaymentOrderRow,
  PaymentOutboxRow,
  PaymentVerifyAttemptRow,
  ReportEvidenceRow,
  ReportRow,
  WalletEntitlementRow,
} from '../db/schema';
import { internalAuth } from '../middleware/internalAuth';
import { getActiveConfig, saveConfig, validateConfigPayload } from '../services/payments/config';
import type { PaymentConfigPayload } from '../services/payments/config';
import { writeAudit } from '../services/payments/audit';
import { getCommunityAnnouncement, setCommunityAnnouncement } from '../services/announcement';
import { buildGroupSnapshot, enqueueOutbox, rebuildWalletSnapshot } from '../services/payments/outbox';
import {
  createBanner,
  deleteBanner,
  listBanners,
  listCommunityGroups,
  setGroupBanned,
  setGroupFlags,
  updateBanner,
} from '../services/community';
import { deleteFeedPostAdmin, listFeedAdmin, updateFeedPostAdmin } from '../services/feed';
import {
  approveClubApplication,
  listClubApplicationsAdmin,
  rejectClubApplication,
} from '../services/clubApplications';
import {
  countPendingCleanup,
  isStorageLifecycleTarget,
  runStorageLifecycle,
  STORAGE_LIFECYCLE_TABLES,
  STORAGE_LIFECYCLE_TARGETS,
} from '../services/storageLifecycle';

const internalAdminRoutes = new Hono<AppEnv>();

internalAdminRoutes.use('*', internalAuth);

function clampPagination(c: { req: { query: (k: string) => string | undefined } }): { page: number; limit: number } {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));
  return { page, limit };
}

async function readBody(c: { req: { json: () => Promise<any> } }): Promise<Record<string, any>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

async function getOrder(db: D1Database, id: string): Promise<PaymentOrderRow | null> {
  return db.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(id).first<PaymentOrderRow>();
}

// 订单关联的 outbox ref_key：订单凭证 + 钱包快照 + 群快照
function orderRefKeys(order: PaymentOrderRow): string[] {
  const keys = [order.id, order.wallet_address];
  if (order.group_id) keys.push(order.group_id);
  return keys;
}

internalAdminRoutes.get('/config', async (c) => {
  const active = await getActiveConfig(c.env.DB);
  if (!active) return c.json({ version: null, payload: null });
  return c.json({ version: active.version, payload: active.payload });
});

// 社区公告（0024）：管理端读写，后台「社区管理 → 公告设置」用。
internalAdminRoutes.get('/community/announcement', async (c) => {
  return c.json(await getCommunityAnnouncement(c.env.DB));
});

internalAdminRoutes.put('/community/announcement', async (c) => {
  const body = await readBody(c);
  const result = await setCommunityAnnouncement(c.env.DB, body);
  if ('error' in result) return c.json({ error: result.error }, 400);
  await writeAudit(c.env.DB, body.actor?.toString() || 'admin', 'community_announcement_update', 'community_announcement:1', {
    text: result.text,
    enabled: result.enabled,
    start_at: result.start_at,
    end_at: result.end_at,
  });
  return c.json(result);
});

internalAdminRoutes.get('/config/versions', async (c) => {
  const { page, limit } = clampPagination(c);
  const total = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM payment_config_versions').first<{ n: number }>())?.n ?? 0;
  const rows = await c.env.DB.prepare(
    'SELECT id, version, change_summary, created_by, created_at, is_active FROM payment_config_versions ORDER BY version DESC LIMIT ? OFFSET ?'
  )
    .bind(limit, (page - 1) * limit)
    .all<Omit<PaymentConfigVersionRow, 'payload_json'>>();
  return c.json({ versions: rows.results, total, page, limit });
});

internalAdminRoutes.put('/config', async (c) => {
  const body = await readBody(c);
  const createdBy = typeof body.createdBy === 'string' && body.createdBy.trim() ? body.createdBy.trim() : null;
  if (!createdBy) return c.json({ error: 'INVALID_CONFIG', details: ['createdBy is required'] }, 400);
  // body 可为 {payload, createdBy}，也可直接把配置平铺在顶层
  const payload = (body.payload && typeof body.payload === 'object' ? body.payload : Object.fromEntries(
    Object.entries(body).filter(([k]) => k !== 'createdBy' && k !== 'payload')
  )) as unknown;
  const errors = validateConfigPayload(payload);
  if (errors.length > 0) return c.json({ error: 'INVALID_CONFIG', details: errors }, 400);

  const { version, changeSummary } = await saveConfig(c.env.DB, payload as PaymentConfigPayload, createdBy);
  await writeAudit(c.env.DB, createdBy, 'config_update', `v${version}`, changeSummary ? JSON.parse(changeSummary) : null);
  return c.json({ version });
});

internalAdminRoutes.get('/orders', async (c) => {
  const { page, limit } = clampPagination(c);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const wallet = c.req.query('wallet');
  if (wallet) {
    clauses.push('wallet_address = ?');
    params.push(wallet.toLowerCase());
  }
  const groupId = c.req.query('groupId');
  if (groupId) {
    clauses.push('group_id = ?');
    params.push(groupId);
  }
  const txHash = c.req.query('txHash');
  if (txHash) {
    clauses.push('tx_hash = ?');
    params.push(txHash.toLowerCase());
  }
  const status = c.req.query('status');
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const from = c.req.query('from');
  if (from) {
    clauses.push('created_at >= ?');
    params.push(from);
  }
  const to = c.req.query('to');
  if (to) {
    clauses.push('created_at <= ?');
    params.push(to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM payment_orders ${where}`).bind(...params).first<{ n: number }>())
      ?.n ?? 0;
  const rows = await c.env.DB.prepare(
    `SELECT * FROM payment_orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, (page - 1) * limit)
    .all<PaymentOrderRow>();
  return c.json({ orders: rows.results, total, page, limit });
});

internalAdminRoutes.get('/orders/:id', async (c) => {
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (!order) return c.json({ error: 'ORDER_NOT_FOUND' }, 404);
  const attempts = await c.env.DB.prepare(
    'SELECT * FROM payment_verify_attempts WHERE order_id = ? ORDER BY id DESC LIMIT 10'
  )
    .bind(order.id)
    .all<PaymentVerifyAttemptRow>();
  const keys = orderRefKeys(order);
  const placeholders = keys.map(() => '?').join(', ');
  const outbox = await c.env.DB.prepare(
    `SELECT * FROM payment_outbox WHERE ref_key IN (${placeholders}) ORDER BY id DESC LIMIT 20`
  )
    .bind(...keys)
    .all<PaymentOutboxRow>();
  return c.json({ order, verifyAttempts: attempts.results, outbox: outbox.results });
});

internalAdminRoutes.post('/orders/:id/retry-verify', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (!order) return c.json({ error: 'ORDER_NOT_FOUND' }, 404);
  const retryable = ['failed', 'manual_review', 'submitted', 'confirming'];
  if (!retryable.includes(order.status)) {
    return c.json({ error: 'INVALID_ORDER_STATE', status: order.status }, 409);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare("UPDATE payment_orders SET status = 'submitted', status_reason = NULL, updated_at = ? WHERE id = ?")
    .bind(now, order.id)
    .run();
  await writeAudit(c.env.DB, actor, 'retry_verify', order.id, {
    from: order.status,
    reason: typeof body.reason === 'string' ? body.reason : null,
  });
  return c.json({ order: await getOrder(c.env.DB, order.id) });
});

internalAdminRoutes.post('/orders/:id/retry-sync', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const order = await getOrder(c.env.DB, c.req.param('id'));
  if (!order) return c.json({ error: 'ORDER_NOT_FOUND' }, 404);
  const keys = orderRefKeys(order);
  const placeholders = keys.map(() => '?').join(', ');
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE payment_outbox SET status = 'pending', last_error = NULL, updated_at = ? WHERE ref_key IN (${placeholders}) AND status != 'pending'`
  )
    .bind(now, ...keys)
    .run();
  const updated = result.meta.changes ?? 0;
  await writeAudit(c.env.DB, actor, 'retry_sync', order.id, { updated });
  return c.json({ updated });
});

internalAdminRoutes.post('/revoke', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const now = new Date().toISOString();

  if (body.kind === 'membership') {
    const wallet = typeof body.walletAddress === 'string' ? body.walletAddress.toLowerCase() : null;
    if (!wallet) return c.json({ error: 'INVALID_REQUEST', details: ['walletAddress is required'] }, 400);
    const row = await c.env.DB.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?')
      .bind(wallet)
      .first<WalletEntitlementRow>();
    if (!row || (!row.membership_tier && !row.membership_expires_at)) {
      return c.json({ error: 'ENTITLEMENT_NOT_FOUND' }, 404);
    }
    await c.env.DB.prepare(
      'UPDATE wallet_entitlements SET membership_tier = NULL, membership_expires_at = NULL, entitlement_version = entitlement_version + 1, updated_at = ? WHERE wallet_address = ?'
    )
      .bind(now, wallet)
      .run();
    const updated = (await c.env.DB.prepare('SELECT * FROM wallet_entitlements WHERE wallet_address = ?')
      .bind(wallet)
      .first<WalletEntitlementRow>())!;
    // rebuildWalletSnapshot 会套用白名单永久会员覆盖（契约 §13），与客户端视角一致
    await enqueueOutbox(c.env.DB, 'wallet_snapshot', wallet, await rebuildWalletSnapshot(c.env.DB, wallet));
    await writeAudit(c.env.DB, actor, 'revoke_membership', wallet, {
      reason,
      previous: { tier: row.membership_tier, expiresAt: row.membership_expires_at },
    });
    return c.json({ entitlement: updated });
  }

  if (body.kind === 'capacity') {
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;
    if (!groupId) return c.json({ error: 'INVALID_REQUEST', details: ['groupId is required'] }, 400);
    const row = await c.env.DB.prepare('SELECT * FROM group_capacity_entitlements WHERE group_id = ?')
      .bind(groupId)
      .first<GroupCapacityEntitlementRow>();
    if (!row) return c.json({ error: 'ENTITLEMENT_NOT_FOUND' }, 404);
    await c.env.DB.prepare(
      'UPDATE group_capacity_entitlements SET capacity_tier = 50, revoked_at = ?, revoke_reason = ?, entitlement_version = entitlement_version + 1, updated_at = ? WHERE group_id = ?'
    )
      .bind(now, reason, now, groupId)
      .run();
    const updated = (await c.env.DB.prepare('SELECT * FROM group_capacity_entitlements WHERE group_id = ?')
      .bind(groupId)
      .first<GroupCapacityEntitlementRow>())!;
    await enqueueOutbox(c.env.DB, 'group_snapshot', groupId, buildGroupSnapshot(updated));
    await writeAudit(c.env.DB, actor, 'revoke_capacity', groupId, {
      reason,
      previous: { capacityTier: row.capacity_tier },
    });
    return c.json({ entitlement: updated });
  }

  return c.json({ error: 'INVALID_REQUEST', details: ["kind must be 'membership' or 'capacity'"] }, 400);
});

// 举报审核（用户/群举报，reports 表 + report_evidence；证据二进制存 VOICE_BUCKET 的 report-evidence/ 前缀）

internalAdminRoutes.get('/reports', async (c) => {
  const { page, limit } = clampPagination(c);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const status = c.req.query('status');
  if (status) {
    if (!['received', 'under_review', 'resolved', 'rejected'].includes(status)) {
      return c.json({ error: 'INVALID_REQUEST', details: ['status must be received|under_review|resolved|rejected'] }, 400);
    }
    clauses.push('r.status = ?');
    params.push(status);
  }
  const targetType = c.req.query('target_type');
  if (targetType) {
    if (!['user', 'group'].includes(targetType)) {
      return c.json({ error: 'INVALID_REQUEST', details: ['target_type must be user|group'] }, 400);
    }
    clauses.push('r.target_type = ?');
    params.push(targetType);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM reports r ${where}`).bind(...params).first<{ n: number }>())
      ?.n ?? 0;
  const rows = await c.env.DB.prepare(
    `SELECT r.*, c.name AS group_name,
       (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = r.reported_group_id) AS group_member_count
     FROM reports r
     LEFT JOIN conversations c ON c.id = r.reported_group_id
     ${where}
     ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, (page - 1) * limit)
    .all<ReportRow & { group_name: string | null; group_member_count: number | null }>();
  return c.json({ list: rows.results, total, page, limit });
});

async function getReport(db: D1Database, id: string): Promise<ReportRow | null> {
  return db.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<ReportRow>();
}

internalAdminRoutes.get('/reports/:id', async (c) => {
  const report = await getReport(c.env.DB, c.req.param('id'));
  if (!report) return c.json({ error: 'REPORT_NOT_FOUND' }, 404);
  const evidence = await c.env.DB.prepare(
    'SELECT object_key, mime_type, size, created_at FROM report_evidence WHERE report_id = ? ORDER BY created_at ASC'
  )
    .bind(report.id)
    .all<Pick<ReportEvidenceRow, 'object_key' | 'mime_type' | 'size' | 'created_at'>>();
  let group: { name: string | null; member_count: number } | null = null;
  if (report.target_type === 'group' && report.reported_group_id) {
    group = await c.env.DB.prepare(
      `SELECT c.name AS name,
         (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count
       FROM conversations c WHERE c.id = ?`
    )
      .bind(report.reported_group_id)
      .first<{ name: string | null; member_count: number }>();
  }
  return c.json({
    report,
    group,
    evidence_keys: evidence.results.map((row) => row.object_key),
    evidence: evidence.results,
  });
});

internalAdminRoutes.post('/reports/:id/review', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const action = body.action;
  if (action !== 'resolve' && action !== 'reject') {
    return c.json({ error: 'INVALID_REQUEST', details: ["action must be 'resolve' or 'reject'"] }, 400);
  }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  const report = await getReport(c.env.DB, c.req.param('id'));
  if (!report) return c.json({ error: 'REPORT_NOT_FOUND' }, 404);
  if (!['received', 'under_review'].includes(report.status)) {
    return c.json({ error: 'INVALID_REPORT_STATE', status: report.status }, 409);
  }
  const nextStatus = action === 'resolve' ? 'resolved' : 'rejected';
  await c.env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind(nextStatus, report.id).run();
  await writeAudit(c.env.DB, actor, 'report_review', report.id, {
    action,
    note,
    from: report.status,
    to: nextStatus,
    target_type: report.target_type,
    reported_group_id: report.reported_group_id,
    reported_wallet_address: report.reported_wallet_address,
  });
  return c.json({ report: await getReport(c.env.DB, report.id) });
});

// 证据图二进制回源（管理端详情页展示用）：key 必须属于该 report，且仅允许 report-evidence/ 前缀
internalAdminRoutes.get('/reports/:id/evidence/*', async (c) => {
  const reportId = c.req.param('id');
  const prefix = `/internal/admin/reports/${reportId}/evidence/`;
  const path = c.req.path;
  if (!path.startsWith(prefix)) return c.json({ error: 'REPORT_NOT_FOUND' }, 404);
  const objectKey = decodeURIComponent(path.slice(prefix.length));
  if (!objectKey.startsWith('report-evidence/') || objectKey.includes('..')) {
    return c.json({ error: 'INVALID_REQUEST', details: ['invalid evidence key'] }, 400);
  }
  const evidence = await c.env.DB.prepare(
    'SELECT * FROM report_evidence WHERE report_id = ? AND object_key = ?'
  )
    .bind(reportId, objectKey)
    .first<ReportEvidenceRow>();
  if (!evidence) return c.json({ error: 'EVIDENCE_NOT_FOUND' }, 404);
  const object = await c.env.VOICE_BUCKET.get(objectKey);
  if (!object) return c.json({ error: 'EVIDENCE_NOT_FOUND' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': evidence.mime_type,
      'Content-Length': String(evidence.size),
      'Cache-Control': 'private, no-store',
    },
  });
});

// ---------------------------------------------------------------------------
// 社区运营：公开群管理（列表/封禁）与 Banner CRUD
// ---------------------------------------------------------------------------

internalAdminRoutes.get('/community/groups', async (c) => {
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const keyword = c.req.query('keyword') ?? '';
  const result = await listCommunityGroups(c.env.DB, { keyword, offset, limit });
  return c.json({ list: result.items, total: result.total, offset: result.offset, limit: result.limit });
});

internalAdminRoutes.post('/community/groups/:id/ban', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
  const group = await setGroupBanned(c.env.DB, c.req.param('id'), true, reason);
  if (!group) return c.json({ error: 'GROUP_NOT_FOUND' }, 404);
  await writeAudit(c.env.DB, actor, 'community_group_ban', group.id, { reason: reason ?? null });
  return c.json({ group });
});

internalAdminRoutes.post('/community/groups/:id/unban', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const group = await setGroupBanned(c.env.DB, c.req.param('id'), false);
  if (!group) return c.json({ error: 'GROUP_NOT_FOUND' }, 404);
  await writeAudit(c.env.DB, actor, 'community_group_unban', group.id, null);
  return c.json({ group });
});

// 运营标记：{hot?, verified?} 布尔合并进 metadata（未提供的键不动），写审计
internalAdminRoutes.post('/community/groups/:id/flags', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const flags: { hot?: boolean; verified?: boolean } = {};
  if (body.hot !== undefined) {
    if (typeof body.hot !== 'boolean') return c.json({ error: 'INVALID_REQUEST', details: ['hot must be a boolean'] }, 400);
    flags.hot = body.hot;
  }
  if (body.verified !== undefined) {
    if (typeof body.verified !== 'boolean') return c.json({ error: 'INVALID_REQUEST', details: ['verified must be a boolean'] }, 400);
    flags.verified = body.verified;
  }
  if (flags.hot === undefined && flags.verified === undefined) {
    return c.json({ error: 'INVALID_REQUEST', details: ['hot or verified is required'] }, 400);
  }
  const group = await setGroupFlags(c.env.DB, c.req.param('id'), flags);
  if (!group) return c.json({ error: 'GROUP_NOT_FOUND' }, 404);
  await writeAudit(c.env.DB, actor, 'community_group_flags', group.id, { hot: group.hot, verified: group.verified });
  return c.json({ group });
});

// ---------------------------------------------------------------------------
// Club 创建申请审核：列表 / approve（实际创建 club）/ reject
// ---------------------------------------------------------------------------

internalAdminRoutes.get('/community/applications', async (c) => {
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  try {
    const result = await listClubApplicationsAdmin(c.env.DB, { status: c.req.query('status'), offset, limit });
    return c.json({ list: result.list, total: result.total, offset: result.offset, limit: result.limit });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('INVALID_STATUS')) return c.json({ error: 'INVALID_STATUS' }, 400);
    return c.json({ error: message }, 400);
  }
});

// 审核通过：实际创建 club（owner=申请人），回填 application.club_id/handled_*
internalAdminRoutes.post('/community/applications/:id/approve', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  try {
    const { application, club } = await approveClubApplication(c.env.DB, c.req.param('id'), actor);
    await writeAudit(c.env.DB, actor, 'club_application_approve', application.id, {
      applicant_id: application.applicant_id,
      club_id: club.id,
    });
    return c.json({ application, club });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('APPLICATION_NOT_FOUND')) return c.json({ error: 'APPLICATION_NOT_FOUND' }, 404);
    if (message.startsWith('APPLICATION_ALREADY_HANDLED')) return c.json({ error: 'APPLICATION_ALREADY_HANDLED' }, 409);
    return c.json({ error: message }, 400);
  }
});

internalAdminRoutes.post('/community/applications/:id/reject', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
  try {
    const application = await rejectClubApplication(c.env.DB, c.req.param('id'), actor, reason);
    await writeAudit(c.env.DB, actor, 'club_application_reject', application.id, {
      applicant_id: application.applicant_id,
      reason: reason ?? null,
    });
    return c.json({ application });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('APPLICATION_NOT_FOUND')) return c.json({ error: 'APPLICATION_NOT_FOUND' }, 404);
    if (message.startsWith('APPLICATION_ALREADY_HANDLED')) return c.json({ error: 'APPLICATION_ALREADY_HANDLED' }, 409);
    return c.json({ error: message }, 400);
  }
});

internalAdminRoutes.get('/community/banners', async (c) => {
  const banners = await listBanners(c.env.DB, true);
  return c.json({ banners });
});

internalAdminRoutes.post('/community/banners', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  try {
    const banner = await createBanner(c.env.DB, body);
    await writeAudit(c.env.DB, actor, 'community_banner_create', banner.id, {
      title: banner.title,
      sort: banner.sort,
      enabled: banner.enabled,
    });
    return c.json({ banner }, 201);
  } catch (err: any) {
    return c.json({ error: 'INVALID_REQUEST', details: [err.message] }, 400);
  }
});

internalAdminRoutes.put('/community/banners/:id', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  try {
    const banner = await updateBanner(c.env.DB, c.req.param('id'), body);
    if (!banner) return c.json({ error: 'BANNER_NOT_FOUND' }, 404);
    await writeAudit(c.env.DB, actor, 'community_banner_update', banner.id, {
      title: banner.title,
      sort: banner.sort,
      enabled: banner.enabled,
    });
    return c.json({ banner });
  } catch (err: any) {
    return c.json({ error: 'INVALID_REQUEST', details: [err.message] }, 400);
  }
});

internalAdminRoutes.delete('/community/banners/:id', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const removed = await deleteBanner(c.env.DB, c.req.param('id'));
  if (!removed) return c.json({ error: 'BANNER_NOT_FOUND' }, 404);
  await writeAudit(c.env.DB, actor, 'community_banner_delete', c.req.param('id'), null);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 动态 feed 管理：列表（含软删与作者信息）+ 编辑/软删（审计）
// ---------------------------------------------------------------------------

internalAdminRoutes.get('/feed/posts', async (c) => {
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const result = await listFeedAdmin(c.env.DB, { offset, limit, club_id: c.req.query('club_id') });
  return c.json({ list: result.list, total: result.total, offset: result.offset, limit: result.limit });
});

internalAdminRoutes.patch('/feed/posts/:id', async (c) => {
  try {
    const body = await readBody(c);
    const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
    const post = await updateFeedPostAdmin(c.env.DB, c.req.param('id'), {
      content: body.content,
      images: body.images,
    });
    if (!post) return c.json({ error: 'POST_NOT_FOUND' }, 404);
    await writeAudit(c.env.DB, actor, 'feed_post_edit', c.req.param('id'), {
      content: body.content !== undefined,
      images: body.images !== undefined,
    });
    return c.json({ post });
  } catch (err: any) {
    return c.json({ error: 'INVALID_REQUEST', details: [err.message] }, 400);
  }
});

internalAdminRoutes.delete('/feed/posts/:id', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  const removed = await deleteFeedPostAdmin(c.env.DB, c.req.param('id'));
  if (!removed) return c.json({ error: 'POST_NOT_FOUND' }, 404);
  await writeAudit(c.env.DB, actor, 'feed_post_delete', c.req.param('id'), null);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 存储生命周期：表行数统计 + 手动触发清理（dry_run 预览），规则与 cron 小时级全量一致
// ---------------------------------------------------------------------------

internalAdminRoutes.get('/storage/stats', async (c) => {
  const tables: Record<string, number> = {};
  for (const table of STORAGE_LIFECYCLE_TABLES) {
    tables[table] =
      (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
  }
  const pending: Record<string, number> = {};
  for (const target of STORAGE_LIFECYCLE_TARGETS) {
    pending[target] = await countPendingCleanup(c.env.DB, target);
  }
  return c.json({ tables, pending_cleanup: pending });
});

internalAdminRoutes.post('/storage/cleanup', async (c) => {
  const body = await readBody(c);
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'system';
  let targets: string[] | undefined;
  if (body.targets !== undefined) {
    if (
      !Array.isArray(body.targets) ||
      body.targets.length === 0 ||
      body.targets.some((t: unknown) => typeof t !== 'string' || !isStorageLifecycleTarget(t))
    ) {
      return c.json(
        { error: 'INVALID_REQUEST', details: [`targets must be a non-empty subset of: ${STORAGE_LIFECYCLE_TARGETS.join(', ')}`] },
        400
      );
    }
    targets = body.targets;
  }
  const dryRun = body.dry_run === true;
  const deleted = await runStorageLifecycle(c.env.DB, c.env.VOICE_BUCKET, { targets, dryRun });
  await writeAudit(c.env.DB, actor, 'storage_cleanup', null, {
    targets: targets ?? 'all',
    dry_run: dryRun,
    deleted,
  });
  return c.json({ deleted });
});

export { internalAdminRoutes };
