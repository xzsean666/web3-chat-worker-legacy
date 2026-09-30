import { verifyMessage, isAddress } from 'viem';
import type { UserRow, SessionRow, NonceRow } from '../db/schema';
import { normalizeAddress } from '../db';

export function getAuthMessage(nonce: string): string {
  return `Sign this message to authenticate with Web3 Chat:\nNonce: ${nonce}`;
}

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generateNonce(
  db: D1Database,
  rawAddress: string
): Promise<{ nonce: string; message: string; expires_at: number }> {
  const walletAddress = normalizeAddress(rawAddress);
  if (!isAddress(walletAddress)) {
    throw new Error('Invalid EVM wallet address');
  }

  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000; // 5 minutes

  await db.prepare(
    'INSERT INTO nonces (id, wallet_address, nonce, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, walletAddress, nonce, expiresAt, now).run();

  return {
    nonce,
    message: getAuthMessage(nonce),
    expires_at: expiresAt,
  };
}

export async function verifySignatureAndLogin(
  db: D1Database,
  rawAddress: string,
  signature: string,
  providedNonce?: string
): Promise<{ token: string; user: UserRow; session: SessionRow }> {
  const walletAddress = normalizeAddress(rawAddress);
  if (!isAddress(walletAddress)) {
    throw new Error('Invalid EVM wallet address');
  }

  const now = Date.now();
  let nonceRow: NonceRow | null = null;

  if (providedNonce) {
    nonceRow = await db.prepare(
      'SELECT * FROM nonces WHERE wallet_address = ? AND nonce = ? AND expires_at > ?'
    ).bind(walletAddress, providedNonce, now).first<NonceRow>();
  } else {
    nonceRow = await db.prepare(
      'SELECT * FROM nonces WHERE wallet_address = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
    ).bind(walletAddress, now).first<NonceRow>();
  }

  if (!nonceRow) {
    throw new Error('Nonce not found or expired');
  }

  const expectedMessage = getAuthMessage(nonceRow.nonce);
  let isValid = false;

  try {
    isValid = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message: expectedMessage,
      signature: signature as `0x${string}`,
    });
  } catch {
    isValid = false;
  }

  if (!isValid) {
    throw new Error('Invalid signature');
  }

  // Prepare batch statements for atomic commit
  const deleteNonceStmt = db.prepare('DELETE FROM nonces WHERE id = ?').bind(nonceRow.id);

  // Find or create user: Address as User ID
  let user = await db.prepare(
    'SELECT * FROM users WHERE wallet_address = ? OR id = ?'
  ).bind(walletAddress, walletAddress).first<UserRow>();

  let createUserStmt: D1PreparedStatement | null = null;
  if (!user) {
    createUserStmt = db.prepare(
      'INSERT INTO users (id, wallet_address, public_metadata, private_metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(walletAddress, walletAddress, '{}', '{}', now, now);

    user = {
      id: walletAddress,
      wallet_address: walletAddress,
      username: null,
      public_metadata: '{}',
      private_metadata: '{}',
      avatar_key: null,
      avatar_mime: null,
      avatar_updated_at: null,
      created_at: now,
      updated_at: now,
    };
  } else {
    user.id = user.wallet_address;
  }

  // Create session
  const rawToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await hashToken(rawToken);
  const sessionId = crypto.randomUUID();
  const sessionExpiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 days

  const createSessionStmt = db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(sessionId, user.id, tokenHash, sessionExpiresAt, now);

  const batchStmts: D1PreparedStatement[] = [deleteNonceStmt];
  if (createUserStmt) {
    batchStmts.push(createUserStmt);
  }
  batchStmts.push(createSessionStmt);

  await db.batch(batchStmts);

  const session: SessionRow = {
    id: sessionId,
    user_id: user.id,
    token_hash: tokenHash,
    expires_at: sessionExpiresAt,
    created_at: now,
  };

  return {
    token: rawToken,
    user,
    session,
  };
}

interface CachedSessionEntry {
  data: { user: UserRow; session: SessionRow };
  cachedUntil: number;
}

const sessionCache = new Map<string, CachedSessionEntry>();
const SESSION_CACHE_TTL_MS = 15_000; // 15s isolate memory cache
const MAX_SESSION_CACHE_SIZE = 1000;

export function invalidateSessionCache(tokenHashOrToken?: string, userId?: string): void {
  if (!tokenHashOrToken && !userId) {
    sessionCache.clear();
    return;
  }
  if (tokenHashOrToken) {
    sessionCache.delete(tokenHashOrToken);
  }
  if (userId) {
    const target = userId.toLowerCase();
    for (const [key, entry] of sessionCache.entries()) {
      if (entry.data.user.id.toLowerCase() === target || entry.data.user.wallet_address.toLowerCase() === target) {
        sessionCache.delete(key);
      }
    }
  }
}

export async function validateSession(
  db: D1Database,
  rawToken: string
): Promise<{ user: UserRow; session: SessionRow } | null> {
  if (!rawToken) return null;

  const tokenHash = await hashToken(rawToken);
  const now = Date.now();

  const cached = sessionCache.get(tokenHash);
  if (cached && cached.cachedUntil > now && cached.data.session.expires_at > now) {
    return cached.data;
  }

  const row = await db.prepare(`
    SELECT
      s.id AS session_id,
      s.user_id,
      s.token_hash,
      s.expires_at AS session_expires_at,
      s.created_at AS session_created_at,
      u.wallet_address,
      u.username,
      u.public_metadata,
      u.private_metadata,
      u.avatar_key,
      u.avatar_mime,
      u.avatar_updated_at,
      u.created_at AS user_created_at,
      u.updated_at AS user_updated_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, now).first<{
    session_id: string;
    user_id: string;
    token_hash: string;
    session_expires_at: number;
    session_created_at: number;
    wallet_address: string;
    username: string | null;
    public_metadata: string;
    private_metadata: string;
    avatar_key: string | null;
    avatar_mime: string | null;
    avatar_updated_at: number | null;
    user_created_at: number;
    user_updated_at: number;
  }>();

  if (!row) return null;

  const result = {
    session: {
      id: row.session_id,
      user_id: row.wallet_address,
      token_hash: row.token_hash,
      expires_at: row.session_expires_at,
      created_at: row.session_created_at,
    },
    user: {
      id: row.wallet_address,
      wallet_address: row.wallet_address,
      username: row.username ?? null,
      public_metadata: row.public_metadata ?? '{}',
      private_metadata: row.private_metadata ?? '{}',
      avatar_key: row.avatar_key ?? null,
      avatar_mime: row.avatar_mime ?? null,
      avatar_updated_at: row.avatar_updated_at ?? null,
      created_at: row.user_created_at,
      updated_at: row.user_updated_at,
    },
  };

  if (sessionCache.size >= MAX_SESSION_CACHE_SIZE) {
    const oldestKey = sessionCache.keys().next().value;
    if (oldestKey) sessionCache.delete(oldestKey);
  }
  sessionCache.set(tokenHash, {
    data: result,
    cachedUntil: Math.min(now + SESSION_CACHE_TTL_MS, row.session_expires_at),
  });

  return result;
}

export async function revokeSession(db: D1Database, rawToken: string): Promise<boolean> {
  const tokenHash = await hashToken(rawToken);
  sessionCache.delete(tokenHash);
  const res = await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  return (res.meta.changes ?? 0) > 0;
}
