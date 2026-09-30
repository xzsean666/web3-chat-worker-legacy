-- Group reports: rebuild reports to add target_type/reported_group_id and relax reported_wallet_address.
-- SQLite cannot alter column constraints, so rebuild the table (same pattern as 0016).
PRAGMA foreign_keys = OFF;
CREATE TABLE reports_new (
    id TEXT PRIMARY KEY,
    reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reported_wallet_address TEXT,
    reported_group_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    target_type TEXT NOT NULL DEFAULT 'user' CHECK(target_type IN ('user', 'group')),
    category TEXT NOT NULL CHECK(category IN (
        'harassment', 'fraud', 'account_theft', 'infringement', 'counterfeit',
        'impersonation', 'minor_protection', 'irrational_fandom'
    )),
    message_ids TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'under_review', 'resolved', 'rejected')),
    created_at INTEGER NOT NULL,
    CHECK (
        (target_type = 'group' AND reported_group_id IS NOT NULL)
        OR (target_type = 'user' AND reported_wallet_address IS NOT NULL)
    )
);

INSERT INTO reports_new (
    id, reporter_user_id, reported_user_id, reported_wallet_address, category, message_ids, description, status, created_at
)
SELECT
    id, reporter_user_id, reported_user_id, reported_wallet_address, category, message_ids, description, status, created_at
FROM reports;

DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX IF NOT EXISTS idx_reports_reporter_created ON reports(reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_wallet ON reports(reported_wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_group ON reports(reported_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at DESC);
PRAGMA foreign_keys = ON;
