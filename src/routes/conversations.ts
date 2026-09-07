import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  getOrCreateDirectConversation,
  listUserConversations,
  getConversation,
} from '../services/conversations';

const conversationRoutes = new Hono<AppEnv>();

conversationRoutes.use('*', authMiddleware);

interface CreateDirectBody {
  target_user_id?: string;
  target_wallet_address?: string;
}

conversationRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json<CreateDirectBody>().catch(() => ({}))) as CreateDirectBody;
    const target = body.target_user_id || body.target_wallet_address;

    if (!target) {
      return c.json({ error: 'Missing target_user_id or target_wallet_address' }, 400);
    }

    const conversation = await getOrCreateDirectConversation(c.env.DB, user.id, target);
    return c.json(conversation, 201);
  } catch (err: any) {
    const status = err.message.includes('blocked') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

conversationRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const conversations = await listUserConversations(c.env.DB, user.id);
    return c.json({ conversations });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

conversationRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const conversationId = c.req.param('id');
    const conversation = await getConversation(c.env.DB, conversationId, user.id);
    return c.json(conversation);
  } catch (err: any) {
    if (err.message.includes('Unauthorized')) {
      return c.json({ error: err.message }, 403);
    }
    return c.json({ error: err.message }, 404);
  }
});

export { conversationRoutes };
