-- 0006_unique_usernames.sql
-- Globally unique, user-chosen usernames for friend discovery.
-- Partial unique index: many NULLs allowed, non-null usernames must be unique.

ALTER TABLE users ADD COLUMN username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique
    ON users(username)
    WHERE username IS NOT NULL;
