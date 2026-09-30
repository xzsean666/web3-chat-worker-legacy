-- Private user-report records and non-conversation image evidence uploads.

CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reported_wallet_address TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN (
        'harassment', 'fraud', 'account_theft', 'infringement', 'counterfeit',
        'impersonation', 'minor_protection', 'irrational_fandom'
    )),
    message_ids TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'under_review', 'resolved', 'rejected')),
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_reporter_created ON reports(reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_wallet ON reports(reported_wallet_address, created_at DESC);

CREATE TABLE IF NOT EXISTS report_evidence (
    object_key TEXT PRIMARY KEY,
    uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_evidence_report ON report_evidence(report_id);
CREATE INDEX IF NOT EXISTS idx_report_evidence_uploader ON report_evidence(uploaded_by, created_at DESC);
