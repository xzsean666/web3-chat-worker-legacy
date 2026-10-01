-- Migration 0028: Composite index for group member cursor pagination & fast count
CREATE INDEX IF NOT EXISTS idx_conv_members_conv_joined ON conversation_members(conversation_id, joined_at ASC, id ASC);
