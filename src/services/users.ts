import type { UserRow } from '../db/schema';

const ALLOWED_AVATAR_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export interface PublicUserProfile {
  id: string;
  wallet_address: string;
  public_metadata: Record<string, any>;
  avatar_url: string | null;
  avatar_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MyUserProfile extends PublicUserProfile {
  private_metadata: Record<string, any>;
}

export interface UpdateMetadataOptions {
  public_metadata?: any;
  private_metadata?: any;
}

export interface UploadAvatarOptions {
  avatarData: Uint8Array | ArrayBuffer;
  mimeType: string;
}

function parseJsonSafe(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function getUserProfile(
  db: D1Database,
  targetAddress: string
): Promise<PublicUserProfile | null> {
  const normalized = targetAddress.toLowerCase().trim();
  const user = await db.prepare(
    'SELECT id, wallet_address, public_metadata, avatar_key, avatar_updated_at, created_at, updated_at FROM users WHERE id = ? OR wallet_address = ?'
  ).bind(normalized, normalized).first<UserRow>();

  if (!user) {
    return null;
  }

  return {
    id: user.wallet_address,
    wallet_address: user.wallet_address,
    public_metadata: parseJsonSafe(user.public_metadata),
    avatar_url: user.avatar_key ? `/users/${user.wallet_address}/avatar` : null,
    avatar_updated_at: user.avatar_updated_at ?? null,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function getMyProfile(
  db: D1Database,
  userId: string
): Promise<MyUserProfile> {
  const normalized = userId.toLowerCase().trim();
  const user = await db.prepare(
    'SELECT * FROM users WHERE id = ? OR wallet_address = ?'
  ).bind(normalized, normalized).first<UserRow>();

  if (!user) {
    throw new Error('User not found');
  }

  return {
    id: user.wallet_address,
    wallet_address: user.wallet_address,
    public_metadata: parseJsonSafe(user.public_metadata),
    private_metadata: parseJsonSafe(user.private_metadata),
    avatar_url: user.avatar_key ? `/users/${user.wallet_address}/avatar` : null,
    avatar_updated_at: user.avatar_updated_at ?? null,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function updateUserMetadata(
  db: D1Database,
  userId: string,
  options: UpdateMetadataOptions
): Promise<MyUserProfile> {
  const normalized = userId.toLowerCase().trim();
  const user = await db.prepare(
    'SELECT * FROM users WHERE id = ? OR wallet_address = ?'
  ).bind(normalized, normalized).first<UserRow>();

  if (!user) {
    throw new Error('User not found');
  }

  if (options.public_metadata === undefined && options.private_metadata === undefined) {
    throw new Error('No metadata provided to update');
  }

  let publicMetadataStr = user.public_metadata ?? '{}';
  if (options.public_metadata !== undefined) {
    if (typeof options.public_metadata !== 'object' || options.public_metadata === null) {
      throw new Error('public_metadata must be a JSON object');
    }
    publicMetadataStr = JSON.stringify(options.public_metadata);
  }

  let privateMetadataStr = user.private_metadata ?? '{}';
  if (options.private_metadata !== undefined) {
    if (typeof options.private_metadata !== 'object' || options.private_metadata === null) {
      throw new Error('private_metadata must be a JSON object');
    }
    privateMetadataStr = JSON.stringify(options.private_metadata);
  }

  const now = Date.now();
  await db.prepare(`
    UPDATE users
    SET public_metadata = ?, private_metadata = ?, updated_at = ?
    WHERE id = ? OR wallet_address = ?
  `).bind(publicMetadataStr, privateMetadataStr, now, normalized, normalized).run();

  return getMyProfile(db, normalized);
}

export async function uploadUserAvatar(
  db: D1Database,
  r2: R2Bucket,
  userId: string,
  options: UploadAvatarOptions
): Promise<{ avatar_url: string; avatar_updated_at: number }> {
  const normalized = userId.toLowerCase().trim();
  const user = await db.prepare(
    'SELECT * FROM users WHERE id = ? OR wallet_address = ?'
  ).bind(normalized, normalized).first<UserRow>();

  if (!user) {
    throw new Error('User not found');
  }

  const normalizedMime = options.mimeType.toLowerCase().split(';')[0].trim();
  const ext = ALLOWED_AVATAR_MIME_TYPES[normalizedMime];
  if (!ext) {
    throw new Error(
      `Unsupported avatar image format: ${options.mimeType}. Allowed: jpeg, png, webp, gif, svg`
    );
  }

  const byteLength = options.avatarData.byteLength;
  if (byteLength === 0) {
    throw new Error('Avatar image cannot be empty');
  }
  if (byteLength > MAX_AVATAR_SIZE_BYTES) {
    throw new Error(`Avatar image exceeds maximum size of ${MAX_AVATAR_SIZE_BYTES / (1024 * 1024)}MB`);
  }

  // Single avatar constraint: Delete previous avatar if exists
  if (user.avatar_key) {
    try {
      await r2.delete(user.avatar_key);
    } catch {
      // Ignore deletion error of previous avatar
    }
  }

  const now = Date.now();
  const objectKey = `avatars/${normalized}-${now}.${ext}`;

  await r2.put(objectKey, options.avatarData, {
    httpMetadata: {
      contentType: normalizedMime,
    },
    customMetadata: {
      user_id: normalized,
      uploaded_at: now.toString(),
    },
  });

  await db.prepare(`
    UPDATE users
    SET avatar_key = ?, avatar_mime = ?, avatar_updated_at = ?, updated_at = ?
    WHERE id = ? OR wallet_address = ?
  `).bind(objectKey, normalizedMime, now, now, normalized, normalized).run();

  return {
    avatar_url: `/users/${normalized}/avatar`,
    avatar_updated_at: now,
  };
}

export async function getUserAvatar(
  db: D1Database,
  r2: R2Bucket,
  targetAddress: string
): Promise<{ object: R2ObjectBody; mimeType: string } | null> {
  const normalized = targetAddress.toLowerCase().trim();
  const user = await db.prepare(
    'SELECT avatar_key, avatar_mime FROM users WHERE id = ? OR wallet_address = ?'
  ).bind(normalized, normalized).first<UserRow>();

  if (!user || !user.avatar_key) {
    return null;
  }

  const object = await r2.get(user.avatar_key);
  if (!object) {
    return null;
  }

  return {
    object,
    mimeType: user.avatar_mime || 'image/png',
  };
}
