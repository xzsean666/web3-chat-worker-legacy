-- Migration: 0005_group_metadata_and_moderation.sql
-- Group metadata, mute status, and member moderation

-- 1. Extend conversations table with metadata, is_muted, and mute_until
ALTER TABLE conversations ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN mute_until INTEGER;

-- 2. Extend conversation_members table with muted_until and mute_reason
ALTER TABLE conversation_members ADD COLUMN muted_until INTEGER;
ALTER TABLE conversation_members ADD COLUMN mute_reason TEXT;

-- 3. Create index for fast muted member lookup
CREATE INDEX IF NOT EXISTS idx_conv_members_muted ON conversation_members(conversation_id, muted_until);
