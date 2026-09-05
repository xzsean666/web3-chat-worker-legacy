# Session State (SESSION_STATE.md)

## Current Goal
Build a high-performance, single-node Cloudflare Worker Web3 Chat MVP supporting EVM wallet signature login, direct/group chat, text and voice messaging, explicit delivery ACK, burn-on-read, voice destruction (R2), and incremental sync.

## Current Task
TASK-013: Image & File Messaging Support with Dual-Storage R2 Upload, Download & Destruction

## Current Status
DONE

## Completed Work
- Defined project rules in `AGENTS.md`.
- Stored AI Agent engineering protocol in `docs/AI_AGENT_PROMPT.md`.
- Documented project goal in `docs/AI/GOAL.md`.
- Defined architecture, D1 schema, and incremental sync protocols in `docs/AI/ARCHITECTURE.md`.
- Recorded architectural decisions in `docs/AI/DECISIONS.md`.
- Outlined task breakdown in `docs/AI/TASK_INDEX.md` and detailed specs in `docs/AI/tasks/TASK-001.md` through `TASK-013.md`.
- Initialized `package.json`, configured `pnpm`, installed `hono`, `viem`, `wrangler`, `vitest`, and `@cloudflare/workers-types`.
- Configured `tsconfig.json` for Cloudflare Worker runtime.
- Configured `wrangler.jsonc` with D1 `DB` binding, R2 `VOICE_BUCKET` binding, and scheduled cron triggers.
- Implemented `src/index.ts` with Hono router, CORS middleware, and `GET /health` endpoint.
- Implemented `test/health.test.ts` and verified with `pnpm test` and `pnpm run typecheck`.
- Created `.gitignore`.
- TASK-002: Created `migrations/0001_initial_schema.sql` defining full DDL and indices for all 8 entities (`users`, `nonces`, `sessions`, `conversations`, `conversation_members`, `messages`, `message_receipts`, `voice_messages`).
- TASK-002: Created `src/db/schema.ts` and `src/db/index.ts` with TypeScript entity interfaces and helpers.
- TASK-002: Created `test/helpers/db.ts` SQLite D1 test mock using Node 24 `node:sqlite`.
- TASK-002: Created `test/db.test.ts` and verified schema, indices, constraints, batch execution, and cascade deletes.
- TASK-003: Implemented `src/services/auth.ts` for nonce generation, viem EIP-191 signature verification, SHA-256 session token hashing, and session validation/revocation.
- TASK-003: Implemented `src/middleware/auth.ts` Bearer token authentication middleware.
- TASK-003: Implemented `src/routes/auth.ts` (`POST /auth/nonce`, `POST /auth/verify`, `GET /auth/me`, `POST /auth/logout`) and registered in `src/index.ts`.
- TASK-003: Created `test/helpers/wallet.ts` for test wallet generation and message signing.
- TASK-003: Implemented `test/auth.test.ts` covering nonce challenge, verification, replay prevention, address mismatch, expiration, and session revocation.
- TASK-004: Implemented `src/services/conversations.ts` for idempotent direct conversation creation, conversation listing, group creation, renaming, and member management.
- TASK-004: Implemented `src/routes/conversations.ts` and `src/routes/groups.ts` and mounted in `src/index.ts`.
- TASK-004: Implemented `test/conversations.test.ts` covering direct chat idempotency, access control, role permissions, and group lifecycle.
- TASK-005: Implemented `src/services/messages.ts` for sending text messages, cursor-based pagination with `after_id`, expiration filtering, and delta `/sync`.
- TASK-005: Implemented `src/routes/messages.ts` and `src/routes/sync.ts` and mounted in `src/index.ts`.
- TASK-005: Implemented `test/messages.test.ts` verifying authorization, default expiration, cursor pagination, expired message exclusion, and multi-conversation delta sync.
- TASK-006: Implemented `src/services/destruction.ts` for simultaneous D1 message deletion and R2 voice asset deletion.
- TASK-006: Added explicit client delivery ACK and read ACK logic (`acknowledgeDelivery`, `acknowledgeRead`) in `src/services/messages.ts`.
- TASK-006: Added single & batch delivery and read ACK endpoints in `src/routes/messages.ts` (`POST /messages/:id/ack`, `POST /messages/ack`, `POST /messages/:id/read`, `POST /messages/read`).
- TASK-006: Implemented `test/receipts.test.ts` verifying delivery ACK progression, sender self-ACK prevention, permanent read ACK, and immediate burn-on-read destruction.
- TASK-007: Created `test/helpers/r2.ts` in-memory MockR2Bucket implementation.
- TASK-007: Implemented `src/services/voice.ts` for voice audio validation, R2 binary upload, and audio streaming.
- TASK-007: Implemented `src/routes/voice.ts` (`POST /voice/upload`, `GET /voice/:messageId`) and mounted in `src/index.ts`.
- TASK-007: Implemented `test/voice.test.ts` verifying R2/D1 storage, audio streaming with headers, membership validation, and atomic burn-on-read destruction.
- TASK-008: Implemented `src/services/cleanup.ts` (`sweepExpiredMessages`) to sweep expired messages and orphan R2 files.
- TASK-008: Wired `POST /admin/cleanup` and Cloudflare Worker `scheduled` event handler in `src/index.ts`.
- TASK-008: Implemented `test/cleanup.test.ts` verifying automatic purging of expired messages and audio files, leaving active data untouched.
- TASK-009: Implemented `test/e2e.test.ts` simulating full client journey: Auth -> 1:1 Chat -> Delivery ACK -> Read ACK -> Group Chat -> Voice Upload -> Binary Stream -> Burn-on-Read -> Expiry Sweep -> Logout.
- TASK-009: Created comprehensive `README.md` with architecture diagrams, D1/R2 Cloudflare deployment steps, and complete REST API reference.
- TASK-010: Implemented 1:N delivery rollup in `acknowledgeDelivery` ensuring group messages only transition to `delivered` when all recipients ACK.
- TASK-010: Synchronized group burn-on-read in `acknowledgeRead` ensuring dual-storage destruction delays until all group members read.
- TASK-010: Implemented `GET /messages/:id/receipts` and `getMessageReceipts` returning detailed per-member delivery and read status.
- TASK-010: Added tests in `test/receipts.test.ts`, updated `test/e2e.test.ts` and `scripts/live-e2e.ts`.
- TASK-010: Documented ADR-006, updated ARCHITECTURE.md, README.md, and FRONTEND_INTEGRATION.md with Local-First storage notes.
- TASK-011: Created `migrations/0002_sovereign_groups.sql` adding `owner_address` column and index on `conversations`.
- TASK-011: Refactored `src/services/auth.ts` to use normalized lowercased EVM wallet address (`0x...`) directly as `user.id`.
- TASK-011: Refactored `src/services/conversations.ts` for deterministic direct conversation IDs (`direct:min:max`), self-certifying sovereign group IDs (`${owner_address}:${slug}`), and strict immutable single-owner RBAC (owner-only rename/add/kick, owner leaving deletes group).
- TASK-011: Updated `src/routes/groups.ts` to support optional custom `slug` parameter.
- TASK-011: Updated test runner in `test/helpers/db.ts` to automatically apply all migrations in order.
- TASK-011: Updated `test/conversations.test.ts` to test owner-only group management permissions and auto-deletion on owner departure.
- TASK-011: Created `docs/CLOUDFLARE_DATA_MERGE.md` with complete SOP for multi-node conflict-free state merging.
- TASK-011: Added ADR-007 to `docs/AI/DECISIONS.md`, updated `docs/AI/ARCHITECTURE.md`, `README.md`, and `docs/FRONTEND_INTEGRATION.md`.
- TASK-011: Applied remote migration `0002_sovereign_groups.sql` to Cloudflare D1.
- TASK-011: Deployed to Cloudflare Worker and verified with `pnpm run test:live` (10/10 live steps passed).
- TASK-011: Completely purged remote D1 tables (`users`, `conversations`, `messages`, `sessions`, etc.) to clear legacy UUID schema data and eliminate foreign key conflicts for clean frontend onboarding.
- TASK-012: Refactored `acknowledgeRead` to always return `{ status: 'burned' }` for `on_read` messages across 1:1 and group chats, resolving front-end UI state desync.
- TASK-012: Added per-user `on_read` message filtering in `getConversationMessages` and `getSyncUpdates`, ensuring users who read ephemeral messages never see them upon refresh or delta sync.
- TASK-012: Added replay prevention in `getVoiceAudio` (`src/services/voice.ts`), returning HTTP 404 if the requester already submitted a read receipt for an `on_read` voice message.
- TASK-012: Preserved atomic dual-storage physical destruction (D1 + R2) once all recipients have read (`all_read === true`) or when `expires_at` is reached.
- TASK-012: Updated `test/receipts.test.ts`, `test/e2e.test.ts`, and `scripts/live-e2e.ts` with per-recipient burn assertions, download guards, and sync exclusion tests.
- TASK-012: Updated `docs/FRONTEND_INTEGRATION.md`, `docs/AI/ARCHITECTURE.md`, `docs/AI/DECISIONS.md` (ADR-008), and `README.md`.
- TASK-013: Created `migrations/0003_media_messages.sql` adding `image_messages` and `file_messages` tables and expanding `messages.type` CHECK constraint to `CHECK(type IN ('text', 'voice', 'image', 'file'))`.
- TASK-013: Updated `src/db/schema.ts` and `src/types.ts` with `ImageMessageRow`, `FileMessageRow`, and updated `MessageType`.
- TASK-013: Implemented `src/services/images.ts` supporting image uploads (`multipart/form-data` and JSON Base64), MIME validation (JPEG, PNG, WebP, GIF, SVG, BMP, HEIC, AVIF), 20MB size guard, metadata queries, and streaming.
- TASK-013: Implemented `src/services/files.ts` supporting file uploads (`multipart/form-data` and JSON Base64), filename sanitization, 50MB size guard, metadata queries, and attachment streaming.
- TASK-013: Added `getVoiceMetadata` in `src/services/voice.ts` and `/voice/:messageId/meta` route for metadata inspection.
- TASK-013: Implemented `src/routes/images.ts` (`POST /images/upload`, `GET /images/:messageId`, `GET /images/:messageId/meta`) and `src/routes/files.ts` (`POST /files/upload`, `GET /files/:messageId`, `GET /files/:messageId/meta`) and mounted in `src/index.ts`.
- TASK-013: Extended `src/services/destruction.ts` (`destroyMessage`) and `src/services/cleanup.ts` (`sweepExpiredMessages`) for atomic R2 dual-storage deletion of voice, image, and file binaries.
- TASK-013: Added `enrichMessagesWithMedia` in `src/services/messages.ts`, automatically attaching media metadata to messages in cursor pagination and incremental `/sync`.
- TASK-013: Created `test/images.test.ts` (6 tests) and `test/files.test.ts` (6 tests), updated `test/db.test.ts`, `test/cleanup.test.ts`, and `test/e2e.test.ts`.
- TASK-013: Documented ADR-009 in `docs/AI/DECISIONS.md`, updated `docs/AI/ARCHITECTURE.md`, `README.md`, and `docs/FRONTEND_INTEGRATION.md` with full TypeScript SDK methods.

