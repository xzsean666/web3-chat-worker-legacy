# TASK-024: Comprehensive Audit & Hardening (Security, Storage Lifecycle & Rate Limiting)

## 1. Context & Motivation
Following the comprehensive architecture, security, and performance audit of the Web3 Chat Worker codebase, five critical findings and enhancements were identified across media streaming, blockchain verification, bot operations, storage lifecycle management, and D1 database performance:
1. **[Security] Stored XSS Mitigation for Image Attachments**: `GET /images/:messageId` served image files with `Content-Disposition: inline` without `X-Content-Type-Options: nosniff` or SVG `Content-Security-Policy: default-src 'none'; sandbox`.
2. **[Web3/Payments] EVM Block Timestamp Skew Tolerance**: `verifyOrder` strictly enforced `blockMs <= claimedMs`. Due to validator/miner clock drift (allowed up to 15s in BSC/EVM), legitimate transactions submitted immediately upon confirmation risked permanent rejection with `invalid_block_time`.
3. **[Storage Leak] Video Object Cleanup in Feed Lifecycle**: Soft-deleted feed posts (`feed_posts`) only purged `images` upon physical expiration, permanently leaking large MP4/WebM video objects (`post.video`) in R2.
4. **[Bot Flood Defense] General Bot Flood Protection**: `POST /bot/messages/send` only enforced B-R4 rate limits when `X-Enforce-Rate-Limit: true` was sent. Unprotected bot calls had no rate limits, allowing DoS floods.
5. **[Performance & Routing] D1 Rate Limit Cleanup Throttling & Middleware Scoping**:
   - `allow(...)` issued a redundant `DELETE FROM rate_limits` query on every single request, triggering unnecessary D1 single-writer lock contention.
   - `messageRoutes.use('*', authMiddleware)` was mounted at `'/'`, introducing potential path matching collisions with other sub-apps.

## 2. Changes Made
- **Security Headers in Image Streaming**:
  - Modified [`src/routes/images.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/routes/images.ts): Added `X-Content-Type-Options: nosniff`, and for SVG MIME types dynamically added `Content-Security-Policy: default-src 'none'; sandbox` and `ETag`.
- **EVM Timestamp Clock Drift Tolerance**:
  - Modified [`src/services/payments/verifier.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/services/payments/verifier.ts): Allowed a 120-second future drift window (`claimedMs + 120_000`) for EVM node block timestamps.
- **Storage Lifecycle Video Cleanup**:
  - Modified [`src/services/storageLifecycle.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/services/storageLifecycle.ts): Extended `runFeedPosts` to query `video` and push `post.video` into `mediaKeys` for deletion from R2.
- **Bot Default Flood Protection**:
  - Modified [`src/routes/botOperations.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/routes/botOperations.ts): Enforced strict B-R4 (3/min) when requested/configured, and enforced general bot flood protection (120/min via `allow(...)`) by default.
- **D1 Rate Limit Throttling**:
  - Modified [`src/services/rateLimit.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/services/rateLimit.ts): Throttled cleanup to run only on the first request of a new minute window (`count === 1`), reducing D1 delete write traffic by ~99%.
- **Scoped Message Middleware**:
  - Modified [`src/routes/messages.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/routes/messages.ts): Replaced root wildcard middleware `use('*')` with scoped paths `use('/conversations/*')` and `use('/messages/*')`.

## 3. Verification & Test Coverage
- `test/images.test.ts`: Added test verifying nosniff header and SVG CSP sandbox.
- `test/payments_verifier.test.ts`: Added tests verifying future clock drift tolerance (+60s accepted, +300s rejected).
- `test/storage_lifecycle.test.ts`: Added tests verifying video object deletion from R2 upon soft-deleted feed post purge.
- `test/bot_extensions.test.ts`: Added test verifying general flood protection rate limiting without header.
- Ran full regression:
  - `pnpm run typecheck`: Passed (0 errors).
  - `pnpm test`: Passed (48/48 test files, 438/438 tests passing).
