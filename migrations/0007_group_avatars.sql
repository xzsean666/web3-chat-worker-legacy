-- Migration: 0007_group_avatars.sql
-- Group avatar support: binary stored in R2, key/mime tracked on conversations

ALTER TABLE conversations ADD COLUMN avatar_key TEXT;
ALTER TABLE conversations ADD COLUMN avatar_mime TEXT;
ALTER TABLE conversations ADD COLUMN avatar_updated_at INTEGER;
