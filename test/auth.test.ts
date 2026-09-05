import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createTestWallet } from './helpers/wallet';
import type { Env } from '../src/types';

describe('EVM Wallet Authentication & Session Management', () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    db = createMockD1Database(true);
    env = {
      DB: db,
      VOICE_BUCKET: {} as any,
    };
  });

  it('generates nonce challenge for valid EVM address', async () => {
    const wallet = createTestWallet();
    const res = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, env);

    expect(res.status).toBe(200);
    const data = (await res.json()) as { nonce: string; message: string; expires_at: number };
    expect(data.nonce).toBeDefined();
    expect(data.message).toContain(data.nonce);
    expect(data.expires_at).toBeGreaterThan(Date.now());
  });

  it('rejects invalid or missing EVM addresses on /auth/nonce', async () => {
    const res1 = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: 'invalid-address' }),
    }, env);
    expect(res1.status).toBe(400);

    const res2 = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env);
    expect(res2.status).toBe(400);
  });

  it('verifies signature and creates user + session', async () => {
    const wallet = createTestWallet();

    // 1. Get nonce
    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, env);
    const nonceData = (await nonceRes.json()) as { nonce: string; message: string };

    // 2. Sign message
    const signature = await wallet.signMessage(nonceData.message);

    // 3. Verify
    const verifyRes = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: wallet.address,
        signature,
      }),
    }, env);

    expect(verifyRes.status).toBe(200);
    const verifyData = (await verifyRes.json()) as {
      token: string;
      user: { id: string; wallet_address: string };
      session: { id: string; expires_at: number };
    };

    expect(verifyData.token).toBeDefined();
    expect(verifyData.user.wallet_address).toBe(wallet.address);
    expect(verifyData.session.expires_at).toBeGreaterThan(Date.now());

    // 4. Test GET /auth/me with bearer token
    const meRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${verifyData.token}` },
    }, env);

    expect(meRes.status).toBe(200);
    const meData = (await meRes.json()) as { user: { id: string; wallet_address: string } };
    expect(meData.user.id).toBe(verifyData.user.id);
    expect(meData.user.wallet_address).toBe(wallet.address);
  });

  it('rejects re-use of consumed nonce (single-use)', async () => {
    const wallet = createTestWallet();
    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, env);
    const nonceData = (await nonceRes.json()) as { nonce: string; message: string };
    const signature = await wallet.signMessage(nonceData.message);

    // First verify succeeds
    const res1 = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: wallet.address,
        signature,
      }),
    }, env);
    expect(res1.status).toBe(200);

    // Second verify with same signature must fail
    const res2 = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: wallet.address,
        signature,
      }),
    }, env);
    expect(res2.status).toBe(401);
  });

  it('rejects signature from a different wallet', async () => {
    const wallet1 = createTestWallet();
    const wallet2 = createTestWallet();

    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet1.address }),
    }, env);
    const nonceData = (await nonceRes.json()) as { nonce: string; message: string };

    // Wallet 2 signs the message intended for Wallet 1
    const signature = await wallet2.signMessage(nonceData.message);

    const res = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: wallet1.address,
        signature,
      }),
    }, env);

    expect(res.status).toBe(401);
  });

  it('rejects expired nonces', async () => {
    const wallet = createTestWallet();
    // Manually insert an expired nonce
    const expiredTime = Date.now() - 1000;
    await db.prepare(
      'INSERT INTO nonces (id, wallet_address, nonce, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('n_exp', wallet.address, 'expirednonce', expiredTime, expiredTime - 60000).run();

    const signature = await wallet.signMessage(
      `Sign this message to authenticate with Web3 Chat:\nNonce: expirednonce`
    );

    const res = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: wallet.address,
        signature,
        nonce: 'expirednonce',
      }),
    }, env);

    expect(res.status).toBe(401);
  });

  it('handles logout and invalidates session token', async () => {
    const wallet = createTestWallet();

    const nonceRes = await app.request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet.address }),
    }, env);
    const nonceData = (await nonceRes.json()) as { nonce: string; message: string };
    const signature = await wallet.signMessage(nonceData.message);

    const verifyRes = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: wallet.address,
        signature,
      }),
    }, env);
    const verifyData = (await verifyRes.json()) as { token: string };

    // Logout
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${verifyData.token}` },
    }, env);
    expect(logoutRes.status).toBe(200);

    // After logout, /auth/me returns 401
    const meRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${verifyData.token}` },
    }, env);
    expect(meRes.status).toBe(401);
  });
});