## Modified Files
- `migrations/0001_initial_schema.sql`
- `migrations/0003_media_messages.sql`
- `src/db/schema.ts`
- `src/types.ts`
- `src/services/images.ts`
- `src/services/files.ts`
- `src/services/voice.ts`
- `src/services/destruction.ts`
- `src/services/cleanup.ts`
- `src/services/messages.ts`
- `src/routes/images.ts`
- `src/routes/files.ts`
- `src/routes/voice.ts`
- `src/index.ts`
- `test/images.test.ts`
- `test/files.test.ts`
- `test/db.test.ts`
- `test/cleanup.test.ts`
- `test/e2e.test.ts`
- `docs/FRONTEND_INTEGRATION.md`
- `docs/AI/ARCHITECTURE.md`
- `docs/AI/DECISIONS.md`
- `README.md`
- `docs/AI/tasks/TASK-013.md`
- `docs/AI/TASK_INDEX.md`
- `docs/AI/SESSION_STATE.md`

## Verification Commands & Results
- `pnpm run typecheck`: Success (zero type errors across all source and test files).
- `pnpm test`: Success (58/58 tests passing across 11 test suites with 100% pass rate).

## Unresolved Issues
None.

## Risks and Assumptions
- R2 uploads share the bucket binding (`VOICE_BUCKET`) under prefixes `images/` and `files/`, ensuring zero-config backward compatibility with Cloudflare deployment bindings.

## Next Task
Frontend integration & client SDK release.

## Next Session Read Files
- `README.md`
- `docs/FRONTEND_INTEGRATION.md`
- `docs/AI/ARCHITECTURE.md`
- `docs/AI/DECISIONS.md`
- `docs/AI/SESSION_STATE.md`

