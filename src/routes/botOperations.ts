import { Hono, type Context } from 'hono';
import type { AppEnv, MessageType } from '../types';
import { botAuthMiddleware } from '../middleware/botAuth';
import {
  listBotConversations,
  botJoinGroup,
  checkBotMessageRateLimit,
  botInviteMember,
  botSetGroupCapacity,
  botModerateGroup,
  getBotGroupEvents,
  createBotTask,
  listBotTasks,
  getBotTask,
  cancelBotTask,
  type BotInviteMemberOptions,
  type BotModerateOptions,
  type CreateBotTaskOptions,
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
  findOrCreateUser,
} from '../services/conversations';
import {
  sendMessage,
  getConversationMessages,
  getSyncUpdates,
} from '../services/messages';
import { allow } from '../services/rateLimit';

interface JoinGroupBody {
  group_id?: string;
  invite_token?: string;
}

interface SendMessageBody {
  conversation_id: string;
  content?: string;
  media_url?: string;
  type?: MessageType;
  mentions?: string[];
  expires_in_seconds?: number;
}

interface InviteMemberBody {
  group_id?: string;
  user_id?: string;
  wallet_address?: string;
  username?: string;
  nickname?: string;
  avatar_url?: string;
}

interface SetCapacityBody {
  group_id?: string;
  capacity?: number;
  max_members?: number;
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
    const limitQuery = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const limit = limitQuery !== undefined ? Math.max(1, parseInt(limitQuery, 10) || 50) : undefined;
    const result = await getGroupMembers(c.env.DB, groupId, bot.id, { limit, cursor });
    return c.json(result);
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
 * POST /bot/messages/send & POST /bot/message/send
 */
const handleSendMessage = async (c: Context<AppEnv>) => {
  try {
    const bot = c.get('bot')!;
    const body = (await c.req.json<SendMessageBody>().catch(() => ({}))) as SendMessageBody;

    if (!body.conversation_id) {
      return c.json({ error: 'conversation_id is required' }, 400);
    }

    let contentToSend = body.content ? body.content.trim() : '';
    if (body.media_url) {
      contentToSend = contentToSend ? `${contentToSend}\n${body.media_url}` : body.media_url;
    }

    if (!contentToSend) {
      return c.json({ error: 'content is required' }, 400);
    }

    // Check rate limit: strict B-R4 (3/min per group) if requested or configured, otherwise general bot flood protection (120/min)
    const enforceStrictLimit = c.req.header('X-Enforce-Rate-Limit') === 'true' || (c.env as any).ENFORCE_BOT_RATE_LIMIT === 'true';
    if (enforceStrictLimit) {
      const allowed = await checkBotMessageRateLimit(c.env.DB, bot.id, body.conversation_id);
      if (!allowed) {
        return c.json(
          { error: 'RATE_LIMITED', message: 'Bot rate limit exceeded: maximum 3 messages per minute per group (B-R4)' },
          429
        );
      }
    } else {
      if (!(await allow(c.env.DB, 'bot_msg_general', bot.id, 120))) {
        return c.json(
          { error: 'RATE_LIMITED', message: 'Bot rate limit exceeded (flood protection: max 120 messages per minute)' },
          429
        );
      }
    }

    const message = await sendMessage(c.env.DB, body.conversation_id, bot.id, {
      content: contentToSend,
      type: body.type || 'text',
      mentions: body.mentions,
      expires_in_seconds: body.expires_in_seconds,
    });

    // 联动优化：若是群聊且配置了 GROUP_MASTER_DO，向 MasterDO 同步以触发在线 WebSocket 即时广播
    if (c.env.GROUP_MASTER_DO && !body.conversation_id.startsWith('direct:')) {
      try {
        const masterId = c.env.GROUP_MASTER_DO.idFromName(body.conversation_id);
        const stub = c.env.GROUP_MASTER_DO.get(masterId);
        const broadcastPromise = stub
          .fetch('http://internal/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: message.id,
              conversationId: body.conversation_id,
              senderId: bot.id,
              type: message.type,
              content: message.content,
              createdAt: message.created_at,
              skipD1WriteBack: true, // 已在上方写过 D1，避免二次冗余落盘
              asyncBroadcast: true,
            }),
          })
          .catch((e: any) => console.error('[Bot HTTP->DO Broadcast failed]:', e));
        if (c.executionCtx) {
          c.executionCtx.waitUntil(broadcastPromise);
        } else {
          await broadcastPromise;
        }
      } catch {
        // ignore
      }
    }

    return c.json(
      {
        message: {
          ...message,
          sender_type: 'bot',
        },
      },
      201
    );
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
};

