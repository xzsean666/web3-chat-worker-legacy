-- Clubs (社群) & Feed (动态)：conversations type 扩 'club'、payment_orders kind 扩 'club_join'，
-- 新表 club_favorites / feed_posts / feed_likes。
--
-- D1 生产端外键强制开启且在事务内不受理 PRAGMA foreign_keys=OFF；DROP 父表
-- 会触发隐式 DELETE 并按子表的 ON DELETE 动作级联清空子表（本迁移第一次远程
-- 执行因此事故，已用 Time Travel 回滚）。因此采用「park 法」：先把全部子孙表
-- 数据挪到临时表并清空原表，再 DROP/重建父表（此时无子行，无级联），最后回灌。
-- defer_foreign_keys 把 FK 校验推迟到事务提交，此时数据已完全一致。
PRAGMA defer_foreign_keys = ON;

-- ========== 1. park 子树 ==========
-- conversations 的子表（CASCADE）：conversation_members / messages /
-- group_invite_links / group_join_requests；messages 的子表（CASCADE）：
-- message_receipts / voice_messages / image_messages / file_messages；
-- reports.reported_group_id 是 SET NULL（只存 id 映射，事后回写）；
-- payment_orders 的子表（NO ACTION）：payment_tx_claims / payment_verify_attempts。
CREATE TABLE park_conversation_members AS SELECT * FROM conversation_members;
CREATE TABLE park_messages AS SELECT * FROM messages;
CREATE TABLE park_message_receipts AS SELECT * FROM message_receipts;
CREATE TABLE park_voice_messages AS SELECT * FROM voice_messages;
CREATE TABLE park_image_messages AS SELECT * FROM image_messages;
CREATE TABLE park_file_messages AS SELECT * FROM file_messages;
CREATE TABLE park_group_invite_links AS SELECT * FROM group_invite_links;
CREATE TABLE park_group_join_requests AS SELECT * FROM group_join_requests;
CREATE TABLE park_reports AS
  SELECT id, reported_group_id FROM reports WHERE reported_group_id IS NOT NULL;
CREATE TABLE park_payment_tx_claims AS SELECT * FROM payment_tx_claims;
CREATE TABLE park_payment_verify_attempts AS SELECT * FROM payment_verify_attempts;

-- ========== 2. 清空子树（孙表先于 messages） ==========
DELETE FROM message_receipts;
DELETE FROM voice_messages;
DELETE FROM image_messages;
DELETE FROM file_messages;
DELETE FROM messages;
DELETE FROM conversation_members;
DELETE FROM group_invite_links;
DELETE FROM group_join_requests;
UPDATE reports SET reported_group_id = NULL WHERE reported_group_id IS NOT NULL;
DELETE FROM payment_tx_claims;
DELETE FROM payment_verify_attempts;

-- ========== 3. 重建 conversations：CHECK 扩 ('direct','group','club') ==========
CREATE TABLE conversations_new (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('direct', 'group', 'club')),
    name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    owner_address TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    is_muted INTEGER NOT NULL DEFAULT 0,
    mute_until INTEGER,
    avatar_key TEXT,
    avatar_mime TEXT,
    avatar_updated_at INTEGER,
    group_type TEXT NOT NULL DEFAULT 'private' CHECK(group_type IN ('private', 'public')),
    content_protected INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    is_banned INTEGER NOT NULL DEFAULT 0
);

INSERT INTO conversations_new (
    id, type, name, created_at, updated_at, owner_address, metadata, is_muted, mute_until,
    avatar_key, avatar_mime, avatar_updated_at, group_type, content_protected, last_message_at, is_banned
)
SELECT
    id, type, name, created_at, updated_at, owner_address, metadata, is_muted, mute_until,
    avatar_key, avatar_mime, avatar_updated_at, group_type, content_protected, last_message_at, is_banned
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_address);
CREATE INDEX IF NOT EXISTS idx_conversations_public_type
    ON conversations(type, group_type) WHERE type = 'club';
CREATE INDEX IF NOT EXISTS idx_conversations_public_active
    ON conversations(last_message_at DESC, id)
    WHERE type='club' AND group_type='public' AND is_banned=0;

