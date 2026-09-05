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
   | (Users, Sessions,       |               |      (Voice Files)      |
   |  Conversations, Groups, |               +-------------------------+
   |  Messages, Receipts)    |
   +-------------------------+
```

## 2. Core Entities & D1 Schema

### 2.1 `users`
- `id`: TEXT PRIMARY KEY (UUID / nanoid)
- `wallet_address`: TEXT UNIQUE NOT NULL (lowercased 0x... hex address)
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
- `user_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `token_hash`: TEXT NOT NULL UNIQUE (SHA-256 hash of bearer token)
- `expires_at`: INTEGER NOT NULL
- `created_at`: INTEGER NOT NULL

### 2.4 `conversations`
- `id`: TEXT PRIMARY KEY
- `type`: TEXT NOT NULL CHECK(type IN ('direct', 'group'))
- `name`: TEXT (optional for groups)
- `created_at`: INTEGER NOT NULL
- `updated_at`: INTEGER NOT NULL

### 2.5 `conversation_members`
- `id`: TEXT PRIMARY KEY
- `conversation_id`: TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
- `user_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `role`: TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member'))
- `joined_at`: INTEGER NOT NULL
- `last_read_message_id`: TEXT
- UNIQUE(conversation_id, user_id)

### 2.6 `messages`
- `id`: TEXT PRIMARY KEY
- `conversation_id`: TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
- `sender_id`: TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
- `type`: TEXT NOT NULL CHECK(type IN ('text', 'voice'))
- `content`: TEXT (text body or audio metadata summary)
- `retention`: TEXT NOT NULL DEFAULT 'permanent' CHECK(retention IN ('permanent', 'on_read'))
- `status`: TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read'))
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

## 4. Ephemeral Lifecycle & Destruction
- **Delivered ACK**: Receiver client sends ACK upon downloading message. Status transitions to `delivered`.
- **Read ACK & Burn-on-read**:
  When receiver client reads an `on_read` message:
  1. If message type is `voice`, read object key from `voice_messages` and call `R2.delete(object_key)`.
  2. Delete D1 record from `messages` (cascading to `voice_messages` and `message_receipts`).
- **Expiration Purge**:
  Messages with `expires_at <= now()` are filtered out in queries, and swept by a scheduled cron trigger:
  Find expired voice messages -> delete R2 files -> delete expired D1 message rows.
