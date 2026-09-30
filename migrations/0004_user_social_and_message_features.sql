-- Migration: 0004_user_social_and_message_features.sql
-- Cloudflare D1 SQLite Schema for User Metadata, Avatars, Message Recall, 30s Burn-on-Read, Friends, Tags & Blacklist

-- 1. Extend users table with public_metadata, private_metadata, and avatar fields
ALTER TABLE users ADD COLUMN public_metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN private_metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE users ADD COLUMN avatar_mime TEXT;
ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER;

-- 2. Extend messages table with recall, burn-on-read viewing window, and mentions fields
ALTER TABLE messages ADD COLUMN recalled_at INTEGER;
ALTER TABLE messages ADD COLUMN burn_after_seconds INTEGER DEFAULT 30;
ALTER TABLE messages ADD COLUMN mentions TEXT DEFAULT '[]';

-- 3. Create friends table for contacts, custom alias and tags
CREATE TABLE IF NOT EXISTS friends (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_address TEXT NOT NULL,
    alias TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, friend_address)
);

CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend_address ON friends(friend_address);

-- 4. Create blacklist table for blocking users
CREATE TABLE IF NOT EXISTS blacklist (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_address TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, blocked_address)
);

CREATE INDEX IF NOT EXISTS idx_blacklist_user_id ON blacklist(user_id);
CREATE INDEX IF NOT EXISTS idx_blacklist_blocked_address ON blacklist(blocked_address);
