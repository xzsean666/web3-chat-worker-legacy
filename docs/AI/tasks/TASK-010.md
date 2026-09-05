# TASK-010: Group Chat 1:N Delivery Rollup, Burn-on-Read Synchronization & Message Receipts API

## Status
DONE

## Motivation & Context
In group chats (1:N, where sender A sends to recipients B, C, D), relying on a single `messages.status` column caused edge cases:
1. When B acknowledged delivery, `messages.status` prematurely transitioned to `'delivered'`, making sender A think all recipients received the message even if C and D were offline.
2. In burn-on-read (`retention: 'on_read'`), when B read the message, it immediately triggered physical deletion from D1 and R2, causing C and D to miss the message before they could read it.
3. No endpoint existed to query per-recipient delivery and read status.
4. Clients can and should store received messages locally in client-side storage (IndexedDB, OPFS, SQLite), decoupling server-side ephemeral transit/destruction from client-side sovereign history retention.

## Key Changes
1. **1:N Delivery Rollup**:
   - In `src/services/messages.ts`: `acknowledgeDelivery` counts total non-sender conversation members and distinct delivery receipts.
   - For 1:1 chats: transitions immediately on single recipient ACK.
   - For group chats: transitions `messages.status` to `'delivered'` only when ALL recipients have submitted delivery receipts.
2. **Group Burn-on-Read Synchronization**:
   - In `src/services/messages.ts`: `acknowledgeRead` counts distinct read receipts.
   - Delays `destroyMessage(db, r2, id)` until ALL recipients have submitted read receipts.
   - If some recipients remain unread, message stays accessible until all read, or until `expires_at` cron sweep.
3. **Receipts Query API**:
   - Endpoint: `GET /messages/:id/receipts`
   - Returns rollup summary (`total_recipients`, `delivered_count`, `read_count`, `all_delivered`, `all_read`) and detailed per-recipient status list (`pending`, `delivered`, `read`).
   - Restricts access to conversation members (403 for non-members, 404 for non-existent/destroyed messages).

## Verification Criteria
- [x] Group delivery ACK marks individual receipt and only updates message status when all recipients ACK.
- [x] Group burn-on-read preserves message in D1/R2 until all recipients read, then executes atomic dual-storage destruction.
- [x] Receipts endpoint returns accurate per-member status and counts.
- [x] 100% test pass rate across all unit, integration, and E2E suites.
