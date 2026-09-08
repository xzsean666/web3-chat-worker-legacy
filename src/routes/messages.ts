import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
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

messageRoutes.use('*', authMiddleware);

interface BatchAckBody {
  message_ids?: string[];
}

// Conversation message sending and fetching
messageRoutes.post('/conversations/:id/messages', async (c) => {
  try {
    const user = c.get('user');
    const conversationId = c.req.param('id');
    const body = (await c.req.json<SendMessageOptions>().catch(() => ({}))) as SendMessageOptions;

    const message = await sendMessage(c.env.DB, conversationId, user.id, body);
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
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const result = await getConversationMessages(c.env.DB, conversationId, user.id, {
      after_id,
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
