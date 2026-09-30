import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';
import { validateSession } from '../services/auth';

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: missing or invalid authorization header' }, 401);
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return c.json({ error: 'Unauthorized: empty bearer token' }, 401);
  }

  const auth = await validateSession(c.env.DB, token);
  if (!auth) {
    return c.json({ error: 'Unauthorized: session expired or invalid' }, 401);
  }

  c.set('user', auth.user);
  c.set('session', auth.session);
  c.set('token', token);

  await next();
});
