# TASK-008: Scheduled Expiration Cleanup & Cron Worker

## Objective
Implement Cloudflare Worker scheduled cron handler to purge expired messages from D1 and delete orphaned voice files from R2, maintaining storage hygiene without human intervention.

## Scope
- Scheduled event handler in `src/index.ts` (`export default { fetch, scheduled }`)
- Sweeper routine: Query messages where `expires_at <= now`
- For expired voice messages, delete objects from R2
- Delete expired message rows from D1
- Admin/trigger endpoint `POST /admin/cleanup` (or internal test helper) to trigger cleanup programmatically

## Allowed Files
- `src/services/cleanup.ts`
- `src/index.ts`
- `test/cleanup.test.ts`

## Dependencies
TASK-007

## Inputs and Outputs
- **Input**: Scheduled cron event or cleanup trigger call.
- **Output**: Count of purged messages and deleted R2 objects.

## Acceptance Criteria
1. Scheduled sweeper correctly identifies all messages with `expires_at <= Date.now()`.
2. Associated R2 voice files are deleted from the bucket.
3. D1 records are removed.
4. Non-expired messages remain untouched.

## Verification Commands
- `pnpm test test/cleanup.test.ts`

## Risks and Assumptions
- Batch deletions should be capped (e.g. 500 rows per run) to stay within Worker CPU execution limits.

## Status
DONE
