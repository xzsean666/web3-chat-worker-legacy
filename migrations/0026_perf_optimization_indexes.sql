-- Migration: 0026_perf_optimization_indexes.sql
-- 全面性能优化索引：消除高频全表扫描、覆盖外键级联检查、优化定时任务清理与对账

-- 1. 内部管理验签与清理：消除 seen_at 范围删除的全表扫描
CREATE INDEX IF NOT EXISTS idx_internal_nonces_seen_at ON internal_nonces(seen_at);

-- 2. 支付 Outbox 补偿队列：消除按业务单号 ref_key 查找与更新时的全表扫描
CREATE INDEX IF NOT EXISTS idx_payment_outbox_ref_key ON payment_outbox(ref_key);
CREATE INDEX IF NOT EXISTS idx_payment_outbox_done_updated ON payment_outbox(updated_at) WHERE status = 'done';

-- 3. 俱乐部申请：支持用户查询自身所有历史申请记录（不论状态）走索引检索
CREATE INDEX IF NOT EXISTS idx_club_applications_applicant_created ON club_applications(applicant_id, created_at DESC, id DESC);

-- 4. 动态 Feed 软删除清扫与全量检索
CREATE INDEX IF NOT EXISTS idx_feed_posts_deleted_created ON feed_posts(created_at DESC) WHERE is_deleted = 1;
CREATE INDEX IF NOT EXISTS idx_feed_posts_global ON feed_posts(created_at DESC, id DESC) WHERE is_deleted = 0 AND club_id IS NULL;

-- 5. 外键级联约束加速（消除用户/群组级联删除或更新时的子表全表扫描）
CREATE INDEX IF NOT EXISTS idx_feed_likes_user ON feed_likes(user_id);
CREATE INDEX IF NOT EXISTS idx_feed_likes_post_created ON feed_likes(post_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_feed_posts_author ON feed_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_user ON group_join_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_handler ON group_join_requests(handled_by);
CREATE INDEX IF NOT EXISTS idx_group_invite_links_creator ON group_invite_links(created_by);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_claims_order ON payment_tx_claims(order_id);
CREATE INDEX IF NOT EXISTS idx_club_applications_club ON club_applications(club_id);

-- 6. 定时任务轮换对账与过期清理索引加速
CREATE INDEX IF NOT EXISTS idx_wallet_entitlements_updated_at ON wallet_entitlements(updated_at ASC);
CREATE INDEX IF NOT EXISTS idx_group_capacity_entitlements_updated_at ON group_capacity_entitlements(updated_at ASC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at ASC);
CREATE INDEX IF NOT EXISTS idx_nonces_expires_at ON nonces(expires_at ASC);
