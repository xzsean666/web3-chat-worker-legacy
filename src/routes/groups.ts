import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
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
  type GroupMarquee,
} from '../services/conversations';

const groupRoutes = new Hono<AppEnv>();

groupRoutes.use('*', authMiddleware);

interface CreateGroupBody {
  name?: string;
  description?: string;
  announcement?: string;
  marquee?: GroupMarquee;
  metadata?: Record<string, any>;
  member_ids?: string[];
  slug?: string;
}

interface UpdateGroupBody {
  name?: string;
  description?: string;
  announcement?: string;
  marquee?: Partial<GroupMarquee> | boolean;
  metadata?: Record<string, any>;
}

interface AddMemberBody {
  user_id?: string;
  wallet_address?: string;
  role?: 'member';
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

// 1. Create group
groupRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json<CreateGroupBody>().catch(() => ({}))) as CreateGroupBody;
    if (!body.name) {
      return c.json({ error: 'Group name is required' }, 400);
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
      }
    );
    return c.json(group, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
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
    const status = err.message.includes('Unauthorized') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

// 4. Leave group (⑤ 成员可以退群)
groupRoutes.post('/:id/leave', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');

    const result = await leaveGroup(c.env.DB, groupId, user.id);
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

    const result = await removeGroupMember(c.env.DB, groupId, user.id, target);
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

    const result = await removeGroupMember(c.env.DB, groupId, user.id, targetUserId);
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

export { groupRoutes };
