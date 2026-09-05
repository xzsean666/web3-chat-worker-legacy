# Web3 Chat Worker

High-performance, single-node Cloudflare Worker backend for ephemeral Web3 chat. Features EVM wallet authentication (EIP-191), relational persistence in Cloudflare D1 (SQLite), audio binary storage in Cloudflare R2, an explicit client delivery ACK protocol, synchronized dual-storage burn-on-read destruction, and incremental sync engines.

---

## Architecture & Design Principles

```
               +-------------------------------------------+
               |             Web3 Client                   |
               | (EVM Wallet: MetaMask / Rabby / Phantom)   |
               +-------------------------------------------+
                                     |
                                     | HTTPS (REST / JSON)
                                     v
               +-------------------------------------------+
               |        Cloudflare Worker (Hono API)       |
               +---------------------+---------------------+
                                     |
                +--------------------+--------------------+
                |                                         |
                v                                         v
   +-------------------------+               +-------------------------+
   |   Cloudflare D1 (DB)    |               |   Cloudflare R2 Bucket  |
   | (Users, Sessions,       |               |      (Voice Files)      |
   |  Conversations, Groups, |               +-------------------------+
   |  Messages, Receipts)    |
   +-------------------------+
```

1. **Cloudflare Worker Single-Node Architecture**: Zero multi-worker coordination complexity, ultra-low latency edge V8 execution.
2. **EVM Challenge-Response Authentication**: Nonce generation with EIP-191 `personal_sign` signature recovery using `viem`. High-entropy Bearer session tokens with SHA-256 hash storage in D1.
3. **Explicit Client Delivery & Read ACK Model**:
   - HTTP 200 upon message sending is only an API receipt.
   - Message status transitions from `pending` -> `delivered` only when the recipient client explicitly acknowledges receipt (`POST /messages/:id/ack` or batch `/messages/ack`).
   - Senders are strictly prevented from acknowledging delivery or read receipts of their own messages.
4. **Dual-Storage Synchronized Destruction (Burn-on-Read)**:
   - When a message with `retention: "on_read"` receives a read acknowledgement (`POST /messages/:id/read`), the backend atomically removes audio binary objects from Cloudflare R2 and deletes the relational row from Cloudflare D1.
5. **Incremental Sync Engine**:
   - **Cursor Sync (`GET /conversations/:id/messages?after_id=...&limit=...`)**: Fetches ordered delta messages newer than the specified cursor.
   - **Global Sync (`GET /sync?since=...`)**: Single roundtrip retrieval of updates across all joined conversations for battery- and bandwidth-constrained mobile clients.
   - **Batch ACK (`POST /messages/ack`, `POST /messages/read`)**: Allows batch acknowledgement of message IDs.
6. **Automated Scheduled Sweeper**:
   - Cloudflare Worker scheduled cron handler runs every minute (`crons = ["* * * * *"]`) to sweep expired messages and orphan voice binaries.

