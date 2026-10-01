import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { allow } from '../services/rateLimit';
import {
  sendMessage,
  getConversationMessages,
  acknowledgeDelivery,
  acknowledgeRead,
  getMessageReceipts,
  recallMessage,
  type SendMessageOptions,
} from '../services/messages';

const messageRoutes = new Hono<AppEnv>();

messageRoutes.use('/conversations/*', authMiddleware);
messageRoutes.use('/messages/*', authMiddleware);

interface BatchAckBody {
  message_ids?: string[];
}

// 单请求 ACK id 上限：正常客户端每批 ≤50，200 上限拦截恶意/异常超大批次打爆 D1
const MAX_ACK_BATCH_SIZE = 200;

// Conversation message sending and fetching
messageRoutes.post('/conversations/:id/messages', async (c) => {
  try {
    const user = c.get('user');
    const conversationId = c.req.param('id');

    // 限流保护：普通发言 120条/分钟
    if (!(await allow(c.env.DB, 'send_msg', user.id, 120))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }

    const body = (await c.req.json<SendMessageOptions>().catch(() => ({}))) as SendMessageOptions;

    const message = await sendMessage(c.env.DB, conversationId, user.id, body);

    // 联动优化：若是群聊且配置了 GROUP_MASTER_DO，向 MasterDO 同步以触发在线 WebSocket 即时广播
    if (c.env.GROUP_MASTER_DO && !conversationId.startsWith('direct:')) {
      try {
        const masterId = c.env.GROUP_MASTER_DO.idFromName(conversationId);
        const stub = c.env.GROUP_MASTER_DO.get(masterId);
        const broadcastPromise = stub.fetch('http://internal/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: message.id,
            conversationId,
            senderId: user.id,
            type: message.type,
            content: message.content,
            createdAt: message.created_at,
            skipD1WriteBack: true, // 已在上方写过 D1，避免二次冗余落盘
            asyncBroadcast: true,
          }),
        }).catch((e) => console.error('[HTTP->DO Broadcast failed]:', e));
        let executionCtx: any;
        try {
          executionCtx = c.executionCtx;
        } catch {}
        if (executionCtx) {
          executionCtx.waitUntil(broadcastPromise);
        } else {
          await broadcastPromise;
        }
      } catch {
        // ignore
      }
    }

    return c.json(message, 201);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') || err.message.includes('blocked') || err.message.includes('muted') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

messageRoutes.get('/conversations/:id/messages', async (c) => {
  try {
    const user = c.get('user');
    const conversationId = c.req.param('id');
    const after_id = c.req.query('after_id');
    const before_id = c.req.query('before_id');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const result = await getConversationMessages(c.env.DB, conversationId, user.id, {
      after_id,
      before_id,
      limit,
    });
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

// Batch delivery ACK (must come before /messages/:id/ack)
messageRoutes.post('/messages/ack', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json<BatchAckBody>().catch(() => ({}))) as BatchAckBody;
    const ids = body.message_ids ?? [];

    if (!Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: 'message_ids array is required' }, 400);
    }
    if (ids.length > MAX_ACK_BATCH_SIZE) {
      return c.json({ error: `message_ids exceeds maximum batch size of ${MAX_ACK_BATCH_SIZE}` }, 400);
    }

    const result = await acknowledgeDelivery(c.env.DB, user.id, ids);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Single delivery ACK
messageRoutes.post('/messages/:id/ack', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('id');

    const result = await acknowledgeDelivery(c.env.DB, user.id, [messageId]);
    if (result.acknowledged.length === 0) {
      return c.json({ error: 'Cannot acknowledge delivery for this message' }, 400);
    }

    return c.json({ success: true, message_id: messageId, status: 'delivered' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Batch read ACK (must come before /messages/:id/read)
messageRoutes.post('/messages/read', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json<BatchAckBody>().catch(() => ({}))) as BatchAckBody;
    const ids = body.message_ids ?? [];

    if (!Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: 'message_ids array is required' }, 400);
    }
    if (ids.length > MAX_ACK_BATCH_SIZE) {
      return c.json({ error: `message_ids exceeds maximum batch size of ${MAX_ACK_BATCH_SIZE}` }, 400);
    }

    const result = await acknowledgeRead(c.env.DB, c.env.VOICE_BUCKET, user.id, ids);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Single read ACK
messageRoutes.post('/messages/:id/read', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('id');

    const result = await acknowledgeRead(c.env.DB, c.env.VOICE_BUCKET, user.id, [messageId]);
    if (result.read.length === 0 && result.burned.length === 0) {
      return c.json({ error: 'Cannot acknowledge read for this message' }, 400);
    }

    const isBurned = result.burned.includes(messageId);
    return c.json({
      success: true,
      message_id: messageId,
      status: isBurned ? 'burned' : 'read',
      burn_after_seconds: isBurned ? (result.burn_windows?.[messageId] ?? 30) : undefined,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Recall message (within configurable window, default 30s)
messageRoutes.post('/messages/:id/recall', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('id');
    const windowSeconds = c.env.MESSAGE_RECALL_WINDOW_SECONDS
      ? Number(c.env.MESSAGE_RECALL_WINDOW_SECONDS)
      : 30;

    const result = await recallMessage(c.env.DB, c.env.VOICE_BUCKET, user.id, messageId, windowSeconds);

    // 联动优化：通知 MasterDO 向全网 WebSocket 广播撤回事件
    if (c.env.GROUP_MASTER_DO) {
      try {
        const msgRow = await c.env.DB.prepare('SELECT conversation_id FROM messages WHERE id = ?').bind(messageId).first<{ conversation_id: string }>();
        if (msgRow?.conversation_id && !msgRow.conversation_id.startsWith('direct:')) {
          const masterId = c.env.GROUP_MASTER_DO.idFromName(msgRow.conversation_id);
          const stub = c.env.GROUP_MASTER_DO.get(masterId);
          const recallPromise = stub.fetch('http://internal/recall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messageId,
              conversationId: msgRow.conversation_id,
            }),
          }).catch((e) => console.error('[Recall->DO Broadcast failed]:', e));
          if (c.executionCtx) {
            c.executionCtx.waitUntil(recallPromise);
          } else {
            await recallPromise;
          }
        }
      } catch {
        // ignore
      }
    }

    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized')
      ? 403
      : err.message.includes('not found')
      ? 404
      : 400;
    return c.json({ error: err.message }, status);
  }
});

// Query message receipts (per-recipient delivery & read status)
messageRoutes.get('/messages/:id/receipts', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('id');

    const result = await getMessageReceipts(c.env.DB, user.id, messageId);
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized')
      ? 403
      : err.message.includes('not found')
      ? 404
      : 400;
    return c.json({ error: err.message }, status);
  }
});

export { messageRoutes };
