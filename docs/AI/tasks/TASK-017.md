# TASK-017: Group Metadata, Moderation (Mute System), Owner Kick, Member Leave & Admin Privileges

## Status
DONE

## Dependencies
- TASK-016

## Objectives
1. Group Metadata Integration:
   - Extend `conversations` with `metadata TEXT NOT NULL DEFAULT '{}'` (JSON object).
   - Support updating group name (`name`), group description (`description`), and top marquee scrolling configuration (`marquee: { enabled, text, speed }`) in group metadata.
   - Automatically synchronize `conversations.name` with `metadata.name`.
2. Group Moderation & Mute System:
   - Group-wide mute (`POST /groups/:id/mute` / `unmute`) supporting indefinite and timed mute durations.
   - Individual member mute list (`POST /groups/:id/members/:userId/mute` / `unmute`) supporting reason and durations.
   - Admin exemption: group owner and admins can ALWAYS speak under any mute condition ("admin始终可以讲话").
   - Query muted status and member list (`GET /groups/:id/muted`).
   - Enforce mute restrictions across text, voice, image, and file messages (returning HTTP 403 Forbidden).
3. Member Management & Leaving:
   - Group owner can kick/delete members (`DELETE /groups/:id/members/:userId`, `POST /groups/:id/kick`).
   - Members can leave the group (`POST /groups/:id/leave`, `DELETE /groups/:id/members/me`).
   - Group owner can manage administrator roles (`PUT /groups/:id/members/:userId/role`).
4. Full Verification & Live E2E:
   - Comprehensive unit and integration tests covering all mute, metadata, kick, leave, and admin features.
   - Apply D1 migration `0005_group_metadata_and_moderation.sql` locally and remotely.
   - Deploy Cloudflare Worker and execute `scripts/live-e2e.ts` end-to-end verification.
   - Update `docs/FRONTEND_INTEGRATION.md`, `README.md`, `docs/AI/ARCHITECTURE.md`, `docs/AI/DECISIONS.md`, and session documentation.

## Verification
- Unit & integration tests in `test/group_features.test.ts` (7 tests passing).
- Full Vitest suite: 77/77 tests passing across 15 test files.
- Live E2E test on Cloudflare production (`scripts/live-e2e.ts`): 17/17 steps passed.
