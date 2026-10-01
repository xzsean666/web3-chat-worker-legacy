import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { uploadFileMessage, getFile, getFileMetadata } from '../services/files';
import { base64ToUint8Array } from '../utils/base64';

const fileRoutes = new Hono<AppEnv>();

fileRoutes.use('*', authMiddleware);

fileRoutes.post('/upload', async (c) => {
  try {
    const user = c.get('user');
    const contentType = c.req.header('Content-Type') || '';

    let conversationId: string | undefined;
    let fileName: string | undefined;
    let caption: string | undefined;
    let retention: 'permanent' | 'on_read' = 'permanent';
    let expiresInSeconds: number | undefined;
    let burnAfterSeconds: number | undefined;
    let fileData: Uint8Array;
    let mimeType = 'application/octet-stream';

    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      conversationId = body['conversation_id'] as string;
      caption = (body['caption'] || body['content']) as string;
      retention = (body['retention'] as any) || 'permanent';

      if (body['expires_in_seconds']) {
        expiresInSeconds = parseInt(body['expires_in_seconds'] as string, 10);
      }
      if (body['burn_after_seconds']) {
        burnAfterSeconds = parseInt(body['burn_after_seconds'] as string, 10);
      }

      const file = body['file'];
      if (!file || typeof file === 'string') {
        return c.json({ error: 'File is required in form-data (key "file")' }, 400);
      }

      const fileObj = file as File;
      mimeType = fileObj.type || 'application/octet-stream';
      fileName = (body['file_name'] as string) || fileObj.name || 'unnamed_file';
      const arrayBuf = await fileObj.arrayBuffer();
      fileData = new Uint8Array(arrayBuf);
    } else {
      // Handle JSON with base64 payload
      const json = await c.req.json().catch(() => ({}));
      conversationId = json.conversation_id;
      fileName = json.file_name;
      caption = json.caption || json.content;
      retention = json.retention || 'permanent';
      expiresInSeconds = json.expires_in_seconds ? Number(json.expires_in_seconds) : undefined;
      burnAfterSeconds = json.burn_after_seconds !== undefined ? Number(json.burn_after_seconds) : undefined;
      mimeType = json.mime_type || 'application/octet-stream';

      if (!json.file_base64) {
        return c.json({ error: 'Missing file_base64 or file' }, 400);
      }

      if (!fileName || !fileName.trim()) {
        return c.json({ error: 'file_name is required' }, 400);
      }

      fileData = base64ToUint8Array(json.file_base64);
    }

    if (!conversationId) {
      return c.json({ error: 'conversation_id is required' }, 400);
    }

    if (!fileName) {
      fileName = 'unnamed_file';
    }

    const result = await uploadFileMessage(c.env.DB, c.env.VOICE_BUCKET, user.id, {
      conversation_id: conversationId,
      fileData,
      file_name: fileName,
      mime_type: mimeType,
      caption,
      retention,
      expires_in_seconds: expiresInSeconds,
      burn_after_seconds: burnAfterSeconds,
    });

    // 联动优化：若是群聊且配置了 GROUP_MASTER_DO，向 MasterDO 同步以触发在线 WebSocket 即时广播
    if (c.env.GROUP_MASTER_DO && !conversationId.startsWith('direct:')) {
      try {
        const masterId = c.env.GROUP_MASTER_DO.idFromName(conversationId);
        const stub = c.env.GROUP_MASTER_DO.get(masterId);
        const broadcastPromise = stub.fetch('http://internal/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: result.message.id,
            conversationId,
            senderId: user.id,
            type: 'file',
            content: result.message.content,
            metadata: {
              file_id: result.file.id,
              file_name: result.file.file_name,
              mime_type: result.file.mime_type,
              size: result.file.size,
            },
            createdAt: result.message.created_at,
            skipD1WriteBack: true,
            asyncBroadcast: true,
          }),
        }).catch((e) => console.error('[HTTP->DO File Broadcast failed]:', e));
        let executionCtx: any;
        try {
          executionCtx = c.executionCtx;
        } catch {}
        if (executionCtx) {
          executionCtx.waitUntil(broadcastPromise);
        } else {
          await broadcastPromise;
        }
      } catch {
        // ignore
      }
    }

    return c.json(result, 201);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') || err.message.includes('muted') ? 403 : 400;
    return c.json({ error: err.message }, status);
  }
});

fileRoutes.get('/:messageId/meta', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('messageId');

    const metadata = await getFileMetadata(c.env.DB, user.id, messageId);
    return c.json(metadata);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 404;
    return c.json({ error: err.message }, status);
  }
});

fileRoutes.get('/:messageId', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('messageId');

    const { object, metadata } = await getFile(
      c.env.DB,
      c.env.VOICE_BUCKET,
      user.id,
      messageId
    );

    const safeName = encodeURIComponent(metadata.file_name);

    return new Response(object.body as any, {
      status: 200,
      headers: {
        'Content-Type': metadata.mime_type,
        'Content-Length': metadata.size.toString(),
        'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${safeName}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 404;
    return c.json({ error: err.message }, status);
  }
});

export { fileRoutes };
