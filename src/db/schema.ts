// Database Entity Definitions

export interface UserRow {
  id: string;
  wallet_address: string;
  username: string | null;
  public_metadata: string;
  private_metadata: string;
  avatar_key: string | null;
  avatar_mime: string | null;
  avatar_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NonceRow {
  id: string;
  wallet_address: string;
  nonce: string;
  expires_at: number;
  created_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  type: 'direct' | 'group' | 'club';
  owner_address: string | null;
  name: string | null;
  metadata: string;
  is_muted: number;
  mute_until: number | null;
  avatar_key: string | null;
  avatar_mime: string | null;
  avatar_updated_at: number | null;
  group_type: 'private' | 'public';
  content_protected: number;
  last_message_at: number | null;
  is_banned: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationMemberRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  muted_until: number | null;
  mute_reason: string | null;
  group_nickname: string | null;
  joined_at: number;
  last_read_message_id: string | null;
}

export interface GroupInviteLinkRow {
  token: string;
  group_id: string;
  created_by: string;
  expires_at: number | null;
  max_uses: number | null;
  uses_count: number;
  slug: string | null;
  created_at: number;
}

export interface GroupJoinRequestRow {
  id: string;
  group_id: string;
  user_id: string;
  wallet_address: string;
  nickname: string | null;
  avatar_url: string | null;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  handled_by: string | null;
  handled_at: number | null;
}

export type ReportCategory =
  | 'harassment'
  | 'fraud'
  | 'account_theft'
  | 'infringement'
  | 'counterfeit'
  | 'impersonation'
  | 'minor_protection'
  | 'irrational_fandom';

export interface ReportRow {
  id: string;
  reporter_user_id: string;
  reported_user_id: string | null;
  reported_wallet_address: string | null;
  reported_group_id: string | null;
  target_type: 'user' | 'group';
  category: ReportCategory;
  message_ids: string;
  description: string | null;
  status: 'received' | 'under_review' | 'resolved' | 'rejected';
  created_at: number;
}

export interface ReportEvidenceRow {
  object_key: string;
  uploaded_by: string;
  report_id: string | null;
  mime_type: string;
  size: number;
  created_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: 'text' | 'voice' | 'image' | 'file' | 'system' | 'sticker';
  content: string | null;
  retention: 'permanent' | 'on_read';
  status: 'pending' | 'delivered' | 'read';
  expires_at: number;
  delivered_at: number | null;
  read_at: number | null;
  created_at: number;
  recalled_at?: number | null;
  burn_after_seconds?: number | null;
  mentions?: string | null;
}

export interface MessageReceiptRow {
  id: string;
  message_id: string;
  user_id: string;
  status: 'delivered' | 'read';
  timestamp: number;
}

export interface VoiceMessageRow {
  id: string;
  message_id: string;
  object_key: string;
  duration: number;
  mime_type: string;
  size: number;
  created_at: number;
}

export interface ImageMessageRow {
  id: string;
  message_id: string;
  object_key: string;
  file_name: string | null;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface FileMessageRow {
  id: string;
  message_id: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  size: number;
  created_at: number;
}

export interface FriendRow {
  id: string;
  user_id: string;
  friend_address: string;
  alias: string | null;
  tags: string;
  created_at: number;
  updated_at: number;
}

export interface BlacklistRow {
  id: string;
  user_id: string;
  blocked_address: string;
  reason: string | null;
  created_at: number;
}

export interface FriendRequestRow {
  id: string;
  from_user_id: string;
  to_user_id: string;
  message: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  is_read: number;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Dividend indexer (LHSwap reward pools)
// ---------------------------------------------------------------------------

export interface IdxPairRow {
  chain_id: number;
  pair_address: string;
  reward_contract: string | null;
  nft_contract: string | null;
  token0: string | null;
  token1: string | null;
  pool_balance0: string;
  pool_balance1: string;
  total_fees0: string;
  total_fees1: string;
  reserve0: string;
  reserve1: string;
  nft_total_minted: number;
  holder_count: number;
  state_updated_at: number;
  recheck_after: number;
  created_at: number;
}

export interface IdxHolderRow {
  chain_id: number;
  nft_contract: string;
  holder: string;
  balance: number;
  updated_at: number;
}

export interface IdxClaimEventRow {
  chain_id: number;
  pair_address: string;
  reward_contract: string;
  tx_hash: string;
  log_index: number;
  user_address: string;
  token_address: string;
  amount: string;
  day_index: number;
  block_number: number;
  block_timestamp: number;
  created_at: number;
}

export interface IdxFeeDailyRow {
  chain_id: number;
  reward_contract: string;
  day_index: number;
  token_address: string;
  fee_amount: string;
}

export interface IdxSyncStateRow {
  chain_id: number;
  scope: string;
  last_block: number;
  meta: string;
  updated_at: number;
}

export interface IdxTokenMetaRow {
  chain_id: number;
  token_address: string;
  symbol: string;
  decimals: number;
  created_at: number;
}

export interface ChatFolderRow {
  id: string;
  user_id: string;
  name: string;
  type: 'all' | 'direct' | 'group';
  hidden: number;
  sort_order: number;
  member_based: number;
  member_conversation_ids: string;
  created_at: number;
  updated_at: number;
}

export interface CommunityBannerRow {
  id: string;
  title: string | null;
  image_url: string;
  link_url: string | null;
  sort: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Membership & on-chain payments (migration 0015, CONTRACT.md §1)
// All amounts are TEXT decimal integer strings (smallest unit); times are
// ISO-8601 UTC strings.
// ---------------------------------------------------------------------------

export type PaymentOrderKind = 'membership_month' | 'membership_year' | 'group_capacity' | 'club_join' | 'feed_post';
export type PaymentOrderStatus =
  | 'awaiting_payment'
  | 'submitted'
  | 'confirming'
  | 'verified'
  | 'granting'
  | 'active'
  | 'expired'
  | 'failed'
  | 'manual_review'
  | 'consumed';

export interface PaymentConfigVersionRow {
  id: number;
  version: number;
  payload_json: string;
  change_summary: string | null;
  created_by: string;
  created_at: string;
  is_active: number;
}

export interface PaymentOrderRow {
  id: string;
  wallet_address: string;
  kind: PaymentOrderKind;
  group_id: string | null;
  owner_at_order: string | null;
  from_tier: number | null;
  to_tier: number | null;
  duration_days: number | null;
  amount: string;
  list_amount: string;
  discount_bps: number;
  chain_id: number;
  token_type: 'native' | 'erc20';
  token_address: string | null;
  token_symbol: string;
  token_decimals: number;
  recipient_address: string;
  config_version: number;
  status: PaymentOrderStatus;
  status_reason: string | null;
  tx_hash: string | null;
  tx_block_number: number | null;
  expires_at: string;
  confirmed_at: string | null;
  granted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentTxClaimRow {
  id: number;
  chain_id: number;
  tx_hash: string;
  order_id: string;
  log_index: number | null;
  claimed_at: string;
}

export interface WalletEntitlementRow {
  wallet_address: string;
  membership_tier: 'month' | 'year' | null;
  membership_expires_at: string | null;
  entitlement_version: number;
  updated_at: string;
}

export interface GroupCapacityEntitlementRow {
  group_id: string;
  capacity_tier: number;
  entitlement_version: number;
  last_order_id: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  updated_at: string;
}

export interface PaymentOutboxRow {
  id: number;
  kind: string;
  ref_key: string;
  payload_json: string;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentAuditLogRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail_json: string | null;
  created_at: string;
}

export interface PaymentVerifyAttemptRow {
  id: number;
  order_id: string;
  result: 'ok' | 'retry' | 'failed';
  error: string | null;
  detail_json: string | null;
  created_at: string;
}

export interface InternalNonceRow {
  nonce: string;
  seen_at: string;
}

// ---------------------------------------------------------------------------
// Clubs & feed (migration 0019)
// ---------------------------------------------------------------------------

/** 群类会话（普通群 group 与社群 club 共用成员/禁言/审批/容量等全部群逻辑）。 */
export function isGroupLike(type: string | null | undefined): boolean {
  return type === 'group' || type === 'club';
}

export interface ClubFavoriteRow {
  id: string;
  user_id: string;
  club_id: string;
  created_at: number;
}

export interface FeedPostRow {
  id: string;
  author_id: string;
  content: string;
  images: string;
  like_count: number;
  is_deleted: number;
  created_at: number;
  club_id: string | null;
  /** 目标板块（migration 0021）：featured/admins/media/files；旧帖为 NULL 按派生规则回落。 */
  section: string | null;
  /** 视频附件 R2 key（migration 0022）：feed-videos/ 前缀；无视频为 NULL。 */
  video: string | null;
}

// ---------------------------------------------------------------------------
// Club applications (migration 0020)：社群创建申请制
// ---------------------------------------------------------------------------

export interface ClubApplicationRow {
  id: string;
  applicant_id: string;
  name: string;
  description: string | null;
  tags: string;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  review_reason: string | null;
  handled_by: string | null;
  handled_at: number | null;
  club_id: string | null;
  created_at: number;
}

export interface FeedLikeRow {
  id: string;
  post_id: string;
  user_id: string;
  created_at: number;
}

export interface RateLimitRow {
  bucket: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Telegram-like Bots (migration 0025)
// ---------------------------------------------------------------------------

export interface BotRow {
  id: string;
  owner_id: string;
  name: string;
  username: string | null;
  description: string | null;
  api_key_hash: string;
  api_key_prefix: string;
  avatar_url: string | null;
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Bot Extensions (Tasks & Audit Logs) (migration 0027)
// ---------------------------------------------------------------------------

export type BotTaskType = 'text' | 'image' | 'video';
export type BotTaskStatus = 'pending' | 'executed' | 'cancelled' | 'failed';

export interface BotTaskRow {
  id: string;
  bot_id: string;
  group_id: string;
  type: BotTaskType;
  content: string | null;
  media_url: string | null;
  schedule_time: number;
  status: BotTaskStatus;
  error_reason: string | null;
  created_at: number;
  executed_at: number | null;
}

export interface BotAuditLogRow {
  id: string;
  bot_id: string;
  group_id: string | null;
  action: string;
  target_id: string | null;
  details: string | null;
  created_at: number;
}

