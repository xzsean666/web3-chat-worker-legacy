# TASK-019: Telegram-like Bot System (Registration, Control & Open API Operations)

## Status
DONE

## Objectives
1. Implement a lightweight, Telegram-style bot mechanism without the complexity of BotFather conversational state machines.
2. Enable any authenticated wallet user to register and manage their own bots (`/bots`).
3. Issue a unique `bot_id` and secure plaintext `api_key` upon creation / reset, securely storing only `api_key_hash` in the database.
4. Integrate bots as native virtual users in the system (`users` table), ensuring full compatibility with conversations, memberships, messaging, and incremental sync (`/sync`).
5. Support adding bots to groups via `bot_id` or unique `username`.
6. Provide an intuitive Open Operations API (`/bot/*`) authenticated via `bot_id` and `api_key`.
7. Empower bots to perform group management operations (kick members, mute/unmute group, mute/unmute individual members, update group info, and leave group) when promoted to group admin.
8. Comprehensive test coverage for bot creation, credentials validation, group interaction, group administration, and lifecycle states.

## Key Changes
- **Database Migration**: Created `migrations/0025_bots.sql` defining `bots` table with indices on `owner_id`, `username`, and `api_key_hash`.
- **Entities & Schema**: Added `BotRow` interface to `src/db/schema.ts` and `src/types.ts`.
- **Service Layer**: Implemented `src/services/bots.ts`:
  - `createBot`: Atomically provisions bot and virtual user via `db.batch()`.
  - `listUserBots`: Lists bots owned by user without leaking plaintext keys.
  - `getBot`, `updateBot`, `deleteBot`: Bot lifecycle management.
  - `resetBotApiKey`: Invalidates old key and issues new credentials.
  - `validateBotCredentials`: Validates credentials and returns bot and virtual user.
  - `listBotConversations`, `botJoinGroup`: Group membership utilities for bots.
- **Middleware**: Created `src/middleware/botAuth.ts` supporting 5 credential injection modes:
  1. `X-Bot-Id` + `X-Bot-Key` / `X-Bot-Api-Key` headers
  2. `X-Bot-Token: <bot_id>:<api_key>` header
  3. `Authorization: Bearer <bot_id>:<api_key>` header
  4. Query parameters `?bot_id=...&api_key=...`
  5. JSON body `{ bot_id, api_key }`
- **User Routes**: Implemented `src/routes/bots.ts` mounted at `/bots` (creation, list, update, reset-key, delete).
- **Bot Operations Routes**: Implemented `src/routes/botOperations.ts` mounted at `/bot`:
  - `GET /bot/me`: Inspect bot self information.
  - `GET /bot/groups` & `GET /bot/conversations`: List groups the bot is in.
  - `GET /bot/groups/:id`: Get group details.
  - `GET /bot/groups/:id/members`: List group members.
  - `POST /bot/groups/join`: Join group via `group_id` or `invite_token`.
  - `POST /bot/messages/send`: Send text or sticker messages.
  - `GET /bot/conversations/:id/messages`: Read conversation messages.
  - `GET /bot/sync`: Incremental delta sync for bot.
  - `POST /bot/groups/:id/kick`: Kick group members.
  - `POST /bot/groups/:id/mute`: Mute/unmute entire group.
  - `POST /bot/groups/:id/mute-member`: Mute/unmute individual member.
  - `PATCH /bot/groups/:id`: Update group name, announcement, description.
  - `PUT /bot/groups/:id/members/:userId/role`: Promote/demote members (if bot is owner).
  - `POST /bot/groups/:id/leave`: Leave group.
- **Conversations & Auth Adaptation**:
  - `findOrCreateUser` updated to support lookup by `username`.
  - `assertCanSendMessage` updated to bypass direct chat mutual friendship requirement when one participant is a bot.
- **D1 Database Write Rules & Roundtrip Optimizations (DATABASE_BATCHING_RULES.md)**:
  - Atomic multi-statement writes: `createBot`, `updateBot`, and `deleteBot` strictly use `await db.batch([...])` to eliminate lock contention and execute in 1 roundtrip.
  - Roundtrip consolidation:
    - `validateBotCredentials` combines `bots` and `users` fetching into a single `JOIN` query (50% latency reduction).
    - `createBot` and `updateBot` merge username uniqueness checks across `bots` and `users` tables into a single `UNION ALL` query.
    - `assertCanSendMessage` consolidates blacklist checking, bot detection, and mutual friendship counting into a single composite query.
- **Test Suite**: Created `test/bots.test.ts` covering 19 test cases across all features.

## Verification
- `pnpm run typecheck`: Passed (0 errors).
- `pnpm test`: Passed (45/45 test files, 386/386 tests passed with 100% pass rate).
