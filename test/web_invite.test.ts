import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import type { Env } from '../src/types';

// 邀请落地页：/g/<token|slug>（群）与 /u/<address>（加好友）。
// 页面必须同时含拉起 App 的 chaintalk:// scheme 与下载引导链接，
// 且对路径参数做严格白名单校验（防注入）。
describe('Invite Landing Routes (/g/*, /u/*)', () => {
  let env: Env;

  beforeEach(() => {
    env = {
      DB: createMockD1Database(true),
      VOICE_BUCKET: createMockR2Bucket() as unknown as R2Bucket,
    };
  });

  it('GET /g/:token serves landing page without auth', async () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const res = await app.request(`/g/${token}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain(`chaintalk://group-invite/${token}`);
    expect(text).toContain('/app/lh-latest.apk');
  });

  it('GET /g/:token accepts slug-style tokens', async () => {
    const res = await app.request('/g/my_team-01', {}, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('chaintalk://group-invite/my_team-01');
  });

  it('GET /g/:token rejects invalid token with 400', async () => {
    const res = await app.request('/g/%3Cscript%3E', {}, env);
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toBe('INVALID_INVITE_TOKEN');
  });

  it('GET /u/:address serves landing page without auth', async () => {
    const address = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const res = await app.request(`/u/${address}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const text = await res.text();
    // scheme 统一小写地址。
    expect(text).toContain(
      `chaintalk://add-friend/${address.toLowerCase()}`
    );
    expect(text).toContain('/app/lh-latest.apk');
  });

  it('GET /u/:address rejects malformed address with 400', async () => {
    for (const bad of ['0x123', 'notanaddress', '0x' + 'g'.repeat(40)]) {
      const res = await app.request(`/u/${bad}`, {}, env);
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toBe('INVALID_ADDRESS');
    }
  });
});
