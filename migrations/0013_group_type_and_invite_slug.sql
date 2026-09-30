-- Group type (private/public), content protection flag, and custom invite-link slugs.

ALTER TABLE conversations ADD COLUMN group_type TEXT NOT NULL DEFAULT 'private' CHECK(group_type IN ('private', 'public'));
ALTER TABLE conversations ADD COLUMN content_protected INTEGER NOT NULL DEFAULT 0;

ALTER TABLE group_invite_links ADD COLUMN slug TEXT;

-- Custom slugs are globally unique across all invite links (t.me/+name style).
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_invite_links_slug
    ON group_invite_links(slug) WHERE slug IS NOT NULL;

-- Read-only public-group discovery.
CREATE INDEX IF NOT EXISTS idx_conversations_public_type
    ON conversations(type, group_type) WHERE type = 'group';
