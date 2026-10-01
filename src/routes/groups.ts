import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { isGroupLike } from '../db/schema';
import { GroupCapacityError, capacityErrorResult } from '../services/payments/capacity';
import { HoldingsGateError, JoinGateConfigError } from '../services/clubs';
import { base64ToUint8Array } from '../utils/base64';
import {
  createGroup,
  updateGroup,
  updateGroupName,
  addGroupMember,
  removeGroupMember,
  leaveGroup,
  updateMemberRole,
  setGroupMute,
  setMemberMute,
  getGroupMuteStatus,
  setGroupNickname,
  getGroupMembers,
  getConversation,
  uploadGroupAvatar,
  getGroupAvatar,
  createGroupInviteLink,
  createGroupJoinRequest,
  handleGroupJoinRequest,
  joinGroupByInviteToken,
  joinPublicGroup,
  listGroupJoinRequests,
  searchPublicGroups,
  transferGroupOwnership,
  findOrCreateUser,
  type GroupMarquee,
} from '../services/conversations';

const groupRoutes = new Hono<AppEnv>();

groupRoutes.use('*', authMiddleware);

// 契约 §8：群容量满 → 403 {error:'GROUP_CAPACITY_REACHED', memberCount, capacity, nextTier}
function capacityResponse(c: any, err: unknown): Response | null {
  if (err instanceof GroupCapacityError) return c.json(capacityErrorResult(err.info), 403);
  return null;
}

import { allow } from '../services/rateLimit';

// club 门禁错误统一映射（持仓不足 403 带 required/current；链未配置/RPC 全挂 500）
function joinGateResponse(c: any, err: unknown): Response | null {
  if (err instanceof HoldingsGateError) {
    return c.json({ error: 'HOLDINGS_GATE_FAILED', required: err.required, current: err.current }, 403);
  }
  if (err instanceof JoinGateConfigError) {
    return c.json({ error: 'JOIN_GATE_NOT_CONFIGURED', details: [err.message] }, 500);
  }
  return null;
}

// 强制断开指定用户的群 WebSocket 连接（退群、被踢、封禁）
function disconnectGroupWebSocket(
  c: any,
  groupId: string,
  userId: string
): void {
  const env = c?.env;
  if (!env?.GROUP_BROADCASTER_DO) return;
  try {
    const TOTAL_SHARDS = 50;
    let hash = 0;
    const uid = userId.toLowerCase();
    for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
    const shardId = hash % TOTAL_SHARDS;
    const shardName = `${groupId}:shard_${shardId}`;
    const doId = env.GROUP_BROADCASTER_DO.idFromName(shardName);
    const stub = env.GROUP_BROADCASTER_DO.get(doId);
    const kickPromise = stub.fetch('http://internal/kick_user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    }).catch(() => {});

    try {
      if (c?.executionCtx) {
        c.executionCtx.waitUntil(kickPromise);
        return;
      }
    } catch {
      // ignore missing executionCtx in tests
    }
    void kickPromise;
  } catch {
    // ignore
  }
}

// 强制通知 MasterDO 立即失效内存中用户的发言限流与角色权限状态
function notifyMasterDOInvalidateCache(
  c: any,
  groupId: string,
  userId: string,
  action: 'kick' | 'leave' | 'mute' | 'unmute' | 'role_change' | 'join',
  mutedUntil?: number | null
): void {
  const env = c?.env;
  if (!env?.GROUP_MASTER_DO) return;
  try {
    const masterId = env.GROUP_MASTER_DO.idFromName(groupId);
    const stub = env.GROUP_MASTER_DO.get(masterId);
    const invalidatePromise = stub.fetch('http://internal/invalidate_cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action, mutedUntil }),
    }).catch(() => {});

    try {
      if (c?.executionCtx) {
        c.executionCtx.waitUntil(invalidatePromise);
        return;
      }
    } catch {
      // ignore missing executionCtx in tests
    }
    void invalidatePromise;
  } catch {
    // ignore
  }
}

interface CreateGroupBody {
  name?: string;
  description?: string;
  announcement?: string;
  marquee?: GroupMarquee;
  metadata?: Record<string, any>;
  member_ids?: string[];
  slug?: string;
  type?: 'group' | 'club';
}

interface UpdateGroupBody {
  name?: string;
  description?: string;
  announcement?: string;
  marquee?: Partial<GroupMarquee> | boolean;
  metadata?: Record<string, any>;
  group_type?: 'private' | 'public';
  content_protected?: boolean;
}

