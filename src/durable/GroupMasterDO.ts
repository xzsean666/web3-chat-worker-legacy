import type { Env } from '../types';
import { assertCanSendMessage } from '../services/conversations';
import {
  type GroupMessageItem,
  type PostMessagePayload,
  type WatermarkItem,
  type GroupSyncResult,
  RING_BUFFER_MAX_SIZE,
  AUTO_BATCH_MAX_SIZE,
  AUTO_BATCH_WAIT_MS,
  TOTAL_DEFAULT_SHARDS,
} from './types';

export class GroupMasterDO {
  private currentSeq = 0;
  private ringBuffer: GroupMessageItem[] = [];
  private pendingWrites: GroupMessageItem[] = [];
  private flushTimer: any = null;
  private slowModeSeconds = 0;
  private adaptiveFloodEnabled = false;
  private lastSendMap = new Map<string, number>();
  private activeShardsSet = new Set<number>();
  private kickedUsers = new Set<string>();
  private mutedUsers = new Map<string, number>();
  private groupMutedUntil: number | null = null;
  private recentMessageTimestamps: number[] = [];
  public static readonly DYNAMIC_FLOOD_THRESHOLD = 25; // 25 msg/s
  public static readonly DYNAMIC_FLOOD_COOLDOWN_SEC = 2; // 2s cooldown during flood surge
  private initialized = false;

  constructor(
    public readonly ctx: DurableObjectState,
    public readonly env: Env
  ) {}

  /**
   * 确保原生 SQLite 数据表结构就绪并恢复当前最大序号和热缓存 RingBuffer
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    if (this.ctx.storage?.sql) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY,
          id TEXT UNIQUE NOT NULL,
          conversation_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'text',
          content TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
        CREATE TABLE IF NOT EXISTS user_watermarks (
          user_id TEXT PRIMARY KEY,
          last_read_seq INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS group_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      // 恢复当前最大序号
      const cursor = this.ctx.storage.sql.exec('SELECT MAX(seq) AS max_seq FROM messages');
      const rows = cursor.toArray();
      const maxSeq = rows[0]?.max_seq;
      this.currentSeq = maxSeq && typeof maxSeq === 'number' ? maxSeq : Number(maxSeq || 0);

      // 加载群配置（慢速模式等）
      const configCursor = this.ctx.storage.sql.exec('SELECT key, value FROM group_config');
      for (const row of configCursor.toArray()) {
        if (row.key === 'slow_mode_seconds') {
          this.slowModeSeconds = Number(row.value) || 0;
        } else if (row.key === 'adaptive_flood_enabled') {
          this.adaptiveFloodEnabled = row.value === 'true' || row.value === '1';
        }
      }

      // 预热内存 RingBuffer（加载最新的最多 500 条）
      const recentCursor = this.ctx.storage.sql.exec(
        `SELECT seq, id, conversation_id, sender_id, type, content, metadata, created_at 
         FROM messages ORDER BY seq DESC LIMIT ?`,
        RING_BUFFER_MAX_SIZE
      );
      const recentRows = recentCursor.toArray().reverse();
      this.ringBuffer = recentRows.map((r: any) => ({
        seq: Number(r.seq),
        id: String(r.id),
        conversationId: String(r.conversation_id),
        senderId: String(r.sender_id),
        type: r.type,
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        createdAt: Number(r.created_at),
      }));
    }

    this.initialized = true;
  }

  /**
   * 注册当前有客户端连接的活跃广播分片（避免向空分片无脑发起 50 次 RPC）
   */
  public registerActiveShard(shardId: number): void {
    this.activeShardsSet.add(shardId);
  }

  /**
   * 注销不再有客户端连接的空闲广播分片（避免向空分片发送冗余 RPC）
   */
  public unregisterActiveShard(shardId: number): void {
    this.activeShardsSet.delete(shardId);
  }

