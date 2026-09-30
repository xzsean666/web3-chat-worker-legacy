-- Group invitation links, join approval workflow, and in-conversation system events.

CREATE TABLE IF NOT EXISTS group_invite_links (
    token TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER,
    max_uses INTEGER,
    uses_count INTEGER NOT NULL DEFAULT 0 CHECK(uses_count >= 0),
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_invite_links_group ON group_invite_links(group_id);

CREATE TABLE IF NOT EXISTS group_join_requests (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL,
    nickname TEXT,
    avatar_url TEXT,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    created_at INTEGER NOT NULL,
    handled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    handled_at INTEGER
);

-- A user can have historical requests, but only one request awaiting a decision.
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_join_requests_pending_user
    ON group_join_requests(group_id, user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_group_join_requests_group_status
    ON group_join_requests(group_id, status, created_at DESC);

-- Rebuild messages to add an explicit system event type while retaining all existing data.
PRAGMA foreign_keys = OFF;
CREATE TABLE messages_new (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'image', 'file', 'system')),
    content TEXT,
    retention TEXT NOT NULL DEFAULT 'permanent' CHECK(retention IN ('permanent', 'on_read')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read')),
    expires_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER,
    created_at INTEGER NOT NULL,
    recalled_at INTEGER,
    burn_after_seconds INTEGER DEFAULT 30,
    mentions TEXT DEFAULT '[]'
);

INSERT INTO messages_new (
    id, conversation_id, sender_id, type, content, retention, status, expires_at,
    delivered_at, read_at, created_at, recalled_at, burn_after_seconds, mentions
)
SELECT
    id, conversation_id, sender_id, type, content, retention, status, expires_at,
    delivered_at, read_at, created_at, recalled_at, burn_after_seconds, mentions
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
PRAGMA foreign_keys = ON;
