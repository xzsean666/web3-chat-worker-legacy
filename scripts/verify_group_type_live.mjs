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
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const health = await fetch(`${BASE}/health`);
console.log('health:', health.status, JSON.stringify(await health.json()));

const alice = await login();
const bob = await login();
console.log('logged in:', alice.address, bob.address);

const ts = Date.now().toString(36);
const g1 = await api(alice.token, 'POST', '/groups', { name: `Slug Test A ${ts}` });
console.log('create group A:', g1.status, 'group_type =', g1.data.group_type, 'content_protected =', g1.data.content_protected);
const g2 = await api(alice.token, 'POST', '/groups', { name: `Slug Test B ${ts}` });

const slug = `live-${ts}`;
const inv1 = await api(alice.token, 'POST', `/groups/${encodeURIComponent(g1.data.id)}/invite-links`, { slug });
console.log('invite with slug:', inv1.status, JSON.stringify(inv1.data));

const conflict = await api(alice.token, 'POST', `/groups/${encodeURIComponent(g2.data.id)}/invite-links`, { slug });
console.log('slug conflict on group B:', conflict.status, JSON.stringify(conflict.data));

const invalid = await api(alice.token, 'POST', `/groups/${encodeURIComponent(g1.data.id)}/invite-links`, { slug: 'Bad Slug!' });
console.log('invalid slug:', invalid.status, JSON.stringify(invalid.data));

const idem = await api(alice.token, 'POST', `/groups/${encodeURIComponent(g1.data.id)}/invite-links`, { slug });
console.log('idempotent same-group slug:', idem.status, 'same token:', idem.data.token === inv1.data.token);

// join-by-token via slug (private group without approval → joined directly)
const join = await api(bob.token, 'POST', '/groups/join-by-token', { token: slug });
console.log('join-by-slug:', join.status, 'status =', join.data.status, 'conv =', join.data.conversation?.id === g1.data.id);

// group type update + public join bypassing join_admin_only
const patch = await api(alice.token, 'PATCH', `/groups/${encodeURIComponent(g2.data.id)}`, {
  group_type: 'public', content_protected: true, metadata: { join_admin_only: true, description: 'live verify public group' },
});
console.log('patch group B:', patch.status, 'group_type =', patch.data.group_type, 'content_protected =', patch.data.content_protected);

const inv2 = await api(alice.token, 'POST', `/groups/${encodeURIComponent(g2.data.id)}/invite-links`, { slug: `open-${ts}` });
const carol = await login();
const joinPublic = await api(carol.token, 'POST', '/groups/join-by-token', { token: `open-${ts}` });
console.log('public join (join_admin_only set):', joinPublic.status, 'status =', joinPublic.data.status);

const search = await api(bob.token, 'GET', `/groups/public?keyword=Slug%20Test`);
console.log('public search:', search.status, 'hits =', search.data.groups.map((g) => g.name).join(', '));

const searchPrivateHidden = await api(bob.token, 'GET', `/groups/public?keyword=${encodeURIComponent('Slug Test A')}`);
console.log('private group hidden from search:', searchPrivateHidden.data.groups.length === 0);
