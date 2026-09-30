import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';
import { validateBotCredentials } from '../services/bots';

export const botAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  let botId: string | undefined;
  let apiKey: string | undefined;

  // 1. Check composite token in X-Bot-Token or Authorization: Bearer <bot_id>:<api_key>
  const botTokenHeader = c.req.header('X-Bot-Token');
  if (botTokenHeader && botTokenHeader.includes(':')) {
    const colonIdx = botTokenHeader.indexOf(':');
    botId = botTokenHeader.substring(0, colonIdx).trim();
    apiKey = botTokenHeader.substring(colonIdx + 1).trim();
  }

  const authHeader = c.req.header('Authorization');
  if (!botId && authHeader && authHeader.startsWith('Bearer ')) {
    const tokenPart = authHeader.substring(7).trim();
    if (tokenPart.includes(':')) {
      const colonIdx = tokenPart.indexOf(':');
      botId = tokenPart.substring(0, colonIdx).trim();
      apiKey = tokenPart.substring(colonIdx + 1).trim();
    } else {
      apiKey = tokenPart;
    }
  }

  // 2. Check X-Bot-Id / X-Bot-Key / X-Bot-Api-Key
  if (!botId) {
    botId = c.req.header('X-Bot-Id')?.trim();
  }
  if (!apiKey) {
    apiKey = c.req.header('X-Bot-Key')?.trim() || c.req.header('X-Bot-Api-Key')?.trim();
  }

  // 3. Check Query parameters
  if (!botId) {
    botId = c.req.query('bot_id')?.trim();
  }
  if (!apiKey) {
    apiKey = c.req.query('api_key')?.trim();
  }

  // 4. If still missing and method is POST/PUT/PATCH, check JSON body (without consuming if possible or cloning)
  if ((!botId || !apiKey) && ['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
    try {
      const clonedReq = c.req.raw.clone();
      const body = await clonedReq.json().catch(() => null);
      if (body && typeof body === 'object') {
        if (!botId && typeof (body as any).bot_id === 'string') {
          botId = (body as any).bot_id.trim();
        }
        if (!apiKey && typeof (body as any).api_key === 'string') {
          apiKey = (body as any).api_key.trim();
        }
      }
    } catch {
      // Ignore body parsing error
    }
  }

  if (!botId || !apiKey) {
    return c.json({ error: 'Unauthorized: missing bot_id or api_key' }, 401);
  }

  const verified = await validateBotCredentials(c.env.DB, botId, apiKey);
  if (!verified) {
    return c.json({ error: 'Unauthorized: invalid bot credentials or bot disabled' }, 401);
  }

  c.set('bot', verified.bot);
  c.set('user', verified.user);
  c.set('token', apiKey);

  await next();
});
