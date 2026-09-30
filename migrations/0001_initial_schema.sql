-- Migration: 0001_initial_schema.sql
-- Cloudflare D1 SQLite Schema for Web3 Chat Worker

PRAGMA foreign_keys = ON;

-- 1. Users table (indexed by wallet_address)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    wallet_address TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_wallet_address ON users(wallet_address);

-- 2. Nonces table for EVM challenge-response authentication
CREATE TABLE IF NOT EXISTS nonces (
    id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    nonce TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonces_wallet_address_expires_at ON nonces(wallet_address, expires_at);

-- 3. Sessions table for authenticated bearer tokens (hashed)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- 4. Conversations table (direct or group)
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
    name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 5. Conversation members table
CREATE TABLE IF NOT EXISTS conversation_members (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
    joined_at INTEGER NOT NULL,
    last_read_message_id TEXT,
    UNIQUE(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_members_conversation_id ON conversation_members(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_members_user_id ON conversation_members(user_id);

-- 6. Messages table (ephemeral, text or voice)
CREATE TABLE IF NOT EXISTS messages (
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

CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);

-- 7. Message receipts table (for per-recipient tracking in group & direct chats)
CREATE TABLE IF NOT EXISTS message_receipts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('delivered', 'read')),
    timestamp INTEGER NOT NULL,
    UNIQUE(message_id, user_id, status)
);

CREATE INDEX IF NOT EXISTS idx_receipts_message_id ON message_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON message_receipts(user_id);

-- 8. Voice messages table (metadata for audio stored in R2)
CREATE TABLE IF NOT EXISTS voice_messages (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    object_key TEXT UNIQUE NOT NULL,
    duration REAL NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_messages_message_id ON voice_messages(message_id);
