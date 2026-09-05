# TASK-004: Conversation & Group Management

## Objective
Implement 1-to-1 direct conversations and group chat management, including role-based access control (owner, admin, member) for group membership and conversation retrieval.

## Scope
- `POST /conversations`: Create or find existing 1-to-1 direct conversation between two users
- `GET /conversations`: List all conversations the authenticated user belongs to
- `GET /conversations/:id`: Get conversation metadata and member list
- `POST /groups`: Create group conversation with creator as `owner`
- `PATCH /groups/:id`: Update group name (owner/admin only)
- `POST /groups/:id/members`: Add user to group (owner/admin only)
- `DELETE /groups/:id/members/:userId`: Remove user or leave group (owner/admin or self)

## Allowed Files
- `src/routes/conversations.ts`
- `src/routes/groups.ts`
- `src/services/conversations.ts`
- `src/index.ts`
- `test/conversations.test.ts`

## Dependencies
TASK-003

## Inputs and Outputs
- **Input**: Conversation creation parameters, member IDs, role actions.
- **Output**: Conversation objects, member lists, HTTP status responses.

## Acceptance Criteria
1. Direct conversations between the same two users are idempotent (returns existing conversation).
2. Users can only access conversations they are members of.
3. Group owner/admin can add/remove members; regular members cannot remove others.
4. Members can leave a group; owner leaving requires transfer or closes group.

## Verification Commands
- `pnpm test test/conversations.test.ts`

## Risks and Assumptions
- Direct conversations must have exactly 2 distinct members.

## Status
DONE
