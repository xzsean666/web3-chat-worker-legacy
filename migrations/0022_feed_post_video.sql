-- 0022: feed_posts.video — 动态视频附件（单个，R2 对象 key，feed-videos/ 前缀）。
-- 与 images 并列；content/images/video 三者至少其一（见 services/feed.ts）。
ALTER TABLE feed_posts ADD COLUMN video TEXT;
