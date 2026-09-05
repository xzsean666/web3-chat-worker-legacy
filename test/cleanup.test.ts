import { describe, it, expect, beforeEach } from 'vitest';
import worker, { app } from '../src/index';
import { createMockD1Database } from './helpers/db';
import { createMockR2Bucket, type MockR2Bucket } from './helpers/r2';
import { sweepExpiredMessages } from '../src/services/cleanup';
import type { Env } from '../src/types';

describe('Scheduled Expiration Cleanup & Cron Worker', () => {
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

    const now = Date.now();

    // 1. Seed user and conversation
    await db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u1', '0x1', now, now).run();
    await db.prepare('INSERT INTO conversations (id, type, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('c1', 'direct', now, now).run();
    await db.prepare('INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)').bind('cm1', 'c1', 'u1', 'owner', now).run();

    // 2. Insert EXPIRED text message
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at)
      VALUES (?, ?, ?, 'text', 'expired text', 'permanent', 'pending', ?, ?)
    `).bind('msg_expired_text', 'c1', 'u1', now - 10000, now - 20000).run();

    // 3. Insert EXPIRED voice message + R2 audio
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at)
      VALUES (?, ?, ?, 'voice', '[Voice]', 'permanent', 'pending', ?, ?)
    `).bind('msg_expired_voice', 'c1', 'u1', now - 10000, now - 20000).run();

    await db.prepare(`
      INSERT INTO voice_messages (id, message_id, object_key, duration, mime_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind('v_exp', 'msg_expired_voice', 'voice/exp.webm', 2.0, 'audio/webm', 128, now - 20000).run();

    await r2.put('voice/exp.webm', new Uint8Array(128));

    // 4. Insert ACTIVE (non-expired) text message
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at)
      VALUES (?, ?, ?, 'text', 'active text', 'permanent', 'pending', ?, ?)
    `).bind('msg_active_text', 'c1', 'u1', now + 60000, now).run();

    // 5. Insert ACTIVE (non-expired) voice message + R2 audio
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at)
      VALUES (?, ?, ?, 'voice', '[Voice]', 'permanent', 'pending', ?, ?)
    `).bind('msg_active_voice', 'c1', 'u1', now + 60000, now).run();

    await db.prepare(`
      INSERT INTO voice_messages (id, message_id, object_key, duration, mime_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind('v_active', 'msg_active_voice', 'voice/active.webm', 4.0, 'audio/webm', 256, now).run();

    await r2.put('voice/active.webm', new Uint8Array(256));
  });

  it('purges only expired messages and removes their voice audio from R2', async () => {
    // Check initial state
    expect(r2.hasKey('voice/exp.webm')).toBe(true);
    expect(r2.hasKey('voice/active.webm')).toBe(true);

    const result = await sweepExpiredMessages(db, r2 as unknown as R2Bucket);

    expect(result.purged_messages).toBe(2);
    expect(result.deleted_voice_objects).toBe(1);

    // Verify expired audio deleted, active audio kept
    expect(r2.hasKey('voice/exp.webm')).toBe(false);
    expect(r2.hasKey('voice/active.webm')).toBe(true);

    // Verify D1 records
    const expText = await db.prepare('SELECT * FROM messages WHERE id = ?').bind('msg_expired_text').first();
    expect(expText).toBeNull();

    const expVoice = await db.prepare('SELECT * FROM messages WHERE id = ?').bind('msg_expired_voice').first();
    expect(expVoice).toBeNull();

    const activeText = await db.prepare('SELECT * FROM messages WHERE id = ?').bind('msg_active_text').first();
    expect(activeText).not.toBeNull();

    const activeVoice = await db.prepare('SELECT * FROM messages WHERE id = ?').bind('msg_active_voice').first();
    expect(activeVoice).not.toBeNull();
  });

  it('triggers cleanup via POST /admin/cleanup endpoint', async () => {
    const res = await app.request('/admin/cleanup', {
      method: 'POST',
    }, env);

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.purged_messages).toBe(2);
    expect(data.deleted_voice_objects).toBe(1);
  });

  it('executes scheduled hook with execution context', async () => {
    let waitedPromise: Promise<any> | null = null;
    const ctx = {
      waitUntil: (promise: Promise<any>) => {
        waitedPromise = promise;
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const controller: ScheduledController = {
      scheduledTime: Date.now(),
      cron: '* * * * *',
      noRetry: () => {},
    };

    await worker.scheduled(controller, env, ctx);
    expect(waitedPromise).not.toBeNull();
    await waitedPromise;

    // Verify cleanup completed
    expect(r2.hasKey('voice/exp.webm')).toBe(false);
  });

  it('purges expired image and file messages and deletes their R2 objects', async () => {
    const now = Date.now();

    // Insert expired image message + R2 image
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at)
      VALUES (?, ?, ?, 'image', '[Image]', 'permanent', 'pending', ?, ?)
    `).bind('msg_exp_img', 'c1', 'u1', now - 5000, now - 15000).run();

    await db.prepare(`
      INSERT INTO image_messages (id, message_id, object_key, file_name, mime_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind('im_exp', 'msg_exp_img', 'images/exp.png', 'exp.png', 'image/png', 200, now - 15000).run();
    await r2.put('images/exp.png', new Uint8Array(200));

    // Insert active image message + R2 image
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at)
      VALUES (?, ?, ?, 'image', '[Image]', 'permanent', 'pending', ?, ?)
    `).bind('msg_act_img', 'c1', 'u1', now + 60000, now).run();

    await db.prepare(`
      INSERT INTO image_messages (id, message_id, object_key, file_name, mime_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind('im_act', 'msg_act_img', 'images/act.png', 'act.png', 'image/png', 300, now).run();
    await r2.put('images/act.png', new Uint8Array(300));

    // Insert expired file message + R2 file
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at)
      VALUES (?, ?, ?, 'file', '[File: old.pdf]', 'permanent', 'pending', ?, ?)
    `).bind('msg_exp_file', 'c1', 'u1', now - 5000, now - 15000).run();

    await db.prepare(`
      INSERT INTO file_messages (id, message_id, object_key, file_name, mime_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind('fm_exp', 'msg_exp_file', 'files/msg_exp_file/old.pdf', 'old.pdf', 'application/pdf', 500, now - 15000).run();
    await r2.put('files/msg_exp_file/old.pdf', new Uint8Array(500));

    // Insert active file message + R2 file
    await db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at)
      VALUES (?, ?, ?, 'file', '[File: new.pdf]', 'permanent', 'pending', ?, ?)
    `).bind('msg_act_file', 'c1', 'u1', now + 60000, now).run();

    await db.prepare(`
      INSERT INTO file_messages (id, message_id, object_key, file_name, mime_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind('fm_act', 'msg_act_file', 'files/msg_act_file/new.pdf', 'new.pdf', 'application/pdf', 600, now).run();
    await r2.put('files/msg_act_file/new.pdf', new Uint8Array(600));

    // Initial state
    expect(r2.hasKey('images/exp.png')).toBe(true);
    expect(r2.hasKey('images/act.png')).toBe(true);
    expect(r2.hasKey('files/msg_exp_file/old.pdf')).toBe(true);
    expect(r2.hasKey('files/msg_act_file/new.pdf')).toBe(true);

    const result = await sweepExpiredMessages(db, r2 as unknown as R2Bucket);

    expect(result.deleted_image_objects).toBe(1);
    expect(result.deleted_file_objects).toBe(1);
    expect(result.deleted_media_objects).toBeGreaterThanOrEqual(3); // voice + image + file

    // Expired deleted, active retained
    expect(r2.hasKey('images/exp.png')).toBe(false);
    expect(r2.hasKey('images/act.png')).toBe(true);
    expect(r2.hasKey('files/msg_exp_file/old.pdf')).toBe(false);
    expect(r2.hasKey('files/msg_act_file/new.pdf')).toBe(true);
  });
});
