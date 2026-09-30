import { isAddress } from 'viem';
import type { ReportCategory, ReportEvidenceRow, ReportRow, UserRow } from '../db/schema';
import { isGroupLike } from '../db/schema';
import { normalizeAddress } from '../db';

const REPORT_CATEGORIES: ReadonlySet<string> = new Set([
  'harassment',
  'fraud',
  'account_theft',
  'infringement',
  'counterfeit',
  'impersonation',
  'minor_protection',
  'irrational_fandom',
]);

const EVIDENCE_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/avif': 'avif',
};

const MAX_EVIDENCE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_EVIDENCE_KEYS = 10;
const MAX_MESSAGE_IDS = 50;
const MAX_DESCRIPTION_LENGTH = 4_000;

export interface CreateReportInput {
  target_type?: 'user' | 'group';
  reported_user_id?: string;
  reported_wallet_address?: string;
  reported_group_id?: string;
  category?: string;
  message_ids?: string[];
  description?: string;
  evidence_keys?: string[];
}

export interface ReportView extends Omit<ReportRow, 'message_ids'> {
  message_ids: string[];
  evidence_keys: string[];
}

function stringArray(value: unknown, fieldName: string, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${fieldName} must be an array of non-empty strings`);
  }
  const entries = value.map((entry) => entry.trim());
  if (entries.length > maxLength) throw new Error(`${fieldName} can contain at most ${maxLength} items`);
  if (new Set(entries).size !== entries.length) throw new Error(`${fieldName} cannot contain duplicates`);
  return entries;
}

function parseMessageIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

async function resolveReportedUser(
  db: D1Database,
  input: CreateReportInput
): Promise<{ user_id: string | null; wallet_address: string }> {
  const walletRaw = input.reported_wallet_address?.trim();
  if (!walletRaw || !isAddress(walletRaw)) {
    throw new Error('reported_wallet_address must be a valid EVM wallet address');
  }
  const walletAddress = normalizeAddress(walletRaw);

  if (!input.reported_user_id?.trim()) {
    const existing = await db.prepare('SELECT id FROM users WHERE wallet_address = ?').bind(walletAddress).first<{ id: string }>();
    return { user_id: existing?.id ?? null, wallet_address: walletAddress };
  }

  const user = await db.prepare('SELECT id, wallet_address FROM users WHERE id = ?').bind(input.reported_user_id.trim()).first<UserRow>();
  if (!user) throw new Error('Reported user not found');
  if (normalizeAddress(user.wallet_address) !== walletAddress) {
    throw new Error('reported_user_id does not match reported_wallet_address');
  }
  return { user_id: user.id, wallet_address: walletAddress };
}

interface ResolvedReportTarget {
  target_type: 'user' | 'group';
  reported_user_id: string | null;
  reported_wallet_address: string | null;
  reported_group_id: string | null;
}

async function resolveReportTarget(
  db: D1Database,
  reporterUserId: string,
  input: CreateReportInput
): Promise<ResolvedReportTarget> {
  const targetType = input.target_type ?? 'user';
  if (targetType !== 'user' && targetType !== 'group') {
    throw new Error('target_type must be one of: user, group');
  }
  if (targetType === 'user') {
    const reported = await resolveReportedUser(db, input);
    return {
      target_type: 'user',
      reported_user_id: reported.user_id,
      reported_wallet_address: reported.wallet_address,
      reported_group_id: null,
    };
  }

  const groupId = input.reported_group_id?.trim();
  if (!groupId) throw new Error('reported_group_id is required when target_type is group');
  const group = await db.prepare("SELECT id, type FROM conversations WHERE id = ?").bind(groupId).first<{ id: string; type: string }>();
  if (!group || !isGroupLike(group.type)) throw new Error('Reported group not found');
  const membership = await db.prepare(
    'SELECT id FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(groupId, reporterUserId).first();
  if (!membership) throw new Error('Reported group is unavailable to the reporting user');
  return { target_type: 'group', reported_user_id: null, reported_wallet_address: null, reported_group_id: groupId };
}

async function assertMessageIdsAreVisibleToReporter(
  db: D1Database,
  reporterUserId: string,
  messageIds: string[]
): Promise<void> {
  for (const messageId of messageIds) {
    const message = await db.prepare(`
      SELECT m.id
      FROM messages m
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE m.id = ?
    `).bind(reporterUserId, messageId).first();
    if (!message) throw new Error(`Message is unavailable to the reporting user: ${messageId}`);
  }
}

export async function uploadReportEvidence(
  db: D1Database,
  r2: R2Bucket,
  uploaderUserId: string,
  file: File
): Promise<ReportEvidenceRow> {
  const mimeType = file.type.toLowerCase().split(';')[0].trim();
  const extension = EVIDENCE_IMAGE_TYPES[mimeType];
  if (!extension) throw new Error('Unsupported evidence image format; use JPEG, PNG, WebP, GIF, HEIC, or AVIF');
  if (file.size === 0) throw new Error('Evidence image cannot be empty');
  if (file.size > MAX_EVIDENCE_SIZE_BYTES) throw new Error('Evidence image exceeds the 20MB limit');

  const data = new Uint8Array(await file.arrayBuffer());
  const objectKey = `report-evidence/${uploaderUserId}/${crypto.randomUUID()}.${extension}`;
  const now = Date.now();
  await r2.put(objectKey, data, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { uploaderUserId, purpose: 'user-report-evidence' },
  });

  try {
    await db.prepare(`
      INSERT INTO report_evidence (object_key, uploaded_by, report_id, mime_type, size, created_at)
      VALUES (?, ?, NULL, ?, ?, ?)
    `).bind(objectKey, uploaderUserId, mimeType, data.byteLength, now).run();
  } catch (err) {
    await r2.delete(objectKey).catch(() => undefined);
    throw err;
  }

  return { object_key: objectKey, uploaded_by: uploaderUserId, report_id: null, mime_type: mimeType, size: data.byteLength, created_at: now };
}

export async function createReport(
  db: D1Database,
  reporter: UserRow,
  input: CreateReportInput
): Promise<ReportView> {
  if (!input.category || !REPORT_CATEGORIES.has(input.category)) {
    throw new Error(`category must be one of: ${[...REPORT_CATEGORIES].join(', ')}`);
  }
  const description = input.description?.trim() || null;
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description is too long (max ${MAX_DESCRIPTION_LENGTH} characters)`);
  }
  const messageIds = stringArray(input.message_ids, 'message_ids', MAX_MESSAGE_IDS);
  const evidenceKeys = stringArray(input.evidence_keys, 'evidence_keys', MAX_EVIDENCE_KEYS);
  const reported = await resolveReportTarget(db, reporter.id, input);
  await assertMessageIdsAreVisibleToReporter(db, reporter.id, messageIds);

  for (const objectKey of evidenceKeys) {
    const evidence = await db.prepare(`
      SELECT object_key FROM report_evidence
      WHERE object_key = ? AND uploaded_by = ? AND report_id IS NULL
    `).bind(objectKey, reporter.id).first();
    if (!evidence) throw new Error('One or more evidence_keys are invalid, already attached, or do not belong to you');
  }

  const now = Date.now();
  const report: ReportRow = {
    id: crypto.randomUUID(),
    reporter_user_id: reporter.id,
    reported_user_id: reported.reported_user_id,
    reported_wallet_address: reported.reported_wallet_address,
    reported_group_id: reported.reported_group_id,
    target_type: reported.target_type,
    category: input.category as ReportCategory,
    message_ids: JSON.stringify(messageIds),
    description,
    status: 'received',
    created_at: now,
  };

  await db.batch([
    db.prepare(`
      INSERT INTO reports (
        id, reporter_user_id, reported_user_id, reported_wallet_address, reported_group_id, target_type,
        category, message_ids, description, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)
    `).bind(
      report.id, report.reporter_user_id, report.reported_user_id, report.reported_wallet_address,
      report.reported_group_id, report.target_type,
      report.category, report.message_ids, report.description, report.created_at
    ),
    ...evidenceKeys.map((objectKey) => db.prepare(`
      UPDATE report_evidence SET report_id = ?
      WHERE object_key = ? AND uploaded_by = ? AND report_id IS NULL
    `).bind(report.id, objectKey, reporter.id)),
  ]);

  return { ...report, message_ids: messageIds, evidence_keys: evidenceKeys };
}

export async function listMyReports(
  db: D1Database,
  reporterUserId: string,
  limitInput?: number
): Promise<ReportView[]> {
  const limit = Math.min(Math.max(Number(limitInput) || 50, 1), 100);
  const reports = await db.prepare(`
    SELECT * FROM reports WHERE reporter_user_id = ? ORDER BY created_at DESC LIMIT ?
  `).bind(reporterUserId, limit).all<ReportRow>();

  return Promise.all(reports.results.map(async (report) => {
    const evidence = await db.prepare(
      'SELECT object_key FROM report_evidence WHERE report_id = ? ORDER BY created_at ASC'
    ).bind(report.id).all<{ object_key: string }>();
    return { ...report, message_ids: parseMessageIds(report.message_ids), evidence_keys: evidence.results.map((row) => row.object_key) };
  }));
}
