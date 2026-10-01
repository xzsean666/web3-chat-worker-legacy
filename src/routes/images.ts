import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { uploadImageMessage, getImage, getImageMetadata } from '../services/images';
import { base64ToUint8Array } from '../utils/base64';

const imageRoutes = new Hono<AppEnv>();

imageRoutes.use('*', authMiddleware);

imageRoutes.post('/upload', async (c) => {
  try {
    const user = c.get('user');
    const contentType = c.req.header('Content-Type') || '';

    let conversationId: string | undefined;
    let fileName: string | undefined;
    let caption: string | undefined;
    let width: number | undefined;
    let height: number | undefined;
    let retention: 'permanent' | 'on_read' = 'permanent';
    let expiresInSeconds: number | undefined;
    let burnAfterSeconds: number | undefined;
    let imageData: Uint8Array;
    let mimeType = 'image/png';

    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      conversationId = body['conversation_id'] as string;
      caption = (body['caption'] || body['content']) as string;
      retention = (body['retention'] as any) || 'permanent';

      if (body['width']) {
        width = parseInt(body['width'] as string, 10);
      }
      if (body['height']) {
        height = parseInt(body['height'] as string, 10);
      }
      if (body['expires_in_seconds']) {
        expiresInSeconds = parseInt(body['expires_in_seconds'] as string, 10);
      }
      if (body['burn_after_seconds']) {
        burnAfterSeconds = parseInt(body['burn_after_seconds'] as string, 10);
      }

      const file = body['file'] || body['image'];
      if (!file || typeof file === 'string') {
        return c.json({ error: 'Image file is required in form-data (key "file" or "image")' }, 400);
      }

      const fileObj = file as File;
      mimeType = fileObj.type || 'image/png';
      fileName = fileObj.name || undefined;
      const arrayBuf = await fileObj.arrayBuffer();
      imageData = new Uint8Array(arrayBuf);
    } else {
      // Handle JSON with base64 payload
      const json = await c.req.json().catch(() => ({}));
      conversationId = json.conversation_id;
      fileName = json.file_name;
      caption = json.caption || json.content;
      width = json.width !== undefined ? Number(json.width) : undefined;
      height = json.height !== undefined ? Number(json.height) : undefined;
      retention = json.retention || 'permanent';
      expiresInSeconds = json.expires_in_seconds ? Number(json.expires_in_seconds) : undefined;
      burnAfterSeconds = json.burn_after_seconds !== undefined ? Number(json.burn_after_seconds) : undefined;
      mimeType = json.mime_type || 'image/png';

      if (!json.image_base64) {
        return c.json({ error: 'Missing image_base64 or file' }, 400);
      }

      imageData = base64ToUint8Array(json.image_base64);
    }

    if (!conversationId) {
      return c.json({ error: 'conversation_id is required' }, 400);
    }

    const result = await uploadImageMessage(c.env.DB, c.env.VOICE_BUCKET, user.id, {
      conversation_id: conversationId,
      imageData,
      mime_type: mimeType,
      file_name: fileName,
      caption,
      width,
      height,
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
            type: 'image',
            content: result.message.content,
            metadata: {
              image_id: result.image.id,
              file_name: result.image.file_name,
              mime_type: result.image.mime_type,
              size: result.image.size,
              width: result.image.width,
              height: result.image.height,
            },
            createdAt: result.message.created_at,
            skipD1WriteBack: true,
            asyncBroadcast: true,
          }),
        }).catch((e) => console.error('[HTTP->DO Image Broadcast failed]:', e));
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

imageRoutes.get('/:messageId/meta', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('messageId');

    const metadata = await getImageMetadata(c.env.DB, user.id, messageId);
    return c.json(metadata);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 404;
    return c.json({ error: err.message }, status);
  }
});

imageRoutes.get('/:messageId', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('messageId');

    const { object, metadata } = await getImage(
      c.env.DB,
      c.env.VOICE_BUCKET,
      user.id,
      messageId
    );

    const safeName = metadata.file_name ? encodeURIComponent(metadata.file_name) : `${messageId}`;

    const headers: Record<string, string> = {
      'Content-Type': metadata.mime_type,
      'Content-Length': metadata.size.toString(),
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };

    if (metadata.mime_type.includes('svg')) {
      headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    }

    if (object.httpEtag) {
      headers['ETag'] = object.httpEtag;
    }

    return new Response(object.body as any, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 404;
    return c.json({ error: err.message }, status);
  }
});

export { imageRoutes };