-- 存量迁移：公开群全部转为 club（发现页只服务 club）
UPDATE conversations SET type='club' WHERE type='group' AND group_type='public';

-- ========== 4. 重建 payment_orders：kind CHECK 扩 'club_join'（列与 0015 一致） ==========
CREATE TABLE payment_orders_new (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('membership_month','membership_year','group_capacity','club_join')),
  group_id TEXT,
  owner_at_order TEXT,
  from_tier INTEGER,
  to_tier INTEGER,
  duration_days INTEGER,
  amount TEXT NOT NULL,
  list_amount TEXT NOT NULL,
  discount_bps INTEGER NOT NULL DEFAULT 0,
  chain_id INTEGER NOT NULL,
  token_type TEXT NOT NULL CHECK (token_type IN ('native','erc20')),
  token_address TEXT,
  token_symbol TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  recipient_address TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('awaiting_payment','submitted','confirming','verified','granting','active',
     'expired','failed','manual_review')),
  status_reason TEXT,
  tx_hash TEXT,
  tx_block_number INTEGER,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  granted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO payment_orders_new (
  id, wallet_address, kind, group_id, owner_at_order, from_tier, to_tier, duration_days,
  amount, list_amount, discount_bps, chain_id, token_type, token_address, token_symbol,
  token_decimals, recipient_address, config_version, status, status_reason, tx_hash,
  tx_block_number, expires_at, confirmed_at, granted_at, created_at, updated_at
)
SELECT
  id, wallet_address, kind, group_id, owner_at_order, from_tier, to_tier, duration_days,
  amount, list_amount, discount_bps, chain_id, token_type, token_address, token_symbol,
  token_decimals, recipient_address, config_version, status, status_reason, tx_hash,
  tx_block_number, expires_at, confirmed_at, granted_at, created_at, updated_at
FROM payment_orders;

DROP TABLE payment_orders;
ALTER TABLE payment_orders_new RENAME TO payment_orders;

CREATE INDEX IF NOT EXISTS idx_orders_wallet ON payment_orders(wallet_address, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_group ON payment_orders(group_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON payment_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON payment_orders(created_at);

-- ========== 5. 回灌子树 ==========
INSERT INTO messages SELECT * FROM park_messages;
INSERT INTO message_receipts SELECT * FROM park_message_receipts;
INSERT INTO voice_messages SELECT * FROM park_voice_messages;
INSERT INTO image_messages SELECT * FROM park_image_messages;
INSERT INTO file_messages SELECT * FROM park_file_messages;
INSERT INTO conversation_members SELECT * FROM park_conversation_members;
INSERT INTO group_invite_links SELECT * FROM park_group_invite_links;
INSERT INTO group_join_requests SELECT * FROM park_group_join_requests;
UPDATE reports SET reported_group_id = (
  SELECT reported_group_id FROM park_reports WHERE park_reports.id = reports.id
) WHERE id IN (SELECT id FROM park_reports);
INSERT INTO payment_tx_claims SELECT * FROM park_payment_tx_claims;
INSERT INTO payment_verify_attempts SELECT * FROM park_payment_verify_attempts;

DROP TABLE park_conversation_members;
DROP TABLE park_messages;
DROP TABLE park_message_receipts;
DROP TABLE park_voice_messages;
DROP TABLE park_image_messages;
DROP TABLE park_file_messages;
DROP TABLE park_group_invite_links;
DROP TABLE park_group_join_requests;
DROP TABLE park_reports;
DROP TABLE park_payment_tx_claims;
DROP TABLE park_payment_verify_attempts;

PRAGMA defer_foreign_keys = OFF;

-- ========== 6. 新表：club 收藏 ==========
CREATE TABLE IF NOT EXISTS club_favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, club_id)
);
CREATE INDEX IF NOT EXISTS idx_club_favorites_club ON club_favorites(club_id);

-- ========== 7. 新表：动态 feed ==========
CREATE TABLE IF NOT EXISTS feed_posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  like_count INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_posts_active
  ON feed_posts(created_at DESC, id) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS feed_likes (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(post_id, user_id)
);
