-- 社群创建改申请制 + club 私有动态。
-- 纯增量迁移：只 CREATE 新表 / ALTER feed_posts 加列 / CREATE 索引，
-- 不 DROP/重建任何既有父表（D1 上 DROP 父表会按子表 ON DELETE 级联清空子表）。

-- ========== 1. 新表：club 创建申请 ==========
CREATE TABLE IF NOT EXISTS club_applications (
  id TEXT PRIMARY KEY,
  applicant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  review_reason TEXT,
  handled_by TEXT,
  handled_at INTEGER,
  club_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
-- 同一申请人同时只允许一条 pending（部分唯一索引；approve/reject 后可再次申请）
CREATE UNIQUE INDEX IF NOT EXISTS idx_club_applications_pending
  ON club_applications(applicant_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_club_applications_status
  ON club_applications(status, created_at DESC, id);

-- ========== 2. feed_posts 增加 club 维度（存量全局帖 club_id 为 NULL） ==========
ALTER TABLE feed_posts ADD COLUMN club_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_feed_posts_club
  ON feed_posts(club_id, created_at DESC, id) WHERE is_deleted = 0;
