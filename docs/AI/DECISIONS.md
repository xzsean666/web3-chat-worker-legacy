# Architectural & Technical Decisions (DECISIONS.md)

## ADR-001: Web Framework - Hono
- **Status**: Accepted
- **Context**: Need a lightweight, fast, and type-safe router running inside Cloudflare Workers without Node.js runtime overhead.
- **Decision**: Use `hono` v4.
- **Consequences**: Fast startup, zero external Node.js polyfills needed, great ergonomics for JSON APIs and middleware.

## ADR-002: EVM Signature Verification - Viem
- **Status**: Accepted
- **Context**: EVM signature recovery (EIP-191 `personal_sign`) must run in edge V8 isolates with Web Crypto API. Libraries like `ethers` or `web3.js` carry massive Node.js polyfill weight.
- **Decision**: Use `viem` (`verifyMessage` and address utilities).
- **Consequences**: Tree-shakeable, clean Web Crypto support, compliant with EIP-191.

## ADR-003: Session Architecture
- **Status**: Accepted
- **Context**: Require session auth after EVM wallet login so clients don't sign on every request.
- **Decision**: Generate high-entropy Bearer token (`crypto.getRandomValues`), store SHA-256 hash in D1 `sessions` table with an expiration timestamp.
- **Consequences**: Database compromises do not expose raw bearer tokens; immediate revocation is supported via `POST /auth/logout`.

## ADR-004: Client Pull & Sync Performance Optimization
- **Status**: Accepted
- **Context**: User explicitly requested performance optimizations for client message pulling (such as incremental sync based on previous state) and simple interaction.
- **Decision**: Provide cursor-based `/conversations/:id/messages?after_id=xxx` as well as a multi-conversation `/sync?since=xxx` delta endpoint. Provide batch ACK endpoints (`POST /messages/ack`, `POST /messages/read`).
- **Consequences**: Client only fetches new delta messages, lowering D1 read row counts and egress costs; batch ACK minimizes mobile latency.

## ADR-005: Dual-Storage Cleanup Protocol (D1 + R2)
- **Status**: Accepted
- **Context**: Burn-on-read (`on_read`) and expiration (`expires_at`) require simultaneous destruction of relational metadata in D1 and audio blobs in R2.
- **Decision**: Atomic read-and-delete flow: retrieve R2 object keys from `voice_messages`, invoke `R2.delete()`, then execute SQL `DELETE FROM messages`. A scheduled background worker cron handles expired message sweeps.
- **Consequences**: Zero orphaned audio files in R2 storage, strictly enforcing ephemeral security.

## ADR-006: Group Chat 1:N Delivery Rollup & Burn-on-Read Synchronization
- **Status**: Accepted
- **Context**: In 1:N group messaging, multiple recipients pull and ACK at different times. If `messages.status` is set to `delivered` upon the first recipient's ACK, the sender is misled into believing all recipients received the message. Similarly, in burn-on-read (`on_read`), if the first recipient's read triggers immediate destruction, subsequent recipients are deprived of receiving the message.
- **Decision**:
  1. Rely on `message_receipts` as the source of truth for per-recipient delivery and read timestamps.
  2. For 1:N group conversations, only transition aggregate `messages.status` to `delivered` or `read` when ALL non-sender conversation members have acknowledged delivery or read.
  3. For `on_read` messages in groups, delay dual-storage destruction until ALL recipients have read the message (or until `expires_at` cron sweep).
  4. Expose `GET /messages/:id/receipts` endpoint for conversation members to inspect delivery & read status of each recipient.
  5. Decouple server-side ephemeral transit/destruction from client-side local sovereign storage (IndexedDB/SQLite).
- **Consequences**: Accurate delivery tracking for senders, zero premature message destruction for group members, and full adherence to Web3 local-first sovereign data principles.

## ADR-007: Sovereign Groups & Deterministic Identity Architecture
- **Status**: Accepted
- **Context**: In multi-node deployments or when migrating/merging state between independent Worker nodes, traditional surrogate UUIDs create identifier collisions and distributed split-brain conflicts (e.g. concurrent owner transfers or group renames).
- **Decision**:
  1. **Address as User ID**: Use normalized EVM wallet address (`0x...`) directly as the user identifier, eliminating stateful mapping synchronization.
  2. **Deterministic Direct Conversations**: Direct conversation IDs are globally fixed as `direct:min(addrA, addrB):max(addrA, addrB)`.
  3. **Self-Certifying Sovereign Group IDs**: Group IDs are bound to creator address `${owner_address}:${slug_or_salt}`.
  4. **Immutable Ownership & Single Authority**: A group permanently belongs to its creator. Ownership cannot be transferred. Only the owner can rename the group or add/remove members. If the owner leaves, the group is dismissed.
  5. **Conflict-Free State Merging**: Conversations support Last-Write-Wins (LWW) merging on `updated_at`, and members support idempotent `INSERT OR IGNORE` merging without duplicate rows.
- **Consequences**: Workers become stateless, plug-and-play transit nodes. Groups and users can be merged across multiple Cloudflare Worker D1 instances without coordination or lock contention.

