import type { Env } from '../types';
import {
  type GroupMessageItem,
  type WatermarkItem,
  type ClientAction,
  COALESCE_WINDOW_MS,
} from './types';

export class GroupBroadcasterDO {
  private coalesceQueue: GroupMessageItem[] = [];
  private coalesceTimer: any = null;
  private watermarkMap = new Map<string, number>();
  private watermarkSyncTimer: any = null;
  private masterGroupId: string | null = null;
  private currentShardId = 0;

  constructor(
    public readonly ctx: DurableObjectState,
    public readonly env: Env
  ) {}

  /**
   * 接收来自 GroupMasterDO 的下行广播消息并进入 100ms 帧合流队列
   */
  public queueBroadcastMessage(message: GroupMessageItem): void {
    this.masterGroupId = message.conversationId;
    this.coalesceQueue.push(message);

    if (!this.coalesceTimer) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        this.flushCoalescedMessages();
      }, COALESCE_WINDOW_MS);
    }
  }

  /**
   * 执行 100ms 帧合流广播：打包为单个复合数组帧，分发给当前分片管理的所有 WebSocket
   */
  public flushCoalescedMessages(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }

    const messages = [...this.coalesceQueue];
    this.coalesceQueue = [];
    if (messages.length === 0) return;

    const sanitizedMessages = messages.map((m: GroupMessageItem) => {
      const { skipD1WriteBack, ...clean } = m;
      return clean;
    });

    const frame = JSON.stringify({
      type: 'messages_batch',
      groupId: this.masterGroupId,
      messages: sanitizedMessages,
    });

    const sockets = this.ctx.getWebSockets ? this.ctx.getWebSockets() : [];
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch (err) {
        // 捕获个别网络异常断开，由 Cloudflare 运行时触发 webSocketClose 清理
      }
    }
  }

  /**
   * 收集并折叠用户上报的已读游标 (Watermark)
   */
  public recordWatermark(userId: string, lastReadSeq: number): void {
    const current = this.watermarkMap.get(userId) || 0;
    if (lastReadSeq > current) {
      this.watermarkMap.set(userId, lastReadSeq);
    }

    if (!this.watermarkSyncTimer) {
      this.watermarkSyncTimer = setTimeout(() => {
        this.watermarkSyncTimer = null;
        void this.syncWatermarksToMaster();
      }, 5000);
    }
  }

  /**
   * 定期将聚合后的游标字典批量同步回 GroupMasterDO
   */
  public async syncWatermarksToMaster(): Promise<void> {
    if (this.watermarkSyncTimer) {
      clearTimeout(this.watermarkSyncTimer);
      this.watermarkSyncTimer = null;
    }

    if (this.watermarkMap.size === 0 || !this.env.GROUP_MASTER_DO || !this.masterGroupId) return;

    const watermarks: WatermarkItem[] = [];
    const now = Date.now();
    for (const [userId, lastReadSeq] of this.watermarkMap.entries()) {
      watermarks.push({ userId, lastReadSeq, updatedAt: now });
    }
    this.watermarkMap.clear();

    try {
      const masterId = this.env.GROUP_MASTER_DO.idFromName(this.masterGroupId);
      const masterStub = this.env.GROUP_MASTER_DO.get(masterId);
      await masterStub.fetch('http://internal/watermarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(watermarks),
      });
    } catch (err) {
      console.error('[GroupBroadcasterDO] Sync watermarks to MasterDO failed:', err);
    }
  }

  /**
   * 广播撤回事件给当前分片连接的所有客户端
   */
  public broadcastRecallEvent(messageId: string, conversationId: string): void {
    const frame = JSON.stringify({
      type: 'message_recalled',
      message_id: messageId,
      conversation_id: conversationId,
    });
    const sockets = this.ctx.getWebSockets ? this.ctx.getWebSockets() : [];
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // ignore
      }
    }
  }

  /**
   * 强制踢下线违规或被移出群聊的成员连接
   */
  public kickUserConnection(userId: string): void {
    const sockets = this.ctx.getWebSockets ? this.ctx.getWebSockets() : [];
    for (const ws of sockets) {
      const attachment: any = (ws as any).deserializeAttachment ? (ws as any).deserializeAttachment() : null;
      if (attachment?.userId?.toLowerCase() === userId.toLowerCase()) {
        try {
          ws.send(JSON.stringify({ type: 'kicked', reason: 'REMOVED_FROM_GROUP' }));
          ws.close(4003, 'KICKED_FROM_GROUP');
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Cloudflare Hibernatable WebSocket 消息事件监听
   */
  async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    try {
      const str = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
      const data: ClientAction = JSON.parse(str);

      // 心跳保持
      if (data.action === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      // 游标已读上报 (Watermark ACK)
      if (data.action === 'read_watermark') {
        if (typeof data.last_read_seq === 'number' && data.last_read_seq > 0) {
          const attachment: any = (ws as any).deserializeAttachment ? (ws as any).deserializeAttachment() : null;
          const userId = attachment?.userId || 'anonymous';
          this.recordWatermark(userId, data.last_read_seq);
        }
        return;
      }

      // 客户端断线重连补洞 (Gap-Filling Sync) 与向上历史翻页
      if (data.action === 'sync') {
        const attachment: any = (ws as any).deserializeAttachment ? (ws as any).deserializeAttachment() : null;
        const targetGroupId = attachment?.groupId || this.masterGroupId;
        if (!this.env.GROUP_MASTER_DO || !targetGroupId) return;
        const masterId = this.env.GROUP_MASTER_DO.idFromName(targetGroupId);
        const masterStub = this.env.GROUP_MASTER_DO.get(masterId);
        const limit = Math.min(Number(data.limit) || 100, 100);
        let query = `limit=${limit}`;
        if (data.before_seq !== undefined && data.before_seq !== null) {
          query += `&before_seq=${data.before_seq}`;
        } else {
          query += `&since_seq=${data.since_seq || 0}`;
        }
        const res = await masterStub.fetch(`http://internal/messages?${query}`);
        if (res.ok) {
          const syncResult = (await res.json()) as Record<string, unknown>;
          ws.send(JSON.stringify({ type: 'sync_result', ...syncResult }));
        }
        return;
      }

      // 客户端直接通过长连接发送消息 (WebSocket Upstream Send)
      if (data.action === 'send') {
        const attachment: any = (ws as any).deserializeAttachment ? (ws as any).deserializeAttachment() : null;
        const targetGroupId = attachment?.groupId || this.masterGroupId;
        if (!this.env.GROUP_MASTER_DO || !targetGroupId) return;
        const senderId = attachment?.userId || 'anonymous';
        const role = attachment?.role || 'member';
        const isAdminOrOwner = role === 'owner' || role === 'admin';

        // 严格安全防御：非空检查与超长截断（防 DoS / OOM）
        if (!data.content || typeof data.content !== 'string' || !data.content.trim()) {
          ws.send(JSON.stringify({ type: 'send_error', error: 'EMPTY_CONTENT' }));
          return;
        }
        if (data.content.length > 4000) {
          ws.send(JSON.stringify({ type: 'send_error', error: 'CONTENT_TOO_LONG: maximum 4000 characters allowed' }));
          return;
        }

        // 消息 ID 安全过滤：仅允许安全 UUID，否则由服务端生成唯一凭据
        const safeMessageId = typeof data.id === 'string' && /^[0-9a-zA-Z_-]{10,64}$/.test(data.id)
          ? data.id
          : crypto.randomUUID();

        const masterId = this.env.GROUP_MASTER_DO.idFromName(targetGroupId);
        const masterStub = this.env.GROUP_MASTER_DO.get(masterId);

        const res = await masterStub.fetch('http://internal/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: safeMessageId,
            conversationId: targetGroupId,
            senderId,
            type: data.type || 'text',
            content: data.content.trim(),
            metadata: data.metadata,
            isAdminOrOwner,
          }),
        });

        if (res.ok) {
          const result = (await res.json()) as Record<string, unknown>;
          ws.send(JSON.stringify({ type: 'send_ack', success: true, ...result }));
        } else {
          const errData = ((await res.json().catch(() => ({ error: 'FAILED_TO_SEND' }))) || {}) as Record<string, unknown>;
          ws.send(JSON.stringify({ type: 'send_error', ...errData }));
        }
      }
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', message: err.message || 'MALFORMED_MESSAGE' }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const remainingSockets = this.ctx.getWebSockets 
      ? this.ctx.getWebSockets().filter((s) => s !== ws) 
      : [];
    if (remainingSockets.length === 0 && this.env?.GROUP_MASTER_DO && this.masterGroupId) {
      try {
        const masterId = this.env.GROUP_MASTER_DO.idFromName(this.masterGroupId);
        const masterStub = this.env.GROUP_MASTER_DO.get(masterId);
        await masterStub.fetch('http://internal/unregister_active_shard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shardId: this.currentShardId }),
        }).catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[GroupBroadcasterDO] WebSocket error:', error);
  }

  /**
   * HTTP 入口：处理 WebSocket 握手升级、MasterDO 内部广播 RPC、撤回广播与踢人下线
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. 处理 MasterDO 下发的消息广播 RPC
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = await request.json<any>();
      if (body?.message) {
        this.queueBroadcastMessage(body.message);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. 处理撤回广播 RPC
    if (url.pathname === '/broadcast_recall' && request.method === 'POST') {
      const body = await request.json<any>();
      if (body?.messageId && body?.conversationId) {
        this.broadcastRecallEvent(body.messageId, body.conversationId);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. 处理踢人强制关闭 WebSocket 连接
    if (url.pathname === '/kick_user' && request.method === 'POST') {
      const body = await request.json<any>();
      if (body?.userId) {
        this.kickUserConnection(body.userId);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. 处理来自客户端的 WebSocket Upgrade 请求
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const userId = url.searchParams.get('user_id') || request.headers.get('X-User-Id') || 'anonymous';
      const role = url.searchParams.get('role') || 'member';
      let groupId = url.searchParams.get('group_id');
      if (!groupId && url.pathname.includes('/groups/')) {
        const match = url.pathname.match(/\/groups\/([^/]+)/);
        if (match) groupId = match[1];
      }
      groupId = groupId || this.masterGroupId || 'default_group';
      const shardIdStr = url.searchParams.get('shard_id');
      if (shardIdStr) {
        this.currentShardId = parseInt(shardIdStr, 10) || 0;
      }
      this.masterGroupId = groupId;

      const existingSockets = this.ctx.getWebSockets ? this.ctx.getWebSockets() : [];
      const isFirstSocket = existingSockets.length === 0;

      if ((server as any).serializeAttachment) {
        (server as any).serializeAttachment({ userId, groupId, role, connectedAt: Date.now() });
      }

      if (this.ctx.acceptWebSocket) {
        this.ctx.acceptWebSocket(server, [groupId, userId.toLowerCase()]);
      }

      // 仅在分片从 0 到 1 首个连接时向 MasterDO 注册活跃分片，避免连接风暴
      if (isFirstSocket && this.env?.GROUP_MASTER_DO) {
        try {
          const masterId = this.env.GROUP_MASTER_DO.idFromName(groupId);
          const masterStub = this.env.GROUP_MASTER_DO.get(masterId);
          await masterStub.fetch('http://internal/register_active_shard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shardId: this.currentShardId }),
          }).catch(() => {});
        } catch {
          // ignore
        }
      }

      try {
        return new Response(null, {
          status: 101,
          webSocket: client,
        } as any);
      } catch {
        const res = new Response(null, { status: 200 });
        Object.defineProperty(res, 'status', { value: 101 });
        Object.defineProperty(res, 'webSocket', { value: client });
        return res;
      }
    }

    // 5. 获取 Broadcaster 运行时统计
    if (url.pathname === '/stats' && request.method === 'GET') {
      const sockets = this.ctx.getWebSockets ? this.ctx.getWebSockets() : [];
      return new Response(
        JSON.stringify({
          activeWebSockets: sockets.length,
          coalesceQueueLength: this.coalesceQueue.length,
          pendingWatermarksCount: this.watermarkMap.size,
          masterGroupId: this.masterGroupId,
          currentShardId: this.currentShardId,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
  }
}
