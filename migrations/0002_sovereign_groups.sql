-- Migration: 0002_sovereign_groups.sql
-- Cloudflare D1 SQLite Schema Migration for Sovereign Groups & Conflict-Free State Merging

ALTER TABLE conversations ADD COLUMN owner_address TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_address);
