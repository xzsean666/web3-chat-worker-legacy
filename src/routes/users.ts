import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  getUserProfile,
  getMyProfile,
  updateUserMetadata,
  uploadUserAvatar,
  getUserAvatar,
  setUsername,
  getUserByUsername,
  checkUsernameAvailability,
} from '../services/users';

const userRoutes = new Hono<AppEnv>();

// Protected endpoints for authenticated user's own profile and avatar (registered first)
userRoutes.use('/me/*', authMiddleware);
userRoutes.use('/me', authMiddleware);

userRoutes.get('/me', async (c) => {
  try {
    const user = c.get('user');
    const profile = await getMyProfile(c.env.DB, user.id);
    return c.json({ user: profile });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

userRoutes.patch('/me/metadata', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const profile = await updateUserMetadata(c.env.DB, user.id, body);
    return c.json({ user: profile });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

userRoutes.post('/me/avatar', async (c) => {
  try {
    const user = c.get('user');
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
      if (!json.avatar_base64 && !json.file_base64 && !json.image_base64) {
        return c.json({ error: 'Missing avatar_base64 or file' }, 400);
      }
      const base64Str = json.avatar_base64 || json.file_base64 || json.image_base64;
      mimeType = json.mime_type || 'image/png';
      const binaryString = atob(base64Str);
      avatarData = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        avatarData[i] = binaryString.charCodeAt(i);
      }
    }

    const result = await uploadUserAvatar(c.env.DB, c.env.VOICE_BUCKET, user.id, {
      avatarData,
      mimeType,
    });

    return c.json(result, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Set/change globally unique username (protected)
userRoutes.put('/me/username', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));

    if (!body.username || typeof body.username !== 'string') {
      return c.json({ error: 'username is required' }, 400);
    }

    const profile = await setUsername(c.env.DB, user.id, body.username);
    return c.json({ user: profile });
  } catch (err: any) {
    if (err.message === 'USERNAME_TAKEN') {
      return c.json({ error: 'Username is already taken' }, 409);
    }
    return c.json({ error: err.message }, 400);
  }
});

// Public endpoint: check username availability (for registration UX)
userRoutes.get('/check-username/:username', async (c) => {
  try {
    const result = await checkUsernameAvailability(c.env.DB, c.req.param('username'));
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Public endpoint: exact lookup of a user's public profile by unique username
userRoutes.get('/by-username/:username', async (c) => {
  try {
    const profile = await getUserByUsername(c.env.DB, c.req.param('username'));
    if (!profile) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ user: profile });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Public endpoint: Stream user avatar image directly
userRoutes.get('/:address/avatar', async (c) => {
  try {
    const address = c.req.param('address');
    const result = await getUserAvatar(c.env.DB, c.env.VOICE_BUCKET, address);

    if (!result) {
      return c.json({ error: 'Avatar not found' }, 404);
    }

    const headers: Record<string, string> = {
      'Content-Type': result.mimeType,
      'Cache-Control': 'public, max-age=3600',
    };

    if (result.object.httpEtag) {
      headers['ETag'] = result.object.httpEtag;
    }

    return new Response(result.object.body, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Public endpoint: Get another user's public profile (strictly NO private_metadata)
userRoutes.get('/:address', async (c) => {
  try {
    const address = c.req.param('address');
    const profile = await getUserProfile(c.env.DB, address);
    if (!profile) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({ user: profile });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { userRoutes };