## ADR-008: Per-Recipient Burn-on-Read & Read-State Message Filtering
- **Status**: Accepted
- **Context**: Under ADR-006, delaying physical destruction until all group members read caused ephemeral messages to remain visible and re-fetchable by users who had already read them. Additionally, read acknowledgments returned `status: 'read'` instead of `burned` for partial reads, breaking client-side burn animations and local message deletion.
- **Decision**:
  1. **Unified Burn Status**: `POST /messages/:id/read` and `/messages/read` always return `status: 'burned'` for `retention: 'on_read'` messages upon successful read receipt creation, across both direct and group conversations.
  2. **Query Read-State Filtering**: In `/conversations/:id/messages` and `/sync`, filter out `on_read` messages where the requesting user already has a `status = 'read'` receipt in `message_receipts`.
  3. **Voice Replay Prevention**: Guard `GET /voice/:messageId` to return HTTP 404 if the requester has already submitted a read receipt for an `on_read` voice message.
  4. **Preserve Deferred Full Destruction**: Maintain dual-storage physical destruction (D1 delete + R2 delete) when ALL non-sender recipients have read (`all_read === true`) or when `expires_at` is reached.
- **Consequences**: Readers experience immediate burn-on-read locally and on message refreshes, unread group members retain access until they read, and server resources are cleanly purged once all recipients have consumed the message.

## ADR-009: Dual-Storage Architecture & Synchronized Lifecycle for Image and File Messaging
- **Status**: Accepted
- **Context**: Users and clients require the ability to send images (JPEG, PNG, WebP, GIF, SVG, BMP, HEIC, AVIF) and generic files/attachments (PDF, ZIP, DOC, etc.) with the same security, authorization, ephemeral retention (burn-on-read), TTL expiration, and incremental sync capabilities as text and voice messages.
- **Decision**:
  1. **Expanded Message Types**: Expand `messages.type` CHECK constraint to `CHECK(type IN ('text', 'voice', 'image', 'file'))`.
  2. **Dedicated Metadata Tables**: Create `image_messages` (with `width`, `height`, `file_name`, `mime_type`, `size`) and `file_messages` (with `file_name`, `mime_type`, `size`), both with foreign keys `REFERENCES messages(id) ON DELETE CASCADE`.
  3. **Dual-Storage Destruction**: Extend `destroyMessage` to inspect `voice_messages`, `image_messages`, and `file_messages` and purge the binary object from R2 before deleting the D1 message row.
  4. **Expiration Sweeper Integration**: Extend `sweepExpiredMessages` to batch-delete expired voice, image, and file objects from R2 alongside D1 rows.
  5. **Streaming & Content Disposition**: `GET /images/:messageId` serves inline binary streaming; `GET /files/:messageId` serves attachment binary streaming with RFC 5987 / RFC 6266 unicode filename handling. Dedicated `/meta` endpoints provide JSON metadata inspection.
  6. **Sync Enrichment**: Automatically enrich messages returned by `/conversations/:id/messages` and `/sync` with media metadata (`voice`, `image`, `file`) to eliminate extra client round-trips.
- **Consequences**: High-performance, secure image and file sharing is fully unified with Web3 authentication, explicit ACKs, burn-on-read, and incremental sync.

## ADR-010: User Dual-Metadata, Single Avatar Storage, 30s Message Recall, 30s Burn Grace Window, and Social Graph Protections
- **Status**: Accepted
- **Context**: The application required user profiles with dual public/private metadata, single avatar management in Cloudflare R2, a 30-second window for message recall with immediate media asset purging, a minimum 30-second viewing window for burn-on-read messages upon reading, and social relationships (friends with tags/aliases, blacklist with direct message blocking).
- **Decision**:
  1. **Dual-Metadata Model**: Added `public_metadata` and `private_metadata` JSON columns to `users`. Both are editable only by the user (`PATCH /users/me/metadata`). Others can read `public_metadata` (`GET /users/:address`), while `private_metadata` is strictly private to the authenticated owner (`GET /users/me`).
  2. **Single Avatar Invariance**: User avatars are stored in R2. Uploading a new avatar (`POST /users/me/avatar`) overwrites/deletes the previous R2 object to guarantee each user has at most one active avatar, publicly streamable via `GET /users/:address/avatar`.
  3. **30-Second Message Recall**: Senders can recall messages within 30 seconds (`MESSAGE_RECALL_WINDOW_SECONDS`, default 30s). The backend marks `recalled_at`, masks content to `"This message was recalled"`, and immediately physically purges any R2 binary object associated with the message.
  4. **Burn-on-Read 30s Viewing Grace Window**: Reading an `on_read` message returns `{ status: "burned", burn_after_seconds: 30 }`. Senders/recipients specify `burn_after_seconds` (default 30s). Exclusion from sync/message queries and media downloads is delayed by `burn_after_seconds` after read receipt timestamp, ensuring readers have at least 30 seconds to view/download media before removal and physical destruction.
  5. **Social Graph & Blacklist Enforcement**: Created `friends` (with `alias` and JSON `tags` array) and `blacklist` tables. When user B has blocked user A, user A cannot initiate a 1:1 chat or send messages to user B (returns HTTP 403 Forbidden). Messages support optional `@mentions`.
