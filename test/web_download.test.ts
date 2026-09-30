import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import type { Env } from '../src/types';

describe('App Download Route (/app/*)', () => {
  let db: D1Database;
  let r2: MockR2Bucket;
  let env: Env;

  beforeEach(async () => {
    db = createMockD1Database(true);
    r2 = createMockR2Bucket() as unknown as MockR2Bucket;
    env = {
      DB: db,
      VOICE_BUCKET: r2 as unknown as R2Bucket,
    };
    const apk = new Uint8Array(5000).map((_, i) => i % 256);
    await r2.put('app/lh-latest-arm64.apk', apk, {
      httpMetadata: { contentType: 'application/vnd.android.package-archive' },
    });
    await r2.put(
      'app/version.json',
      JSON.stringify({ version: '1.1.6', build: '16', size: 5000 }),
      { httpMetadata: { contentType: 'application/json' } }
    );
  });

  it('serves download page HTML without auth', async () => {
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('/app/lh-latest.apk');
  });

  it('serves version.json from R2', async () => {
    const res = await app.request('/app/version.json', {}, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.version).toBe('1.1.6');
  });

  it('full APK download returns 200 with Accept-Ranges and Content-Length', async () => {
    const res = await app.request('/app/lh-latest.apk', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe('5000');
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.android.package-archive'
    );
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(5000);
  });

  it('honors Range bytes=start-end with 206 partial content', async () => {
    const res = await app.request(
      '/app/lh-latest.apk',
      { headers: { Range: 'bytes=0-1023' } },
      env
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1023/5000');
    expect(res.headers.get('Content-Length')).toBe('1024');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(1024);
    expect(buf[0]).toBe(0);
    expect(buf[1023]).toBe(1023 % 256);
  });

  it('honors suffix Range bytes=-N (last N bytes)', async () => {
    const res = await app.request(
      '/app/lh-latest.apk',
      { headers: { Range: 'bytes=-100' } },
      env
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 4900-4999/5000');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(100);
    expect(buf[0]).toBe(4900 % 256);
  });

  it('returns 416 for out-of-bounds Range', async () => {
    const res = await app.request(
      '/app/lh-latest.apk',
      { headers: { Range: 'bytes=99999-100000' } },
      env
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */5000');
  });

  it('returns 404 when APK object missing', async () => {
    await r2.delete('app/lh-latest-arm64.apk');
    const res = await app.request('/app/lh-latest.apk', {}, env);
    expect(res.status).toBe(404);
  });
});
