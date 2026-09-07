import type { UserRow, SessionRow, FriendRow, BlacklistRow } from './db/schema';

export interface Env {
  DB: D1Database;
  VOICE_BUCKET: R2Bucket;
  MESSAGE_RECALL_WINDOW_SECONDS?: string | number;
}

export type User = UserRow;
export type Session = SessionRow;
export type Friend = FriendRow;
export type Blacklist = BlacklistRow;

export type ConversationType = 'direct' | 'group';
export type MemberRole = 'owner' | 'member';
export type MessageType = 'text' | 'voice' | 'image' | 'file';
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
};

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}
