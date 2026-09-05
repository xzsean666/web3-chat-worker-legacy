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
