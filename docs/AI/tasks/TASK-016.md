# TASK-016: Social System: Friends List, Friend Tagging & Blacklist Enforcement

## Status
DONE

## Dependencies
- TASK-015

## Objectives
1. Implement Friends Management:
   - Add/manage friends (`POST /friends`, `GET /friends`, `GET /friends/:address`, `PATCH /friends/:address`, `DELETE /friends/:address`).
   - Custom friend alias (display name) and tags array.
   - Filter friends by tag (`GET /friends?tag=crypto`).
   - Query all friend tags (`GET /friends/tags`).
   - Add/update friend tags (`POST /friends/:address/tags`).
2. Implement Blacklist Management:
   - Block/unblock addresses (`POST /blacklist`, `GET /blacklist`, `DELETE /blacklist/:address`).
3. Enforce Chat Blocking:
   - Prevent blocked users from sending direct messages to the blocker (403 Forbidden).
   - Prevent blocked users from initiating direct conversations with the blocker (403 Forbidden).
4. Implement Message Mentions / Tagging:
   - Allow tagging/mentioning users in messages (`mentions?: string[]`).

## Verification
- Verified with unit & integration tests in `test/social.test.ts` (3 tests passing).
- Typecheck verified with `pnpm run typecheck`.
