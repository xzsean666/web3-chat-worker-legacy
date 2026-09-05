-- Migration: 0003_media_messages.sql
-- Cloudflare D1 SQLite Schema for Image and File Messaging

PRAGMA foreign_keys = OFF;

-- 1. Recreate messages table to expand CHECK(type IN ('text', 'voice', 'image', 'file'))
CREATE TABLE IF NOT EXISTS messages_new (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'image', 'file')),
    content TEXT,
    retention TEXT NOT NULL DEFAULT 'permanent' CHECK(retention IN ('permanent', 'on_read')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read')),
    expires_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER,
    created_at INTEGER NOT NULL
);

INSERT INTO messages_new (id, conversation_id, sender_id, type, content, retention, status, expires_at, delivered_at, read_at, created_at)
SELECT id, conversation_id, sender_id, type, content, retention, status, expires_at, delivered_at, read_at, created_at
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);

PRAGMA foreign_keys = ON;

-- 2. Image messages table (metadata for images stored in R2)
CREATE TABLE IF NOT EXISTS image_messages (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    object_key TEXT UNIQUE NOT NULL,
    file_name TEXT,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_messages_message_id ON image_messages(message_id);

-- 3. File messages table (metadata for files stored in R2)
CREATE TABLE IF NOT EXISTS file_messages (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    object_key TEXT UNIQUE NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_messages_message_id ON file_messages(message_id);
