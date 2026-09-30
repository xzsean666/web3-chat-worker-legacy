-- 0024: 社区公告（轮播图下方滚动横条）：后台可配文案/开关/定时起止。
-- 单行表（id 恒为 1）；空定时=长期有效，客户端按 enabled+时间窗决定显隐。
CREATE TABLE IF NOT EXISTS community_announcement (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  start_at INTEGER,
  end_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO community_announcement (id, text, enabled, start_at, end_at, updated_at)
  VALUES (1, '', 0, NULL, NULL, 0);
