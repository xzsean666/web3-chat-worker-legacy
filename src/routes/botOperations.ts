import { Hono } from 'hono';
import type { AppEnv, MessageType } from '../types';
import { botAuthMiddleware } from '../middleware/botAuth';
import {
  listBotConversations,
  botJoinGroup,
} from '../services/bots';
import {
  getConversation,
  getGroupMembers,
  removeGroupMember,
  setGroupMute,
  setMemberMute,
  updateGroup,
  leaveGroup,
  updateMemberRole,
} from '../services/conversations';
import {
  sendMessage,
  getConversationMessages,
  getSyncUpdates,
} from '../services/messages';

interface JoinGroupBody {
  group_id?: string;
  invite_token?: string;
}

interface SendMessageBody {
  conversation_id: string;
  content: string;
  type?: MessageType;
  mentions?: string[];
  expires_in_seconds?: number;
}

interface KickMemberBody {
  user_id?: string;
  wallet_address?: string;
}

interface MuteGroupBody {
  muted?: boolean;
  duration_seconds?: number;
}

interface MuteMemberBody {
  user_id?: string;
  wallet_address?: string;
  muted?: boolean;
  duration_seconds?: number;
  reason?: string;
}

interface UpdateGroupBody {
  name?: string;
  description?: string;
  announcement?: string;
  marquee?: any;
}

interface UpdateRoleBody {
  role?: 'admin' | 'member';
}

export const botOperationsRoutes = new Hono<AppEnv>();

// All bot operation routes require bot credential authentication
botOperationsRoutes.use('*', botAuthMiddleware);

/**
 * 1. Get bot self information
 * GET /bot/me
 */
botOperationsRoutes.get('/me', async (c) => {
  const bot = c.get('bot')!;
  return c.json({
    bot: {
      id: bot.id,
      name: bot.name,
      username: bot.username,
      description: bot.description,
      avatar_url: bot.avatar_url,
      owner_id: bot.owner_id,
      status: bot.status,
      created_at: bot.created_at,
      updated_at: bot.updated_at,
    },
  });
});

/**
 * 2. List conversations/groups the bot is currently in
 * GET /bot/groups or GET /bot/conversations
 */
botOperationsRoutes.get('/groups', async (c) => {
  const bot = c.get('bot')!;
  const groups = await listBotConversations(c.env.DB, bot.id);
  return c.json({ groups });
});

botOperationsRoutes.get('/conversations', async (c) => {
  const bot = c.get('bot')!;
  const conversations = await listBotConversations(c.env.DB, bot.id);
  return c.json({ conversations });
});

/**
 * 3. Get single group details
 * GET /bot/groups/:id
 */
