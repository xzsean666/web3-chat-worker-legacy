// Club（社群）专用服务：收藏（club_favorites）、持仓/付费入群门禁解析与校验。
// 持仓门槛通过 viem 读链上余额（native getBalance / ERC20 balanceOf），
// RPC 取 active payment config 的 chains[]（与支付验款同一配置源）。

import { createPublicClient, http, erc20Abi } from 'viem';
import { getActiveConfig } from './payments/config';

// ---------------------------------------------------------------------------
// metadata 门禁字段解析
// ---------------------------------------------------------------------------

export interface ClubJoinGate {
  chain_id: number;
  /** null = 链原生币 */
  token_address: string | null;
  /** 最小持有量（最小单位十进制整数字符串） */
  min_amount: string;
}

export interface ClubJoinPrice {
  /** 进群价（最小单位十进制整数字符串），支付链/代币取 active payment config 默认链 */
  amount: string;
  token?: string;
}

const NON_NEG_INT_RE = /^(0|[1-9]\d*)$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** metadata.join_gate 解析；结构不完整/非法视为无门槛（null）。 */
export function parseJoinGate(metadata: Record<string, any>): ClubJoinGate | null {
  const gate = metadata?.join_gate;
  if (!gate || typeof gate !== 'object') return null;
  const chainId = Number(gate.chain_id);
  const tokenAddress = gate.token_address;
  const minAmount = gate.min_amount;
  if (!Number.isInteger(chainId) || chainId <= 0) return null;
  if (tokenAddress !== null && tokenAddress !== undefined && (typeof tokenAddress !== 'string' || !EVM_ADDRESS_RE.test(tokenAddress))) return null;
  if (typeof minAmount !== 'string' || !NON_NEG_INT_RE.test(minAmount)) return null;
  return { chain_id: chainId, token_address: tokenAddress ?? null, min_amount: minAmount };
}

/** metadata.join_price 解析；amount 非法视为无付费门槛（null）。 */
export function parseJoinPrice(metadata: Record<string, any>): ClubJoinPrice | null {
  const price = metadata?.join_price;
  if (!price || typeof price !== 'object') return null;
  const amount = price.amount;
  if (typeof amount !== 'string' || !NON_NEG_INT_RE.test(amount)) return null;
  const token = typeof price.token === 'string' && price.token.trim() ? price.token.trim() : undefined;
  return { amount, token };
}

// ---------------------------------------------------------------------------
// 持仓门槛校验（链上余额）
// ---------------------------------------------------------------------------

/** 持仓不足：路由层映射 403 {error:'HOLDINGS_GATE_FAILED', required, current}。 */
export class HoldingsGateError extends Error {
  readonly required: string;
  readonly current: string;
  constructor(required: string, current: string) {
    super('HOLDINGS_GATE_FAILED');
    this.name = 'HoldingsGateError';
    this.required = required;
    this.current = current;
  }
}

/** 门禁链未在 payment config 中配置 / RPC 不可用：路由层映射 500 配置错误。 */
export class JoinGateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoinGateConfigError';
  }
}

type BalanceReader = (args: {
  chainId: number;
  tokenAddress: string | null;
  wallet: string;
  rpcUrls: string[];
}) => Promise<bigint>;

