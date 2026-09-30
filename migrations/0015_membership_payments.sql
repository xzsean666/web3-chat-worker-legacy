-- ChainTalk 会员与链上付费扩群（契约 docs/membership/CONTRACT.md §1）
-- 所有金额字段为 TEXT 存十进制整数字符串（最小支付单位），禁止浮点。
-- 时间一律 ISO-8601 UTC 字符串。

-- 生效配置版本（append-only，active 唯一）
CREATE TABLE IF NOT EXISTS payment_config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  change_summary TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_payment_config_active ON payment_config_versions(is_active);

-- 订单（不可变报价快照随行冻结）
CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('membership_month','membership_year','group_capacity')),
  group_id TEXT,
  owner_at_order TEXT,
  from_tier INTEGER,
  to_tier INTEGER,
  duration_days INTEGER,
  amount TEXT NOT NULL,
  list_amount TEXT NOT NULL,
  discount_bps INTEGER NOT NULL DEFAULT 0,
  chain_id INTEGER NOT NULL,
  token_type TEXT NOT NULL CHECK (token_type IN ('native','erc20')),
  token_address TEXT,
  token_symbol TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  recipient_address TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('awaiting_payment','submitted','confirming','verified','granting','active',
     'expired','failed','manual_review')),
  status_reason TEXT,
  tx_hash TEXT,
  tx_block_number INTEGER,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  granted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_wallet ON payment_orders(wallet_address, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_group ON payment_orders(group_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON payment_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON payment_orders(created_at);

-- 链上交易认领（防一 tx 多单）
CREATE TABLE IF NOT EXISTS payment_tx_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES payment_orders(id),
  log_index INTEGER,
  claimed_at TEXT NOT NULL,
  UNIQUE (chain_id, tx_hash)
);

-- 钱包会员权益
CREATE TABLE IF NOT EXISTS wallet_entitlements (
  wallet_address TEXT PRIMARY KEY,
  membership_tier TEXT CHECK (membership_tier IN ('month','year')),
  membership_expires_at TEXT,
  entitlement_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 群容量权益（唯一权威来源，不放群 metadata）
CREATE TABLE IF NOT EXISTS group_capacity_entitlements (
  group_id TEXT PRIMARY KEY,
  capacity_tier INTEGER NOT NULL DEFAULT 50,
  entitlement_version INTEGER NOT NULL DEFAULT 1,
  last_order_id TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  updated_at TEXT NOT NULL
);

-- 异步 R2 同步 outbox（D1→R2 补偿）
CREATE TABLE IF NOT EXISTS payment_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON payment_outbox(status, id);

-- 管理员操作审计 + 验款错误记录
CREATE TABLE IF NOT EXISTS payment_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON payment_audit_log(created_at);

-- 验款尝试记录（失败原因可查）
CREATE TABLE IF NOT EXISTS payment_verify_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES payment_orders(id),
  result TEXT NOT NULL,
  error TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verify_attempts_order ON payment_verify_attempts(order_id);

-- 内部 API 防重放 nonce
CREATE TABLE IF NOT EXISTS internal_nonces (
  nonce TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

-- 用户侧限流（固定窗口）
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
