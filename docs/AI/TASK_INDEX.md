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

