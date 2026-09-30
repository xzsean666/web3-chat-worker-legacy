-- Migration: 0009_group_nicknames.sql
-- Per-group member nickname ("群成员专属昵称"), stored on the member-group
-- relation (conversation_members), not in global user metadata.

ALTER TABLE conversation_members ADD COLUMN group_nickname TEXT;