interface AddMemberBody {
  user_id?: string;
  wallet_address?: string;
  role?: 'member';
}

interface CreateInviteLinkBody {
  expires_in_seconds?: number;
  max_uses?: number;
  slug?: string;
}

interface JoinByTokenBody {
  token?: string;
  message?: string;
  /** Explicitly creates a fresh request after a prior request was rejected. */
  retry?: boolean;
}

interface CreateJoinRequestBody {
  message?: string;
}

interface TransferOwnershipBody {
  new_owner_user_id?: string;
  wallet_address?: string;
}

interface KickMemberBody {
  user_id?: string;
  wallet_address?: string;
}

interface UpdateRoleBody {
  role?: 'admin' | 'member';
}

interface MuteGroupBody {
  muted?: boolean;
  duration_seconds?: number;
}

interface MuteMemberBody {
  muted?: boolean;
  duration_seconds?: number;
  reason?: string;
}

interface SetNicknameBody {
  group_nickname?: string | null;
}

// 0. Read-only public club discovery (registered before /:id so it is not
// swallowed by the parameterized detail route). 发现页只服务 club（旧公开群已由 0019 迁移）。
groupRoutes.get('/public', async (c) => {
  try {
    const user = c.get('user');
    const keyword = c.req.query('keyword') ?? c.req.query('q') ?? '';
    const limitParam = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;
    const cursor = c.req.query('cursor');
    const result = await searchPublicGroups(c.env.DB, keyword, { cursor, limit, userId: user.id });
    // 外层结构保持 { groups } 兼容，追加游标分页字段
    return c.json({ groups: result.items, next_cursor: result.next_cursor, has_more: result.has_more });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Invalid cursor')) return c.json({ error: 'INVALID_CURSOR' }, 400);
    return c.json({ error: message }, 400);
  }
});

// 0a. Get group detail (members include per-group nickname "group_nickname")
groupRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');

    const detail = await getConversation(c.env.DB, groupId, user.id);
    if (!isGroupLike(detail.type)) {
      return c.json({ error: 'Group not found' }, 404);
    }
    return c.json(detail);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 404;
    return c.json({ error: err.message }, status);
  }
});

// 0b. List group members (includes group_nickname per member, with optional cursor pagination)
groupRoutes.get('/:id/members', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const limitQuery = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const limit = limitQuery !== undefined ? Math.max(1, parseInt(limitQuery, 10) || 50) : undefined;

    const result = await getGroupMembers(c.env.DB, groupId, user.id, { limit, cursor });
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 0c. Set my per-group nickname (群成员专属昵称); empty string / null clears it
groupRoutes.patch('/:id/members/me', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const body = (await c.req.json<SetNicknameBody>().catch(() => ({}))) as SetNicknameBody;

    if (!('group_nickname' in body)) {
      return c.json({ error: 'group_nickname is required (string, or null/empty to clear)' }, 400);
    }

    const member = await setGroupNickname(c.env.DB, groupId, user.id, body.group_nickname ?? null);
    return c.json(member);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 1. Create group（普通群）。club 已改申请制：POST /groups type='club' 一律 403 CLUB_CREATE_VIA_APPLICATION，
//    走 POST /clubs/apply → 管理端审核通过后由 approve 内部创建。
groupRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    if (!(await allow(c.env.DB, 'create_group', user.id, 10))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    const body = (await c.req.json<CreateGroupBody>().catch(() => ({}))) as CreateGroupBody;
    if (!body.name) {
      return c.json({ error: 'Group name is required' }, 400);
    }
    if (body.type !== undefined && body.type !== 'group' && body.type !== 'club') {
      return c.json({ error: 'type must be "group" or "club"' }, 400);
    }
    if (body.type === 'club') {
      return c.json({ error: 'CLUB_CREATE_VIA_APPLICATION' }, 403);
    }

    const group = await createGroup(
      c.env.DB,
      user.id,
      body.name,
      body.member_ids ?? [],
      {
        description: body.description,
        announcement: body.announcement,
        marquee: body.marquee,
        metadata: body.metadata,
        slug: body.slug,
        type: body.type,
      }
    );
    return c.json(group, 201);
  } catch (err: any) {
    const capacity = capacityResponse(c, err);
    if (capacity) return capacity;
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('MEMBERSHIP_REQUIRED')) {
      return c.json({ error: 'MEMBERSHIP_REQUIRED' }, 403);
    }
    return c.json({ error: message }, 400);
  }
});