- **Consequences**: User customization and social features are fully integrated into the existing Cloudflare Worker architecture without compromising ephemeral privacy or storage efficiency.

## ADR-011: Group Metadata, Moderation (Mute System), Member Management & Sovereign Group Role Control
- **Context**: Community groups require rich metadata (group name, description, top marquee scrolling banners), moderation capabilities (group-wide mute and per-member mute lists), voluntary self-leaving, owner kick mechanisms, and administrator delegation while preserving sovereign single-ownership and immutable decentralization guarantees.
- **Decision**:
  1. **Group Metadata Storage**: Added `metadata TEXT NOT NULL DEFAULT '{}'` column to `conversations`. The JSON stores `name`, `description`, `announcement`, `marquee: { enabled, text, speed }`, and arbitrary custom frontend attributes. Changes to `metadata.name` or root `name` are kept bidirectionally synchronized with the database column `conversations.name`.
  2. **Top Marquee Scrolling Banner**: Metadata stores `marquee: { enabled: boolean, text?: string, speed?: number }`. Frontends render this banner at the top of the group chat window, defaulting to `description` if `text` is omitted.
  3. **Three-Tier RBAC (Owner, Admin, Member)**:
     - Group creator is permanent immutable `owner`.
     - Owner can promote/demote members to `admin` (`PUT /groups/:id/members/:userId/role`).
     - Owner can kick any member or admin (`POST /groups/:id/kick`, `DELETE /groups/:id/members/:userId`).
     - Admins can kick regular members (cannot kick owner or other admins).
  4. **Voluntary Self-Leaving**: Any member or admin can leave the group (`POST /groups/:id/leave`, `DELETE /groups/:id/members/me`). If the owner leaves, the sovereign group is deleted.
  5. **Moderation & Mute System**:
     - Group-wide mute (`POST /groups/:id/mute` / `POST /groups/:id/unmute`) with optional duration in seconds or indefinite.
     - Individual member mute (`POST /groups/:id/members/:userId/mute` / `unmute`) with duration and optional reason.
     - **Admin Speech Invariance ("admin始终可以讲话")**: Group owner and admins are completely exempt from mute restrictions and can always send messages across text, voice, image, and file channels.
     - Mute queries: `GET /groups/:id/muted` returns group mute status and the active muted member list.
## ADR-012: D1 Write Batching & In-Memory Auto-Batching Engine Optimization
- **Context**: Cloudflare D1 operates on distributed SQLite with single-writer serialization. High-frequency discrete write statements (`stmt.run()`) across concurrent requests cause high IPC/network latency and SQLite write-lock contention. In addition, multi-step mutations (e.g. creating conversations, adding initial members, mutual friend creation, authentication session issuance) previously performed sequential roundtrips.
- **Decision**:
  1. **In-Memory Micro-Batch Buffer (`D1WriteBatcher`)**: Built `D1WriteBatcher` in `src/db/batcher.ts` (referencing `cloudlflare-worker-kvdb`). Aggregates concurrent `.run()` mutation statements occurring within the same worker isolate and debounce window (`maxWaitMs: 100ms`, `maxBatchSize: 100`) into atomic `db.batch()` operations.
  2. **Strict Read-Your-Own-Writes (RYOW)**: Any read query (`first()`, `all()`, `raw()`, `db.batch()`, or `db.exec()`) triggers an immediate pre-flush of all pending writes, guaranteeing that data read in the same isolate is always fresh and consistent.
  3. **Cloudflare ExecutionContext Lifecycle Integration**: Background flush timers register their draining promise with `ctx.waitUntil()` to prevent Cloudflare Worker isolates from suspending before all buffered writes are committed.
  4. **Transparent Proxy (`withAutoBatch`) & Middleware**: Added Hono middleware in `src/index.ts` to wrap `c.env.DB` with `withAutoBatch(c.env.DB, { ctx })` and ensure guaranteed flush upon request completion. The scheduled event handler similarly wraps `env.DB` with auto-batch and flushes before completion.
  5. **Explicit Multi-Statement Batch Optimization**: Refactored multi-step mutations across services to execute atomic `db.batch([stmt1, stmt2, ...])` operations:
     - `auth.ts`: Nonce deletion, user registration, and session insertion.
     - `conversations.ts`: Direct conversation creation, group chat creation with all members, member removal (kick/leave), member role promotion, join request submission, and member muting.
     - `friendRequests.ts`: Bidirectional friend row insertion and request acceptance.
  6. **Safe Parameter & Statement Boundaries (`chunker.ts`)**: Enforced D1 parameter limits (max 100 parameters, chunked at 80) and statement batch sizes (chunked at 50) using `chunkArray` and `chunkByParamCount`.
- **Consequences**: Drastically mitigates D1 write-lock contention, reduces roundtrip latency for multi-statement flows from N roundtrips to 1 roundtrip, maintains strict Read-Your-Own-Writes consistency, and achieves 100% test pass rate across all 44 test suites (365 tests).

