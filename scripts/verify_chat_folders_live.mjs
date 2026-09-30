import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = 'https://api.chatnice.top';

async function login() {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonceRes = await fetch(`${BASE}/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: account.address }),
  });
  const nonce = await nonceRes.json();
  const signature = await account.signMessage({ message: nonce.message });
  const verifyRes = await fetch(`${BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: account.address, signature }),
  });
  const body = await verifyRes.json();
  return { token: body.token, address: account.address };
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
}

const health = await fetch(`${BASE}/health`);
console.log('health:', health.status, JSON.stringify(await health.json()));

const alice = await login();
const bob = await login();
console.log('logged in:', alice.address, bob.address);

const unauth = await api(null, 'GET', '/chat-folders');
check('GET without token → 401', unauth.status === 401);

const empty = await api(alice.token, 'GET', '/chat-folders');
check('fresh user GET → empty list', empty.status === 200 && empty.data.folders.length === 0);

const ts = Date.now();
const folders = [
  { id: `${ts}000-0`, name: '工程', type: 'all', hidden: false, sort_order: 0, member_based: true, member_conversation_ids: ['c1', 'g1'] },
  { id: `${ts}001-1`, name: '私信', type: 'direct', hidden: true, sort_order: 1, member_based: false, member_conversation_ids: [] },
];
const saved = await api(alice.token, 'PUT', '/chat-folders', { folders });
check('PUT snapshot → 200 ordered by sort_order',
  saved.status === 200 && saved.data.folders.map((f) => f.name).join(',') === '工程,私信');
check('folder fields round-trip',
  saved.data.folders[0].member_based === true &&
  JSON.stringify(saved.data.folders[0].member_conversation_ids) === '["c1","g1"]' &&
  saved.data.folders[1].hidden === true);

const listed = await api(alice.token, 'GET', '/chat-folders');
check('GET after PUT returns same list', listed.data.folders.length === 2);

const replaced = await api(alice.token, 'PUT', '/chat-folders', [
  { ...folders[1], name: '私信改', hidden: false, sort_order: 0 },
]);
check('PUT replace drops missing ids', replaced.status === 200 && replaced.data.folders.length === 1 && replaced.data.folders[0].name === '私信改');
check('surviving id keeps created_at', replaced.data.folders[0].created_at === saved.data.folders[1].created_at);

const cleared = await api(alice.token, 'PUT', '/chat-folders', []);
check('PUT [] deletes all', cleared.status === 200 && cleared.data.folders.length === 0);

await api(alice.token, 'PUT', '/chat-folders', folders);
const sameIdForBob = await api(bob.token, 'PUT', '/chat-folders', [folders[0]]);
check('same client id usable by another user (per-user PK)', sameIdForBob.status === 200 && sameIdForBob.data.folders.length === 1);
const aliceStill = await api(alice.token, 'GET', '/chat-folders');
check('user isolation intact', aliceStill.data.folders.length === 2);

const bad = await api(alice.token, 'PUT', '/chat-folders', [{ id: '', name: 'x', type: 'all' }]);
check('invalid payload → 400', bad.status === 400);
