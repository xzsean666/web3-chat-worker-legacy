// 社区公告（0024）：单行配置，公开读 + 管理端写。
// 客户端按 enabled 与时间窗（start_at/end_at，epoch ms，空=不限）决定显隐。

export interface CommunityAnnouncement {
  text: string;
  enabled: boolean;
  start_at: number | null;
  end_at: number | null;
  updated_at: number;
}

const MAX_TEXT_LENGTH = 200;

export async function getCommunityAnnouncement(
  db: D1Database
): Promise<CommunityAnnouncement> {
  const row = await db
    .prepare('SELECT text, enabled, start_at, end_at, updated_at FROM community_announcement WHERE id = 1')
    .first<{
      text: string;
      enabled: number;
      start_at: number | null;
      end_at: number | null;
      updated_at: number;
    }>();
  return {
    text: row?.text ?? '',
    enabled: row?.enabled === 1,
    start_at: row?.start_at ?? null,
    end_at: row?.end_at ?? null,
    updated_at: row?.updated_at ?? 0,
  };
}

export async function setCommunityAnnouncement(
  db: D1Database,
  input: { text?: unknown; enabled?: unknown; start_at?: unknown; end_at?: unknown }
): Promise<CommunityAnnouncement | { error: string }> {
  const current = await getCommunityAnnouncement(db);
  const text =
    input.text === undefined ? current.text : String(input.text ?? '').trim();
  if (text.length > MAX_TEXT_LENGTH) {
    return { error: `text is too long (max ${MAX_TEXT_LENGTH} characters)` };
  }
  const enabled =
    input.enabled === undefined ? current.enabled : input.enabled === true;
  const startAt =
    input.start_at === undefined ? current.start_at : toEpochOrNull(input.start_at);
  const endAt =
    input.end_at === undefined ? current.end_at : toEpochOrNull(input.end_at);
  if (input.start_at !== undefined && startAt === undefined) {
    return { error: 'start_at must be an epoch-ms number or null' };
  }
  if (input.end_at !== undefined && endAt === undefined) {
    return { error: 'end_at must be an epoch-ms number or null' };
  }
  if (startAt != null && endAt != null && endAt <= startAt) {
    return { error: 'end_at must be later than start_at' };
  }
  await db
    .prepare(
      'UPDATE community_announcement SET text = ?, enabled = ?, start_at = ?, end_at = ?, updated_at = ? WHERE id = 1'
    )
    .bind(text, enabled ? 1 : 0, startAt, endAt, Date.now())
    .run();
  return getCommunityAnnouncement(db);

  function toEpochOrNull(v: unknown): number | null | undefined {
    if (v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.floor(n);
  }
}
