// 社区公开接口（登录用户）：运营 Banner 列表。
// 管理端 CRUD 在 /internal/admin/community/*（HMAC），此处只暴露启用项。

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { listBanners } from '../services/community';

const communityRoutes = new Hono<AppEnv>();

communityRoutes.use('*', authMiddleware);

communityRoutes.get('/banners', async (c) => {
  const banners = await listBanners(c.env.DB, false);
  return c.json({ banners });
});

export { communityRoutes };