botOperationsRoutes.post('/messages/send', handleSendMessage);
botOperationsRoutes.post('/message/send', handleSendMessage);


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

    const result = await removeGroupMember(c.env.DB, groupId, bot.id, targetUserId, c.env.VOICE_BUCKET);

    // 联动优化：强制关闭被踢用户的 WebSocket 连接
    if (c.env.GROUP_BROADCASTER_DO) {
      try {
        let resolvedUserId = targetUserId;
        try {
          const resolved = await findOrCreateUser(c.env.DB, targetUserId);
          if (resolved?.id) resolvedUserId = resolved.id;
        } catch {}

        const TOTAL_SHARDS = 50;
        let hash = 0;
        const uid = resolvedUserId.toLowerCase();
        for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
        const shardId = hash % TOTAL_SHARDS;
        const shardName = `${groupId}:shard_${shardId}`;
        const doId = c.env.GROUP_BROADCASTER_DO.idFromName(shardName);
        const stub = c.env.GROUP_BROADCASTER_DO.get(doId);
        const kickPromise = stub.fetch('http://internal/kick_user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: resolvedUserId }),
        }).catch(() => {});
        if (c.executionCtx) {
          c.executionCtx.waitUntil(kickPromise);
        } else {
          await kickPromise;
        }
      } catch {
        // ignore
      }
    }

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

/**
 * 15. Bot Group Invite / Add Member (Requires bot to be admin/owner)
 * POST /bot/group/invite, POST /bot/groups/invite, POST /bot/groups/:id/invite
 */
const handleInviteMember = async (c: Context<AppEnv>) => {
  try {
    const user = c.get('user');
    const paramId = c.req.param('id');
    const body = (await c.req.json<InviteMemberBody>().catch(() => ({}))) as InviteMemberBody;
    const groupId = paramId || body.group_id;
    if (!groupId) {
      return c.json({ error: 'group_id is required' }, 400);
    }
    const result = await botInviteMember(c.env.DB, user, groupId, body);
    return c.json(result, 201);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized')
      ? 403
      : message.includes('already a member')
      ? 409
      : message.includes('not found')
      ? 404
      : message.includes('GROUP_CAPACITY_REACHED')
      ? 403
      : 400;
    return c.json({ error: message }, status);
  }
};

botOperationsRoutes.post('/group/invite', handleInviteMember);
botOperationsRoutes.post('/groups/invite', handleInviteMember);
botOperationsRoutes.post('/groups/:id/invite', handleInviteMember);

/**
 * 16. Bot Set Group Capacity Limit (Requires bot to be admin/owner)
 * POST /bot/group/capacity, POST /bot/groups/capacity, POST /bot/groups/:id/capacity
 */
