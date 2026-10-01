import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { uploadVoiceMessage, getVoiceAudio, getVoiceMetadata } from '../services/voice';
import { base64ToUint8Array } from '../utils/base64';

const voiceRoutes = new Hono<AppEnv>();

voiceRoutes.use('*', authMiddleware);

voiceRoutes.post('/upload', async (c) => {
  try {
    const user = c.get('user');
    const contentType = c.req.header('Content-Type') || '';

    let conversationId: string | undefined;
    let duration = 0;
    let retention: 'permanent' | 'on_read' = 'permanent';
    let expiresInSeconds: number | undefined;
    let burnAfterSeconds: number | undefined;
    let audioData: Uint8Array;
    let mimeType = 'audio/webm';

    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      conversationId = body['conversation_id'] as string;
      duration = parseFloat((body['duration'] as string) || '0');
      retention = (body['retention'] as any) || 'permanent';
      if (body['expires_in_seconds']) {
        expiresInSeconds = parseInt(body['expires_in_seconds'] as string, 10);
      }
      if (body['burn_after_seconds']) {
        burnAfterSeconds = parseInt(body['burn_after_seconds'] as string, 10);
      }

      const file = body['file'] || body['audio'];
      if (!file || typeof file === 'string') {
        return c.json({ error: 'Audio file is required in form-data (key "file" or "audio")' }, 400);
      }

      const fileObj = file as File;
      mimeType = fileObj.type || 'audio/webm';
      const arrayBuf = await fileObj.arrayBuffer();
      audioData = new Uint8Array(arrayBuf);
    } else {
      // Handle JSON with base64 payload
      const json = await c.req.json().catch(() => ({}));
      conversationId = json.conversation_id;
      duration = Number(json.duration) || 0;
      retention = json.retention || 'permanent';
      expiresInSeconds = json.expires_in_seconds ? Number(json.expires_in_seconds) : undefined;
      burnAfterSeconds = json.burn_after_seconds !== undefined ? Number(json.burn_after_seconds) : undefined;
      mimeType = json.mime_type || 'audio/webm';

      if (!json.audio_base64) {
        return c.json({ error: 'Missing audio_base64 or file' }, 400);
      }

      audioData = base64ToUint8Array(json.audio_base64);
    }

    if (!conversationId) {
      return c.json({ error: 'conversation_id is required' }, 400);
    }

    const result = await uploadVoiceMessage(c.env.DB, c.env.VOICE_BUCKET, user.id, {
      conversation_id: conversationId,
      audioData,
      mime_type: mimeType,
      duration,
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
            type: 'voice',
            content: `[Voice: ${duration}s]`,
            metadata: {
              voice_id: result.voice.id,
              duration,
              mime_type: result.voice.mime_type,
              size: result.voice.size,
            },
            createdAt: result.message.created_at,
            skipD1WriteBack: true,
            asyncBroadcast: true,
          }),
        }).catch((e) => console.error('[HTTP->DO Voice Broadcast failed]:', e));
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

voiceRoutes.get('/:messageId/meta', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('messageId');

    const metadata = await getVoiceMetadata(c.env.DB, user.id, messageId);
    return c.json(metadata);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 404;
    return c.json({ error: err.message }, status);
  }
});

voiceRoutes.get('/:messageId', async (c) => {
  try {
    const user = c.get('user');
    const messageId = c.req.param('messageId');

    const { object, metadata } = await getVoiceAudio(
      c.env.DB,
      c.env.VOICE_BUCKET,
      user.id,
      messageId
    );

    return new Response(object.body as any, {
      status: 200,
      headers: {
        'Content-Type': metadata.mime_type,
        'Content-Length': metadata.size.toString(),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 404;
    return c.json({ error: err.message }, status);
  }
});

export { voiceRoutes };
