# TASK-012: Per-Recipient Burn-on-Read and Group Read-State Filtering

## Status
DONE

## Motivation & Context
In group conversations, the previous burn-on-read implementation required ALL recipients to read before transitioning status or deleting the message. While this prevented premature physical destruction (satisfying ADR-006), it created major UX defects:
1. When a group member read an `on_read` message, `POST /messages/:id/read` returned `status: 'read'` instead of `'burned'`, preventing frontends from triggering burn animations and local message destruction.
2. When the reader refreshed the chat or polled `/conversations/:id/messages` or `/sync`, the backend re-served the already-read ephemeral message because queries did not filter out messages already read by that specific user.
3. Audio files in R2 could be repeatedly downloaded and played by readers before the final recipient finished reading.
4. If a single group member was inactive or offline, the message remained active and visible to all members for up to 24 hours.

## Key Changes
1. **Per-Recipient Burn Response**:
   - In `acknowledgeRead` (`src/services/messages.ts`), always push `on_read` message IDs to the `burned` list upon read confirmation for the reading user, returning `{ status: 'burned' }` across both 1:1 and group chats.
   - Physical deletion (`destroyMessage`) remains deferred until ALL non-sender recipients have read (or expires_at cron sweep).
2. **Per-User Read Filtering on Message Pulls**:
   - In `getConversationMessages` and `getSyncUpdates` (`src/services/messages.ts`), exclude `retention = 'on_read'` messages if the requesting user already has a `status = 'read'` receipt in `message_receipts`.
   - The sender still retains visibility until all recipients read and physical destruction occurs.
3. **Voice Playback Burn Guard**:
   - In `getVoiceAudio` (`src/services/voice.ts`), reject download requests with 404 if the requesting user has already submitted a `read` receipt for an `on_read` voice message.
4. **Test Suite & Integration Script Updates**:
   - Update `test/receipts.test.ts`, `test/e2e.test.ts`, and `scripts/live-e2e.ts` to assert `status: 'burned'` for partial reads, while verifying deferred physical destruction and per-user retrieval filtering.
5. **Documentation Updates**:
   - Update `docs/FRONTEND_INTEGRATION.md`, `docs/AI/ARCHITECTURE.md`, `docs/AI/DECISIONS.md`, and `README.md`.

## Verification Criteria
- [x] Reader gets `{ status: 'burned' }` on read ACK for any `on_read` message in direct and group chats.
- [x] Reader cannot re-fetch read `on_read` messages via `/conversations/:id/messages` or `/sync`.
- [x] Reader cannot re-download audio of read `on_read` voice messages via `/voice/:id` (returns 404).
- [x] Unread members can still fetch and read the message until all have read.
- [x] Dual-storage physical destruction (D1 + R2) executes automatically once all members read.
- [x] 100% test pass rate across `pnpm run typecheck` and `pnpm test`.
