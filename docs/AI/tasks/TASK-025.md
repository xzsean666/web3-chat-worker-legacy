# TASK-025: Group Chat End-to-End Optimization (Cursor Pagination, DO Cache Invalidation, Supergroup Capacity Tiers & Composite Index)

## 1. Context & Motivation
Following the chat group capacity analysis, several optimization opportunities were identified to enhance scalability from 500 members to 100,000 members while maintaining complete backward compatibility and test stability:
1. **[Performance & OOM Prevention] Group Member Cursor Pagination**: `getGroupMembers` loaded and returned all members of a group in a single unpaginated array. For large groups, this created substantial memory pressure and transfer payload bloat.
2. **[Security & State Consistency] Instant MasterDO Invalidation on Kick/Mute/Role Changes**: When members were kicked, muted, or had their roles updated, `GroupBroadcasterDO` kicked the WebSocket connection, but `GroupMasterDO`'s in-memory permission and slow-mode cooldown state was not notified immediately.
3. **[Scalability & Commercial Tiers] Supergroup Capacity Tiers Expansion**: The capacity management system was constrained to 500 members (`MAX_CAPACITY = 500`), despite the underlying DO engine supporting 100,000 members. We need smooth tier escalation supporting 1,000 to 100,000 members.
4. **[Database Optimization] Composite Index on Member Relations**: Querying member relations and counting members in high-concurrency join paths benefits from a compound index on `(conversation_id, joined_at, id)`.

## 2. Plan of Changes
1. **Migration 0028**:
   - Create `migrations/0028_group_member_pagination_index.sql` with `idx_conv_members_conv_joined` on `conversation_members(conversation_id, joined_at ASC, id ASC)`.
2. **Member Cursor Pagination (`src/services/conversations.ts` & `src/routes/groups.ts`)**:
   - Extend `getGroupMembers` with optional `limit` and `cursor`.
   - Update `GET /groups/:id/members` to accept `limit` and `cursor`, returning `{ members, next_cursor, has_more, total }`.
   - Ensure backward compatibility: `members` array is always present, and when `limit` is not specified, all members are returned.
   - Update `GET /bot/groups/:id/members` in `src/routes/botOperations.ts` to support the same pagination params.
3. **MasterDO Cache Invalidation Endpoint & Group Route Notifications (`src/durable/GroupMasterDO.ts` & `src/routes/groups.ts`)**:
   - Add `/invalidate_cache` endpoint in `GroupMasterDO` to clear `lastSendMap`, handle membership role invalidations, and update memory guards.
   - In `src/routes/groups.ts`, call `notifyMasterDOInvalidateCache` whenever a member is kicked, leaves, has role modified, or is muted.
4. **Supergroup Capacity Tier Support (`src/services/payments/capacity.ts`)**:
   - Add `STANDARD_MAX_CAPACITY = 500`, `SUPERGROUP_MAX_CAPACITY = 100_000`, and `SUPERGROUP_TIERS = [1000, 2000, 5000, 10000, 50000, 100000]`.
   - Support supergroup capacity checks and nextTier computation while strictly preserving the 500 ceiling for standard commercial groups without supergroup flag or custom tiers.
## 3. Implementation Summary
- **Migration 0028**:
  - Added `migrations/0028_group_member_pagination_index.sql` creating `idx_conv_members_conv_joined` on `conversation_members(conversation_id, joined_at ASC, id ASC)`.
- **Member Cursor Pagination**:
  - Updated `getGroupMembers` in `src/services/conversations.ts` to accept `limit` and `cursor`.
  - Updated `GET /groups/:id/members` in `src/routes/groups.ts` and `GET /bot/groups/:id/members` in `src/routes/botOperations.ts` to return `{ members, next_cursor, has_more, total }`.
- **MasterDO Instant Cache Invalidation & In-Memory Guards**:
  - Added `invalidateUserCache` method and mounted `POST /invalidate_cache` in `src/durable/GroupMasterDO.ts`.
  - Added in-memory fast guards `kickedUsers`, `mutedUsers`, and `groupMutedUntil` in `postMessage`.
  - Integrated `notifyMasterDOInvalidateCache` in `src/routes/groups.ts` on leave, kick, role update, and group/member mutes.
- **Supergroup Capacity Escalation Tiers**:
  - Expanded `src/services/payments/capacity.ts` with `STANDARD_MAX_CAPACITY = 500`, `SUPERGROUP_MAX_CAPACITY = 100_000`, `SUPERGROUP_TIERS`, and `isSupergroup` detection.
  - Standard groups retain 500 ceiling while supergroups seamlessly escalate to 100,000 members.

## 4. Verification & Test Coverage
- Created `test/group_pagination_and_cache.test.ts` with 6 comprehensive integration tests covering:
  1. Multi-page cursor pagination with non-overlapping partitions, `total`, `has_more`, and unpaginated backward compatibility.
  2. In-memory MasterDO instant rejection of kicked users without DB queries, and recovery on rejoin.
  3. Group-wide mute and individual member mute enforcement in MasterDO memory with admin bypass.
  4. RPC `POST /invalidate_cache` handling.
  5. Capacity tier computation: standard groups up to 500, supergroups up to 100K.
  6. Supergroup detection via `is_supergroup` metadata and 1000-tier entitlement escalation.
- Ran full regression:
  - `pnpm run typecheck`: Passed (0 errors).
  - `pnpm test`: Passed (49/49 test files, 444/444 tests passing, 100% pass rate).
