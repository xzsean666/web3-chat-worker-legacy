-- 0021: feed_posts.section — 作者发布动态时选择的目标板块。
-- featured=精选（默认/未指定，兼容旧帖 NULL）/ admins=自选 / media=图片·视频 / files=文件。
-- 列表过滤按板块优先、旧帖（section IS NULL）回落原派生规则（见 services/feed.ts）。
ALTER TABLE feed_posts ADD COLUMN section TEXT;
CREATE INDEX IF NOT EXISTS idx_feed_posts_club_section
  ON feed_posts(club_id, section, created_at DESC, id DESC);
