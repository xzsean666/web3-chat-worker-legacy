# Project Goal: Web3 Chat Worker MVP

## 1. Executive Summary
Build a high-performance, single-node Cloudflare Worker backend for a Web3 Chat MVP. The service uses EVM wallet signature authentication, Cloudflare D1 for relational persistence, and Cloudflare R2 for voice audio object storage. It supports ephemeral messaging with explicit client delivery ACK, burn-on-read, voice file destruction, and incremental sync for client pull efficiency.

## 2. In-Scope MVP Features
1. **EVM Wallet Authentication**:
   - Nonce challenge generation (`POST /auth/nonce`).
   - EIP-191 personal_sign verification (`POST /auth/verify`).
   - Bearer session token issuance, validation, and revocation (`POST /auth/logout`, `GET /auth/me`).
2. **Conversations & Groups**:
   - 1-to-1 direct chat creation and discovery.
   - Group chat creation with roles (`owner`, `admin`, `member`), member add/remove/leave.
3. **Messages (Text & Voice)**:
   - Text message sending & retrieval.
   - Voice upload to Cloudflare R2 with D1 metadata tracking (`duration`, `mime_type`, `size`, `object_key`).
4. **Delivery & Read Acknowledgement (ACK)**:
   - Explicit client delivery ACK (`POST /messages/ack`) - HTTP 200 is not treated as delivered.
   - Read ACK (`POST /messages/read`).
   - Message lifecycle states: `pending` -> `delivered` -> `read` -> `expired` / `deleted`.
5. **Burn-on-Read & Lifecycle Destruction**:
   - `retention: "permanent" | "on_read"`.
   - On Read ACK, `on_read` messages are deleted immediately from D1 (and R2 if voice).
6. **Message Expiration**:
   - `expires_at` timestamp.
   - Messages past `expires_at` are lazily filtered out and purged.
7. **Performance & Client Interaction**:
   - Cursor-based / incremental sync (`GET /conversations/:id/messages?after_id=...&limit=...` or `/sync`).
   - Batch ACK capabilities (`message_ids: string[]`) to minimize mobile/web roundtrips.
   - Lightweight JSON responses.
8. **Scheduled Maintenance**:
   - Cloudflare Worker scheduled cron trigger (`crons = ["* * * * *"]`) to sweep expired messages and unreferenced R2 files.

## 3. Non-Goals
- Multi-Worker synchronization or external coordination clusters.
- Federation / Matrix-like protocols.
- P2P messaging.
- Real-time WebRTC / audio-video streaming.
- Complex IM features (push notification gateway integration, rich link unfurling, stickers).
