# TASK-015: 30-Second Message Recall & 30-Second Burn-on-Read Viewing Window

## Status
DONE

## Dependencies
- TASK-014

## Objectives
1. Implement message recall within 30 seconds (`POST /messages/:id/recall`):
   - Sender-only authorization.
   - 30-second recall limit (configurable via `MESSAGE_RECALL_WINDOW_SECONDS`, default 30s).
   - Rejection with 400 Bad Request if recall window has expired.
   - Purge R2 media objects (voice, images, files) immediately upon recall.
   - Return message as recalled in conversation queries and incremental sync (`recalled_at`, `content: '[Message recalled]'`).
2. Extend burn-on-read lifecycle to provide at least 30-second viewing window:
   - When recipient reads an `on_read` message, record read receipt with timestamp.
   - Recipient can still read and view message content and stream media within the 30-second window (`mr.timestamp + burn_after_seconds * 1000`).
   - Query filters out message for that reader only after the 30-second window has passed.
   - Dual-storage physical destruction (D1 + R2) is delayed until all recipients have read and their 30-second viewing windows have expired.
   - Scheduled sweeper purges expired burn-on-read messages where all reading windows have passed.

## Verification
- Verified with unit & integration tests in `test/recall_and_burn.test.ts` (4 tests passing).
- Verified regression compatibility across `test/receipts.test.ts`, `test/voice.test.ts`, `test/images.test.ts`, `test/files.test.ts`, and `test/e2e.test.ts`.
- Typecheck verified with `pnpm run typecheck`.
