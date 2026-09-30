// Club（社群）用户侧 API：发现/搜索、收藏、门禁入群、创建申请、社群主页、club 私有动态。
// 响应结构与旧 GET /groups/public 保持兼容（{groups, next_cursor, has_more}）。

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { joinPublicGroup, searchPublicClubs } from '../services/conversations';
import {
  favoriteClub,
  unfavoriteClub,
  getClubMemberRole,
  getClubProfile,
  getClubRow,
  HoldingsGateError,
  JoinGateConfigError,
} from '../services/clubs';
import { createClubApplication, getMyClubApplication } from '../services/clubApplications';
import { createFeedPost, feedPostCreatedJson, listClubFeed, type ClubFeedFilter } from '../services/feed';
import { getActiveConfig } from '../services/payments/config';
import { GroupCapacityError, capacityErrorResult } from '../services/payments/capacity';

const clubRoutes = new Hono<AppEnv>();

clubRoutes.use('*', authMiddleware);

// GET /clubs?keyword=&cursor=&limit= — club 发现/搜索（游标分页，同 searchPublicClubs）
clubRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const keyword = c.req.query('keyword') ?? c.req.query('q') ?? '';
    const limitParam = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;
    const cursor = c.req.query('cursor');
    const result = await searchPublicClubs(c.env.DB, keyword, { cursor, limit, userId: user.id });
    // 键名保持 {groups} 不变，App 端解析兼容
    return c.json({ groups: result.items, next_cursor: result.next_cursor, has_more: result.has_more });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Invalid cursor')) return c.json({ error: 'INVALID_CURSOR' }, 400);
    return c.json({ error: message }, 400);
  }
});

// POST /clubs/apply {name, description?, tags?, message?} — 创建申请（仅会员；已有 pending → 409）
clubRoutes.post('/apply', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const application = await createClubApplication(c.env.DB, user.id, body);
    return c.json({ application }, 201);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('MEMBERSHIP_REQUIRED')) return c.json({ error: 'MEMBERSHIP_REQUIRED' }, 403);
    if (message.startsWith('APPLICATION_PENDING')) return c.json({ error: 'APPLICATION_PENDING' }, 409);
    return c.json({ error: message }, 400);
  }
});

// GET /clubs/my-application — 当前用户最新一条申请（无 → {application:null}）
clubRoutes.get('/my-application', async (c) => {
  const user = c.get('user');
  const application = await getMyClubApplication(c.env.DB, user.id);
  return c.json({ application });
});

// GET /clubs/:id — 社群主页资料（非成员可见，my_role=null）
clubRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const profile = await getClubProfile(c.env.DB, user.id, c.req.param('id'));
  if (!profile) return c.json({ error: 'CLUB_NOT_FOUND' }, 404);
  return c.json(profile);
});

// GET /clubs/:id/feed?cursor=&limit=&filter=all|featured|admins|media|files — club 私有动态（非成员可见）
clubRoutes.get('/:id/feed', async (c) => {
  try {
    const user = c.get('user');
    const clubId = c.req.param('id');
    if (!(await getClubRow(c.env.DB, clubId))) return c.json({ error: 'CLUB_NOT_FOUND' }, 404);
    const limitParam = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;
    const filterParam = c.req.query('filter') ?? 'all';
    if (!['all', 'featured', 'admins', 'media', 'files'].includes(filterParam)) {
      return c.json({ error: 'filter must be all|featured|admins|media|files' }, 400);
    }
    const result = await listClubFeed(c.env.DB, user.id, clubId, {
      cursor: c.req.query('cursor'),
      limit,
      filter: filterParam as ClubFeedFilter,
    });
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Invalid cursor')) return c.json({ error: 'INVALID_CURSOR' }, 400);
    return c.json({ error: message }, 400);
  }
});