  /**
   * 发送/写入群消息：
   * 1. 禁言与黑名单权限拦截校验 (安全防御)
   * 2. 慢速发言限流检查 (Slow Mode)
   * 3. 绝对单调自增序号分配 (保序)
   * 4. 内存 RingBuffer 极速直出
   * 5. Auto-Batch 本地 SQLite 刷盘与异步写回全局 D1
   * 6. 并发扇出广播到活跃 Broadcaster 分片
   */
  public async postMessage(payload: PostMessagePayload): Promise<GroupMessageItem> {
    await this.ensureInitialized();

    const now = Date.now();
    const senderId = payload.senderId;
    const conversationId = payload.conversationId || 'default_group';

    // 0. 基础内容安全校验（防 DoS / 空内容注入）
    const msgType = payload.type || 'text';
    const content = payload.content ? payload.content.trim() : null;
    if (msgType === 'text' && !content) {
      const err: any = new Error('Message content cannot be empty for text messages');
      err.status = 400;
      throw err;
    }
    if (content && content.length > 4000) {
      const err: any = new Error('Message content exceeds maximum limit of 4000 characters');
      err.status = 400;
      throw err;
    }

    // 0.1 内存快速安全拦截（被踢/禁言快速拦截）
    const senderLower = senderId.toLowerCase();
    if (this.kickedUsers.has(senderLower)) {
      const err: any = new Error('Unauthorized: you are not a member of this group');
      err.status = 403;
      throw err;
    }
    if (this.groupMutedUntil !== null) {
      if (this.groupMutedUntil === -1 || this.groupMutedUntil > now) {
        if (!payload.isAdminOrOwner) {
          const err: any = new Error('Group is muted');
          err.status = 403;
          throw err;
        }
      } else {
        this.groupMutedUntil = null;
      }
    }
    const mutedUntil = this.mutedUsers.get(senderLower);
    if (mutedUntil !== undefined) {
      if (mutedUntil === -1 || mutedUntil > now) {
        const err: any = new Error('You are muted in this group');
        err.status = 403;
        throw err;
      } else {
        this.mutedUsers.delete(senderLower);
      }
    }

    // 1. 安全防御：若该消息来自 WebSocket 直发（未经过 HTTP 层的校验），且会话在 D1 存在，严格执行禁言与成员资格校验
    if (!payload.skipD1WriteBack && this.env?.DB) {
      const convExists = await this.env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?').bind(conversationId).first();
      if (convExists) {
        await assertCanSendMessage(this.env.DB, conversationId, senderId);
      }
    }

    // 2. 慢速发言限流检查 (Slow Mode & 智能自适应涌浪限流)
    let effectiveSlowMode = this.slowModeSeconds;

    // 清理 1 秒前的滑动窗口时间戳
    const oneSecAgo = now - 1000;
    while (this.recentMessageTimestamps.length > 0 && this.recentMessageTimestamps[0] < oneSecAgo) {
      this.recentMessageTimestamps.shift();
    }
    this.recentMessageTimestamps.push(now);

    // 智能自适应涌浪限流：当配置开启自适应限流或请求显式开启且未配置显式慢速模式时，群瞬时速度突破阈值（25 msg/s）自动启动 2 秒涌浪阻尼
    const isAdaptiveCheck = payload.adaptiveFloodProtection ?? this.adaptiveFloodEnabled;
    if (isAdaptiveCheck && effectiveSlowMode === 0 && this.recentMessageTimestamps.length >= GroupMasterDO.DYNAMIC_FLOOD_THRESHOLD) {
      effectiveSlowMode = GroupMasterDO.DYNAMIC_FLOOD_COOLDOWN_SEC;
    }

    if (effectiveSlowMode > 0 && !payload.isAdminOrOwner) {
      const lastSend = this.lastSendMap.get(senderId) || 0;
      const cooldownMs = effectiveSlowMode * 1000;
      if (now - lastSend < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - (now - lastSend)) / 1000);
        const error: any = new Error(`SLOW_MODE_COOLDOWN:${remainingSeconds}`);
        error.status = 429;
        throw error;
      }
    }

    // 3. 绝对单调自增序号 (Strict Total Ordering)
    const seq = ++this.currentSeq;
    this.lastSendMap.set(senderId, now);

    // 定期回收过期的 lastSendMap 记录，防止 10 万人群长期堆积内存泄漏
    if (this.lastSendMap.size > 10000) {
      const cutoff = now - (effectiveSlowMode > 0 ? effectiveSlowMode * 2000 : 60000);
      for (const [uid, time] of this.lastSendMap.entries()) {
        if (time < cutoff) this.lastSendMap.delete(uid);
      }
    }

    const message: GroupMessageItem = {
      seq,
      id: payload.id || crypto.randomUUID(),
      conversationId,
      senderId: payload.senderId,
      type: msgType,
      content: content ?? '',
      metadata: payload.metadata || null,
      createdAt: payload.createdAt || now,
      skipD1WriteBack: payload.skipD1WriteBack,
    };

    // 4. 内存 RingBuffer 直存（毫秒级热点直出）
    this.ringBuffer.push(message);
    if (this.ringBuffer.length > RING_BUFFER_MAX_SIZE) {
      this.ringBuffer.shift();
    }

    // 5. 进入 Auto-Batch 队列
    this.pendingWrites.push(message);
    if (this.pendingWrites.length >= AUTO_BATCH_MAX_SIZE) {
      const p = this.flushPendingWrites();
      if (this.ctx && typeof (this.ctx as any).waitUntil === 'function') {
        (this.ctx as any).waitUntil(p);
      } else {
        void p;
      }
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const p = this.flushPendingWrites();
        if (this.ctx && typeof (this.ctx as any).waitUntil === 'function') {
          (this.ctx as any).waitUntil(p);
        } else {
          void p;
        }
      }, AUTO_BATCH_WAIT_MS);
    }

    // 6. 并行扇出 RPC 广播给活跃的 Broadcaster 分片 (当显式指定 asyncBroadcast 时异步后台执行，极速返回发送者回执)
    const broadcastPromise = this.fanOutBroadcast(message);
    const shouldAsync = payload.asyncBroadcast === true && this.ctx && typeof (this.ctx as any).waitUntil === 'function';
    if (shouldAsync) {
      (this.ctx as any).waitUntil(broadcastPromise);
    } else {
      await broadcastPromise;
    }

    return message;
  }

  /**
   * Auto-Batch 批量事务落盘到 DO 原生嵌入式 SQLite，并异步写回全局 D1（解决数据割裂）
   */
  public async flushPendingWrites(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingWrites.length === 0) return;

    const batch = [...this.pendingWrites];
    this.pendingWrites = [];

    // 1. 本地原生嵌入式 SQLite 原子事务落盘
    if (this.ctx.storage?.sql) {
      try {
        for (const msg of batch) {
          const metaStr = msg.metadata ? JSON.stringify(msg.metadata) : null;
          this.ctx.storage.sql.exec(
            `INSERT OR IGNORE INTO messages (seq, id, conversation_id, sender_id, type, content, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            msg.seq,
            msg.id,
            msg.conversationId,
            msg.senderId,
            msg.type,
            msg.content,
            metaStr,
            msg.createdAt
          );
        }
      } catch (err) {
        console.error('[GroupMasterDO] Auto-Batch local SQLite flush error:', err);
      }
    }

    // 2. 异步批量写回全局 D1（保证全局离线消息查询、/sync、未读数完全同步）
    const needWriteBack = batch.filter((m) => !m.skipD1WriteBack);
    if (needWriteBack.length > 0 && this.env?.DB) {
      try {
        const stmts: D1PreparedStatement[] = [];
        const convUpdated = new Set<string>();

        for (const msg of needWriteBack) {
          const expiresAt = msg.createdAt + 24 * 60 * 60 * 1000;
          stmts.push(
            this.env.DB.prepare(`
              INSERT OR IGNORE INTO messages (
                id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at, burn_after_seconds, mentions
              ) VALUES (?, ?, ?, ?, ?, 'permanent', 'pending', ?, ?, null, '[]')
            `).bind(msg.id, msg.conversationId, msg.senderId, msg.type, msg.content, expiresAt, msg.createdAt)
          );

          if (!convUpdated.has(msg.conversationId)) {
            convUpdated.add(msg.conversationId);
            stmts.push(
              this.env.DB.prepare(
                'UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?'
              ).bind(msg.createdAt, msg.createdAt, msg.conversationId)
            );
          }
        }

        if (stmts.length > 0) {
          await this.env.DB.batch(stmts);
        }
      } catch (err: any) {
        // 在独立 DO 单测或 D1 尚未建群的情况下忽略外键约束异常，防止污染测试日志
        if (!err?.message?.includes('FOREIGN KEY')) {
          console.error('[GroupMasterDO] Write-back to global D1 failed:', err);
        }
      }
    }
  }

  /**
   * 并发扇出广播到当前活跃的 Broadcaster 分片
   */
  private async fanOutBroadcast(message: GroupMessageItem): Promise<void> {
    if (!this.env.GROUP_BROADCASTER_DO) return;

    // 自适应广播：如果活跃集合为空，默认广播分片 0；否则仅广播给有真实连接的活跃分片
    const targetShards = this.activeShardsSet.size > 0 
      ? Array.from(this.activeShardsSet) 
      : [0];

    const payload = JSON.stringify({
      type: 'dispatch_message',
      message,
    });

    // 采用 10 分片分块并发池（Subrequest Pooling），平滑分散 Cloudflare 内部并发子请求与事件循环调度
    const CHUNK_SIZE = 10;
    for (let i = 0; i < targetShards.length; i += CHUNK_SIZE) {
      const chunk = targetShards.slice(i, i + CHUNK_SIZE);
      await Promise.allSettled(
        chunk.map((shardId) => {
          const shardName = `${message.conversationId}:shard_${shardId}`;
          const doId = this.env.GROUP_BROADCASTER_DO!.idFromName(shardName);
          const stub = this.env.GROUP_BROADCASTER_DO!.get(doId);
          return stub
            .fetch('http://internal/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: payload,
            })
            .catch((err) => {
              console.error(`[GroupMasterDO] Fan-out failed on shard ${shardId}:`, err);
            });
        })
      );
    }
  }

  /**
   * 消息撤回 (Recall) 处理与全网广播
   */
  public async handleMessageRecall(messageId: string, conversationId: string): Promise<void> {
    await this.ensureInitialized();

    // 1. 本地 SQLite 标记撤回
    if (this.ctx.storage?.sql) {
      this.ctx.storage.sql.exec(
        `UPDATE messages SET content = '[Message recalled]' WHERE id = ?`,
        messageId
      );
    }

    // 2. 内存 RingBuffer 替换内容
    const ringItem = this.ringBuffer.find((m) => m.id === messageId);
    if (ringItem) {
      ringItem.content = '[Message recalled]';
    }

    // 3. 向活跃广播分片下发撤回广播 (采用 10 分片分块并发池)
    if (this.env.GROUP_BROADCASTER_DO) {
      const targetShards = this.activeShardsSet.size > 0 
        ? Array.from(this.activeShardsSet) 
        : [0];

      const payload = JSON.stringify({
        type: 'dispatch_recall',
        messageId,
        conversationId,
      });

      const CHUNK_SIZE = 10;
      for (let i = 0; i < targetShards.length; i += CHUNK_SIZE) {
        const chunk = targetShards.slice(i, i + CHUNK_SIZE);
        await Promise.allSettled(
          chunk.map((shardId) => {
            const shardName = `${conversationId}:shard_${shardId}`;
            const doId = this.env.GROUP_BROADCASTER_DO!.idFromName(shardName);
            const stub = this.env.GROUP_BROADCASTER_DO!.get(doId);
            return stub
              .fetch('http://internal/broadcast_recall', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
              })
              .catch((e) => console.error('[GroupMasterDO] Broadcast recall error:', e));
          })
        );
      }
    }
  }

  /**
   * 水位线游标批量持久化 (Watermark ACK) - 使用原生兼容的 MAX 函数，并同步写回全局 D1
   */
  public async updateWatermarks(watermarks: WatermarkItem[]): Promise<void> {
    await this.ensureInitialized();
    if (!watermarks || watermarks.length === 0) return;

    if (this.ctx.storage?.sql) {
      for (const w of watermarks) {
        this.ctx.storage.sql.exec(
          `INSERT INTO user_watermarks (user_id, last_read_seq, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET 
             last_read_seq = MAX(user_watermarks.last_read_seq, excluded.last_read_seq),
             updated_at = excluded.updated_at`,
          w.userId,
          w.lastReadSeq,
          w.updatedAt
        );
      }
    }

    // 将 WebSocket 已读水位线同步回全局 D1（更新 conversation_members.last_read_message_id 与 message_receipts）
    if (this.env?.DB && this.ctx.storage?.sql) {
      try {
        const stmts: D1PreparedStatement[] = [];
        for (const w of watermarks) {
          const cursor = this.ctx.storage.sql.exec(
            'SELECT id, conversation_id FROM messages WHERE seq <= ? ORDER BY seq DESC LIMIT 1',
            w.lastReadSeq
          );
          const rows = cursor.toArray();
          if (rows.length > 0) {
            const msgId = String(rows[0].id);
            const convId = String(rows[0].conversation_id);
            const receiptId = crypto.randomUUID();
            stmts.push(
              this.env.DB.prepare(
                'UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?'
              ).bind(msgId, convId, w.userId)
            );
            stmts.push(
              this.env.DB.prepare(`
                INSERT OR IGNORE INTO message_receipts (id, message_id, user_id, status, timestamp)
                VALUES (?, ?, ?, 'read', ?)
              `).bind(receiptId, msgId, w.userId, w.updatedAt)
            );
          }
        }
        if (stmts.length > 0) {
          await this.env.DB.batch(stmts);
        }
      } catch (err: any) {
        if (!err?.message?.includes('FOREIGN KEY')) {
          console.error('[GroupMasterDO] Sync watermarks to D1 failed:', err);
        }
      }
    }
  }

  /**
   * 查询消息与增量补洞：支持 sinceSeq 增量向下同步与 beforeSeq 向上历史翻页
   */
  public async getMessages(sinceSeq = 0, limit = 50, beforeSeq?: number): Promise<GroupSyncResult> {
    await this.ensureInitialized();

    const safeLimit = Math.min(Math.max(limit, 1), 200);

    // 1. 若指定了 beforeSeq 进行向上历史翻页
    if (beforeSeq !== undefined && beforeSeq > 0) {
      if (this.ctx.storage?.sql) {
        const cursor = this.ctx.storage.sql.exec(
          `SELECT seq, id, conversation_id, sender_id, type, content, metadata, created_at
           FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?`,
          beforeSeq,
          safeLimit + 1
        );
        const rows = cursor.toArray();
        const hasMore = rows.length > safeLimit;
        const resultRows = (hasMore ? rows.slice(0, safeLimit) : rows).reverse();

        const messages: GroupMessageItem[] = resultRows.map((r: any) => ({
          seq: Number(r.seq),
          id: String(r.id),
          conversationId: String(r.conversation_id),
          senderId: String(r.sender_id),
          type: r.type,
          content: r.content,
          metadata: r.metadata ? JSON.parse(r.metadata) : null,
          createdAt: Number(r.created_at),
        }));

        return {
          messages,
          latestSeq: this.currentSeq,
          hasMore,
        };
      }

      // 降级使用 RingBuffer
      const filtered = this.ringBuffer.filter((m) => m.seq < beforeSeq);
      const hasMore = filtered.length > safeLimit;
      const sliced = filtered.slice(-safeLimit);
      return {
        messages: sliced,
        latestSeq: this.currentSeq,
        hasMore,
      };
    }

    // 2. 常规 sinceSeq 向下同步：优先内存 RingBuffer 直出
    if (this.ringBuffer.length > 0) {
      const minSeqInBuffer = this.ringBuffer[0].seq;
      if (sinceSeq >= minSeqInBuffer - 1) {
        const filtered = this.ringBuffer.filter((m) => m.seq > sinceSeq);
        const sliced = filtered.slice(0, safeLimit);
        return {
          messages: sliced,
          latestSeq: this.currentSeq,
          hasMore: filtered.length > safeLimit,
        };
      }
    }

    // 2. 内存未覆盖（深度历史记录），回退到 DO 本地 SQLite
    if (this.ctx.storage?.sql) {
      const cursor = this.ctx.storage.sql.exec(
        `SELECT seq, id, conversation_id, sender_id, type, content, metadata, created_at
         FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        sinceSeq,
        safeLimit + 1
      );
      const rows = cursor.toArray();
      const hasMore = rows.length > safeLimit;
      const resultRows = hasMore ? rows.slice(0, safeLimit) : rows;

      const messages: GroupMessageItem[] = resultRows.map((r: any) => ({
        seq: Number(r.seq),
        id: String(r.id),
        conversationId: String(r.conversation_id),
        senderId: String(r.sender_id),
        type: r.type,
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        createdAt: Number(r.created_at),
      }));

      return {
        messages,
        latestSeq: this.currentSeq,
        hasMore,
      };
    }

    return {
      messages: [],
      latestSeq: this.currentSeq,
      hasMore: false,
    };
  }

  /**
   * 配置更新（慢速模式秒数等）
   */
  public async setConfig(key: string, value: string): Promise<void> {
    await this.ensureInitialized();

    if (key === 'slow_mode_seconds') {
      this.slowModeSeconds = Number(value) || 0;
    } else if (key === 'adaptive_flood_enabled') {
      this.adaptiveFloodEnabled = value === 'true' || value === '1';
    }

    if (this.ctx.storage?.sql) {
      this.ctx.storage.sql.exec(
        `INSERT INTO group_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value
      );
    }
  }

  /**
   * 获取当前运行时监控数据
   */
  public getStats() {
    const now = Date.now();
    const oneSecAgo = now - 1000;
    const recentVelocity = this.recentMessageTimestamps.filter((t) => t >= oneSecAgo).length;
    return {
      currentSeq: this.currentSeq,
      ringBufferSize: this.ringBuffer.length,
      pendingWritesCount: this.pendingWrites.length,
      slowModeSeconds: this.slowModeSeconds,
      activeShardsCount: this.activeShardsSet.size,
      activeShards: Array.from(this.activeShardsSet),
      recentMessageRate: recentVelocity,
      adaptiveFloodEnabled: this.adaptiveFloodEnabled,
      adaptiveFloodActive: this.adaptiveFloodEnabled && this.slowModeSeconds === 0 && recentVelocity >= GroupMasterDO.DYNAMIC_FLOOD_THRESHOLD,
    };
  }

  /**
   * 立即失效并刷新内存中用户的发言限流与角色权限状态
   */
  public invalidateUserCache(userId: string, action: string, mutedUntil?: number | null): void {
    if (!userId) return;
    if (userId === '*') {
      if (action === 'mute') {
        this.groupMutedUntil = typeof mutedUntil === 'number' ? mutedUntil : -1;
      } else if (action === 'unmute') {
        this.groupMutedUntil = null;
      }
      return;
    }

    const uid = userId.toLowerCase();
    this.lastSendMap.delete(uid);

    if (action === 'kick' || action === 'leave') {
      this.kickedUsers.add(uid);
      this.mutedUsers.delete(uid);
    } else if (action === 'join') {
      this.kickedUsers.delete(uid);
    } else if (action === 'mute') {
      this.mutedUsers.set(uid, typeof mutedUntil === 'number' ? mutedUntil : -1);
    } else if (action === 'unmute') {
      this.mutedUsers.delete(uid);
    } else if (action === 'role_change') {
      this.lastSendMap.delete(uid);
    }
  }

  /**
   * HTTP 路由分发入口 (RPC 协议)
   */
  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();
    const url = new URL(request.url);

    try {
      if (url.pathname === '/messages' && request.method === 'POST') {
        const payload: PostMessagePayload = await request.json();
        const msg = await this.postMessage(payload);
        return new Response(JSON.stringify({ success: true, message: msg }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/messages' && request.method === 'GET') {
        const sinceSeq = Number(url.searchParams.get('since_seq') || '0');
        const beforeSeqParam = url.searchParams.get('before_seq');
        const beforeSeq = beforeSeqParam !== null ? Number(beforeSeqParam) : undefined;
        const limit = Number(url.searchParams.get('limit') || '50');
        const result = await this.getMessages(sinceSeq, limit, beforeSeq);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/register_active_shard' && request.method === 'POST') {
        const { shardId } = await request.json<any>();
        if (typeof shardId === 'number') {
          this.registerActiveShard(shardId);
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/unregister_active_shard' && request.method === 'POST') {
        const { shardId } = await request.json<any>();
        if (typeof shardId === 'number') {
          this.unregisterActiveShard(shardId);
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/recall' && request.method === 'POST') {
        const { messageId, conversationId } = await request.json<any>();
        await this.handleMessageRecall(messageId, conversationId);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/watermarks' && request.method === 'POST') {
        const watermarks: WatermarkItem[] = await request.json();
        await this.updateWatermarks(watermarks);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/config' && request.method === 'POST') {
        const { key, value } = await request.json<any>();
        await this.setConfig(key, String(value));
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/invalidate_cache' && request.method === 'POST') {
        const { userId, action, mutedUntil } = await request.json<any>();
        if (userId && typeof userId === 'string') {
          this.invalidateUserCache(userId, action, mutedUntil);
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/stats' && request.method === 'GET') {
        return new Response(JSON.stringify(this.getStats()), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      if (err.message?.startsWith('SLOW_MODE_COOLDOWN')) {
        const seconds = err.message.split(':')[1];
        return new Response(
          JSON.stringify({ error: 'SLOW_MODE_COOLDOWN', remainingSeconds: Number(seconds) }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const isAuthError = err.message?.includes('Unauthorized') || err.message?.includes('muted') || err.message?.includes('blocked');
      const status = isAuthError ? 403 : 500;
      return new Response(JSON.stringify({ error: err.message || 'INTERNAL_ERROR' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
