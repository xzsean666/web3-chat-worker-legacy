-- Migration: 0025_bots.sql
-- Telegram-like Bot registration, management and API keys

CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    username TEXT UNIQUE,
    description TEXT,
    api_key_hash TEXT NOT NULL,
    api_key_prefix TEXT NOT NULL,
    avatar_url TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bots_owner_id ON bots(owner_id);
CREATE INDEX IF NOT EXISTS idx_bots_username ON bots(username);
CREATE INDEX IF NOT EXISTS idx_bots_api_key_hash ON bots(api_key_hash);
