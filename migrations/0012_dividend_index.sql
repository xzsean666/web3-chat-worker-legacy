-- 0012_dividend_index.sql
-- LHSwap 分红体系链上索引：全量池注册表、NFT Transfer holder 去重索引、
-- FeeDeposited 日聚合、RewardClaimed 领取流水、同步游标、代币元数据缓存。

-- 全量分红池注册表（覆盖 factory.getAllPairs 中所有带 reward 合约的池）
CREATE TABLE IF NOT EXISTS idx_pairs (
  chain_id INTEGER NOT NULL,
  pair_address TEXT NOT NULL,
  reward_contract TEXT,               -- NULL 表示该池暂无分红合约（可能后续创建）
  nft_contract TEXT,
  token0 TEXT,
  token1 TEXT,
  pool_balance0 TEXT NOT NULL DEFAULT '0',  -- uint256 十进制字符串
  pool_balance1 TEXT NOT NULL DEFAULT '0',
  total_fees0 TEXT NOT NULL DEFAULT '0',
  total_fees1 TEXT NOT NULL DEFAULT '0',
  reserve0 TEXT NOT NULL DEFAULT '0',
  reserve1 TEXT NOT NULL DEFAULT '0',
  nft_total_minted INTEGER NOT NULL DEFAULT 0,
  holder_count INTEGER NOT NULL DEFAULT 0,  -- 本池 NFT 持有地址数（balance>0 去重）
  state_updated_at INTEGER NOT NULL DEFAULT 0,  -- 池状态（余额/手续费/储备）最近刷新 ms
  recheck_after INTEGER NOT NULL DEFAULT 0,     -- 无 reward 合约池的下次复查 ms
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, pair_address)
);
CREATE INDEX IF NOT EXISTS idx_pairs_reward ON idx_pairs(chain_id, reward_contract);
CREATE INDEX IF NOT EXISTS idx_pairs_nft ON idx_pairs(chain_id, nft_contract);

-- NFT holder 余额索引（由 Transfer 事件增量维护，mint: from=0x0，burn: to=0x0）
CREATE TABLE IF NOT EXISTS idx_holders (
  chain_id INTEGER NOT NULL,
  nft_contract TEXT NOT NULL,
  holder TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, nft_contract, holder)
);
CREATE INDEX IF NOT EXISTS idx_holders_holder ON idx_holders(chain_id, holder);

-- RewardClaimed 领取流水（跨设备全网视角），tx_hash+log_index 幂等
CREATE TABLE IF NOT EXISTS idx_claim_events (
  chain_id INTEGER NOT NULL,
  pair_address TEXT NOT NULL DEFAULT '',
  reward_contract TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  user_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  day_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_timestamp INTEGER NOT NULL DEFAULT 0,  -- 秒
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_claim_events_user ON idx_claim_events(chain_id, user_address, block_number DESC);
CREATE INDEX IF NOT EXISTS idx_claim_events_pair ON idx_claim_events(chain_id, pair_address, block_number DESC);

-- FeeDeposited 按 UTC 日聚合（APR 滚动年化输入）
CREATE TABLE IF NOT EXISTS idx_fee_daily (
  chain_id INTEGER NOT NULL,
  reward_contract TEXT NOT NULL,
  day_index INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  fee_amount TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (chain_id, reward_contract, day_index, token_address)
);

-- 同步游标（scope: 'events'），meta 存 JSON（自适应窗口等）
CREATE TABLE IF NOT EXISTS idx_sync_state (
  chain_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  last_block INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, scope)
);

-- ERC20 symbol/decimals 永久缓存
CREATE TABLE IF NOT EXISTS idx_token_meta (
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, token_address)
);

-- 通用 KV（价格缓存等）
CREATE TABLE IF NOT EXISTS idx_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
