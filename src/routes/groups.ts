import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  createGroup,
  updateGroupName,
  addGroupMember,
  removeGroupMember,
} from '../services/conversations';

const groupRoutes = new Hono<AppEnv>();

groupRoutes.use('*', authMiddleware);

interface CreateGroupBody {
  name?: string;
  member_ids?: string[];
}

interface UpdateGroupBody {
  name?: string;
}

interface AddMemberBody {
  user_id?: string;
  wallet_address?: string;
  role?: 'admin' | 'member';
}

groupRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json<CreateGroupBody>().catch(() => ({}))) as CreateGroupBody;
    if (!body.name) {
      return c.json({ error: 'Group name is required' }, 400);
    }

    const group = await createGroup(c.env.DB, user.id, body.name, body.member_ids ?? []);
    return c.json(group, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

groupRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const body = (await c.req.json<UpdateGroupBody>().catch(() => ({}))) as UpdateGroupBody;
    if (!body.name) {
      return c.json({ error: 'Group name is required' }, 400);
    }

    const updated = await updateGroupName(c.env.DB, groupId, user.id, body.name);
    return c.json(updated);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

groupRoutes.post('/:id/members', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const body = (await c.req.json<AddMemberBody>().catch(() => ({}))) as AddMemberBody;
    const target = body.user_id || body.wallet_address;

    if (!target) {
      return c.json({ error: 'user_id or wallet_address is required' }, 400);
    }

    const member = await addGroupMember(c.env.DB, groupId, user.id, target, body.role || 'member');
    return c.json(member, 201);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

groupRoutes.delete('/:id/members/:userId', async (c) => {
  try {
    const user = c.get('user');
    const groupId = c.req.param('id');
    const targetUserId = c.req.param('userId');

    const result = await removeGroupMember(c.env.DB, groupId, user.id, targetUserId);
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

export { groupRoutes };