// 默认实现：viem 逐 rpcUrl 轮换，首个成功为止（同 dividends/verifier 的轮换模式）。
async function viemBalanceReader(args: {
  chainId: number;
  tokenAddress: string | null;
  wallet: string;
  rpcUrls: string[];
}): Promise<bigint> {
  let lastError: unknown = null;
  for (const url of args.rpcUrls) {
    try {
      const client = createPublicClient({ transport: http(url) });
      if (args.tokenAddress) {
        return await client.readContract({
          address: args.tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [args.wallet as `0x${string}`],
        });
      }
      return await client.getBalance({ address: args.wallet as `0x${string}` });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

let balanceReader: BalanceReader = viemBalanceReader;

/** 测试注入缝：替换链上余额读取实现；传 null 恢复默认 viem 实现。 */
export function setJoinGateBalanceReaderForTests(reader: BalanceReader | null): void {
  balanceReader = reader ?? viemBalanceReader;
}

/**
 * 持仓门槛判定：余额 < min_amount 抛 HoldingsGateError；
 * chain_id 未配置 → JoinGateConfigError（500）；RPC 全挂 → JoinGateConfigError。
 */
export async function assertHoldingsGate(db: D1Database, gate: ClubJoinGate, wallet: string): Promise<void> {
  const active = await getActiveConfig(db);
  const chain = active?.payload.chains?.find((c) => c.chainId === gate.chain_id);
  if (!chain || !chain.rpcUrls?.length) {
    throw new JoinGateConfigError(`join_gate chain ${gate.chain_id} is not configured in payment config`);
  }
  let balance: bigint;
  try {
    balance = await balanceReader({
      chainId: gate.chain_id,
      tokenAddress: gate.token_address,
      wallet,
      rpcUrls: chain.rpcUrls,
    });
  } catch (err: any) {
    throw new JoinGateConfigError(`join_gate balance check failed: ${err?.message ?? String(err)}`);
  }
  if (balance < BigInt(gate.min_amount)) {
    throw new HoldingsGateError(gate.min_amount, balance.toString());
  }
}

// ---------------------------------------------------------------------------
// 收藏（club_favorites）
// ---------------------------------------------------------------------------

async function countFavorites(db: D1Database, clubId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM club_favorites WHERE club_id = ?')
    .bind(clubId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function getClubRow(db: D1Database, clubId: string): Promise<{ id: string } | null> {
  return db
    .prepare("SELECT id FROM conversations WHERE id = ? AND type = 'club'")
    .bind(clubId)
    .first<{ id: string }>();
}

/** 幂等收藏；club 不存在返回 null（路由 404）。 */
export async function favoriteClub(db: D1Database, userId: string, clubId: string): Promise<{ favorite_count: number } | null> {
  if (!(await getClubRow(db, clubId))) return null;
  await db
    .prepare('INSERT OR IGNORE INTO club_favorites (id, user_id, club_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), userId, clubId, Date.now())
    .run();
  return { favorite_count: await countFavorites(db, clubId) };
}

/** 幂等取消收藏；club 不存在返回 null（路由 404）。 */
export async function unfavoriteClub(db: D1Database, userId: string, clubId: string): Promise<{ favorite_count: number } | null> {
  if (!(await getClubRow(db, clubId))) return null;
  await db.prepare('DELETE FROM club_favorites WHERE user_id = ? AND club_id = ?').bind(userId, clubId).run();
  return { favorite_count: await countFavorites(db, clubId) };
}

// ---------------------------------------------------------------------------
// 社群主页（GET /clubs/:id，auth，非成员可见）
// ---------------------------------------------------------------------------

export interface ClubProfileMember {
  wallet_address: string;
  avatar_url: string | null;
  nickname: string | null;
}

export interface ClubProfile {
  id: string;
  name: string | null;
  description: string | null;
  avatar_url: string | null;
  avatar_updated_at: number | null;
  verified: boolean;
  hot: boolean;
  tags: string[];
  member_count: number;
  favorite_count: number;
  is_favorited: boolean;
  members: ClubProfileMember[];
  joinable: boolean;
  join_requires_approval: boolean;
  join_price: ClubJoinPrice | null;
  join_gate: ClubJoinGate | null;
  my_role: 'owner' | 'admin' | 'member' | null;
  tencent_meeting_url: string | null;
  tencent_meeting_start_at: number | null;
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

/** 用户在 club 中的角色（非成员 null）。 */
export async function getClubMemberRole(
  db: D1Database,
  clubId: string,
  userId: string
): Promise<'owner' | 'admin' | 'member' | null> {
  const row = await db
    .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(clubId, userId)
    .first<{ role: 'owner' | 'admin' | 'member' }>();
  return row?.role ?? null;
}

/** 社群主页资料；club 不存在返回 null（路由 404 CLUB_NOT_FOUND）。 */
export async function getClubProfile(db: D1Database, userId: string, clubId: string): Promise<ClubProfile | null> {
  const conv = await db
    .prepare("SELECT * FROM conversations WHERE id = ? AND type = 'club'")
    .bind(clubId)
    .first<{
      id: string;
      name: string | null;
      metadata: string;
      avatar_key: string | null;
      avatar_updated_at: number | null;
    }>();
  if (!conv) return null;
  const metadata = parseJsonSafe(conv.metadata);

  const memberCount =
    (await db.prepare('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?').bind(clubId).first<{ n: number }>())?.n ?? 0;
  const favoriteCount = await countFavorites(db, clubId);
  const isFavorited = await db
    .prepare('SELECT 1 AS x FROM club_favorites WHERE club_id = ? AND user_id = ?')
    .bind(clubId, userId)
    .first<{ x: number }>();
  const myRole = await getClubMemberRole(db, clubId, userId);
  const membersRes = await db
    .prepare(
      `SELECT u.wallet_address, u.public_metadata, u.avatar_key
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ?
       ORDER BY cm.joined_at ASC, cm.id ASC
       LIMIT 9`
    )
    .bind(clubId)
    .all<{ wallet_address: string; public_metadata: string | null; avatar_key: string | null }>();

  const members: ClubProfileMember[] = membersRes.results.map((row) => {
    const publicMetadata = parseJsonSafe(row.public_metadata);
    return {
      wallet_address: row.wallet_address,
      avatar_url: row.avatar_key ? `/users/${encodeURIComponent(row.wallet_address)}/avatar` : null,
      nickname: typeof publicMetadata.nickname === 'string' ? publicMetadata.nickname : null,
    };
  });

  return {
    id: conv.id,
    name: conv.name,
    description: typeof metadata.description === 'string' ? metadata.description : null,
    avatar_url: conv.avatar_key
      ? `/groups/${encodeURIComponent(conv.id)}/avatar`
      : typeof metadata.avatar_url === 'string'
        ? metadata.avatar_url
        : null,
    avatar_updated_at: conv.avatar_updated_at ?? null,
    verified: metadata.verified === true,
    hot: metadata.hot === true,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((t: unknown) => typeof t === 'string') : [],
    member_count: Number(memberCount),
    favorite_count: favoriteCount,
    is_favorited: Boolean(isFavorited),
    members,
    joinable: metadata.joinable !== false,
    join_requires_approval: metadata.join_requires_approval === true,
    join_price: parseJoinPrice(metadata),
    join_gate: parseJoinGate(metadata),
    my_role: myRole,
    tencent_meeting_url: typeof metadata.tencent_meeting_url === 'string' ? metadata.tencent_meeting_url : null,
    // 开播时间（epoch ms）：群主办播门禁——未到时间客户端置灰「暂未开播」。
    tencent_meeting_start_at: typeof metadata.tencent_meeting_start_at === 'number' ? metadata.tencent_meeting_start_at : null,
  };
}
