-- Migration: 0008_friend_requests.sql
-- Friend requests: pending/accepted/rejected applications with verification
-- message and unread tracking (drives the unread-count badge).

CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
    is_read INTEGER NOT NULL DEFAULT 0,     -- recipient has fetched the incoming list
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(from_user_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status, is_read);
CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id, status);
