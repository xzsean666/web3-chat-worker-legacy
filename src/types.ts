import type { UserRow, SessionRow, FriendRow, BlacklistRow, BotRow } from './db/schema';

export interface Env {
  DB: D1Database;
  VOICE_BUCKET: R2Bucket;
  // 权益快照 bucket（契约 §2）；未绑定时回退 VOICE_BUCKET + entitlements/ 前缀
  ENTITLEMENT_BUCKET?: R2Bucket;
  // 内部管理 API HMAC 共享密钥（契约 §7，wrangler secret 注入）；缺失时内部 API 返回 503
  INTERNAL_ADMIN_SECRET?: string;
  MESSAGE_RECALL_WINDOW_SECONDS?: string | number;
  DIVIDEND_INDEX_ENABLED?: string;
  DIVIDEND_RPC_56?: string;
  DIVIDEND_FACTORY_56?: string;
  DIVIDEND_START_BLOCK_56?: string;
  DIVIDEND_RPC_97?: string;
  DIVIDEND_FACTORY_97?: string;
  DIVIDEND_START_BLOCK_97?: string;
  HYPERLIQUID_API?: string;
}

export type User = UserRow;
export type Session = SessionRow;
export type Friend = FriendRow;
export type Blacklist = BlacklistRow;
export type Bot = BotRow;

export type MemberRole = 'owner' | 'admin' | 'member';
export type MessageType = 'text' | 'voice' | 'image' | 'file' | 'system' | 'sticker';
export type RetentionType = 'permanent' | 'on_read';
export type MessageStatus = 'pending' | 'delivered' | 'read';

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

export type AppVariables = {
  user: UserRow;
  session: SessionRow;
  token: string;
  bot?: BotRow;
};

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}
