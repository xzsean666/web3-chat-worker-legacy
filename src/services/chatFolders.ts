import type { ChatFolderRow } from '../db/schema';

export interface ChatFolderInput {
  id: string;
  name: string;
  type: 'all' | 'direct' | 'group';
  hidden: boolean;
  sort_order: number;
  member_based: boolean;
  member_conversation_ids: string[];
}

export interface ChatFolderPayload extends ChatFolderInput {
  created_at: number;
  updated_at: number;
}

const MAX_FOLDERS = 200;
const MAX_NAME_LENGTH = 64;
const MAX_MEMBER_IDS = 1000;
const MAX_ID_LENGTH = 128;

function rowToPayload(row: ChatFolderRow): ChatFolderPayload {
  let memberIds: string[] = [];
  try {
    const parsed = JSON.parse(row.member_conversation_ids || '[]');
    if (Array.isArray(parsed)) memberIds = parsed.map((id) => String(id));
  } catch {
    memberIds = [];
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    hidden: row.hidden === 1,
    sort_order: row.sort_order,
    member_based: row.member_based === 1,
    member_conversation_ids: memberIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listChatFolders(
  db: D1Database,
  userId: string,
): Promise<ChatFolderPayload[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, name, type, hidden, sort_order, member_based,
              member_conversation_ids, created_at, updated_at
       FROM chat_folders
       WHERE user_id = ?
       ORDER BY sort_order ASC, created_at ASC`,
    )
    .bind(userId)
    .all<ChatFolderRow>();
  return (result.results ?? []).map(rowToPayload);
}

function normalizeFolderInput(raw: unknown, index: number): ChatFolderInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`folders[${index}] must be an object`);
  }
  const item = raw as Record<string, unknown>;

  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id || id.length > MAX_ID_LENGTH) {
    throw new Error(`folders[${index}].id is required (max ${MAX_ID_LENGTH} chars)`);
  }

  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new Error(`folders[${index}].name is required (max ${MAX_NAME_LENGTH} chars)`);
  }

  const type = item.type;
  if (type !== 'all' && type !== 'direct' && type !== 'group') {
    throw new Error(`folders[${index}].type must be one of all/direct/group`);
  }

  const sortOrder = Number.isFinite(item.sort_order) ? Math.trunc(item.sort_order as number) : 0;

  const rawMembers = item.member_conversation_ids;
  const memberIds = Array.isArray(rawMembers)
    ? rawMembers.map((id) => String(id).trim()).filter((id) => id.length > 0)
    : [];
  if (memberIds.length > MAX_MEMBER_IDS) {
    throw new Error(`folders[${index}].member_conversation_ids exceeds ${MAX_MEMBER_IDS} entries`);
  }

  return {
    id,
    name,
    type,
    hidden: item.hidden === true,
    sort_order: sortOrder,
    member_based: item.member_based === true,
    member_conversation_ids: memberIds,
  };
}

/**
 * Whole-snapshot replace: the submitted array becomes the user's complete
 * folder set. Simplest reliable semantics for multi-device sync.
 */
export async function replaceChatFolders(
  db: D1Database,
  userId: string,
  rawFolders: unknown,
): Promise<ChatFolderPayload[]> {
  const list = Array.isArray(rawFolders)
    ? rawFolders
    : Array.isArray((rawFolders as Record<string, unknown> | null)?.folders)
      ? ((rawFolders as Record<string, unknown>).folders as unknown[])
      : null;
  if (!list) throw new Error('folders must be an array');
  if (list.length > MAX_FOLDERS) {
    throw new Error(`folders exceeds the ${MAX_FOLDERS} entry limit`);
  }

  const folders = list.map(normalizeFolderInput);
  const seen = new Set<string>();
  for (const folder of folders) {
    if (seen.has(folder.id)) throw new Error(`duplicate folder id: ${folder.id}`);
    seen.add(folder.id);
  }

  const now = Date.now();
  const existing = await db
    .prepare('SELECT id, created_at FROM chat_folders WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string; created_at: number }>();
  const createdAtById = new Map(
    (existing.results ?? []).map((row) => [row.id, row.created_at]),
  );

  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM chat_folders WHERE user_id = ?').bind(userId),
    ...folders.map((folder) =>
      db
        .prepare(
          `INSERT INTO chat_folders
             (id, user_id, name, type, hidden, sort_order, member_based,
              member_conversation_ids, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          folder.id,
          userId,
          folder.name,
          folder.type,
          folder.hidden ? 1 : 0,
          folder.sort_order,
          folder.member_based ? 1 : 0,
          JSON.stringify(folder.member_conversation_ids),
          createdAtById.get(folder.id) ?? now,
          now,
        ),
    ),
  ];
  await db.batch(statements);

  return listChatFolders(db, userId);
}