// POST /clubs/:id/feed/posts {content, images?, section?, video?, order_id?}
// 权限：社群成员可发（非成员 403）。收费规则：该社群的动态总数（全员累计，
// 未软删）达到 freeQuota 后，任何人再发都须携带 kind='feed_post' 的已支付
// 订单（order_id，原子消费一次一帖）；群主/管理员同样计数收费。
clubRoutes.post('/:id/feed/posts', async (c) => {
  try {
    const user = c.get('user');
    const clubId = c.req.param('id');
    if (!(await getClubRow(c.env.DB, clubId))) return c.json({ error: 'CLUB_NOT_FOUND' }, 404);
    const role = await getClubMemberRole(c.env.DB, clubId, user.id);
    if (!role) return c.json({ error: 'NOT_CLUB_MEMBER' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; images?: unknown; section?: unknown; video?: unknown; order_id?: unknown };

    const active = await getActiveConfig(c.env.DB);
    const feedPost = active?.payload.feedPost;
    if (feedPost?.enabled) {
      const freeQuota = feedPost.freeQuota;
      const total =
        (await c.env.DB
          .prepare('SELECT COUNT(*) AS n FROM feed_posts WHERE club_id = ? AND is_deleted = 0')
          .bind(clubId)
          .first<{ n: number }>())?.n ?? 0;
      if (total >= freeQuota) {
        const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
        let consumed = false;
        if (orderId) {
          // 原子消费：仅当订单属于本人、本社群、kind='feed_post' 且已支付
          // （active）才置为 consumed——同一订单不能复用第二条。
          const nowIso = new Date().toISOString();
          const consume = await c.env.DB
            .prepare(
              "UPDATE payment_orders SET status = 'consumed', updated_at = ? WHERE id = ? AND wallet_address = ? AND kind = 'feed_post' AND group_id = ? AND status = 'active'"
            )
            .bind(nowIso, orderId, user.id, clubId)
            .run();
          consumed = (consume.meta.changes ?? 0) > 0;
        }
        if (!consumed) {
          return c.json(
            {
              error: 'PAYMENT_REQUIRED',
              price: feedPost.price,
              free_quota: freeQuota,
              free_used: Math.min(total, freeQuota),
              chain_id: feedPost.chainId,
              token_type: feedPost.token.type,
              token_address: feedPost.token.address,
              token_symbol: feedPost.token.symbol,
              token_decimals: feedPost.token.decimals,
              recipient_address: active?.payload.recipientAddress ?? feedPost.recipientAddress,
            },
            402
          );
        }
      }
    }

    const post = await createFeedPost(c.env.DB, user.id, body, clubId);
    return c.json({ post: feedPostCreatedJson(post) }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});


// POST /clubs/:id/favorite — 幂等收藏 → {favorited:true, favorite_count}
clubRoutes.post('/:id/favorite', async (c) => {
  const user = c.get('user');
  const result = await favoriteClub(c.env.DB, user.id, c.req.param('id'));
  if (!result) return c.json({ error: 'CLUB_NOT_FOUND' }, 404);
  return c.json({ favorited: true, favorite_count: result.favorite_count });
});

// DELETE /clubs/:id/favorite — 幂等取消收藏 → {favorited:false, favorite_count}
clubRoutes.delete('/:id/favorite', async (c) => {
  const user = c.get('user');
  const result = await unfavoriteClub(c.env.DB, user.id, c.req.param('id'));
  if (!result) return c.json({ error: 'CLUB_NOT_FOUND' }, 404);
  return c.json({ favorited: false, favorite_count: result.favorite_count });
});

// POST /clubs/:id/join — 门禁按序：joinable → 持仓门槛 → 付费门槛 → 审批 → 直接入群
clubRoutes.post('/:id/join', async (c) => {
  try {
    const user = c.get('user');
    const result = await joinPublicGroup(c.env.DB, c.req.param('id'), user);
    if (result.status === 'requires_payment') {
      if (result.group.avatar_url?.startsWith('/')) {
        result.group.avatar_url = new URL(result.group.avatar_url, c.req.url).toString();
      }
      return c.json(result, 200);
    }
    if (result.status === 'pending') {
      if (result.group.avatar_url?.startsWith('/')) {
        result.group.avatar_url = new URL(result.group.avatar_url, c.req.url).toString();
      }
      return c.json(result, 202);
    }
    return c.json(result, 201);
  } catch (err: any) {
    if (err instanceof GroupCapacityError) return c.json(capacityErrorResult(err.info), 403);
    if (err instanceof HoldingsGateError) {
      return c.json({ error: 'HOLDINGS_GATE_FAILED', required: err.required, current: err.current }, 403);
    }
    if (err instanceof JoinGateConfigError) {
      return c.json({ error: 'JOIN_GATE_NOT_CONFIGURED', details: [err.message] }, 500);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('GROUP_NOT_JOINABLE')) {
      return c.json({ error: 'GROUP_NOT_JOINABLE' }, 403);
    }
    const status = message.includes('not found') ? 404 : message.includes('not public') ? 403 : 400;
    return c.json({ error: message }, status);
  }
});

export { clubRoutes };
