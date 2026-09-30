import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { createReport, listMyReports, uploadReportEvidence, type CreateReportInput } from '../services/reports';

const reportRoutes = new Hono<AppEnv>();
reportRoutes.use('*', authMiddleware);

reportRoutes.post('/evidence', async (c) => {
  try {
    if (!(c.req.header('Content-Type') || '').includes('multipart/form-data')) {
      return c.json({ error: 'multipart/form-data is required for report evidence' }, 400);
    }
    const body = await c.req.parseBody();
    const value = body.file || body.image || body.evidence;
    if (!value || typeof value === 'string') {
      return c.json({ error: 'Evidence image file is required (key "file", "image", or "evidence")' }, 400);
    }
    const evidence = await uploadReportEvidence(c.env.DB, c.env.VOICE_BUCKET, c.get('user').id, value as File);
    return c.json({ object_key: evidence.object_key, mime_type: evidence.mime_type, size: evidence.size, created_at: evidence.created_at }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

reportRoutes.post('/', async (c) => {
  try {
    const body = (await c.req.json<CreateReportInput>().catch(() => ({}))) as CreateReportInput;
    const report = await createReport(c.env.DB, c.get('user'), body);
    return c.json({ report }, 201);
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : err.message.includes('unavailable') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

reportRoutes.get('/', async (c) => {
  try {
    const reports = await listMyReports(c.env.DB, c.get('user').id, Number(c.req.query('limit')));
    return c.json({ reports });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { reportRoutes };
