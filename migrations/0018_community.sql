-- Community upgrade: public-group activity ordering, ban flag, and community banners.
-- messages 表列名经 0001_initial_schema.sql 确认：conversation_id / created_at。

ALTER TABLE conversations ADD COLUMN last_message_at INTEGER;
ALTER TABLE conversations ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0;

-- 回填：群的最后一条消息时间（无消息的老群保持 NULL，查询侧用 COALESCE 兜底）
UPDATE conversations SET last_message_at = (
  SELECT MAX(created_at) FROM messages WHERE messages.conversation_id = conversations.id
) WHERE type = 'group';

-- 公开群发现：按最近活跃排序（封禁群不进索引）
CREATE INDEX IF NOT EXISTS idx_conversations_public_active
  ON conversations(last_message_at DESC, id)
  WHERE type='group' AND group_type='public' AND is_banned=0;

CREATE TABLE IF NOT EXISTS community_banners (
  id TEXT PRIMARY KEY,
  title TEXT,
  image_url TEXT NOT NULL,
  link_url TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
