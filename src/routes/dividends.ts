// Public read-only dividend indexer API (LHSwap reward pools).
// All data is aggregated from public chain events; no auth required.

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  getClaimsForAddress,
  getDividendOverview,
  getHolderPositions,
  getPairAprDetail,
  listDividendPairs,
} from '../services/dividends/stats';
import { runDividendIndexTick } from '../services/dividends/indexer';
import { dividendIndexerEnabled } from '../services/dividends/chain';

const dividendRoutes = new Hono<AppEnv>();

function parseChainId(c: { req: { query: (k: string) => string | undefined } }): number {
  const raw = c.req.query('chainId');
  const chainId = raw ? parseInt(raw, 10) : 56;
  return chainId === 97 ? 97 : 56;
}

dividendRoutes.get('/overview', async (c) => {
  try {
    if (!dividendIndexerEnabled(c.env)) return c.json({ error: 'dividend indexer disabled' }, 404);
    return c.json(await getDividendOverview(c.env, parseChainId(c)));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dividendRoutes.get('/pairs', async (c) => {
  try {
    if (!dividendIndexerEnabled(c.env)) return c.json({ error: 'dividend indexer disabled' }, 404);
    return c.json(await listDividendPairs(c.env, parseChainId(c)));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dividendRoutes.get('/pairs/:pair/apr', async (c) => {
  try {
    if (!dividendIndexerEnabled(c.env)) return c.json({ error: 'dividend indexer disabled' }, 404);
    const detail = await getPairAprDetail(c.env, parseChainId(c), c.req.param('pair'));
    if (!detail) return c.json({ error: 'pair not indexed' }, 404);
    return c.json(detail);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dividendRoutes.get('/claims/:address', async (c) => {
  try {
    if (!dividendIndexerEnabled(c.env)) return c.json({ error: 'dividend indexer disabled' }, 404);
    const limitRaw = c.req.query('limit');
    const beforeRaw = c.req.query('beforeBlock');
    return c.json(
      await getClaimsForAddress(c.env, parseChainId(c), c.req.param('address'), {
        pair: c.req.query('pair'),
        limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
        beforeBlock: beforeRaw ? parseInt(beforeRaw, 10) : undefined,
      })
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

dividendRoutes.get('/holders/:address', async (c) => {
  try {
    if (!dividendIndexerEnabled(c.env)) return c.json({ error: 'dividend indexer disabled' }, 404);
    return c.json(await getHolderPositions(c.env, parseChainId(c), c.req.param('address')));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Manual sync trigger (ops / testing); the cron schedule calls the same tick.
dividendRoutes.post('/sync', async (c) => {
  try {
    if (!dividendIndexerEnabled(c.env)) return c.json({ error: 'dividend indexer disabled' }, 404);
    return c.json(await runDividendIndexTick(c.env));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { dividendRoutes };
