-- Migration: 0024_perf_indexes.sql
-- 性能索引：支撑高频 /sync 游标扫描与每分钟 on_read 清扫
-- （0002 编号已被 sovereign_groups 占用，按现有序号顺延为 0024）

-- /sync 与 getConversationMessages 均以 (created_at, id) 全序游标增量拉取，
-- messages 原先只有 (conversation_id, created_at) 复合索引与 expires_at 索引，
-- 跨会话按 created_at 过滤/排序时可能退化为近全表扫描。
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- 每分钟 cron 清扫的阅后即焚分支：部分索引让 DELETE 只扫描 retention='on_read'
-- 的少量行再评估相关子查询，避免 messages 全表扫描。
CREATE INDEX IF NOT EXISTS idx_messages_retention_on_read ON messages(retention) WHERE retention = 'on_read';
