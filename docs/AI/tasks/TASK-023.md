# TASK-023: Group Chat Production Hardening: Security, Performance & DO Optimizations

## Status
DONE

## Objectives
Based on a comprehensive production readiness audit of group chat security and performance, implement all critical hardening measures:
1. **Stored XSS Defense**: Disallow SVG image format in avatar uploads (both user profile and group avatars); add `X-Content-Type-Options: nosniff` and CSP headers when serving avatars.
2. **Metadata Mass Assignment & Input Bounds**: Filter protected administrative metadata keys (`hot`, `verified`, `banned_reason`, `is_banned`, `join_gate`, `join_price`) in group creation and updates; enforce maximum lengths (name <= 64 chars, description <= 1000 chars, announcement <= 2000 chars, metadata JSON <= 10KB).
3. **Message Input Bounds & Rate Limiting**: Bound message content to 4000 characters and mentions to 50; enforce rate limiting on message sending (120 msgs/min per user) and group lifecycle actions (group creation, invite links, join requests) using D1 fixed windows (`allow(...)`).
4. **WebSocket Disconnection Enforcement**: Automatically disconnect and close WebSocket connections via BroadcasterDO RPC (`kickUserConnection`) when a member voluntarily leaves (`POST /groups/:id/leave`), is kicked (`POST /groups/:id/kick`), or is removed (`DELETE /groups/:id/members/:userId`).
5. **Real-time Multimedia WebSocket Broadcast**: Bridge voice, image, and file uploads (`/voice/upload`, `/images/upload`, `/files/upload`) and group system events to `GROUP_MASTER_DO` so connected supergroup WebSocket clients receive immediate broadcasts.
6. **Active Shard Lifecycle**: Prevent shard leaks and connection stampedes by registering with MasterDO only on the first socket connection (0 -> 1) and unregistering when the last socket disconnects (count == 0).
7. **Watermark D1 Synchronization**: In `GroupMasterDO.updateWatermarks`, resolve latest read `message_id` and batch update D1 `conversation_members.last_read_message_id` and `message_receipts`, ensuring offline badge count consistency.
8. **Bidirectional History Pagination**: Support backward history pagination via `before_seq` in `GET /groups/:id/supergroup/messages` and `before_id` in `GET /conversations/:id/messages`.

## Verification
- `pnpm run typecheck`: Passed with 0 errors.
- `pnpm test`: All 48 test files and 434 tests passed.
- Dedicated test suite `test/group_optimizations.test.ts`: 13 comprehensive tests covering all security, performance, and DO lifecycle upgrades.
