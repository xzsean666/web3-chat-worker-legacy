import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  createBot,
  listUserBots,
  getBot,
  updateBot,
  resetBotApiKey,
  deleteBot,
  type CreateBotOptions,
  type UpdateBotOptions,
} from '../services/bots';

export const botRoutes = new Hono<AppEnv>();

// All bot management routes require user authentication
botRoutes.use('*', authMiddleware);

/**
 * 1. Create a new bot
 * POST /bots
 */
botRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json<CreateBotOptions>().catch(() => ({} as CreateBotOptions));

    if (!body.name) {
      return c.json({ error: 'Bot name is required' }, 400);
    }

    const bot = await createBot(c.env.DB, user.id, body);
    return c.json({ bot }, 201);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('already taken') ? 400 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 2. List all bots created by the current user
 * GET /bots
 */
botRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const bots = await listUserBots(c.env.DB, user.id);
    return c.json({ bots });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * 3. Get bot details
 * GET /bots/:id
 */
botRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const botId = c.req.param('id');
    const bot = await getBot(c.env.DB, botId, user.id);
    return c.json({ bot });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 4. Update bot details
 * PATCH /bots/:id
 */
botRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const botId = c.req.param('id');
    const body = await c.req.json<UpdateBotOptions>().catch(() => ({} as UpdateBotOptions));

    const bot = await updateBot(c.env.DB, botId, user.id, body);
    return c.json({ bot });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized')
      ? 403
      : message.includes('not found')
      ? 404
      : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 5. Reset bot API Key
 * POST /bots/:id/reset-key
 */
botRoutes.post('/:id/reset-key', async (c) => {
  try {
    const user = c.get('user');
    const botId = c.req.param('id');
    const result = await resetBotApiKey(c.env.DB, botId, user.id);
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized')
      ? 403
      : message.includes('not found')
      ? 404
      : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 6. Delete a bot
 * DELETE /bots/:id
 */
botRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const botId = c.req.param('id');
    const result = await deleteBot(c.env.DB, botId, user.id);
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized')
      ? 403
      : message.includes('not found')
      ? 404
      : 400;
    return c.json({ error: message }, status);
  }
});
