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
    | (Users, Sessions,       |               | (Voice, Images & Files) |
    |  Conversations, Groups, |               +-------------------------+
    |  Messages, Receipts,    |
    |  Media Metadata)        |
    +-------------------------+
```

1. **Cloudflare Worker Single-Node Architecture**: Zero multi-worker coordination complexity, ultra-low latency edge V8 execution.
2. **EVM Challenge-Response Authentication**: Nonce generation with EIP-191 `personal_sign` signature recovery using `viem`. High-entropy Bearer session tokens with SHA-256 hash storage in D1.
3. **Explicit Client Delivery & Read ACK Model**:
   - HTTP 200 upon message sending is only an API receipt.
   - Message status transitions from `pending` -> `delivered` only when the recipient client explicitly acknowledges receipt (`POST /messages/:id/ack` or batch `/messages/ack`).
   - Senders are strictly prevented from acknowledging delivery or read receipts of their own messages.
4. **Dual-Storage Synchronized Destruction & 30s Burn Window**:
   - Ephemeral messages (`retention: "on_read"`) allow recipients at least a 30-second viewing window upon reading before filtering out.
   - Once all recipients have read and their viewing windows elapse, the backend atomically purges binary objects from Cloudflare R2 and relational rows from Cloudflare D1.
5. **30-Second Message Recall**:
   - Message senders can recall messages within 30 seconds (`POST /messages/:id/recall`). Media assets in R2 are purged immediately upon recall.
6. **User Dual-Metadata & Single Avatar in R2**:
   - Each user maintains `public_metadata` (readable by everyone) and `private_metadata` (readable only by the user). Both are editable solely by the user.
   - Users can maintain exactly one avatar in R2; uploading a new avatar automatically purges the old one.
7. **Social Graph: Friends, Tags & Blacklist**:
   - Friend management with custom aliases and arbitrary tag categorization (`/friends`, `/friends/tags`).
   - Blacklist enforcement (`/blacklist`) prevents blocked users from initiating 1:1 chats or messaging the blocker with HTTP 403.
8. **Incremental Sync Engine**:
   - **Cursor Sync (`GET /conversations/:id/messages?after_id=...&limit=...`)**: Fetches ordered delta messages newer than the specified cursor.
   - **Global Sync (`GET /sync?since=...`)**: Single roundtrip retrieval of updates across all joined conversations for battery- and bandwidth-constrained mobile clients.
   - **Batch ACK (`POST /messages/ack`, `POST /messages/read`)**: Allows batch acknowledgement of message IDs.
9. **Automated Scheduled Sweeper**:
   - Cloudflare Worker scheduled cron handler runs every minute (`crons = ["* * * * *"]`) to sweep expired messages and orphan voice binaries.
10. **Telegram-like Bot System & Open API**:
   - Anyone can register their own bot via `POST /bots` without BotFather complexity.
   - Bots are system virtual users, enabling native group messaging, direct chats without friendship blocks, and full incremental sync.
   - Open Bot Operations API (`/bot/*`) authenticated via `bot_id` + `api_key` allows external programs to send messages, kick violators, mute groups/members, and manage announcements. See [`docs/BOT_INTEGRATION_GUIDE.md`](docs/BOT_INTEGRATION_GUIDE.md).

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
      "id": "0x71c...8976f",
      "wallet_address": "0x71c...8976f",
      "created_at": 1725511200000,
      "updated_at": 1725511200000
    },
    "session": {
      "id": "s_uuid",
      "user_id": "0x71c...8976f",
      "expires_at": 1728103200000
    }
  }
  ```

#### `GET /auth/me`
Return currently authenticated user profile.
- **Response**: `200 OK`
  ```json
  {
    "user": { "id": "0x71c...8976f", "wallet_address": "0x71c...8976f" }
  }
  ```

#### `POST /auth/logout`
Revoke active session token immediately.
- **Response**: `200 OK` `{ "success": true }`

---

### 2. Sovereign Groups & Conversations (`/conversations`, `/groups`)

> [!TIP]
> **Conflict-Free Multi-Node Merging**: User IDs are normalized EVM addresses (`0x...`). Direct chat IDs are deterministic (`direct:minAddress:maxAddress`). Group IDs are self-certifying (`${owner_address}:${slug}`). Groups have immutable single-ownership, enabling zero-conflict state merging across multiple Cloudflare Workers. See [CLOUDFLARE_DATA_MERGE.md](docs/CLOUDFLARE_DATA_MERGE.md) for details.

#### `POST /conversations`
Create or retrieve an idempotent, deterministic direct 1-to-1 conversation (`direct:min:max`).
- **Request Body**:
  ```json
  { "target_user_id": "0xbob..." }
  ```
  *(or `{ "target_wallet_address": "0xbob..." }`)*
- **Response**: `201 Created` returns conversation details and member list.

#### `GET /conversations`
List all conversations the authenticated user belongs to with member counts.
- **Response**: `200 OK`
  ```json
  {
    "conversations": [
      { "id": "direct:0xalice...:0xbob...", "type": "direct", "name": null, "role": "member", "member_count": 2 },
      { "id": "0xalice...:buidlers", "type": "group", "name": "Web3 BUIDLers", "role": "owner", "member_count": 3 }
    ]
  }
  ```

#### `GET /conversations/:id`
Get conversation metadata and members.
- **Response**: `200 OK`

#### `POST /groups`
Create a sovereign group conversation with initial metadata (description, announcement, marquee scrolling config).
- **Request Body**:
  ```json
  {
    "name": "Web3 BUIDLers",
    "description": "Welcome to the Web3 BUIDLers community!",
    "announcement": "Pinned: Contract audit completed.",
    "marquee": {
      "enabled": true,
      "text": "Welcome to the Web3 BUIDLers community!",
      "speed": 50
    },
    "member_ids": ["0xbob...", "0xcharlie..."],
    "slug": "buidlers" // optional, defaults to 8-char random hex
  }
  ```
- **Response**: `201 Created` (ID format: `0xcreatorAddress:slug`), returns parsed `metadata` object.

#### `PATCH /groups/:id` / `PATCH /groups/:id/metadata`
Update group name, description, and top marquee scrolling configuration (`owner` or `admin` only).
- **Request Body**:
  ```json
  {
    "name": "Web3 Super Builders",
    "description": "Updated group description.",
    "marquee": {
      "enabled": true,
      "text": "Breaking announcement: Live demo today!"
    }
  }
  ```
- **Response**: `200 OK` returns updated conversation with synchronized `metadata`.
- **Metadata semantics**: supplied `metadata` is a top-level merge into the stored object; it is not a full replacement. Clients that submit a fully merged object remain compatible.
- **Server enforcement**: when `metadata.rename_admin_only` is `true`, non-owners/admins receive `403` for rename attempts. Group settings remain administrator-only even when the flag is false.

#### Join approval and invite links

`metadata.join_admin_only` is enforced by the Worker. Direct member additions by a non-owner/admin are rejected with `403`; use the approval flow instead.

- `POST /groups/:id/invite-links` (`owner`/`admin`): create a deep-link token. Body: `{ "expires_in_seconds": 3600, "max_uses": 10 }` (both optional). Returns `{ token, url: "https://api.chatnice.top/g/<token|slug>", expires_at, max_uses }`. Encode `url` as the QR payload; the public landing page at `/g/:token` tries to open the app via `chaintalk://group-invite/<token>` and falls back to the download page. Legacy `chaintalk://` links remain supported by clients.
- `POST /groups/join-by-token`: body `{ "token": "...", "message": "optional application note", "retry": false }`. It returns `{ status: "joined", member, conversation }` for direct entry (and also when an already-approved member refreshes the link). For approval groups it returns `202` with `{ status: "pending", pending: true, request, join_request, group }`; `group` is a preview with ID, name, absolute avatar URL when set, avatar timestamp, current member count, and metadata. A rejected applicant receives `200` with `{ status: "rejected", pending: false, request, join_request, group }`. Send `retry: true` after that rejected response to explicitly create a new pending request without silently creating one during a status refresh.
- Invalid/missing invite links return `404`, expired links `410`, and exhausted limited-use links `429`; their error bodies remain `{ "error": "..." }`.
- `POST /groups/:id/join-requests`: submit the authenticated user's application with `{ "message": "optional" }`.
- `GET /groups/:id/join-requests?status=pending`: list requests (`owner`/`admin` only). Rows include the applicant's stored wallet, nickname, avatar URL, message, status, and handler fields.
- `POST /groups/:id/join-requests/:requestId/approve` and `/reject`: owner/admin decision endpoints. Approval creates the membership.

Each application, decision, and successful join emits a `messages.type = "system"` event (JSON payload in `content`) through the normal conversation and `/sync` channels.

#### `POST /groups/:id/members`
Add member to group (`owner` or `admin`).
- **Request Body**: `{ "user_id": "0xdave..." }` or `{ "wallet_address": "0xdave..." }`

#### `POST /groups/:id/kick`
Kick/delete a member from the group (`owner` or `admin`).
- **Request Body**: `{ "user_id": "0xcharlie..." }` or `{ "wallet_address": "0xcharlie..." }`

#### `DELETE /groups/:id/members/:userId`
Remove member from group or self-leave.
- `owner` can remove any member or admin.
- `admin` can remove regular members.
- Regular members cannot kick anyone.

#### `POST /groups/:id/leave`
Voluntarily leave the group for members and admins.
- The current owner leaving still deletes the group. To preserve the group, transfer ownership first and then leave.

#### `POST /groups/:id/transfer`
Transfer ownership (`owner` only). Body: `{ "new_owner_user_id": "..." }` or `{ "wallet_address": "0x..." }`. The target must already be a group member. The D1 batch updates `owner_address`, promotes the target to the single `owner`, and demotes the prior owner to `admin` atomically.

#### `PUT /groups/:id/members/:userId/role`
Promote or demote group members (`owner` only).
- **Request Body**: `{ "role": "admin" }` or `{ "role": "member" }`

#### `POST /groups/:id/mute` / `POST /groups/:id/unmute`
Enable or disable group-wide mute (`owner` or `admin` only).
- **Request Body**: `{ "muted": true, "duration_seconds": 3600 }` (0 or omitted = indefinite)
- **Admin Exemption**: Group owner and admins can ALWAYS speak under group mute ("admin始终可以讲话").

#### `POST /groups/:id/members/:userId/mute` / `POST /groups/:id/members/:userId/unmute`
Mute or unmute an individual member with reason and duration (`owner` or `admin` only).
- **Request Body**: `{ "muted": true, "duration_seconds": 600, "reason": "Spamming" }`
- Group owner and admins cannot be muted.

#### `GET /groups/:id/muted`
Query group mute status and the active muted member list.

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
    - Responds with `{ "status": "burned", "burn_after_seconds": 30 }`.
    - Reader is guaranteed at least 30 seconds to view/play/download the message before it is excluded from sync/queries and downloads return `404`.
    - In **1:1 chats**: Atomically destroys D1 row and R2 media binaries once the reading window has elapsed.
    - In **1:N group chats**: Preserves transit message until **all** group recipients have read and all viewing windows have elapsed, then executes atomic dual-storage destruction.

#### `POST /messages/:id/recall`
Recall a sent message within 30 seconds of creation.
- **Access**: Sender only (`HTTP 403` otherwise).
- **Time Window**: Within 30 seconds (`HTTP 400` if expired).
- **Effect**: Sets `recalled_at`, masks content to `"This message was recalled"`, and immediately purges any linked voice/image/file binary in Cloudflare R2 and removes media metadata.

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

#### `GET /voice/:messageId/meta`
Retrieve voice metadata JSON without downloading the audio body.

---

### 6. Image & File Messages (`/images`, `/files`)

#### `POST /images/upload`
Upload an image binary (JPEG, PNG, WebP, GIF, SVG, BMP, HEIC, AVIF; up to 20MB). Supports `multipart/form-data` and JSON (Base64).
- **Multipart Fields**:
  - `file`: Binary image file.
  - `conversation_id`: Target conversation ID.
  - `caption`: Optional text caption.
  - `width` / `height`: Optional image dimensions.
  - `retention`: `"permanent"` or `"on_read"`.
  - `expires_in_seconds`: Expiration in seconds.
- **Response**: `201 Created` with `{ message, image }`.

#### `GET /images/:messageId`
Stream image binary directly from R2 with `Content-Disposition: inline`.

#### `GET /images/:messageId/meta`
Retrieve image metadata JSON.

#### `POST /files/upload`
Upload a generic file/document (up to 50MB). Supports `multipart/form-data` and JSON (Base64).
- **Multipart Fields**:
  - `file`: Binary file.
  - `conversation_id`: Target conversation ID.
  - `file_name`: Optional explicit filename.
  - `caption`: Optional text caption.
  - `retention`: `"permanent"` or `"on_read"`.
  - `expires_in_seconds`: Expiration in seconds.
- **Response**: `201 Created` with `{ message, file }`.

#### `GET /files/:messageId`
Stream file binary directly from R2 with `Content-Disposition: attachment; filename=...`.

#### `GET /files/:messageId/meta`
Retrieve file metadata JSON.

---

### 7. User Dual-Metadata & Single Avatar (`/users`)

#### `GET /users/me`
Retrieve authenticated user profile including `public_metadata` and `private_metadata`.

#### `PATCH /users/me/metadata`
Update user's `public_metadata` and/or `private_metadata`.
- **Request Body**:
  ```json
  {
    "public_metadata": { "nickname": "Alice", "bio": "Web3 dev" },
    "private_metadata": { "theme": "dark" }
  }
  ```

#### `POST /users/me/avatar`
Upload user's single avatar (multipart file or base64 JSON). Any previously uploaded avatar is atomically removed from Cloudflare R2.
- **Response**: `200 OK` with `{ "success": true, "avatar_url": "...", "avatar_mime": "image/png", "avatar_updated_at": ... }`

#### `GET /users/:address`
Public profile lookup. Returns `public_metadata` and `avatar_url`. Strictly excludes `private_metadata`.

#### `GET /users/:address/avatar`
Public stream of user's active avatar image. Returns `404` if user has not uploaded an avatar.

---

### 8. Social Graph & Blacklist (`/friends`, `/blacklist`)

#### `GET /friends` & `GET /friends?tag=crypto`
List friends, optionally filtered by tag. Includes friend profile, custom `alias`, `tags`, and avatar.

#### `POST /friends`
Add a friend.
- **Request Body**: `{ "friend_address": "0xbob...", "alias": "Bob", "tags": ["crypto", "dev"] }`

#### `GET /friends/:address`
Get friend details and tags.

#### `PATCH /friends/:address`
Update friend `alias` and/or `tags`.

#### `PUT /friends/:address/tags`
Replace friend tags array.

#### `GET /friends/tags`
List all unique tags used across the user's friend list.

#### `DELETE /friends/:address`
Remove a friend.

#### `GET /blacklist`
List blocked addresses.

#### `POST /blacklist`
Block an address with optional reason.
- **Request Body**: `{ "blocked_address": "0xevil...", "reason": "spam" }`
- **Enforcement**: Blocked users are prohibited from creating 1:1 direct conversations or sending messages to the blocker (`HTTP 403 Forbidden`).

#### `DELETE /blacklist/:address`
Unblock an address.

---

### 9. Scheduled Sweeper & Admin Maintenance

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

### 10. User Reports (`/reports`)

All report endpoints require authentication. Reports and their evidence are private: they are never sent to a conversation and cannot be read by the reported account.

#### `POST /reports/evidence`

Upload one image as private evidence using `multipart/form-data`. Use form key `file` (also accepts `image` or `evidence`). Supported types: JPEG, PNG, WebP, GIF, HEIC, AVIF; maximum size 20 MB.

- **Response**: `201 Created`
  ```json
  {
    "object_key": "report-evidence/0xreporter.../uuid.png",
    "mime_type": "image/png",
    "size": 12345,
    "created_at": 1725514800000
  }
  ```

#### `POST /reports`

Submit a report. `reported_wallet_address` must be a valid EVM address; if `reported_user_id` is also supplied it must identify that same wallet.

```json
{
  "reported_user_id": "0xtarget...",
  "reported_wallet_address": "0xtarget...",
  "category": "fraud",
  "message_ids": ["message-uuid"],
  "description": "Asked for an off-platform payment.",
  "evidence_keys": ["report-evidence/0xreporter.../uuid.png"]
}
```

Allowed categories: `harassment`, `fraud`, `account_theft`, `infringement`, `counterfeit`, `impersonation`, `minor_protection`, `irrational_fandom`.

`message_ids` must be visible to the reporting account. `evidence_keys` must have been uploaded by that same account and can only be attached once.

- **Response**: `201 Created`, `{ "report": { "id", "status": "received", "created_at", ... } }`

#### `GET /reports`

List the authenticated user's submitted reports. Optional `?limit=1..100`; response shape is `{ "reports": [...] }`.

---

### 11. Telegram-like Bots (`/bots` & `/bot/*`)

For full details, tutorials, Python/TypeScript SDK examples, and API references, see [`docs/BOT_INTEGRATION_GUIDE.md`](docs/BOT_INTEGRATION_GUIDE.md).

#### Bot Management (User Authenticated)
- `POST /bots`: Register a new bot (returns `bot_id` and plaintext `api_key`).
- `GET /bots`: List all bots owned by the caller (masked keys).
- `GET /bots/:id`: Get bot details.
- `PATCH /bots/:id`: Update bot profile (name, username, description, avatar_url, status).
- `POST /bots/:id/reset-key`: Invalidate old API key and issue a new one.
- `DELETE /bots/:id`: Delete bot and its virtual user.

#### Bot Operations (Open API with `bot_id` + `api_key`)
Authenticate via `X-Bot-Token: <bot_id>:<api_key>` (or `X-Bot-Id` + `X-Bot-Key`, `Authorization: Bearer <bot_id>:<api_key>`, query parameters, or JSON body).
- `GET /bot/me`: Inspect bot profile.
- `GET /bot/groups`: List groups the bot is currently in.
- `GET /bot/groups/:id`: Get group details and bot role.
- `GET /bot/groups/:id/members`: List group members.
- `POST /bot/groups/join`: Join a group via `group_id` or `invite_token`.
- `POST /bot/messages/send`: Send text or sticker messages (with `@mentions` support).
- `GET /bot/conversations/:id/messages`: Paginated message history.
- `GET /bot/sync`: Incremental delta sync for realtime message listening.
- `POST /bot/groups/:id/kick`: Kick member (requires admin/owner bot role).
- `POST /bot/groups/:id/mute`: Mute/unmute entire group ("admin始终可以讲话").
- `POST /bot/groups/:id/mute-member`: Mute/unmute individual member with duration and reason.
- `PATCH /bot/groups/:id`: Update group name, announcement, or description.
- `POST /bot/groups/:id/leave`: Leave group.

---

## License

MIT License.
