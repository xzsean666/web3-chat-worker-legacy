# TASK-006: Explicit Delivery ACK & Burn-on-Read Lifecycle

## Objective
Implement client explicit delivery ACK protocol, Read ACK protocol, lifecycle state progression (`pending` -> `delivered` -> `read` -> `deleted`), and automatic burn-on-read destruction.

## Scope
- `POST /messages/:id/ack` & `POST /messages/ack` (batch): Mark messages as delivered by receiver client
- `POST /messages/:id/read` & `POST /messages/read` (batch): Mark messages as read by receiver client
- Update `message_receipts` table for multi-user audit
- Burn-on-read execution: if `retention === 'on_read'`, delete message immediately upon Read ACK
- Guard against sender acknowledging their own message as delivery/read receipt

## Allowed Files
- `src/routes/messages.ts`
- `src/services/messages.ts`
- `src/services/destruction.ts`
- `test/receipts.test.ts`

## Dependencies
TASK-005

## Inputs and Outputs
- **Input**: Message IDs to acknowledge or mark read.
- **Output**: ACK confirmation, updated status, or confirmation of burned message deletion.

## Acceptance Criteria
1. Client delivery ACK transitions message status from `pending` to `delivered`.
2. Sender cannot send delivery ACK for their own message.
3. Read ACK transitions status to `read` when retention is `permanent`.
4. When `retention === 'on_read'`, Read ACK deletes the message row from D1 immediately.
5. Once deleted by burn-on-read, subsequent message queries cannot find the message.
6. Batch ACK endpoint processes multiple IDs in a single request.

## Verification Commands
- `pnpm test test/receipts.test.ts`

## Risks and Assumptions
- For 1-to-1 chats, single recipient ACK directly changes `status` on `messages`. For groups, `message_receipts` records individual ACKs.

## Status
DONE
