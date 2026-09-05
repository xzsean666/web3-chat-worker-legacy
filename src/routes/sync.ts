import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getSyncUpdates } from '../services/messages';

const syncRoutes = new Hono<AppEnv>();

syncRoutes.use('*', authMiddleware);

syncRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const sinceStr = c.req.query('since');
    const limitStr = c.req.query('limit');

    const since = sinceStr ? parseInt(sinceStr, 10) : undefined;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const result = await getSyncUpdates(c.env.DB, user.id, { since, limit });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { syncRoutes };
