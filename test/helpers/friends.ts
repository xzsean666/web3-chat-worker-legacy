import { app } from '../../src/index';
import type { Env } from '../../src/types';

export async function addFriend(env: Env, token: string, friendAddress: string): Promise<void> {
  const res = await app.request('/friends', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ friend_address: friendAddress }),
  }, env);

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`addFriend failed with status ${res.status}: ${await res.text()}`);
  }
}

// Direct chats require mutual friendship, so tests that exchange direct
// messages must friend both users with each other first.
export async function makeMutualFriends(
  env: Env,
  tokenA: string,
  addressA: string,
  tokenB: string,
  addressB: string
): Promise<void> {
  await addFriend(env, tokenA, addressB);
  await addFriend(env, tokenB, addressA);
}