const handleSetCapacity = async (c: Context<AppEnv>) => {
  try {
    const user = c.get('user');
    const paramId = c.req.param('id');
    const body = (await c.req.json<SetCapacityBody>().catch(() => ({}))) as SetCapacityBody;
    const groupId = paramId || body.group_id;
    const capacity = Number(body.capacity ?? body.max_members);
    if (!groupId) {
      return c.json({ error: 'group_id is required' }, 400);
    }
    if (!capacity || isNaN(capacity)) {
      return c.json({ error: 'Valid capacity or max_members is required' }, 400);
    }
    const result = await botSetGroupCapacity(c.env.DB, user, groupId, capacity);
    return c.json(result, 200);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
};

botOperationsRoutes.post('/group/capacity', handleSetCapacity);
botOperationsRoutes.post('/groups/capacity', handleSetCapacity);
botOperationsRoutes.post('/groups/:id/capacity', handleSetCapacity);

/**
 * 17. Bot Group Moderation (Unified Moderation Endpoint)
 * POST /bot/group/moderate, POST /bot/groups/moderate, POST /bot/groups/:id/moderate
 */
const handleModerateGroup = async (c: Context<AppEnv>) => {
  try {
    const user = c.get('user');
    const paramId = c.req.param('id');
    const body = (await c.req.json<BotModerateOptions & { group_id?: string }>().catch(() => ({}))) as BotModerateOptions & { group_id?: string };
    const groupId = paramId || body.group_id;
    if (!groupId) {
      return c.json({ error: 'group_id is required' }, 400);
    }
    const result = await botModerateGroup(c.env.DB, user, groupId, body, c.env.VOICE_BUCKET);
    return c.json(result, 200);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') ? 403 : message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
};

botOperationsRoutes.post('/group/moderate', handleModerateGroup);
botOperationsRoutes.post('/groups/moderate', handleModerateGroup);
botOperationsRoutes.post('/groups/:id/moderate', handleModerateGroup);

/**
 * 18. Bot Group Events Stream Subscription
 * GET /bot/group/events, GET /bot/groups/events, GET /bot/groups/:id/events
 */
const handleGetEvents = async (c: Context<AppEnv>) => {
  try {
    const bot = c.get('bot')!;
    const paramId = c.req.param('id');
    const groupId = paramId || c.req.query('group_id');
    const since = c.req.query('since') ? Number(c.req.query('since')) : 0;
    const sinceId = c.req.query('since_id');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50;

    const result = await getBotGroupEvents(c.env.DB, bot.id, {
      group_id: groupId,
      since,
      since_id: sinceId,
      limit,
    });
    return c.json(result, 200);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
};

botOperationsRoutes.get('/group/events', handleGetEvents);
botOperationsRoutes.get('/groups/events', handleGetEvents);
botOperationsRoutes.get('/groups/:id/events', handleGetEvents);

/**
 * 19. Bot Scheduled Content Tasks
 * POST /bot/tasks
 * GET /bot/tasks
 * GET /bot/tasks/:id
 * DELETE /bot/tasks/:id
 */
botOperationsRoutes.post('/tasks', async (c) => {
  try {
    const bot = c.get('bot')!;
    const body = (await c.req.json<CreateBotTaskOptions>().catch(() => ({}))) as CreateBotTaskOptions;
    const task = await createBotTask(c.env.DB, bot.id, body);
    return c.json({ task }, 201);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('Unauthorized') || message.includes('not a member') ? 403 : 400;
    return c.json({ error: message }, status);
  }
});

botOperationsRoutes.get('/tasks', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.query('group_id');
    const status = c.req.query('status') as any;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50;
    const tasks = await listBotTasks(c.env.DB, bot.id, { group_id: groupId, status, limit });
    return c.json({ tasks });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

botOperationsRoutes.get('/tasks/:id', async (c) => {
  try {
    const bot = c.get('bot')!;
    const taskId = c.req.param('id');
    const task = await getBotTask(c.env.DB, bot.id, taskId);
    return c.json({ task });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

botOperationsRoutes.delete('/tasks/:id', async (c) => {
  try {
    const bot = c.get('bot')!;
    const taskId = c.req.param('id');
    const task = await cancelBotTask(c.env.DB, bot.id, taskId);
    return c.json({ task });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

/**
 * 20. Bot Audit Logs
 * GET /bot/audit-logs
 */
botOperationsRoutes.get('/audit-logs', async (c) => {
  try {
    const bot = c.get('bot')!;
    const groupId = c.req.query('group_id');
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);

    let sql = 'SELECT * FROM bot_audit_logs WHERE bot_id = ?';
    const params: unknown[] = [bot.id];
    if (groupId) {
      sql += ' AND group_id = ?';
      params.push(groupId);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const { results } = await c.env.DB.prepare(sql).bind(...params).all();
    return c.json({ logs: results || [] });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

