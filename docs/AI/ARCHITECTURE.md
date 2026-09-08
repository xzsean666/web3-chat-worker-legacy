# Architecture Specification: Web3 Chat Worker

## 1. System Architecture

```text
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

## 2. Core Entities & D1 Schema

### 2.1 `users`
- `id`: TEXT PRIMARY KEY (normalized lowercased EVM 0x... wallet address)
- `wallet_address`: TEXT UNIQUE NOT NULL (lowercased 0x... hex address)
- `avatar_key`: TEXT (Cloudflare R2 object key for user's single avatar)
- `avatar_mime`: TEXT (avatar MIME type, e.g. `image/png`)
- `avatar_updated_at`: INTEGER (UNIX timestamp ms of avatar upload)
- `public_metadata`: TEXT (JSON string, publicly readable by all users, editable only by owner)
- `private_metadata`: TEXT (JSON string, private to user, readable and editable only by owner)
- `created_at`: INTEGER NOT NULL (UNIX timestamp ms)
- `updated_at`: INTEGER NOT NULL

### 2.2 `nonces`
- `id`: TEXT PRIMARY KEY
- `wallet_address`: TEXT NOT NULL
- `nonce`: TEXT NOT NULL UNIQUE
- `expires_at`: INTEGER NOT NULL
- `created_at`: INTEGER NOT NULL

### 2.3 `sessions`
- `id`: TEXT PRIMARY KEY
- `user_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE (wallet address)
- `token_hash`: TEXT NOT NULL UNIQUE (SHA-256 hash of bearer token)
- `expires_at`: INTEGER NOT NULL
- `created_at`: INTEGER NOT NULL

### 2.4 `conversations` (Sovereign Groups & Deterministic Direct Chats)
- `id`: TEXT PRIMARY KEY
  - Direct: `direct:min(addrA, addrB):max(addrA, addrB)` (globally deterministic across nodes)
  - Group: `${owner_address}:${slug_or_salt}` (self-certifying sovereign ID)
- `type`: TEXT NOT NULL CHECK(type IN ('direct', 'group'))
- `owner_address`: TEXT (creator EVM wallet address for groups; immutable, cannot be transferred)
- `name`: TEXT (group name, synchronized with `metadata.name`)
- `metadata`: TEXT NOT NULL DEFAULT '{}' (JSON containing name, description, announcement, marquee scrolling config, custom fields)
- `is_muted`: INTEGER NOT NULL DEFAULT 0 (1 when group-wide mute is enabled)
- `mute_until`: INTEGER (timestamp ms until which group is muted; NULL/0 for indefinite)
- `created_at`: INTEGER NOT NULL
- `updated_at`: INTEGER NOT NULL (used for Last-Write-Wins LWW state merging)

### 2.5 `conversation_members`
- `id`: TEXT PRIMARY KEY (deterministic `${conversation_id}:${user_id}`)
- `conversation_id`: TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
- `user_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE (EVM wallet address)
- `role`: TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member'))
- `muted_until`: INTEGER (timestamp ms until which member is muted; -1 for indefinite, NULL for unmuted)
- `mute_reason`: TEXT (optional moderator reason)
- `joined_at`: INTEGER NOT NULL
- `last_read_message_id`: TEXT
- UNIQUE(conversation_id, user_id)

### 2.6 `messages`
- `id`: TEXT PRIMARY KEY
- `conversation_id`: TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
- `sender_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `type`: TEXT NOT NULL CHECK(type IN ('text', 'voice', 'image', 'file'))
- `content`: TEXT (text body or media metadata summary / caption)
- `retention`: TEXT NOT NULL DEFAULT 'permanent' CHECK(retention IN ('permanent', 'on_read'))
- `status`: TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read'))
- `burn_after_seconds`: INTEGER DEFAULT 30 (minimum viewing grace window in seconds for burn-on-read)
- `recalled_at`: INTEGER (UNIX timestamp ms if recalled within 30 seconds by sender)
- `mentions`: TEXT (JSON array string of mentioned wallet addresses)
- `expires_at`: INTEGER NOT NULL (timestamp ms)
- `delivered_at`: INTEGER
- `read_at`: INTEGER
- `created_at`: INTEGER NOT NULL (timestamp ms, used for ordering & cursor sync)

