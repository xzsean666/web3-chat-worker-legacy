# Project Rules (AGENTS.md)

## 1. Tooling & Package Manager
- Node.js: Always use `pnpm` (`pnpm install`, `pnpm test`, `pnpm build`, etc.).
- Python: Always use `uv` (if applicable).
- Git PR: Always use `gh` for pull requests.

## 2. Agent Principles
- Strict single-task progression: One Goal and one active Task per session.
- No destructive git operations (`reset`, `checkout`, recursive deletion, etc.).
- Do not commit, push, or publish unless explicitly requested.
- Verify everything with real executable commands; never claim a test passed without running it.
- Keep documentation in sync across sessions (`docs/AI/SESSION_STATE.md`, `docs/AI/TASK_INDEX.md`, task files).

## 3. Architecture Constraints
- Cloudflare Worker single-node architecture (no multi-worker, no federation, no P2P).
- Cloudflare D1 for SQLite relational data (users, sessions, nonces, conversations, messages, receipts, voice metadata).
- Cloudflare R2 for voice binary objects.
- Explicit ACK model: HTTP 200 is only an API receipt; delivery requires active ACK from receiver client.
- Expiration and burn-on-read strictly clean up D1 and R2 together.
- Support incremental sync (cursor/since_id) for optimal client pull performance.
