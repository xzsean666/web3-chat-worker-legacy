// Club 创建申请：用户提交（仅会员、同时只允许一条 pending）、管理端审核。
// approve 时实际创建 club（createGroup type='club' + skipMembershipCheck 内部 bypass，
// 申请人已被人工审过），owner=申请人，回填 application.club_id/handled_*。

import type { ClubApplicationRow } from '../db/schema';
import { isMemberWallet } from './payments/config';
import { createGroup, type ConversationDetail } from './conversations';

export const MAX_CLUB_NAME_LENGTH = 100;
export const MAX_CLUB_DESCRIPTION_LENGTH = 500;
export const MAX_CLUB_APPLICATION_MESSAGE_LENGTH = 500;
export const MAX_CLUB_TAGS = 10;
export const MAX_CLUB_TAG_LENGTH = 32;

export interface ClubApplicationItem {
  id: string;
  applicant_id: string;
  applicant_wallet_address?: string;
  name: string;
  description: string | null;
  tags: string[];
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  review_reason: string | null;
  handled_by: string | null;
  handled_at: number | null;
  club_id: string | null;
  created_at: number;
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toItem(row: ClubApplicationRow & { applicant_wallet_address?: string | null }): ClubApplicationItem {
  const item: ClubApplicationItem = {
    id: row.id,
    applicant_id: row.applicant_id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags),
    message: row.message,
    status: row.status,
    review_reason: row.review_reason,
    handled_by: row.handled_by,
    handled_at: row.handled_at,
    club_id: row.club_id,
    created_at: row.created_at,
  };
  if (row.applicant_wallet_address !== undefined) {
    item.applicant_wallet_address = row.applicant_wallet_address ?? row.applicant_id;
  }
  return item;
}

function validateTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new Error('tags must be an array of strings');
  const list = tags.map((t) => String(t).trim()).filter((t) => t.length > 0);
  if (list.length > MAX_CLUB_TAGS) throw new Error(`tags exceeds maximum of ${MAX_CLUB_TAGS}`);
  for (const tag of list) {
    if (tag.length > MAX_CLUB_TAG_LENGTH) throw new Error(`tag is too long (max ${MAX_CLUB_TAG_LENGTH} characters)`);
  }
  return list;
}

/**
 * 提交 club 创建申请。仅会员钱包（isMemberWallet）；同一申请人已有 pending → APPLICATION_PENDING。
 */
export async function createClubApplication(
  db: D1Database,
  applicantId: string,
  input: { name?: unknown; description?: unknown; tags?: unknown; message?: unknown }
): Promise<ClubApplicationItem> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new Error('name is required');
  if (name.length > MAX_CLUB_NAME_LENGTH) throw new Error(`name is too long (max ${MAX_CLUB_NAME_LENGTH} characters)`);
  const description =
    typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null;
  if (description && description.length > MAX_CLUB_DESCRIPTION_LENGTH) {
    throw new Error(`description is too long (max ${MAX_CLUB_DESCRIPTION_LENGTH} characters)`);
  }
  const message = typeof input.message === 'string' && input.message.trim() ? input.message.trim() : null;
  if (message && message.length > MAX_CLUB_APPLICATION_MESSAGE_LENGTH) {
    throw new Error(`message is too long (max ${MAX_CLUB_APPLICATION_MESSAGE_LENGTH} characters)`);
  }
  const tags = validateTags(input.tags);

  if (!(await isMemberWallet(db, applicantId))) {
    throw new Error('MEMBERSHIP_REQUIRED: only member wallets can apply for a club');
  }

  const row: ClubApplicationRow = {
    id: crypto.randomUUID(),
    applicant_id: applicantId,
    name,
    description,
    tags: JSON.stringify(tags),
    message,
    status: 'pending',
    review_reason: null,
    handled_by: null,
    handled_at: null,
    club_id: null,
    created_at: Date.now(),
  };
  try {
    await db
      .prepare(
        "INSERT INTO club_applications (id, applicant_id, name, description, tags, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
      )
      .bind(row.id, row.applicant_id, row.name, row.description, row.tags, row.message, row.created_at)
      .run();
  } catch (err: any) {
    // 部分唯一索引 idx_club_applications_pending 命中 → 已有 pending 申请
    if (String(err?.message ?? err).includes('UNIQUE')) {
      throw new Error('APPLICATION_PENDING: you already have a pending club application');
    }
    throw err;
  }
  return toItem(row);
}

