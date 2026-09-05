import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { generateNonce, verifySignatureAndLogin, revokeSession } from '../services/auth';
import { authMiddleware } from '../middleware/auth';

const authRoutes = new Hono<AppEnv>();

interface NonceReqBody {
  wallet_address?: string;
}

interface VerifyReqBody {
  wallet_address?: string;
  signature?: string;
  nonce?: string;
}

authRoutes.post('/nonce', async (c) => {
  try {
    const body = (await c.req.json<NonceReqBody>().catch(() => ({}))) as NonceReqBody;
    if (!body.wallet_address) {
      return c.json({ error: 'Missing wallet_address' }, 400);
    }

    const challenge = await generateNonce(c.env.DB, body.wallet_address);
    return c.json(challenge);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

authRoutes.post('/verify', async (c) => {
  try {
    const body = (await c.req.json<VerifyReqBody>().catch(() => ({}))) as VerifyReqBody;
    if (!body.wallet_address || !body.signature) {
      return c.json({ error: 'Missing wallet_address or signature' }, 400);
    }

    const result = await verifySignatureAndLogin(c.env.DB, body.wallet_address, body.signature, body.nonce);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 401);
  }
});

authRoutes.get('/me', authMiddleware, (c) => {
  const user = c.get('user');
  return c.json({ user });
});

authRoutes.post('/logout', authMiddleware, async (c) => {
  const token = c.get('token');
  await revokeSession(c.env.DB, token);
  return c.json({ success: true });
});

export { authRoutes };