### 2.7 `message_receipts` (Track per-recipient delivery & read in group chats)
- `id`: TEXT PRIMARY KEY
- `message_id`: TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
- `user_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `status`: TEXT NOT NULL CHECK(status IN ('delivered', 'read'))
- `timestamp`: INTEGER NOT NULL
- UNIQUE(message_id, user_id, status)

### 2.8 `voice_messages`
- `id`: TEXT PRIMARY KEY
- `message_id`: TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
- `object_key`: TEXT NOT NULL UNIQUE
- `duration`: REAL NOT NULL
- `mime_type`: TEXT NOT NULL
- `size`: INTEGER NOT NULL
- `created_at`: INTEGER NOT NULL

### 2.9 `image_messages`
- `id`: TEXT PRIMARY KEY
- `message_id`: TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
- `object_key`: TEXT NOT NULL UNIQUE
- `file_name`: TEXT
- `mime_type`: TEXT NOT NULL
- `size`: INTEGER NOT NULL
- `width`: INTEGER
- `height`: INTEGER
- `created_at`: INTEGER NOT NULL

### 2.10 `file_messages`
- `id`: TEXT PRIMARY KEY
- `message_id`: TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
- `object_key`: TEXT NOT NULL UNIQUE
- `file_name`: TEXT NOT NULL
- `mime_type`: TEXT NOT NULL
- `size`: INTEGER NOT NULL
- `created_at`: INTEGER NOT NULL

### 2.11 `friends`
- `id`: TEXT PRIMARY KEY
- `user_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `friend_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `alias`: TEXT
- `tags`: TEXT (JSON array string)
- `created_at`: INTEGER NOT NULL
- `updated_at`: INTEGER NOT NULL
- UNIQUE(user_id, friend_id)

### 2.12 `blacklist`
- `id`: TEXT PRIMARY KEY
- `user_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `blocked_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `reason`: TEXT
- `created_at`: INTEGER NOT NULL
- UNIQUE(user_id, blocked_id)

## 3. High Performance Incremental Sync Protocol
To satisfy client performance and simple interaction:
- **Cursor Sync API**:
  `GET /conversations/:id/messages?after_id=<message_id>&limit=50`
  Returns messages with `id > cursor` ordered by `created_at ASC`, along with `next_cursor` and `has_more`.
- **Global Sync API**:
  `GET /sync?since=<timestamp>&limit=100`
  Allows client to fetch delta updates across all joined conversations since the last sync checkpoint in a single HTTP request.
- **Batch Acknowledgement**:
  `POST /messages/ack` with body `{"message_ids": ["msg_1", "msg_2"]}`
  `POST /messages/read` with body `{"message_ids": ["msg_1"]}`
  Reduces roundtrip latency on mobile and browser clients.
- **Receipts Inspection API**:
  `GET /messages/:id/receipts`
  Returns delivery & read status for each recipient in direct or group chats (`pending`, `delivered`, `read`), along with aggregated counts (`delivered_count`, `read_count`, `all_delivered`, `all_read`).

## 4. Ephemeral Lifecycle, Recall & Social Protections
- **Per-Recipient Delivery Tracking**:
  Each recipient acknowledges delivery individually. In 1:1 chats, message status becomes `delivered` upon the recipient's ACK. In 1:N group chats, `messages.status` transitions to `delivered` only when **all** other members have acknowledged delivery.
- **Read ACK & Burn-on-Read 30-Second Viewing Grace Window**:
  When a recipient reads an `on_read` message:
  1. The API responds with `{ status: "burned", burn_after_seconds: 30 }`.
  2. For the reading user, the message remains viewable and media downloadable for at least 30 seconds (`(now - read_timestamp) < burn_after_seconds * 1000`) before being filtered out from sync/queries and media downloads returning HTTP 404.
  3. In 1:1 chats, physical destruction of D1 row and R2 binary executes once the 30-second viewing window elapses.
  4. In 1:N group chats, physical destruction executes once **all** non-sender members have read AND all viewing windows have elapsed.
- **30-Second Message Recall**:
  Senders can recall messages within 30 seconds of creation (`POST /messages/:id/recall`). If the message contains audio, image, or file attachments, the R2 binaries are immediately purged and media metadata is cleared.
- **Blacklist Chat Enforcement**:
  If user B has blocked user A, user A cannot initiate a 1:1 conversation with B or send messages to B (returns HTTP 403 Forbidden).

## 5. Server Relay vs. Client Local-First Sovereign Storage
- **Server Role (Ephemeral Mailbox / Transit Node)**:
  Cloudflare D1 & R2 act strictly as a secure temporary delivery pipeline, not a permanent archive. Relayed data is purged immediately upon read completion or TTL expiration.
- **Client Role (Local Sovereign Store)**:
  Clients pull delta messages (`/sync`) and persist them into local client databases (IndexedDB / OPFS on Web, SQLite / MMKV on native apps). Even when server copies are burned or expired, users retain their local history independently under their own device and key control.