---

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: [Hono](https://hono.dev/) v4
- **Database**: Cloudflare D1 (SQLite)
- **Object Storage**: Cloudflare R2
- **Web3 & Cryptography**: [viem](https://viem.sh/) (EIP-191 `verifyMessage`), Web Crypto API (`crypto.subtle`, `crypto.randomUUID`)
- **Package Manager**: `pnpm`
- **Testing**: [Vitest](https://vitest.dev/) with Node 24 native SQLite test fixtures

---

## Getting Started

### Prerequisites

- Node.js >= 20 (Node 24 recommended)
- `pnpm` installed (`corepack enable pnpm` or `npm install -g pnpm`)
- Cloudflare Wrangler CLI (installed via devDependencies)

### Installation

```bash
git clone <repository-url>
cd web3-chat-worker
pnpm install
```

### Type Checking & Testing

```bash
# Run TypeScript typecheck
pnpm run typecheck

# Run full automated test suite (Unit, Integration & E2E)
pnpm test

# Run live E2E integration test against deployed Cloudflare Worker
pnpm run test:live
# (Custom endpoint: WORKER_URL=https://your-worker.workers.dev pnpm run test:live)
```

### Local Development

Start the local Worker emulator using Wrangler:

```bash
pnpm dev
```

---

## Cloudflare Deployment

### 1. Create Cloudflare D1 Database

```bash
npx wrangler d1 create web3-chat-db
```

Update your `database_id` in `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "web3-chat-db",
    "database_id": "<YOUR_D1_DATABASE_ID>",
    "migrations_dir": "migrations"
  }
]
```

### 2. Apply Schema Migrations

```bash
# Local development database
npx wrangler d1 execute web3-chat-db --local --file=./migrations/0001_initial_schema.sql

# Production remote database
npx wrangler d1 execute web3-chat-db --remote --file=./migrations/0001_initial_schema.sql
```

### 3. Create Cloudflare R2 Bucket

```bash
npx wrangler r2 bucket create web3-chat-voice
```

Ensure the binding name in `wrangler.jsonc` matches:

```jsonc
"r2_buckets": [
  {
    "binding": "VOICE_BUCKET",
    "bucket_name": "web3-chat-voice"
  }
]
```

### 4. Deploy to Cloudflare

```bash
pnpm run deploy
```

---

## API Reference

All protected endpoints require an HTTP header:
`Authorization: Bearer <session_token>`

### 1. Authentication (`/auth`)

#### `POST /auth/nonce`
Generate a single-use 5-minute authentication challenge for an EVM wallet address.
- **Request Body**:
  ```json
  { "wallet_address": "0x71c...8976f" }
  ```
- **Response**: `200 OK`
  ```json
  {
    "nonce": "4b68e99999a4...",
    "message": "Sign this message to authenticate with Web3 Chat:\nNonce: 4b68e99999a4...",
    "expires_at": 1725514800000
  }
  ```

#### `POST /auth/verify`
Verify an EIP-191 `personal_sign` signature over the challenge message, create user if first time, and issue a Bearer session token.
- **Request Body**:
  ```json
  {
    "wallet_address": "0x71c...8976f",
    "signature": "0x14eda...",
    "nonce": "4b68e99999a4..." // optional, defaults to latest active nonce
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "token": "a4d9f0...",
    "user": {
      "id": "u_uuid",
      "wallet_address": "0x71c...8976f",
      "created_at": 1725511200000,
      "updated_at": 1725511200000
    },
    "session": {
      "id": "s_uuid",
      "user_id": "u_uuid",
      "expires_at": 1728103200000
    }
  }
  ```

#### `GET /auth/me`
Return currently authenticated user profile.
- **Response**: `200 OK`
  ```json
  {
    "user": { "id": "u_uuid", "wallet_address": "0x71c...8976f" }
  }
  ```

#### `POST /auth/logout`
Revoke active session token immediately.
- **Response**: `200 OK` `{ "success": true }`

---

### 2. Conversations & Groups (`/conversations`, `/groups`)

#### `POST /conversations`
Create or retrieve an idempotent direct 1-to-1 conversation.
- **Request Body**:
  ```json
  { "target_user_id": "u_target" }
  ```
  *(or `{ "target_wallet_address": "0x..." }`)*
- **Response**: `201 Created` returns conversation details and member list.

#### `GET /conversations`
List all conversations the authenticated user belongs to with member counts.
- **Response**: `200 OK`
  ```json
  {
    "conversations": [
      { "id": "c_uuid", "type": "direct", "name": null, "role": "owner", "member_count": 2 }
    ]
  }
  ```

#### `GET /conversations/:id`
Get conversation metadata and members.
- **Response**: `200 OK`

#### `POST /groups`
Create a group conversation with the creator assigned as `owner`.
- **Request Body**:
  ```json
  {
    "name": "Web3 BUIDLers",
    "member_ids": ["u_bob", "u_charlie"]
  }
  ```
- **Response**: `201 Created`

#### `PATCH /groups/:id`
Update group name (`owner` or `admin` only).
- **Request Body**: `{ "name": "New Name" }`

#### `POST /groups/:id/members`
Add member to group (`owner` or `admin` only).
- **Request Body**: `{ "user_id": "u_dave", "role": "member" }`

#### `DELETE /groups/:id/members/:userId`
Remove member from group (`owner` can remove anyone, `admin` can remove `member`, or any member can leave).

---

### 3. Messaging & Incremental Sync

#### `POST /conversations/:id/messages`
Send a text message.
- **Request Body**:
  ```json
  {
    "content": "Secret rendezvous point",
    "retention": "on_read",         // "permanent" (default) or "on_read"
    "expires_in_seconds": 86400    // optional, defaults to 24h
  }
  ```
- **Response**: `201 Created` with initial status `"pending"`.

#### `GET /conversations/:id/messages`
Fetch messages in conversation with incremental cursor pagination.
- **Query Parameters**:
  - `after_id`: Message ID of previous sync cursor.
  - `limit`: Number of messages (1–100, default 50).
- **Response**: `200 OK`
  ```json
  {
    "messages": [ ... ],
    "next_cursor": "m_latest_id",
    "has_more": false
  }
  ```

#### `GET /sync`
High-performance multi-conversation delta sync for mobile/browser clients.
- **Query Parameters**:
  - `since`: UNIX timestamp in ms.
  - `limit`: Number of messages (1–200, default 100).
- **Response**: `200 OK`
  ```json
  {
    "messages": [ ... ],
    "sync_timestamp": 1725514000000,
    "has_more": false
  }
  ```

---

### 4. Delivery & Read Acknowledgements (`/messages`)

#### `POST /messages/:id/ack` & `POST /messages/ack`
Explicit client delivery acknowledgement upon downloading messages.
- **Batch Body**: `{ "message_ids": ["m1", "m2"] }`
- **Effect**: Records receipt in `message_receipts`.
  - In **1:1 chats**: transitions `messages.status` from `pending` -> `delivered` immediately.
  - In **1:N group chats**: records per-recipient delivery; transitions aggregate `messages.status` to `delivered` only when **all** other group members have acknowledged delivery.

#### `POST /messages/:id/read` & `POST /messages/read`
Read acknowledgement when the user views the message.
- **Batch Body**: `{ "message_ids": ["m1", "m2"] }`
- **Effect**:
  - For `permanent` messages: Transitions status to `read` (when all recipients have read in groups).
  - For `on_read` messages:
    - In **1:1 chats**: Atomically destroys the message row in D1 and R2 audio binary immediately.
    - In **1:N group chats**: Delays destruction until **all** recipients have read the message (ensuring no member misses it), or until `expires_at` cron sweeper purges it.

#### `GET /messages/:id/receipts`
Inspect delivery and read progress for each recipient in direct or group chats.
- **Access**: Restricted to conversation members.
- **Response**: `200 OK`
  ```json
  {
    "message_id": "m_uuid",
    "conversation_id": "c_uuid",
    "sender_id": "u_alice",
    "total_recipients": 2,
    "delivered_count": 2,
    "read_count": 1,
    "all_delivered": true,
    "all_read": false,
    "receipts": [
      {
        "user_id": "u_bob",
        "wallet_address": "0x123...bob",
        "status": "read",
        "delivered_at": 1725514000000,
        "read_at": 1725514005000
      },
      {
        "user_id": "u_charlie",
        "wallet_address": "0x456...charlie",
        "status": "delivered",
        "delivered_at": 1725514002000,
        "read_at": null
      }
    ]
  }
  ```

---

### 5. Voice Messages (`/voice`)

#### `POST /voice/upload`
Upload an audio binary. Supports both `multipart/form-data` and JSON (Base64).
- **Multipart Fields**:
  - `file`: Binary audio file (`audio/webm`, `audio/mp3`, `audio/ogg`, `audio/wav`, `audio/aac`).
  - `conversation_id`: Target conversation ID.
  - `duration`: Audio duration in seconds (e.g. `5.2`).
  - `retention`: `"permanent"` or `"on_read"`.
  - `expires_in_seconds`: Expiration in seconds.
- **Response**: `201 Created`
  ```json
  {
    "message": { "id": "m_voice_id", "type": "voice", "status": "pending" },
    "voice": {
      "id": "v_id",
      "object_key": "voice/m_voice_id.webm",
      "duration": 5.2,
      "size": 64512
    }
  }
  ```

#### `GET /voice/:messageId`
Stream and download audio binary directly from R2. Returns `200 OK` with `Content-Type` matching audio format. Returns `403` if requester is not a member, or `404` if destroyed/expired.

---

### 6. Scheduled Sweeper & Admin Maintenance

#### `POST /admin/cleanup`
Manually invoke expiration sweeper.
- **Response**: `200 OK`
  ```json
  {
    "purged_messages": 5,
    "deleted_voice_objects": 2,
    "timestamp": 1725514800000
  }
  ```

---

## License

MIT License.
