-- Per-user chat folders (client conversation tags) synced across devices.
-- Clients push a full snapshot (PUT /chat-folders) and pull it back on a new
-- device; ids are client-generated per user (microsecond timestamp + sequence),
-- so uniqueness is scoped per user via the composite primary key.

CREATE TABLE chat_folders (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'all' CHECK(type IN ('all', 'direct', 'group')),
    hidden INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    member_based INTEGER NOT NULL DEFAULT 0,
    member_conversation_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_chat_folders_user ON chat_folders(user_id, sort_order);
