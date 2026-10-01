-- Migration: 0027_bot_extensions.sql
-- Bot Scheduled Tasks & Audit Logging

CREATE TABLE IF NOT EXISTS bot_tasks (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('text', 'image', 'video')),
    content TEXT,
    media_url TEXT,
    schedule_time INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'executed', 'cancelled', 'failed')),
    error_reason TEXT,
    created_at INTEGER NOT NULL,
    executed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bot_tasks_schedule ON bot_tasks(status, schedule_time);
CREATE INDEX IF NOT EXISTS idx_bot_tasks_bot_id ON bot_tasks(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_tasks_group_id ON bot_tasks(group_id);

CREATE TABLE IF NOT EXISTS bot_audit_logs (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    group_id TEXT,
    action TEXT NOT NULL,
    target_id TEXT,
    details TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_bot ON bot_audit_logs(bot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_group ON bot_audit_logs(group_id, created_at);
