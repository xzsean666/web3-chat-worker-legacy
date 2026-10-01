# Task Index (TASK_INDEX.md)

| Task ID | Title | Dependencies | Status | Scope / Description |
| :--- | :--- | :--- | :--- | :--- |
| [TASK-001](tasks/TASK-001.md) | Project Skeleton, TypeScript, Wrangler & Vitest Setup | None | DONE | Initialize package.json, pnpm, wrangler, tsconfig, Hono app, and test runner |
| [TASK-002](tasks/TASK-002.md) | D1 Database Schema, Migrations & Storage Helper | TASK-001 | DONE | D1 SQL migration files, schema definitions, indices, and migration test runner |
| [TASK-003](tasks/TASK-003.md) | EVM Wallet Authentication & Session Management | TASK-002 | DONE | Nonce challenge, viem EIP-191 signature verify, session tokens, auth middleware |
| [TASK-004](tasks/TASK-004.md) | Conversation & Group Management | TASK-003 | DONE | Direct chats, group creation, member management, roles (owner, admin, member) |
| [TASK-005](tasks/TASK-005.md) | Messaging Pipeline & Incremental Sync Engine | TASK-004 | DONE | Send messages, cursor-based pagination (after_id), delta /sync endpoint |
| [TASK-006](tasks/TASK-006.md) | Explicit Delivery ACK & Burn-on-Read Lifecycle | TASK-005 | DONE | Client delivery ACK, read ACK, state transitions, burn-on-read destruction |
| [TASK-007](tasks/TASK-007.md) | Voice Message Storage (R2) & Synchronized Cleanup | TASK-006 | DONE | R2 audio upload, voice metadata in D1, dual-storage deletion on burn/read |
| [TASK-008](tasks/TASK-008.md) | Scheduled Expiration Cleanup & Cron Worker | TASK-007 | DONE | Scheduled cron handler to sweep expired messages and orphan R2 voice files |
| [TASK-009](tasks/TASK-009.md) | End-to-End Integration Verification & API Docs | TASK-008 | DONE | Full lifecycle E2E test suite, API documentation, and deployment guidelines |
| [TASK-010](tasks/TASK-010.md) | Group Chat 1:N Delivery Rollup, Burn-on-Read Synchronization & Message Receipts API | TASK-009 | DONE | Group delivery rollup, group burn-on-read synchronization, and receipts query API |
| [TASK-011](tasks/TASK-011.md) | Sovereign Groups, Address-as-User-ID & Conflict-Free State Merging | TASK-010 | DONE | Address-as-User-ID, deterministic direct IDs, sovereign group IDs, and multi-node merge SOP |
| [TASK-012](tasks/TASK-012.md) | Per-Recipient Burn-on-Read & Group Read-State Filtering | TASK-011 | DONE | Per-user burn response, per-user query filtering, voice download guard, and deferred full destruction |
| [TASK-013](tasks/TASK-013.md) | Image & File Messaging Support with Dual-Storage R2 Upload, Download & Destruction | TASK-012 | DONE | Image & file upload, download, metadata, dual-storage destruction, sweeper cleanup |
| [TASK-014](tasks/TASK-014.md) | User Dual-Metadata (Public/Private JSON) & Single Avatar Storage (R2) | TASK-013 | DONE | Public & private JSON user metadata, privacy controls, avatar upload, download & single-avatar limit |
| [TASK-015](tasks/TASK-015.md) | 30-Second Message Recall & 30-Second Burn-on-Read Viewing Window | TASK-014 | DONE | Configurable 30s message recall, R2 media purge on recall, 30s minimum burn-on-read viewing window |
| [TASK-016](tasks/TASK-016.md) | Social System: Friends List, Friend Tagging & Blacklist Enforcement | TASK-015 | DONE | Friends management, friend tags, blacklist management, 1:1 chat block enforcement, and message mentions |
| [TASK-017](tasks/TASK-017.md) | Group Metadata, Moderation (Mute System), Owner Kick, Member Leave & Admin Privileges | TASK-016 | DONE | Group metadata (name, intro, top marquee), group/member mute ("admin始终可以讲话"), owner kick, self leave |
| [TASK-018](tasks/TASK-018.md) | D1 Write Batching & Auto-Batching Engine Optimization | TASK-017 | DONE | D1WriteBatcher, withAutoBatch transparent proxy, RYOW pre-flush, statement chunking, and service batch writes |
| [TASK-019](tasks/TASK-019.md) | Telegram-like Bot System (Registration, Control & Open API Operations) | TASK-018 | DONE | Bot registration, virtual users, multiple credential auth, messaging, sync, and group administration |
| [TASK-020](tasks/TASK-020.md) | Comprehensive Performance Optimization (D1, CPU, R2 IO, In-Memory Caches & Auto-Batching) | TASK-019 | DONE | Covering/FK indexes migration, native base64 CPU boost, N+1 fix, D1 batching, isolate cache, R2 concurrency |
| [TASK-021](tasks/TASK-021.md) | 100K-Member Supergroup Architecture with Hierarchical Durable Objects, SQLite Storage & WebSockets | TASK-020 | DONE | GroupMasterDO, GroupBroadcasterDO, Hibernatable WS, 100ms coalescing, watermark ACK, and Auto-Batch |
| [TASK-022](tasks/TASK-022.md) | Decentralized Bot Specification V1.0 Alignment & Extensions | TASK-021 | DONE | bot_tasks, bot_audit_logs, structured events (/events), fixed capacity limit, scheduled tasks cron |
| [TASK-023](tasks/TASK-023.md) | Group Chat Production Hardening: Security, Performance & DO Optimizations | TASK-022 | DONE | SVG XSS fix, nosniff/CSP headers, protected metadata filtering, input bounds, rate limiting, leave/kick WS disconnect, DO multimedia broadcast, active shard unregister, watermark D1 sync, and bidirectional pagination |
| [TASK-024](tasks/TASK-024.md) | Comprehensive Audit & Production Hardening (Security, Storage & Performance) | TASK-023 | DONE | Image attachment Stored XSS defense (nosniff & SVG CSP sandbox), EVM block time drift tolerance (+120s), feed video storage lifecycle purge, default bot flood protection, rate limit D1 cleanup throttling, and route middleware scoping |
| [TASK-025](tasks/TASK-025.md) | Group Chat End-to-End Optimization (Cursor Pagination, DO Cache Invalidation, Supergroup Capacity Tiers & Composite Index) | TASK-024 | DONE | Group member cursor pagination, instant MasterDO cache invalidation on kick/mute/role changes, supergroup capacity tiers expansion up to 100K, and composite database indexes |
| [TASK-026](tasks/TASK-026.md) | Supergroup Architecture Hardening (Async Fan-out, Adaptive Flood Damping & Subrequest Pooling) | TASK-025 | DONE | Non-blocking async fan-out RPCs, 10-shard subrequest pooling, adaptive velocity flood damping, compact WebSocket frames, and fast-path DO integration |




