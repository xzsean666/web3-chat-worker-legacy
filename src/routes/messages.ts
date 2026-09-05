import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  sendMessage,
  getConversationMessages,
  acknowledgeDelivery,
  acknowledgeRead,
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
    const status = err.message.includes('Unauthorized') ? 403 : 400;
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
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { messageRoutes };
