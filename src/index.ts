import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Env } from './types';
import { authRoutes } from './routes/auth';
import { conversationRoutes } from './routes/conversations';
import { groupRoutes } from './routes/groups';
import { messageRoutes } from './routes/messages';
import { syncRoutes } from './routes/sync';
import { voiceRoutes } from './routes/voice';
import { imageRoutes } from './routes/images';
import { fileRoutes } from './routes/files';
import { userRoutes } from './routes/users';
import { friendRoutes, blacklistRoutes } from './routes/social';
import { sweepExpiredMessages } from './services/cleanup';

const app = new Hono<AppEnv>();

app.use('*', cors());

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: Date.now(),
    service: 'web3-chat-worker',
  });
});

app.post('/admin/cleanup', async (c) => {
  try {
    const result = await sweepExpiredMessages(c.env.DB, c.env.VOICE_BUCKET);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.route('/auth', authRoutes);
app.route('/users', userRoutes);
app.route('/friends', friendRoutes);
app.route('/blacklist', blacklistRoutes);
app.route('/conversations', conversationRoutes);
app.route('/groups', groupRoutes);
app.route('/voice', voiceRoutes);
app.route('/images', imageRoutes);
app.route('/files', fileRoutes);
app.route('/', messageRoutes);
app.route('/sync', syncRoutes);

export { app };

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweepExpiredMessages(env.DB, env.VOICE_BUCKET));
  },
};
