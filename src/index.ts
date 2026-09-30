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
import { friendRequestRoutes } from './routes/friendRequests';
import { reportRoutes } from './routes/reports';
import { chatFolderRoutes } from './routes/chatFolders';
import { dividendRoutes } from './routes/dividends';
import { stickerRoutes } from './routes/stickers';
import { internalAdminRoutes } from './routes/internalAdmin';
import { communityRoutes } from './routes/community';
import { clubRoutes } from './routes/clubs';
import { feedRoutes } from './routes/feed';
import { paymentRoutes } from './routes/payments';
import { webRoutes } from './routes/web';
import { sweepExpiredMessages } from './services/cleanup';
import { runDividendIndexTick } from './services/dividends/indexer';
import { dividendIndexerEnabled } from './services/dividends/chain';
import { runPaymentsTick } from './services/payments/tick';
import { runStorageLifecycle } from './services/storageLifecycle';

import { withAutoBatch, isAutoBatchD1 } from './db';

const app = new Hono<AppEnv>();

app.use('*', cors());

// 数据库自动微批写入（Auto-Batch）中间件：跨请求/微任务防抖合并写入，保障读写一致性（RYOW）
app.use('*', async (c, next) => {
  if (c.env?.DB && !isAutoBatchD1(c.env.DB)) {
    let ctx: ExecutionContext | undefined;
    try {
      ctx = c.executionCtx as unknown as ExecutionContext;
    } catch {
      // In unit tests with app.request(), executionCtx is not attached
    }
    c.env.DB = withAutoBatch(c.env.DB, { ctx });
  }
  try {
    await next();
  } finally {
    if (c.env?.DB && isAutoBatchD1(c.env.DB) && c.env.DB.pendingBatchCount > 0) {
      await c.env.DB.flush();
    }
  }
});

// 统一错误出口：服务端记录完整错误，客户端只拿到通用文案（不泄漏内部细节）。
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'INTERNAL' }, 500);
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: Date.now(),
    service: 'web3-chat-worker',
  });
});

app.route('/auth', authRoutes);
app.route('/users', userRoutes);
app.route('/friends', friendRoutes);
app.route('/friend-requests', friendRequestRoutes);
app.route('/reports', reportRoutes);
app.route('/blacklist', blacklistRoutes);
app.route('/conversations', conversationRoutes);
app.route('/groups', groupRoutes);
app.route('/clubs', clubRoutes);
app.route('/community', communityRoutes);
// feed 路由内自带鉴权划分（GET /feed/images/* 公开，其余 auth），须在 messageRoutes 之前注册
app.route('/feed', feedRoutes);
app.route('/voice', voiceRoutes);
app.route('/images', imageRoutes);
app.route('/files', fileRoutes);
// dividendRoutes 为公开只读接口，必须注册在 messageRoutes（挂于 '/' 且带全局 auth 中间件）之前
app.route('/dividends', dividendRoutes);
// stickerRoutes 为公开静态内容（R2 动态贴纸），无需 auth，同样须注册在 messageRoutes 之前
app.route('/stickers', stickerRoutes);
app.route('/chat-folders', chatFolderRoutes);
// 内部管理 API（HMAC 鉴权，契约 §6/§7），注册在 messageRoutes 之前避免被全局 auth 拦截
app.route('/internal/admin', internalAdminRoutes);
// 官网下载页与最新安装包下载（公开无 auth），必须在 messageRoutes 之前注册
app.route('/', webRoutes);
// 用户侧支付/权益 API（自有 authMiddleware，契约 §6 用户侧）
app.route('/', paymentRoutes);
app.route('/', messageRoutes);
app.route('/sync', syncRoutes);

export { app };

// 存储生命周期按小时降频：cron 每分钟触发，但同一小时内只跑一轮全量清理。
let lastStorageLifecycleHour = -1;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (env?.DB && !isAutoBatchD1(env.DB)) {
      env.DB = withAutoBatch(env.DB, { ctx });
    }
    try {
      return await app.fetch(request, env, ctx);
    } finally {
      if (env?.DB && isAutoBatchD1(env.DB) && env.DB.pendingBatchCount > 0) {
        await env.DB.flush();
      }
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const db = withAutoBatch(env.DB, { ctx });
    const scheduledEnv: Env = { ...env, DB: db };
    const tasks: Promise<unknown>[] = [sweepExpiredMessages(db, env.VOICE_BUCKET), runPaymentsTick(scheduledEnv)];
    if (dividendIndexerEnabled(scheduledEnv)) {
      tasks.push(runDividendIndexTick(scheduledEnv));
    }
    const hour = Math.floor(Date.now() / 3_600_000);
    if (hour !== lastStorageLifecycleHour) {
      lastStorageLifecycleHour = hour;
      tasks.push(
        runStorageLifecycle(db, env.VOICE_BUCKET).catch((err) => {
          console.error('storage lifecycle tick failed:', err);
        })
      );
    }
    ctx.waitUntil(Promise.allSettled(tasks).finally(() => db.flush()));
  },
};
