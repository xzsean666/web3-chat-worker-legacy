// Database Entity Definitions

export interface UserRow {
  id: string;
  wallet_address: string;
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
  type: 'direct' | 'group';
  owner_address: string | null;
  name: string | null;
  metadata: string;
  is_muted: number;
  mute_until: number | null;
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
  joined_at: number;
  last_read_message_id: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: 'text' | 'voice' | 'image' | 'file';
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

