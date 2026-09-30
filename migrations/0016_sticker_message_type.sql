-- Add 'sticker' message type (telemoji animated WebP stickers hosted publicly in R2).
-- Rebuild messages to extend the type CHECK while retaining all existing data.
PRAGMA foreign_keys = OFF;
CREATE TABLE messages_new (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'image', 'file', 'system', 'sticker')),
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
