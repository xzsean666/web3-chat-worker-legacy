import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  addFriend,
  getFriends,
  getFriend,
  updateFriend,
  setFriendTags,
  getAllFriendTags,
  removeFriend,
  blockUser,
  getBlockedUsers,
  unblockUser,
} from '../services/social';

const friendRoutes = new Hono<AppEnv>();
const blacklistRoutes = new Hono<AppEnv>();

friendRoutes.use('*', authMiddleware);
blacklistRoutes.use('*', authMiddleware);

// ---------------- FRIENDS ROUTES ----------------

// Get all unique tags used across friends (must be before /:address)
friendRoutes.get('/tags', async (c) => {
  try {
    const user = c.get('user');
    const tags = await getAllFriendTags(c.env.DB, user.id);
    return c.json({ tags });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// List friends (supports ?tag=xyz)
friendRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const tag = c.req.query('tag');
    const friends = await getFriends(c.env.DB, user.id, { tag });
    return c.json({ friends });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Add friend
friendRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const friendAddress = body.friend_address || body.address;

    if (!friendAddress) {
      return c.json({ error: 'friend_address is required' }, 400);
    }

    const friend = await addFriend(c.env.DB, user.id, friendAddress, {
      alias: body.alias,
      tags: body.tags,
    });

    return c.json({ friend }, 201);
  } catch (err: any) {
    const status = err.message.includes('blocked') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

// Get single friend
friendRoutes.get('/:address', async (c) => {
  try {
    const user = c.get('user');
    const address = c.req.param('address');
    const friend = await getFriend(c.env.DB, user.id, address);

    if (!friend) {
      return c.json({ error: 'Friend not found' }, 404);
    }

    return c.json({ friend });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Update friend (alias / tags)
friendRoutes.patch('/:address', async (c) => {
  try {
    const user = c.get('user');
    const address = c.req.param('address');
    const body = await c.req.json().catch(() => ({}));

    const friend = await updateFriend(c.env.DB, user.id, address, {
      alias: body.alias,
      tags: body.tags,
    });

    return c.json({ friend });
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// Set/Update tags for friend
friendRoutes.post('/:address/tags', async (c) => {
  try {
    const user = c.get('user');
    const address = c.req.param('address');
    const body = await c.req.json().catch(() => ({}));

    if (!Array.isArray(body.tags)) {
      return c.json({ error: 'tags must be an array of strings' }, 400);
    }

    const friend = await setFriendTags(c.env.DB, user.id, address, body.tags);
    return c.json({ friend });
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
});

// Delete friend
friendRoutes.delete('/:address', async (c) => {
  try {
    const user = c.get('user');
    const address = c.req.param('address');
    const deleted = await removeFriend(c.env.DB, user.id, address);
    return c.json({ success: deleted });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ---------------- BLACKLIST ROUTES ----------------

// List blocked users
blacklistRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const blocked = await getBlockedUsers(c.env.DB, user.id);
    return c.json({ blocked, blacklist: blocked });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Block a user
blacklistRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const blockedAddress = body.blocked_address || body.address;

    if (!blockedAddress) {
      return c.json({ error: 'blocked_address is required' }, 400);
    }

    const result = await blockUser(c.env.DB, user.id, blockedAddress, body.reason);
    return c.json(result, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Unblock a user
blacklistRoutes.delete('/:address', async (c) => {
  try {
    const user = c.get('user');
    const address = c.req.param('address');
    const unblocked = await unblockUser(c.env.DB, user.id, address);
    return c.json({ success: unblocked });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { friendRoutes, blacklistRoutes };
