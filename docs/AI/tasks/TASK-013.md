# TASK-013: Image & File Messaging Support with Dual-Storage R2 Upload, Download & Destruction

## Status
DONE

## Dependencies
- TASK-012

## Objectives
1. Add database schema support for `'image'` and `'file'` message types with dedicated metadata tables `image_messages` and `file_messages`.
2. Implement image message upload (`POST /images/upload`) supporting `multipart/form-data` and `application/json` (base64) with MIME validation (JPEG, PNG, WebP, GIF, SVG, BMP, HEIC, AVIF) and 20MB limit.
3. Implement image streaming endpoint (`GET /images/:messageId`) and metadata endpoint (`GET /images/:messageId/meta`) with conversation membership validation, TTL expiration checks, and burn-on-read protection.
4. Implement generic file message upload (`POST /files/upload`) supporting `multipart/form-data` and `application/json` (base64) with sanitized filenames and 50MB limit.
5. Implement file streaming/download endpoint (`GET /files/:messageId`) with `Content-Disposition: attachment` and metadata endpoint (`GET /files/:messageId/meta`).
6. Update dual-storage destruction (`src/services/destruction.ts`) and expiration cleanup sweeper (`src/services/cleanup.ts`) to atomically purge image and file binary objects from R2 alongside D1 records.
7. Enrich conversation messages and incremental sync updates with media metadata.
8. Maintain 100% backward compatibility and update comprehensive test suites and documentation.

## Implementation Details
- **Migration**: Added `migrations/0003_media_messages.sql` to expand `messages.type` CHECK constraint to include `'image'` and `'file'`, and create `image_messages` and `file_messages` tables with cascade deletes. Updated `migrations/0001_initial_schema.sql` check constraint.
- **Types**: Added `ImageMessageRow` and `FileMessageRow` in `src/db/schema.ts`, expanded `MessageType` in `src/types.ts`.
- **Services**: Created `src/services/images.ts` and `src/services/files.ts`. Added `getVoiceMetadata` to `src/services/voice.ts`.
- **Destruction**: Extended `destroyMessage` in `src/services/destruction.ts` to delete R2 objects for voice, images, and files.
- **Cleanup**: Extended `sweepExpiredMessages` in `src/services/cleanup.ts` to sweep expired voice, image, and file R2 objects.
- **Enrichment**: Added `enrichMessagesWithMedia` in `src/services/messages.ts` for automatic attachment of media metadata to messages in cursor pagination and incremental `/sync`.
- **Routes**: Implemented `src/routes/images.ts` and `src/routes/files.ts`. Mounted at `/images` and `/files` in `src/index.ts`. Added `/voice/:messageId/meta`.
- **Tests**: Created `test/images.test.ts` (6 tests) and `test/files.test.ts` (6 tests). Updated `test/db.test.ts`, `test/cleanup.test.ts`, and `test/e2e.test.ts`.

## Verification Commands & Results
- `pnpm run typecheck`: 0 errors.
- `pnpm test`: 58/58 tests passed across 11 test suites.
- `pnpm wrangler d1 migrations apply DB --remote`: 0003_media_messages.sql applied to remote D1.
- `pnpm wrangler deploy`: Successfully deployed to Cloudflare Workers.
- `pnpm run test:live`: 12/12 live integration steps passed against real Cloudflare Worker (`https://web3-chat-worker.002788.xyz`) with D1 and R2.