/** 当前用户最新一条申请（无 → null）。 */
export async function getMyClubApplication(db: D1Database, applicantId: string): Promise<ClubApplicationItem | null> {
  const row = await db
    .prepare('SELECT * FROM club_applications WHERE applicant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .bind(applicantId)
    .first<ClubApplicationRow>();
  return row ? toItem(row) : null;
}

// ---------------------------------------------------------------------------
// 管理端（internalAdmin）
// ---------------------------------------------------------------------------

export async function listClubApplicationsAdmin(
  db: D1Database,
  options: { status?: string; offset?: number; limit?: number } = {}
): Promise<{ list: ClubApplicationItem[]; total: number; offset: number; limit: number }> {
  const limit = Math.min(Math.max(Math.floor(Number(options.limit)) || 20, 1), 100);
  const offset = Math.max(Math.floor(Number(options.offset)) || 0, 0);
  const status = options.status;
  if (status !== undefined && status !== '' && !['pending', 'approved', 'rejected'].includes(status)) {
    throw new Error('INVALID_STATUS: status must be pending|approved|rejected');
  }
  const where = status ? 'WHERE a.status = ?' : '';
  const params: unknown[] = status ? [status] : [];
  const total =
    (await db.prepare(`SELECT COUNT(*) AS n FROM club_applications a ${where}`).bind(...params).first<{ n: number }>())?.n ?? 0;
  const res = await db
    .prepare(
      `SELECT a.*, u.wallet_address AS applicant_wallet_address
       FROM club_applications a
       LEFT JOIN users u ON u.id = a.applicant_id
       ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all<ClubApplicationRow & { applicant_wallet_address: string | null }>();
  return { list: res.results.map(toItem), total: Number(total), offset, limit };
}

async function getPendingApplication(db: D1Database, applicationId: string): Promise<ClubApplicationRow> {
  const row = await db.prepare('SELECT * FROM club_applications WHERE id = ?').bind(applicationId).first<ClubApplicationRow>();
  if (!row) throw new Error('APPLICATION_NOT_FOUND');
  if (row.status !== 'pending') throw new Error(`APPLICATION_ALREADY_HANDLED: status is ${row.status}`);
  return row;
}

/**
 * 审核通过：实际创建 club（owner=申请人，name/description/tags 写入），
 * 回填 application.status='approved' + club_id + handled_*。
 */
export async function approveClubApplication(
  db: D1Database,
  applicationId: string,
  handledBy: string
): Promise<{ application: ClubApplicationItem; club: ConversationDetail }> {
  const row = await getPendingApplication(db, applicationId);
  const club = await createGroup(db, row.applicant_id, row.name, [], {
    type: 'club',
    description: row.description ?? undefined,
    metadata: { tags: parseTags(row.tags) },
    skipMembershipCheck: true,
  });
  const handledAt = Date.now();
  await db
    .prepare("UPDATE club_applications SET status = 'approved', club_id = ?, handled_by = ?, handled_at = ? WHERE id = ? AND status = 'pending'")
    .bind(club.id, handledBy, handledAt, row.id)
    .run();
  const updated = (await db.prepare('SELECT * FROM club_applications WHERE id = ?').bind(row.id).first<ClubApplicationRow>())!;
  return { application: toItem(updated), club };
}

/** 审核拒绝：status='rejected' + review_reason + handled_*。 */
export async function rejectClubApplication(
  db: D1Database,
  applicationId: string,
  handledBy: string,
  reason?: string
): Promise<ClubApplicationItem> {
  const row = await getPendingApplication(db, applicationId);
  const handledAt = Date.now();
  await db
    .prepare("UPDATE club_applications SET status = 'rejected', review_reason = ?, handled_by = ?, handled_at = ? WHERE id = ? AND status = 'pending'")
    .bind(reason ?? null, handledBy, handledAt, row.id)
    .run();
  const updated = (await db.prepare('SELECT * FROM club_applications WHERE id = ?').bind(row.id).first<ClubApplicationRow>())!;
  return toItem(updated);
}
