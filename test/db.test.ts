import { describe, it, expect, beforeEach } from 'vitest';
import { createMockD1Database } from './helpers/db';

describe('D1 Database Schema & Migrations', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockD1Database(true);
  });

  it('verifies all expected tables exist after migration', async () => {
    const res = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC"
    ).all<{ name: string }>();

    const tableNames = res.results.map((r) => r.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('nonces');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('conversations');
    expect(tableNames).toContain('conversation_members');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('message_receipts');
    expect(tableNames).toContain('voice_messages');
  });

  it('enforces unique wallet_address on users', async () => {
    const now = Date.now();
    await db.prepare(
      'INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).bind('u1', '0x1234567890abcdef', now, now).run();

    await expect(
      db.prepare(
        'INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).bind('u2', '0x1234567890abcdef', now, now).run()
    ).rejects.toThrow();
  });

  it('enforces foreign key constraints and cascade deletes on user deletion', async () => {
    const now = Date.now();
    // 1. Insert user
    await db.prepare(
      'INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).bind('u_alice', '0xalice', now, now).run();

    // 2. Insert session for user
    await db.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('s_1', 'u_alice', 'hash_abc', now + 10000, now).run();

    // 3. Insert conversation and member
    await db.prepare(
      'INSERT INTO conversations (id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('c_1', 'direct', null, now, now).run();

    await db.prepare(
      'INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('cm_1', 'c_1', 'u_alice', 'owner', now).run();

    // 4. Insert message
    await db.prepare(
      'INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind('m_1', 'c_1', 'u_alice', 'text', 'Hello World', 'permanent', 'pending', now + 86400000, now).run();

    // Verify records exist
    const session = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind('s_1').first();
    expect(session).not.toBeNull();

    // Delete user
    await db.prepare('DELETE FROM users WHERE id = ?').bind('u_alice').run();

    // Verify session, member, and message were cascade deleted
    const sessionAfter = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind('s_1').first();
    expect(sessionAfter).toBeNull();

    const memberAfter = await db.prepare('SELECT * FROM conversation_members WHERE id = ?').bind('cm_1').first();
    expect(memberAfter).toBeNull();

    const messageAfter = await db.prepare('SELECT * FROM messages WHERE id = ?').bind('m_1').first();
    expect(messageAfter).toBeNull();
  });

  it('enforces cascade deletion of voice_messages and receipts when message is deleted', async () => {
    const now = Date.now();
    await db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('u1', '0x1', now, now).run();
    await db.prepare('INSERT INTO conversations (id, type, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('c1', 'direct', now, now).run();
    await db.prepare(
      'INSERT INTO messages (id, conversation_id, sender_id, type, content, retention, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind('m1', 'c1', 'u1', 'voice', null, 'on_read', 'pending', now + 60000, now).run();

    await db.prepare(
      'INSERT INTO voice_messages (id, message_id, object_key, duration, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('vm1', 'm1', 'voice/m1.webm', 12.5, 'audio/webm', 1024, now).run();

    await db.prepare(
      'INSERT INTO message_receipts (id, message_id, user_id, status, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).bind('r1', 'm1', 'u1', 'delivered', now).run();

    // Delete message directly
    await db.prepare('DELETE FROM messages WHERE id = ?').bind('m1').run();

    // Check voice_messages and receipts were cascaded
    const vm = await db.prepare('SELECT * FROM voice_messages WHERE id = ?').bind('vm1').first();
    expect(vm).toBeNull();

    const receipt = await db.prepare('SELECT * FROM message_receipts WHERE id = ?').bind('r1').first();
    expect(receipt).toBeNull();
  });

  it('supports batch statement execution', async () => {
    const now = Date.now();
    const stmts = [
      db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('batch_u1', '0xb1', now, now),
      db.prepare('INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('batch_u2', '0xb2', now, now),
    ];

    await db.batch(stmts);

    const res = await db.prepare('SELECT id FROM users WHERE id LIKE ?').bind('batch_%').all<{ id: string }>();
    expect(res.results.length).toBe(2);
  });
});
