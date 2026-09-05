# TASK-011: Sovereign Groups, Address-as-User-ID & Conflict-Free State Merging

## Objective
Refactor the user and conversation identifier model into a decentralized, self-certifying architecture:
1. Address-as-User-ID: normalized EVM wallet address (`0x...`) directly serves as `user.id`.
2. Deterministic Direct Conversations: `direct:min(addrA, addrB):max(addrA, addrB)`.
3. Self-Certifying Sovereign Groups: `${owner_address}:${slug_or_salt}` with immutable single ownership.
4. Conflict-free multi-node / multi-Worker state merging support (LWW on `updated_at`, idempotent member union).
5. Comprehensive data merge guide (`docs/CLOUDFLARE_DATA_MERGE.md`).

## Dependencies
- TASK-010

## Scope & Implementation Details
1. **D1 Migration**:
   - Add `migrations/0002_sovereign_groups.sql` adding `owner_address` column and index on `conversations`.
   - Update `test/helpers/db.ts` to automatically discover and execute all migrations in sequence.
2. **Entity Types & DB Schema**:
   - `src/db/schema.ts`: Update `ConversationRow` to include `owner_address: string | null`, `ConversationMemberRow` role to `'owner' | 'member'`.
   - `src/types.ts`: `MemberRole` updated to `'owner' | 'member'`.
3. **Services & Auth**:
   - `src/services/auth.ts`: Ensure `user.id` is always the normalized lowercased `wallet_address`.
   - `src/services/conversations.ts`:
     - Implement `findOrCreateUser` auto-provisioning addresses.
     - Deterministic direct conversation IDs (`direct:min:max`).
     - Sovereign group IDs with `${owner_address}:${slug}`.
     - Immutable single-owner model: only owner can rename, add, or remove members. If owner leaves, the group is dismissed.
4. **Routes**:
   - `src/routes/groups.ts`: Support optional `slug` parameter in `POST /groups`.
5. **Testing & Verification**:
   - Update tests in `test/conversations.test.ts` to enforce owner-only group management permissions.
   - Verify all 43 vitest tests pass across all 9 suites.
   - Apply remote D1 migration `0002_sovereign_groups.sql`.
   - Deploy to Cloudflare Worker and execute `scripts/live-e2e.ts` verifying all 10 live steps.
6. **Documentation**:
   - Create `docs/CLOUDFLARE_DATA_MERGE.md` explaining conflict-free merging math, SQL SOP, and FAQs.
   - Update `docs/AI/ARCHITECTURE.md`, `docs/AI/DECISIONS.md` (ADR-007), `README.md`, and `docs/FRONTEND_INTEGRATION.md`.

## Acceptance Criteria
- [x] All users identified by lowercased EVM wallet address (`0x...`).
- [x] Group IDs strictly bound to owner wallet address.
- [x] Direct conversation IDs deterministic across independent nodes.
- [x] Only owner can modify group metadata or membership; owner cannot be transferred.
- [x] 100% test pass rate locally and on live Cloudflare production.
- [x] Detailed cross-node data merge documentation created.
