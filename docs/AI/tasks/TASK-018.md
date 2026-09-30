# TASK-018: D1 Write Batching & Auto-Batching Engine Optimization

## Status: DONE

## Dependencies
- TASK-017

## Motivation & Architecture Context
Cloudflare D1 is a distributed SQLite database with single-writer concurrency. Each independent `.run()` write query across HTTP requests requires an IPC/network roundtrip to SQLite, acquiring a table write lock. Under concurrent writes or multi-step operations (e.g. creating conversations + adding members, accepting friend requests, authenticating users), unbatched sequential writes cause severe lock contention, elevated latencies, and risk worker timeout.

Referencing the high-performance batching architecture in `/ssd0/git/cloudlflare-worker-kvdb`:
1. We implement `D1WriteBatcher` and `withAutoBatch` in `src/db/batcher.ts`, creating an in-memory aggregating micro-batch buffer for Cloudflare D1.
2. We strictly guarantee **Read-Your-Own-Writes (RYOW)** within the same isolate by triggering an immediate `flush()` of all queued writes prior to any `.first()`, `.all()`, `.raw()`, `.batch()`, or `.exec()` read operation.
3. We register background drain tasks using Cloudflare Worker's `ctx.waitUntil()` to prevent premature isolate suspension.
4. We enforce D1 boundary protection via `src/db/chunker.ts` (`chunkArray`, `chunkByParamCount`, `D1_MAX_PARAMS_LIMIT = 100`, `D1_SAFE_BATCH_CHUNK = 50`).
5. We optimize multi-write service functions across `auth.ts`, `conversations.ts`, `friendRequests.ts`, etc., to use atomic `db.batch([stmt1, stmt2, ...])`.

## Changes
1. Created `src/db/chunker.ts` for parameter and statement chunking.
2. Created `src/db/batcher.ts` with `D1WriteBatcher`, `withAutoBatch`, and `isAutoBatchD1`.
3. Exported chunker and batcher from `src/db/index.ts`.
4. Mounted Auto-Batch middleware in `src/index.ts` to automatically wrap `c.env.DB` with `withAutoBatch(c.env.DB, { ctx })` and ensure post-request/post-cron flushing.
5. Optimized multi-statement writes to native `db.batch()`:
   - `src/services/auth.ts`: Nonce deletion, user creation, and session insertion.
   - `src/services/conversations.ts`: Direct conversation creation, group creation, member removal (kick/leave), member role promotion, join request creation, and member muting.
   - `src/services/friendRequests.ts`: Bidirectional friend row insertion and request acceptance.
6. Created `test/batcher.test.ts` (16 unit tests) verifying coalescing, threshold triggers, RYOW consistency, and error propagation.
7. Verified entire test suite (`44/44` test files passed, `365/365` tests passed).
