import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { uploadVoiceMessage, getVoiceAudio } from '../services/voice';

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
      mimeType = json.mime_type || 'audio/webm';

      if (!json.audio_base64) {
        return c.json({ error: 'Missing audio_base64 or file' }, 400);
      }

      const binaryStr = atob(json.audio_base64);
      const len = binaryStr.length;
      audioData = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        audioData[i] = binaryStr.charCodeAt(i);
      }
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
    });

    return c.json(result, 201);
  } catch (err: any) {
    const status = err.message.includes('Unauthorized') ? 403 : 400;
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
