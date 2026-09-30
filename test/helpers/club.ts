// 测试夹具：直接向 D1 插入 club（type='club' + group_type='public' + owner 成员行）。
// POST /groups type='club' 已改申请制（403 CLUB_CREATE_VIA_APPLICATION），
// 需要 club 夹具的测试（发现/收藏/门禁/feed）不再走 HTTP 创建。

export interface InsertClubOptions {
  ownerId: string;
  name: string;
  metadata?: Record<string, unknown>;
  id?: string;
  /** 额外成员（owner 自动写入）；user 须已存在（先 login） */
  members?: { userId: string; role?: 'owner' | 'admin' | 'member' }[];
}

export async function insertClub(db: D1Database, options: InsertClubOptions): Promise<{ id: string; name: string }> {
  const id = options.id ?? `club-${crypto.randomUUID()}`;
  const now = Date.now();
  const metadata = { ...(options.metadata ?? {}), name: options.name };
  await db
    .prepare(
      "INSERT INTO conversations (id, type, owner_address, name, metadata, is_muted, mute_until, group_type, created_at, updated_at) VALUES (?, 'club', ?, ?, ?, 0, NULL, 'public', ?, ?)"
    )
    .bind(id, options.ownerId, options.name, JSON.stringify(metadata), now, now)
    .run();
  await db
    .prepare("INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)")
    .bind(`${id}:${options.ownerId}`, id, options.ownerId, now)
    .run();
  for (const member of options.members ?? []) {
    await db
      .prepare('INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)')
      .bind(`${id}:${member.userId}`, id, member.userId, member.role ?? 'member', now)
      .run();
  }
  return { id, name: options.name };
}
