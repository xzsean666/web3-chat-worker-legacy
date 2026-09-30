import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { listChatFolders, replaceChatFolders } from '../services/chatFolders';

const chatFolderRoutes = new Hono<AppEnv>();
chatFolderRoutes.use('*', authMiddleware);

chatFolderRoutes.get('/', async (c) => {
  try {
    const folders = await listChatFolders(c.env.DB, c.get('user').id);
    return c.json({ folders });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

chatFolderRoutes.put('/', async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const folders = await replaceChatFolders(c.env.DB, c.get('user').id, body);
    return c.json({ folders });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

export { chatFolderRoutes };
