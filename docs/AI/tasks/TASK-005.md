# TASK-005: Messaging Pipeline & Incremental Sync Engine

## Objective
Implement text message sending and high-performance message retrieval using cursor-based incremental sync (`after_id`) and multi-conversation `/sync`, filtering out expired messages.

## Scope
- `POST /conversations/:id/messages`: Send a message (text, `retention: 'permanent' | 'on_read'`, `expires_at` default 24h)
- `GET /conversations/:id/messages`: Retrieve messages in conversation with cursor support (`after_id`, `limit`)
- `GET /sync`: Delta sync endpoint fetching updates across all active user conversations since a timestamp or cursor
- Validation that sender is an active member of the conversation

## Allowed Files
- `src/routes/messages.ts`
- `src/routes/sync.ts`
- `src/services/messages.ts`
- `src/index.ts`
- `test/messages.test.ts`

## Dependencies
TASK-004

## Inputs and Outputs
- **Input**: Message payload (`content`, `type`, `retention`, `expires_in_seconds`), query parameters (`after_id`, `limit`, `since`).
- **Output**: Created message object, paginated message lists with cursor metadata (`next_cursor`, `has_more`).

## Acceptance Criteria
1. Sending a message succeeds only if user is a member of the conversation.
2. Messages store expiration time (`expires_at`), defaulting to 24 hours if unspecified.
3. Message query with `after_id` returns strictly newer messages in ascending order.
4. Messages that have passed `expires_at` are excluded from fetch results.
5. `/sync` returns delta messages grouped or ordered for all joined conversations.

## Verification Commands
- `pnpm test test/messages.test.ts`

## Risks and Assumptions
- SQLite sorting on indexed `created_at` or auto-incrementing ID ensures consistent cursor ordering.

## Status
DONE
