import { describe, it, expect } from 'vitest';
import { app } from '../src/index';

describe('GET /health', () => {
  it('returns status ok with timestamp', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const data = (await res.json()) as { status: string; service: string; timestamp: number };
    expect(data.status).toBe('ok');
    expect(data.service).toBe('web3-chat-worker');
    expect(typeof data.timestamp).toBe('number');
  });
});
