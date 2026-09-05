# TASK-002: D1 Database Schema, Migrations & Test Fixtures

## Objective
Design and implement SQL migration files for Cloudflare D1 representing all required entities: users, nonces, sessions, conversations, conversation_members, messages, message_receipts, and voice_messages with proper indices and foreign keys, plus in-memory SQLite / D1 migration runner for testing.

## Scope
- `migrations/0001_initial_schema.sql` containing full DDL for all tables and indices
- `src/db/schema.ts` defining TypeScript interfaces for DB entities
- `test/db.test.ts` verifying schema creation, foreign key constraints, unique constraints, and cascade deletions

## Allowed Files
- `migrations/0001_initial_schema.sql`
- `src/db/schema.ts`
- `src/db/index.ts`
- `test/db.test.ts`
- `test/helpers/db.ts`

## Dependencies
TASK-001

## Inputs and Outputs
- **Input**: Architecture D1 table specifications.
- **Output**: SQL migration file, TypeScript schema definitions, and validated DB test suite.

## Acceptance Criteria
1. DDL includes `users`, `nonces`, `sessions`, `conversations`, `conversation_members`, `messages`, `message_receipts`, `voice_messages`.
2. Indices created for fast query performance (e.g. `messages(conversation_id, created_at)`, `messages(expires_at)`).
3. Test suite runs migrations against test DB and validates insertion, foreign key constraints, and cascade delete behavior.

## Verification Commands
- `pnpm run typecheck`
- `pnpm test test/db.test.ts`

## Risks and Assumptions
- SQLite in Cloudflare D1 supports foreign keys when `PRAGMA foreign_keys = ON;` is enabled.

## Status
DONE
