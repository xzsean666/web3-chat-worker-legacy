import type { MessageType } from '../types';

export interface GroupMessageItem {
  seq: number;
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  content: string;
  metadata?: string | Record<string, unknown> | null;
  createdAt: number;
  skipD1WriteBack?: boolean;
}

export interface WatermarkItem {
  userId: string;
  lastReadSeq: number;
  updatedAt: number;
}

export interface PostMessagePayload {
  id?: string;
  conversationId?: string;
  senderId: string;
  type?: MessageType;
  content: string;
  metadata?: string | Record<string, unknown> | null;
  createdAt?: number;
  // 管理员或群主标识（免除慢速模式限制）
  isAdminOrOwner?: boolean;
  // 是否跳过写回中心 D1（当来自 HTTP 接口写入后只做广播时为 true）
  skipD1WriteBack?: boolean;
  // 是否采用非阻塞异步扇出广播
  asyncBroadcast?: boolean;
  // 显式启用/禁用自适应防涌浪限流（默认根据群设置）
  adaptiveFloodProtection?: boolean;
}

export interface GroupSyncQuery {
  sinceSeq?: number;
  beforeSeq?: number;
  limit?: number;
}

export interface GroupSyncResult {
  messages: GroupMessageItem[];
  latestSeq: number;
  hasMore: boolean;
}

export type BroadcasterFrame =
  | { type: 'messages_batch'; groupId: string; messages: GroupMessageItem[] }
  | { type: 'message_recalled'; message_id: string; conversation_id: string }
  | { type: 'kicked'; user_id: string; group_id: string; reason?: string };

export type ClientAction =
  | { action: 'send'; id?: string; type?: MessageType; content: string; metadata?: any }
  | { action: 'read_watermark'; last_read_seq: number }
  | { action: 'sync'; since_seq?: number; before_seq?: number; limit?: number }
  | { action: 'ping' };

export const TOTAL_DEFAULT_SHARDS = 50;
export const RING_BUFFER_MAX_SIZE = 500;
export const AUTO_BATCH_MAX_SIZE = 50;
export const AUTO_BATCH_WAIT_MS = 20;
export const COALESCE_WINDOW_MS = 100;
