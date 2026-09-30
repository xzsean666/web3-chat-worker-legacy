-- 0023: 动态发布付费 —— payment_orders kind 扩 'feed_post'、status 扩 'consumed'。
-- kind='feed_post' 的订单=一条付费动态的支付凭证，发帖时原子消费
--（active → consumed，见 routes/clubs.ts 发帖门禁）。
-- 采用与 0019 相同的「park 法」重建（payment_tx_claims /
-- payment_verify_attempts 为 NO ACTION 子表）。
PRAGMA defer_foreign_keys = ON;

CREATE TABLE park_payment_tx_claims AS SELECT * FROM payment_tx_claims;
CREATE TABLE park_payment_verify_attempts AS SELECT * FROM payment_verify_attempts;
DELETE FROM payment_tx_claims;
DELETE FROM payment_verify_attempts;

CREATE TABLE payment_orders_new (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('membership_month','membership_year','group_capacity','club_join','feed_post')),
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
     'expired','failed','manual_review','consumed')),
  status_reason TEXT,
  tx_hash TEXT,
  tx_block_number INTEGER,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  granted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO payment_orders_new (
  id, wallet_address, kind, group_id, owner_at_order, from_tier, to_tier, duration_days,
  amount, list_amount, discount_bps, chain_id, token_type, token_address, token_symbol,
  token_decimals, recipient_address, config_version, status, status_reason, tx_hash,
  tx_block_number, expires_at, confirmed_at, granted_at, created_at, updated_at
)
SELECT
  id, wallet_address, kind, group_id, owner_at_order, from_tier, to_tier, duration_days,
  amount, list_amount, discount_bps, chain_id, token_type, token_address, token_symbol,
  token_decimals, recipient_address, config_version, status, status_reason, tx_hash,
  tx_block_number, expires_at, confirmed_at, granted_at, created_at, updated_at
FROM payment_orders;

DROP TABLE payment_orders;
ALTER TABLE payment_orders_new RENAME TO payment_orders;

CREATE INDEX IF NOT EXISTS idx_orders_wallet ON payment_orders(wallet_address, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_group ON payment_orders(group_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON payment_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON payment_orders(created_at);

INSERT INTO payment_tx_claims SELECT * FROM park_payment_tx_claims;
INSERT INTO payment_verify_attempts SELECT * FROM park_payment_verify_attempts;
DROP TABLE park_payment_tx_claims;
DROP TABLE park_payment_verify_attempts;