botOperationsRoutes.get('/groups/:id', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.param('id');
    const conversation = await getConversation(c.env.DB, groupId, bot.id);
    return c.json({ conversation });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 4. Get group members list
 * GET /bot/groups/:id/members
 */
botOperationsRoutes.get('/groups/:id/members', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.param('id');
    const members = await getGroupMembers(c.env.DB, groupId, bot.id);
    return c.json({ members });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 5. Join a group via invite token or group id
 * POST /bot/groups/join
 */
botOperationsRoutes.post('/groups/join', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json<JoinGroupBody>().catch(() => ({}))) as JoinGroupBody;
    const result = await botJoinGroup(c.env.DB, user, body);
    return c.json({ result }, 200);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 6. Send message to conversation
 * POST /bot/messages/send
 */
botOperationsRoutes.post('/messages/send', async (c) => {
  try {
    const bot = c.get('bot')!;
    const body = (await c.req.json<SendMessageBody>().catch(() => ({}))) as SendMessageBody;

    if (!body.conversation_id) {
      return c.json({ error: 'conversation_id is required' }, 400);
    }
    if (!body.content || !body.content.trim()) {
      return c.json({ error: 'content is required' }, 400);
    }

    const message = await sendMessage(c.env.DB, body.conversation_id, bot.id, {
      content: body.content,
      type: body.type || 'text',
      mentions: body.mentions,
      expires_in_seconds: body.expires_in_seconds,
    });

    return c.json({ message }, 201);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized')
      ? 403
      : message.includes('muted')
      ? 403
      : message.includes('not found')
      ? 404
      : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 7. Read conversation messages
 * GET /bot/conversations/:id/messages
 */
botOperationsRoutes.get('/conversations/:id/messages', async (c) => {
  try {
    const bot = c.get('bot')!;
    const conversationId = c.req.param('id');
    const afterId = c.req.query('after_id');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50;

    const result = await getConversationMessages(c.env.DB, conversationId, bot.id, {
      after_id: afterId,
      limit,
    });
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 8. Incremental sync for bot
 * GET /bot/sync
 */
botOperationsRoutes.get('/sync', async (c) => {
  try {
    const bot = c.get('bot')!;
    const since = c.req.query('since') ? Number(c.req.query('since')) : 0;
    const sinceId = c.req.query('since_id');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 100;

    const updates = await getSyncUpdates(c.env.DB, bot.id, {
      since,
      since_id: sinceId,
      limit,
    });
    return c.json(updates);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/**
 * 9. Group Management: Kick member
 * POST /bot/groups/:id/kick
 */
botOperationsRoutes.post('/groups/:id/kick', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.param('id');
    const body = (await c.req.json<KickMemberBody>().catch(() => ({}))) as KickMemberBody;
    const targetUserId = body.user_id || body.wallet_address;

    if (!targetUserId) {
      return c.json({ error: 'user_id or wallet_address is required' }, 400);
    }

    const result = await removeGroupMember(c.env.DB, groupId, bot.id, targetUserId);
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 10. Group Management: Mute / Unmute entire group
 * POST /bot/groups/:id/mute
 */
botOperationsRoutes.post('/groups/:id/mute', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.param('id');
    const body = (await c.req.json<MuteGroupBody>().catch(() => ({}))) as MuteGroupBody;
    const muted = body.muted !== false;

    const result = await setGroupMute(c.env.DB, groupId, bot.id, {
      muted,
      duration_seconds: body.duration_seconds,
    });
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 11. Group Management: Mute / Unmute single member
 * POST /bot/groups/:id/mute-member
 */
botOperationsRoutes.post('/groups/:id/mute-member', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.param('id');
    const body = (await c.req.json<MuteMemberBody>().catch(() => ({}))) as MuteMemberBody;

    const targetUserId = body.user_id || body.wallet_address;
    if (!targetUserId) {
      return c.json({ error: 'user_id or wallet_address is required' }, 400);
    }

    const muted = body.muted !== false;

    const result = await setMemberMute(c.env.DB, groupId, bot.id, targetUserId, {
      muted,
      duration_seconds: body.duration_seconds,
      reason: body.reason,
    });
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 12. Group Management: Update group info
 * PATCH /bot/groups/:id
 */
botOperationsRoutes.patch('/groups/:id', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.param('id');
    const body = (await c.req.json<UpdateGroupBody>().catch(() => ({}))) as UpdateGroupBody;

    const result = await updateGroup(c.env.DB, groupId, bot.id, body);
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 13. Group Management: Update member role (if bot is owner)
 * PUT /bot/groups/:id/members/:userId/role
 */
botOperationsRoutes.put('/groups/:id/members/:userId/role', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.param('id');
    const targetUserId = c.req.param('userId');
    const body = (await c.req.json<UpdateRoleBody>().catch(() => ({}))) as UpdateRoleBody;

    if (!body.role || (body.role !== 'admin' && body.role !== 'member')) {
      return c.json({ error: 'role must be "admin" or "member"' }, 400);
    }

    const result = await updateMemberRole(c.env.DB, groupId, bot.id, targetUserId, body.role);
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 14. Bot Leave Group
 * POST /bot/groups/:id/leave
 */
botOperationsRoutes.post('/groups/:id/leave', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.param('id');
    const result = await leaveGroup(c.env.DB, groupId, bot.id, c.env.VOICE_BUCKET);
    return c.json(result);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});
