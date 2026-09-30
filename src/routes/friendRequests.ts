import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  sendFriendRequest,
  listFriendRequests,
  getUnreadFriendRequestCount,
  acceptFriendRequest,
  rejectFriendRequest,
} from '../services/friendRequests';

const friendRequestRoutes = new Hono<AppEnv>();

friendRequestRoutes.use('*', authMiddleware);

interface SendFriendRequestBody {
  to_address?: string;
  friend_address?: string;
  address?: string;
  message?: string;
}

function errorStatus(message: string): 400 | 403 | 404 {
  if (message.includes('not found')) return 404;
  if (message.includes('Unauthorized') || message.includes('blocked')) return 403;
  return 400;
}

// Unread count for the badge / red dot (must be registered before /:id routes)
friendRequestRoutes.get('/unread-count', async (c) => {
  try {
    const user = c.get('user');
    const unreadCount = await getUnreadFriendRequestCount(c.env.DB, user.id);
    return c.json({ unread_count: unreadCount });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Submit a friend request (optional verification message)
friendRequestRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = (await c.req.json<SendFriendRequestBody>().catch(() => ({}))) as SendFriendRequestBody;
    const target = body.to_address || body.friend_address || body.address;

    if (!target) {
      return c.json({ error: 'to_address is required' }, 400);
    }

    const request = await sendFriendRequest(c.env.DB, user.id, target, body.message);
    return c.json({ request }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, errorStatus(err.message));
  }
});

// List requests: ?direction=incoming (default, pending + marks read) | outgoing
friendRequestRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const directionRaw = c.req.query('direction') || 'incoming';
    if (directionRaw !== 'incoming' && directionRaw !== 'outgoing') {
      return c.json({ error: 'direction must be "incoming" or "outgoing"' }, 400);
    }

    const result = await listFriendRequests(c.env.DB, user.id, directionRaw);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Accept a request -> establishes the contact relationship in both directions
friendRequestRoutes.post('/:id/accept', async (c) => {
  try {
    const user = c.get('user');
    const requestId = c.req.param('id');

    const result = await acceptFriendRequest(c.env.DB, user.id, requestId);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, errorStatus(err.message));
  }
});

// Reject a request
friendRequestRoutes.post('/:id/reject', async (c) => {
  try {
    const user = c.get('user');
    const requestId = c.req.param('id');

    const result = await rejectFriendRequest(c.env.DB, user.id, requestId);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, errorStatus(err.message));
  }
});

export { friendRequestRoutes };