// 1b. Generate an app deep link / QR token. QR clients should encode `url` directly.
groupRoutes.post('/:id/invite-links', async (c) => {
  try {
    const user = c.get('user');
    if (!(await allow(c.env.DB, 'create_invite', user.id, 20))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    const body = (await c.req.json<CreateInviteLinkBody>().catch(() => ({}))) as CreateInviteLinkBody;
    const invite = await createGroupInviteLink(c.env.DB, c.req.param('id'), user.id, body);
    return c.json(invite, 201);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized')
      ? 403
      : err.message.includes('not found')
        ? 404
        : err.message.includes('Slug already taken')
          ? 409
          : 400;
    return c.json({ error: err.message }, status);
  }
});

// 1c. Consume the `chaintalk://group-invite/<token>` deep-link token.
groupRoutes.post('/join-by-token', async (c) => {
  try {
    const user = c.get('user');
    if (!(await allow(c.env.DB, 'join_by_token', user.id, 30))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    const body = (await c.req.json<JoinByTokenBody>().catch(() => ({}))) as JoinByTokenBody;
    if (!body.token?.trim()) return c.json({ error: 'token is required' }, 400);
    const result = await joinGroupByInviteToken(c.env.DB, body.token.trim(), user, body.message, body.retry === true);
    if ('group' in result && result.group.avatar_url?.startsWith('/')) {
      result.group.avatar_url = new URL(result.group.avatar_url, c.req.url).toString();
    }
    const status = result.status === 'joined' ? 201 : result.status === 'pending' ? 202 : 200;
    return c.json(result, status);
  } catch (err: any) {
    const capacity = capacityResponse(c, err);
    if (capacity) return capacity;
    const status = err.message.includes('not found')
      ? 404
      : err.message.includes('expired')
        ? 410
        : err.message.includes('usage limit')
          ? 429
          : 400;
    return c.json({ error: err.message }, status);
  }
});

// 1d. Submit a self-service application to a group. Administrators see it below.
groupRoutes.post('/:id/join-requests', async (c) => {
  try {
    const user = c.get('user');
    if (!(await allow(c.env.DB, 'join_request', user.id, 10))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    const body = (await c.req.json<CreateJoinRequestBody>().catch(() => ({}))) as CreateJoinRequestBody;
    const request = await createGroupJoinRequest(c.env.DB, c.req.param('id'), user, body.message);
    return c.json(request, 201);
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 1e. Join a public group/club by id. metadata.join_requires_approval=true 时转审批流（202 pending）；
// club 门禁：joinable=false → 403；持仓不足 → 403 HOLDINGS_GATE_FAILED；join_price → 200 requires_payment。
groupRoutes.post('/:id/join', async (c) => {
  try {
    const user = c.get('user');
    if (!(await allow(c.env.DB, 'join_group', user.id, 30))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
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
    const capacity = capacityResponse(c, err);
    if (capacity) return capacity;
    const gate = joinGateResponse(c, err);
    if (gate) return gate;
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('GROUP_NOT_JOINABLE')) {
      return c.json({ error: 'GROUP_NOT_JOINABLE' }, 403);
    }
    const status = message.includes('not found') ? 404 : message.includes('not public') ? 403 : 400;
    return c.json({ error: message }, status);
  }
});

groupRoutes.get('/:id/join-requests', async (c) => {
  try {
    const user = c.get('user');
    const requests = await listGroupJoinRequests(c.env.DB, c.req.param('id'), user.id, c.req.query('status') || 'pending');
    return c.json({ requests });
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

groupRoutes.post('/:id/join-requests/:requestId/approve', async (c) => {
  try {
    const user = c.get('user');
    const request = await handleGroupJoinRequest(
      c.env.DB, c.req.param('id'), c.req.param('requestId'), user.id, 'approved'
    );
    return c.json(request);
  } catch (err: any) {
    const capacity = capacityResponse(c, err);
    if (capacity) return capacity;
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

groupRoutes.post('/:id/join-requests/:requestId/reject', async (c) => {
  try {
    const user = c.get('user');
    const request = await handleGroupJoinRequest(
      c.env.DB, c.req.param('id'), c.req.param('requestId'), user.id, 'rejected'
    );
    return c.json(request);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 2. Update group info & metadata (① 修改群名, ② 群介绍, ③ 顶部滚动播放)
groupRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const body = (await c.req.json<UpdateGroupBody>().catch(() => ({}))) as UpdateGroupBody;

    const updated = await updateGroup(c.env.DB, groupId, user.id, body);
    return c.json(updated);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 2b. Update group metadata directly
groupRoutes.patch('/:id/metadata', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const body = (await c.req.json<UpdateGroupBody>().catch(() => ({}))) as UpdateGroupBody;

    const updated = await updateGroup(c.env.DB, groupId, user.id, body);
    return c.json(updated);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 3. Add group member
groupRoutes.post('/:id/members', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const body = (await c.req.json<AddMemberBody>().catch(() => ({}))) as AddMemberBody;
    const target = body.user_id || body.wallet_address;

    if (!target) {
      return c.json({ error: 'user_id or wallet_address is required' }, 400);
    }

    const member = await addGroupMember(c.env.DB, groupId, user.id, target);
    return c.json(member, 201);
  } catch (err: any) {
    const capacity = capacityResponse(c, err);
    if (capacity) return capacity;
    const status = err.message.includes('Unauthorized') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 4. Leave group (⑤ 成员可以退群)
groupRoutes.post('/:id/leave', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');

    const result = await leaveGroup(c.env.DB, groupId, user.id, c.env.VOICE_BUCKET);
    disconnectGroupWebSocket(c, groupId, user.id);
    notifyMasterDOInvalidateCache(c, groupId, user.id, 'leave');
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 4b. Ownership transfer is a D1 batch: previous owner becomes admin and there is exactly one owner.
groupRoutes.post('/:id/transfer', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json<TransferOwnershipBody>().catch(() => ({}))) as TransferOwnershipBody;
    const target = body.new_owner_user_id || body.wallet_address;
    if (!target) return c.json({ error: 'new_owner_user_id or wallet_address is required' }, 400);
    const result = await transferGroupOwnership(c.env.DB, c.req.param('id'), user.id, target);
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 5. Kick member (④ 群主/管理员踢人删除群员)
groupRoutes.post('/:id/kick', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const body = (await c.req.json<KickMemberBody>().catch(() => ({}))) as KickMemberBody;
    const target = body.user_id || body.wallet_address;

    if (!target) {
      return c.json({ error: 'user_id or wallet_address is required' }, 400);
    }

    const result = await removeGroupMember(c.env.DB, groupId, user.id, target, c.env.VOICE_BUCKET);

    // 联动优化：强制关闭被踢用户的 WebSocket 连接并通知 MasterDO 缓存失效
    let resolvedUserId = target;
    try {
      const resolved = await findOrCreateUser(c.env.DB, target);
      if (resolved?.id) resolvedUserId = resolved.id;
    } catch {}
    disconnectGroupWebSocket(c, groupId, resolvedUserId);
    notifyMasterDOInvalidateCache(c, groupId, resolvedUserId, 'kick');

    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 6. Delete member or self-leave via DELETE route
groupRoutes.delete('/:id/members/:userId', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const targetUserId = c.req.param('userId');

    const result = await removeGroupMember(c.env.DB, groupId, user.id, targetUserId, c.env.VOICE_BUCKET);

    // 联动优化：强制关闭被移出群成员的 WebSocket 连接并通知 MasterDO 缓存失效
    let resolvedUserId = targetUserId;
    try {
      const resolved = await findOrCreateUser(c.env.DB, targetUserId);
      if (resolved?.id) resolvedUserId = resolved.id;
    } catch {}
    disconnectGroupWebSocket(c, groupId, resolvedUserId);
    notifyMasterDOInvalidateCache(c, groupId, resolvedUserId, 'kick');

    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 7. Update member role (Appoint Admin / Demote)
groupRoutes.put('/:id/members/:userId/role', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const targetUserId = c.req.param('userId');
    const body = (await c.req.json<UpdateRoleBody>().catch(() => ({}))) as UpdateRoleBody;

    if (!body.role || !['admin', 'member'].includes(body.role)) {
      return c.json({ error: 'Valid role is required ("admin" or "member")' }, 400);
    }

    const updated = await updateMemberRole(c.env.DB, groupId, user.id, targetUserId, body.role);
    notifyMasterDOInvalidateCache(c, groupId, targetUserId, 'role_change');
    return c.json(updated);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 8. Group-wide mute/unmute (⑥ 可以群禁言)
groupRoutes.post('/:id/mute', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const body = (await c.req.json<MuteGroupBody>().catch(() => ({}))) as MuteGroupBody;
    const muted = body.muted !== undefined ? Boolean(body.muted) : true;

    const result = await setGroupMute(c.env.DB, groupId, user.id, {
      muted,
      duration_seconds: body.duration_seconds,
    });
    notifyMasterDOInvalidateCache(c, groupId, '*', 'mute', result.mute_until);
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

groupRoutes.post('/:id/unmute', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');

    const result = await setGroupMute(c.env.DB, groupId, user.id, { muted: false });
    notifyMasterDOInvalidateCache(c, groupId, '*', 'unmute');
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 9. Individual member mute/unmute (⑥ 单独某人禁言名单)
groupRoutes.post('/:id/members/:userId/mute', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const targetUserId = c.req.param('userId');
    const body = (await c.req.json<MuteMemberBody>().catch(() => ({}))) as MuteMemberBody;
    const muted = body.muted !== undefined ? Boolean(body.muted) : true;

    const result = await setMemberMute(c.env.DB, groupId, user.id, targetUserId, {
      muted,
      duration_seconds: body.duration_seconds,
      reason: body.reason,
    });
    notifyMasterDOInvalidateCache(c, groupId, targetUserId, 'mute', result.muted_until);
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

groupRoutes.post('/:id/members/:userId/unmute', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const targetUserId = c.req.param('userId');

    const result = await setMemberMute(c.env.DB, groupId, user.id, targetUserId, { muted: false });
    notifyMasterDOInvalidateCache(c, groupId, targetUserId, 'unmute');
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 10. Query mute status and muted member list (⑥ 获取禁言名单)
groupRoutes.get('/:id/muted', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');

    const status = await getGroupMuteStatus(c.env.DB, groupId, user.id);
    return c.json(status);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 11. Upload / change group avatar (仅群主 owner 可操作)
groupRoutes.post('/:id/avatar', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const contentType = c.req.header('Content-Type') || '';

    let avatarData: Uint8Array;
    let mimeType = 'image/png';

    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body['file'] || body['avatar'] || body['image'];
      if (!file || typeof file === 'string') {
        return c.json({ error: 'Avatar file is required in form-data (key "file" or "avatar")' }, 400);
      }

      const fileObj = file as File;
      mimeType = fileObj.type || 'image/png';
      const arrayBuf = await fileObj.arrayBuffer();
      avatarData = new Uint8Array(arrayBuf);
    } else {
      const json = await c.req.json().catch(() => ({}));
      const base64Str = json.avatar_base64 || json.file_base64 || json.image_base64;
      if (!base64Str) {
        return c.json({ error: 'Missing avatar_base64 or file' }, 400);
      }
      mimeType = json.mime_type || 'image/png';
      avatarData = base64ToUint8Array(base64Str);
    }

    const result = await uploadGroupAvatar(c.env.DB, c.env.VOICE_BUCKET, groupId, user.id, {
      avatarData,
      mimeType,
    });

    return c.json(result, 201);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 12. Get group avatar image (群成员可读)
groupRoutes.get('/:id/avatar', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');

    const result = await getGroupAvatar(c.env.DB, c.env.VOICE_BUCKET, groupId, user.id);

    if (!result) {
      return c.json({ error: 'Avatar not found' }, 404);
    }

    const headers: Record<string, string> = {
      'Content-Type': result.mimeType,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    };

    if (result.mimeType.includes('svg')) {
      headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    }

    if (result.object.httpEtag) {
      headers['ETag'] = result.object.httpEtag;
    }

    return new Response(result.object.body, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 500;
    return c.json({ error: err.message }, status);
  }
});

// 13. Supergroup 100K-Member WebSocket Endpoint
groupRoutes.get('/:id/ws', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');

    // 检查群组存在性与成员资格 (轻量级单点查询，绝不全表加载 10 万成员数据防 OOM)
    const conv = await c.env.DB.prepare('SELECT id, type FROM conversations WHERE id = ?').bind(groupId).first<{ id: string; type: string }>();
    if (!conv || !isGroupLike(conv.type)) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    const membership = await c.env.DB.prepare(
      'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(groupId, user.id).first<{ role: string }>();
    if (!membership) {
      return c.json({ error: 'Forbidden: not a member of this group' }, 403);
    }

    if (!c.env.GROUP_BROADCASTER_DO) {
      return c.json({ error: 'DURABLE_OBJECT_NOT_BOUND' }, 503);
    }

    // 计算分片哈希 (默认 50 个分片均衡承载 10 万连接)
    const TOTAL_SHARDS = 50;
    let hash = 0;
    const uid = user.id.toLowerCase();
    for (let i = 0; i < uid.length; i++) {
      hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
    }
    const shardId = hash % TOTAL_SHARDS;
    const shardName = `${groupId}:shard_${shardId}`;

    const doId = c.env.GROUP_BROADCASTER_DO.idFromName(shardName);
    const stub = c.env.GROUP_BROADCASTER_DO.get(doId);

    const wsUrl = new URL(c.req.url);
    wsUrl.searchParams.set('user_id', user.id);
    wsUrl.searchParams.set('group_id', groupId);
    wsUrl.searchParams.set('shard_id', String(shardId));
    wsUrl.searchParams.set('role', membership.role || 'member');

    const forwardReq = new Request(wsUrl.toString(), {
      method: 'GET',
      headers: c.req.raw.headers,
    });

    return stub.fetch(forwardReq);
  } catch (err: any) {
    return c.json({ error: err.message || 'INTERNAL_ERROR' }, 500);
  }
});

// 14. Supergroup 监控指标与运行时数据 (群成员/管理员权限守卫)
groupRoutes.get('/:id/supergroup/stats', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');

    const membership = await c.env.DB.prepare(
      'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(groupId, user.id).first<{ role: string }>();
    if (!membership) {
      return c.json({ error: 'Forbidden: not a member of this group' }, 403);
    }

    if (!c.env.GROUP_MASTER_DO) {
      return c.json({ error: 'DURABLE_OBJECT_NOT_BOUND' }, 503);
    }
    const masterId = c.env.GROUP_MASTER_DO.idFromName(groupId);
    const stub = c.env.GROUP_MASTER_DO.get(masterId);
    const res = await stub.fetch('http://internal/stats');
    const stats = (await res.json()) as Record<string, unknown>;
    return c.json({ group_id: groupId, ...stats });
  } catch (err: any) {
    return c.json({ error: err.message || 'INTERNAL_ERROR' }, 500);
  }
});

// 15. Supergroup 历史消息（基于绝对自增 seq 拉取）
groupRoutes.get('/:id/supergroup/messages', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const membership = await c.env.DB.prepare(
      'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(groupId, user.id).first<{ role: string }>();
    if (!membership) {
      return c.json({ error: 'Forbidden: not a member of this group' }, 403);
    }

    if (!c.env.GROUP_MASTER_DO) {
      return c.json({ error: 'DURABLE_OBJECT_NOT_BOUND' }, 503);
    }

    const sinceSeq = c.req.query('since_seq');
    const beforeSeq = c.req.query('before_seq');
    const limit = c.req.query('limit') || '50';
    const masterId = c.env.GROUP_MASTER_DO.idFromName(groupId);
    const stub = c.env.GROUP_MASTER_DO.get(masterId);
    let url = `http://internal/messages?limit=${limit}`;
    if (beforeSeq) {
      url += `&before_seq=${beforeSeq}`;
    } else if (sinceSeq) {
      url += `&since_seq=${sinceSeq}`;
    }
    const res = await stub.fetch(url);
    const data = await res.json();
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err.message || 'INTERNAL_ERROR' }, 500);
  }
});

// 16. Supergroup 慢速发言模式配置 (群主与管理员专属)
groupRoutes.post('/:id/slow-mode', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const membership = await c.env.DB.prepare(
      'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(groupId, user.id).first<{ role: string }>();
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return c.json({ error: 'Unauthorized: only owner or admin can configure slow mode' }, 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as { seconds?: number };
    const seconds = Math.max(0, Math.min(Number(body.seconds) || 0, 3600));

    if (!c.env.GROUP_MASTER_DO) {
      return c.json({ error: 'DURABLE_OBJECT_NOT_BOUND' }, 503);
    }

    const masterId = c.env.GROUP_MASTER_DO.idFromName(groupId);
    const stub = c.env.GROUP_MASTER_DO.get(masterId);
    const res = await stub.fetch('http://internal/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'slow_mode_seconds', value: seconds }),
    });

    if (res.ok) {
      return c.json({ success: true, group_id: groupId, slow_mode_seconds: seconds });
    }
    return c.json({ error: 'Failed to configure slow mode' }, 500);
  } catch (err: any) {
    return c.json({ error: err.message || 'INTERNAL_ERROR' }, 500);
  }
});

export { groupRoutes };

