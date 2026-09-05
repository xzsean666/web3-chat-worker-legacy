# Web3 Chat Worker 前端对接开发指南 (Frontend Integration Guide)

本文档面向前端开发团队（Web / React / Vue / React Native / Flutter / 微信小程序等），详细阐述如何对接 **Web3 Chat Worker** 后端服务。

> **基准地址说明**：
> 文档中统一使用占位符 `WORKER_BASE_URL` 表示后端部署根路径（例如 `https://your-domain.com`，末尾不带斜杠 `/`）。在前端工程中请配置为环境变量（如 `process.env.NEXT_PUBLIC_WORKER_BASE_URL` 或 `import.meta.env.VITE_WORKER_BASE_URL`）。

---

## 目录

1. [核心架构与设计规范](#1-核心架构与设计规范)
2. [公共请求头与错误响应规范](#2-公共请求头与错误响应规范)
3. [模块一：EVM 钱包签名鉴权 (Auth)](#3-模块一evm-钱包签名鉴权-auth)
4. [模块二：1v1 私聊会话管理 (Conversations)](#4-模块二1v1-私聊会话管理-conversations)
5. [模块三：群聊管理与 RBAC 权限 (Groups)](#5-模块三群聊管理与-rbac-权限-groups)
6. [模块四：消息发送与拉取 (Messages)](#6-模块四消息发送与拉取-messages)
7. [模块五：消息确认机制 (Delivery &amp; Read ACK)](#7-模块五消息确认机制-delivery--read-ack)
8. [模块六：语音消息上传与播放 (Voice &amp; R2)](#8-模块六语音消息上传与播放-voice--r2)
9. [模块七：阅后即焚 (Burn-on-Read) 与消息过期 (TTL)](#9-模块七阅后即焚-burn-on-read-与消息过期-ttl)
10. [模块八：增量全局同步引擎 (Incremental Sync)](#10-模块八增量全局同步引擎-incremental-sync)
11. [前端 TypeScript 类型定义汇总](#11-前端-typescript-类型定义汇总)
12. [完整前端集成示例代码 (TypeScript SDK)](#12-完整前端集成示例代码-typescript-sdk)

---

## 1. 核心架构与设计规范

1. **单节点无状态 Worker + D1 关系型存储 + R2 对象存储**：
   - 关系数据（用户、会话、成员、消息、回执、元数据）存储在 Cloudflare D1（SQLite）。
   - 语音音频二进制文件存储在 Cloudflare R2。
2. **Web3 身份标准**：
   - 用户身份通过 EVM 钱包地址识别。
   - 所有地址入库时强制格式化为小写 `0x...`。
   - 登录鉴权采用 EIP-191 挑战-应答签名（SIWE 流程），无需私钥上链，防重放攻击。
3. **显式 ACK 投递模型 (Explicit ACK)**：
   - 发送消息接口返回 `HTTP 201` **仅代表服务端已收妥并入库（API Receipt）**，并不代表接收方已收到。
   - 接收方客户端获取消息后，须主动调用 `POST /messages/:id/ack`（投递确认，状态转为 `delivered`）。
   - 用户点击或查看消息后，须主动调用 `POST /messages/:id/read`（已读确认，状态转为 `read`）。
4. **双重物理销毁 (Dual-Storage Burn-on-Read)**：
   - 设置为 `retention: "on_read"` 的消息在被接收方调用已读接口后，服务端会**立即同时从 D1 数据库删除消息记录**并**从 R2 存储桶中物理删除音频文件**。
5. **增量拉取与同步 (Sync)**：
   - 推荐使用增量拉取端点 `GET WORKER_BASE_URL/sync?since=<timestamp>`，根据时间戳仅同步新增变更，大幅优化客户端性能与流量。

---

## 2. 公共请求头与错误响应规范

### 2.1 跨域支持 (CORS)

Worker 已开启全面 CORS 支持：

- `Access-Control-Allow-Origin: *`
- 允许常用请求头（`Authorization`, `Content-Type` 等）以及标准 HTTP 请求方法（`GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`）。

### 2.2 请求鉴权 Header

除健康检查和公开登录相关接口外，其余接口必须携带 Bearer Token：

```http
Authorization: Bearer <TOKEN>
```

### 2.3 错误响应结构

当请求发生错误时，服务端统一返回带有 `error` 字段的 JSON 对象：

```json
{
  "error": "具体的错误信息描述"
}
```

常见 HTTP 状态码：

| 状态码                 | 含义                                         | 前端处理建议                         |
| :--------------------- | :------------------------------------------- | :----------------------------------- |
| `200 OK`             | 请求成功                                     | 正常处理业务数据                     |
| `201 Created`        | 资源创建成功                                 | 获取新生成的资源实体                 |
| `400 Bad Request`    | 请求参数缺失或校验失败                       | 检查入参字段、地址格式、音视频大小等 |
| `401 Unauthorized`   | 签名错误、Token 缺失或会话过期               | 清除本地 Token，重定向至钱包登录页   |
| `403 Forbidden`      | 权限不足（非会话成员、群普通成员无权操作等） | 弹窗提示无权限                       |
| `404 Not Found`      | 目标资源不存在（或阅后即焚已被销毁）         | 列表标记为已失效/不可播放            |
| `500 Internal Error` | 服务端内部异常                               | 提示稍后重试或上报监控日志           |

---

## 3. 模块一：EVM 钱包签名鉴权 (Auth)

基于 EIP-191 规范的挑战-应答登录流程：

```
[前端客户端 / 钱包]                             [Worker 服务端]
        |                                              |
        | ----- 1. POST /auth/nonce (wallet_address) ->|
        | <---- 返回 { nonce, message, expires_at } ---|
        |                                              |
 [用户唤起钱包签名]                                       |
 [personal_sign(message)]                              |
        |                                              |
        | ----- 2. POST /auth/verify (addr, sig, nonce)->|
        | <---- 校验通过，返回 { token, user, session } -|
        |                                              |
 [保存 token 至本地，后续请求携带 Bearer Token]
```

### 3.1 获取登录 Nonce 挑战码

- **接口路径**：`POST WORKER_BASE_URL/auth/nonce`
- **认证要求**：公开接口，无需 Header
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "wallet_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa"
  }
  ```
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "nonce": "c6233d4e6eb44078a6331a982994fef4",
    "message": "Sign this message to authenticate with Web3 Chat:
  ```

Nonce: c6233d4e6eb44078a6331a982994fef4",
    "expires_at": 1788588157000
  }

```
  - `message`：用于让用户在钱包（如 MetaMask, Rainbow, Rabby 等）中签名的完整纯文本明文。
  - `expires_at`：毫秒时间戳，Nonce 有效期为 **5 分钟**。

### 3.2 提交钱包签名完成登录
- **接口路径**：`POST WORKER_BASE_URL/auth/verify`
- **认证要求**：公开接口，无需 Header
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "wallet_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
    "signature": "0x...",
    "nonce": "c6233d4e6eb44078a6331a982994fef4"
  }
```

- `nonce` 为可选字段，但强烈建议携带。服务端验证通过后会**立即销毁该 Nonce**（防止重放攻击）。
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "token": "d748f...64位随机高熵token",
    "user": {
      "id": "7d82a793-c6b4-4b29-b7b7-1114f8c4f625",
      "wallet_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
      "created_at": 1788587857000,
      "updated_at": 1788587857000
    },
    "session": {
      "id": "18f50fa5-c496-4100-bda4-4861219b1650",
      "user_id": "7d82a793-c6b4-4b29-b7b7-1114f8c4f625",
      "expires_at": 1789192657000,
      "created_at": 1788587857000
    }
  }
  ```

  - `token`：会话凭证，前端存入 `localStorage` 或安全存储区，有效期默认 **7 天**。

### 3.3 获取当前登录用户信息

- **接口路径**：`GET WORKER_BASE_URL/auth/me`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "user": {
      "id": "7d82a793-c6b4-4b29-b7b7-1114f8c4f625",
      "wallet_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
      "created_at": 1788587857000,
      "updated_at": 1788587857000
    }
  }
  ```

### 3.4 注销登录 (Logout)

- **接口路径**：`POST WORKER_BASE_URL/auth/logout`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "success": true
  }
  ```

  > 前端调用注销后，应立即清理本地持久化 Token。
  >

---

## 4. 模块二：1v1 私聊会话管理 (Conversations)

### 4.1 发起或获取 1v1 私聊（强幂等）

- **接口路径**：`POST WORKER_BASE_URL/conversations`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求体 (Content-Type: application/json)**：
  支持通过 `target_user_id` 或 `target_wallet_address` 传参：

  ```json
  {
    "target_wallet_address": "0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2"
  }
  ```

  或
  ```json
  {
    "target_user_id": "85d7d882-590d-4d16-8f5e-57676a6b50ac"
  }
  ```
- **幂等特性**：如果当前用户与对方已存在 1v1 会话，不会重复创建，直接返回既有会话详情。
- **成功响应 (`HTTP 201`)**：

  ```json
  {
    "id": "a310eec6-82ab-479a-8a3b-8510ae8a1560",
    "type": "direct",
    "name": null,
    "created_at": 1788587857000,
    "updated_at": 1788587857000,
    "my_role": "owner",
    "members": [
      {
        "id": "member-uuid-1",
        "conversation_id": "a310eec6-82ab-479a-8a3b-8510ae8a1560",
        "user_id": "7d82a793-c6b4-4b29-b7b7-1114f8c4f625",
        "role": "owner",
        "joined_at": 1788587857000,
        "last_read_message_id": null,
        "wallet_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa"
      },
      {
        "id": "member-uuid-2",
        "conversation_id": "a310eec6-82ab-479a-8a3b-8510ae8a1560",
        "user_id": "85d7d882-590d-4d16-8f5e-57676a6b50ac",
        "role": "member",
        "joined_at": 1788587857000,
        "last_read_message_id": null,
        "wallet_address": "0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2"
      }
    ]
  }
  ```

### 4.2 获取当前用户的会话列表

- **接口路径**：`GET WORKER_BASE_URL/conversations`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "conversations": [
      {
        "id": "a310eec6-82ab-479a-8a3b-8510ae8a1560",
        "type": "direct",
        "name": null,
        "created_at": 1788587857000,
        "updated_at": 1788587860000,
        "role": "owner",
        "member_count": 2
      },
      {
        "id": "d6f3813f-44b3-481b-b2d5-1dd5153c8b69",
        "type": "group",
        "name": "Web3 BUIDLers DAO",
        "created_at": 1788587860000,
        "updated_at": 1788587865000,
        "role": "owner",
        "member_count": 3
      }
    ]
  }
  ```

### 4.3 获取指定会话详情（含成员与角色）

- **接口路径**：`GET WORKER_BASE_URL/conversations/:id`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **权限控制**：非会话成员访问会返回 `HTTP 403 Forbidden`。
- **成功响应 (`HTTP 200`)**：格式同 4.1，包含完整 `members` 数组和 `my_role`。

---

## 5. 模块三：群聊管理与 RBAC 权限 (Groups)

角色模型：`owner` (创建者/群主) > `admin` (管理员) > `member` (普通群成员)。

### 5.1 创建群聊

- **接口路径**：`POST WORKER_BASE_URL/groups`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "name": "Web3 BUIDLers DAO",
    "member_ids": [
      "85d7d882-590d-4d16-8f5e-57676a6b50ac",
      "cd218012-0faf-44aa-849a-38e174639ff7"
    ]
  }
  ```

  - `member_ids`：可选的初始成员 UUID 列表。创建者默认加入并拥有 `owner` 角色。
- **成功响应 (`HTTP 201`)**：返回新建群会话详情（包含 `members` 列表）。

### 5.2 修改群聊名称

- **接口路径**：`PATCH WORKER_BASE_URL/groups/:id`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **权限要求**：仅 `owner` 或 `admin` 有权修改，普通 `member` 调用返回 `HTTP 403`。
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "name": "Web3 Super Builders"
  }
  ```
- **成功响应 (`HTTP 200`)**：返回更新后的群详情对象。

### 5.3 添加群成员

- **接口路径**：`POST WORKER_BASE_URL/groups/:id/members`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **权限要求**：仅 `owner` 或 `admin` 有权邀请新成员。
- **请求体 (Content-Type: application/json)**：
  支持通过 `user_id` 或 `wallet_address`：
  ```json
  {
    "wallet_address": "0x41a0706a3636ce383a69054f52b46ac980743a1d",
    "role": "member"
  }
  ```

  - `role` 可选值为 `"admin"` 或 `"member"`，默认 `"member"`。
- **成功响应 (`HTTP 201`)**：
  ```json
  {
    "id": "cm-uuid-new",
    "conversation_id": "d6f3813f-44b3-481b-b2d5-1dd5153c8b69",
    "user_id": "cd218012-0faf-44aa-849a-38e174639ff7",
    "role": "member",
    "joined_at": 1788587865000,
    "last_read_message_id": null
  }
  ```

### 5.4 移除群成员 / 主动退群

- **接口路径**：`DELETE WORKER_BASE_URL/groups/:id/members/:userId`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **权限逻辑**：
  - 群成员主动退群：当 `:userId` 为当前登录用户本人时，允许自主退出。
  - 踢人：当前用户角色必须为 `owner` 或 `admin`。
  - 不能踢出群主 (`owner`)。
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "success": true
  }
  ```

---

## 6. 模块四：消息发送与拉取 (Messages)

### 6.1 发送文本消息

- **接口路径**：`POST WORKER_BASE_URL/conversations/:id/messages`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "content": "Hello, Bob! Are you ready for Web3?",
    "type": "text",
    "retention": "permanent",
    "expires_in_seconds": 86400
  }
  ```

  - `content`：消息文本（必填且不能为空白）。
  - `type`：默认 `"text"`。
  - `retention`：保存策略，可选值：
    - `"permanent"` (默认)：永久保存直到过期 TTL 触发。
    - `"on_read"`：阅后即焚，接收方调用已读 ACK 后服务端立即物理删除。
  - `expires_in_seconds`：消息生命周期（秒），默认为 86400 秒（24 小时）。
- **成功响应 (`HTTP 201`)**：
  ```json
  {
    "id": "36037617-81d9-4226-aecc-317d53dabd7a",
    "conversation_id": "a310eec6-82ab-479a-8a3b-8510ae8a1560",
    "sender_id": "7d82a793-c6b4-4b29-b7b7-1114f8c4f625",
    "type": "text",
    "content": "Hello, Bob! Are you ready for Web3?",
    "retention": "permanent",
    "status": "pending",
    "expires_at": 1788674257000,
    "delivered_at": null,
    "read_at": null,
    "created_at": 1788587857000
  }
  ```

### 6.2 基于游标的分页拉取会话历史消息

- **接口路径**：`GET WORKER_BASE_URL/conversations/:id/messages`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **查询参数 (Query Parameters)**：
  - `after_id` (可选)：游标 Message ID。传入后拉取该消息**之后**的新消息。
  - `limit` (可选)：每次拉取条数，默认 `50`，最大 `100`。
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "messages": [
      {
        "id": "36037617-81d9-4226-aecc-317d53dabd7a",
        "conversation_id": "a310eec6-82ab-479a-8a3b-8510ae8a1560",
        "sender_id": "7d82a793-c6b4-4b29-b7b7-1114f8c4f625",
        "sender_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "type": "text",
        "content": "Hello, Bob! Are you ready for Web3?",
        "retention": "permanent",
        "status": "pending",
        "expires_at": 1788674257000,
        "delivered_at": null,
        "read_at": null,
        "created_at": 1788587857000
      }
    ],
    "next_cursor": "36037617-81d9-4226-aecc-317d53dabd7a",
    "has_more": false
  }
  ```

  - `sender_address`：服务端自动关联了发送者的钱包地址，前端无需二次查询。
  - `has_more`：布尔值，为 `true` 时前端可使用 `next_cursor` 作为下一次请求的 `after_id`。

---

## 7. 模块五：消息确认机制 (Delivery & Read ACK)

### 状态转换流转图

```
[发送方 POST 成功]
       │
       ▼
   "pending"   (已入库，等待接收方设备接收)
       │
       ├──── 接收方 App 拉取到消息，触发 Delivery ACK
       ▼
  "delivered"  (已送达接收方客户端)
       │
       ├──── 接收方用户浏览/点击消息，触发 Read ACK
       ▼
   "read" / "burned"
       │
       ├─ permanent: 状态置为 "read"，记录 read_at
       └─ on_read:   服务端触发阅后即焚，物理擦除 D1 + R2，返回 "burned"
```

> **注意**：发送方不能给自己发送的消息触发 ACK；仅接收方能确认。

### 7.1 单条消息投递确认 (Delivery ACK)

客户端只要通过 `/sync` 或 `/conversations/:id/messages` 收到别人发来的新消息，应在后台自动静默上报投递确认：

- **接口路径**：`POST WORKER_BASE_URL/messages/:id/ack`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "success": true,
    "message_id": "36037617-81d9-4226-aecc-317d53dabd7a",
    "status": "delivered"
  }
  ```

### 7.2 批量消息投递确认 (Batch Delivery ACK)

- **接口路径**：`POST WORKER_BASE_URL/messages/ack`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "message_ids": [
      "msg-id-1",
      "msg-id-2",
      "msg-id-3"
    ]
  }
  ```
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "acknowledged": ["msg-id-1", "msg-id-2"],
    "skipped": ["msg-id-3"]
  }
  ```

  - `skipped`：自己的消息、不存在或不属于该用户的消息会被自动跳过，不影响其余消息。

### 7.3 单条消息已读确认 (Read ACK)

用户在前端界面阅读、展开或播放该消息时触发：

- **接口路径**：`POST WORKER_BASE_URL/messages/:id/read`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **成功响应 (`HTTP 200`)**：
  - 普通消息成功响应：
    ```json
    {
      "success": true,
      "message_id": "36037617-81d9-4226-aecc-317d53dabd7a",
      "status": "read"
    }
    ```
  - 阅后即焚消息成功响应（触发销毁）：
    ```json
    {
      "success": true,
      "message_id": "b315c4ec-d41f-48bb-b1dc-9a85f39cce93",
      "status": "burned"
    }
    ```

### 7.4 批量消息已读确认 (Batch Read ACK)

- **接口路径**：`POST WORKER_BASE_URL/messages/read`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "message_ids": [
      "msg-id-1",
      "msg-id-2"
    ]
  }
  ```
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "read": ["msg-id-1"],
    "burned": ["msg-id-2"],
    "skipped": []
  }
  ```

---

## 8. 模块六：语音消息上传与播放 (Voice & R2)

音频文件直接存储在 Cloudflare R2，单文件上限 **10MB**。
支持格式：`audio/webm`, `audio/mp3`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/aac`, `audio/mp4`。

### 8.1 语音消息上传 (推荐方式一：`multipart/form-data`)

适合 Web 浏览器的 `MediaRecorder` 产出 Blob 或移动端原生录音文件直接上传：

- **接口路径**：`POST WORKER_BASE_URL/voice/upload`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求格式**：`multipart/form-data`
- **表单字段**：
  - `conversation_id` (文本，必填)：所属会话 ID
  - `duration` (文本/数字，必填)：录音时长（秒）
  - `retention` (文本，可选)：`"permanent"` (默认) 或 `"on_read"` (阅后即焚)
  - `expires_in_seconds` (文本/数字，可选)：过期时间（秒），默认 86400
  - `file` 或 `audio` (二进制文件，必填)：音频 Blob / File 对象
- **成功响应 (`HTTP 201`)**：
  ```json
  {
    "message": {
      "id": "b315c4ec-d41f-48bb-b1dc-9a85f39cce93",
      "conversation_id": "a310eec6-82ab-479a-8a3b-8510ae8a1560",
      "sender_id": "7d82a793-c6b4-4b29-b7b7-1114f8c4f625",
      "type": "voice",
      "content": "[Voice: 12.5s]",
      "retention": "permanent",
      "status": "pending",
      "expires_at": 1788674257000,
      "delivered_at": null,
      "read_at": null,
      "created_at": 1788587857000
    },
    "voice": {
      "id": "voice-meta-uuid",
      "message_id": "b315c4ec-d41f-48bb-b1dc-9a85f39cce93",
      "object_key": "voice/b315c4ec-d41f-48bb-b1dc-9a85f39cce93.webm",
      "duration": 12.5,
      "mime_type": "audio/webm",
      "size": 45120,
      "created_at": 1788587857000
    }
  }
  ```

### 8.2 语音消息上传 (兼容方式二：`application/json` + Base64)

适用于不方便直接构造 FormData 的环境：

- **接口路径**：`POST WORKER_BASE_URL/voice/upload`
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "conversation_id": "a310eec6-82ab-479a-8a3b-8510ae8a1560",
    "duration": 5,
    "mime_type": "audio/webm",
    "audio_base64": "GkXfo59ChoEBQveBAULygQ8...",
    "retention": "on_read",
    "expires_in_seconds": 3600
  }
  ```
- **成功响应 (`HTTP 201`)**：返回与方式一相同的 JSON 结构。

### 8.3 获取并播放语音音频流

- **接口路径**：`GET WORKER_BASE_URL/voice/:messageId`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`（安全隔离，非会话成员无权下载）
- **响应表现**：
  - `Content-Type`：如 `audio/webm` 或原始上传的音频 MIME 类型。
  - `Content-Length`：文件真实字节数。
  - `Cache-Control`：`no-store, no-cache, must-revalidate`（禁止浏览器强缓存，防止被删后仍从本地读取）。
  - Body：原始音频数据流。
- **前端播放方式**：
  ```typescript
  // 使用 fetch 携带 Authorization 头下载音频 Blob 并播放
  async function playVoiceMessage(messageId: string, token: string) {
    const res = await fetch(`WORKER_BASE_URL/voice/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("Audio unavailable or burned");
    const blob = await res.blob();
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    audio.play();
  }
  ```

---

## 9. 模块七：阅后即焚 (Burn-on-Read) 与消息过期 (TTL)

### 9.1 阅后即焚生命周期流转

1. **发送消息**：发送者指定 `retention: "on_read"`。
2. **拉取与展示**：接收方拉取到消息，UI 上可展示“阅后即焚音频”或“一次性密文”占位符。
3. **播放/查看**：
   - 客户端调用 `GET WORKER_BASE_URL/voice/:messageId` 下载并播放音频。
   - 播放完毕后（或用户点击已读时），客户端调用 `POST WORKER_BASE_URL/messages/:id/read`。
4. **双重物理擦除**：
   - 服务端拦截到该消息 `retention == "on_read"`，立即：
     1. 从 R2 存储桶彻底删除 `voice/<messageId>.<ext>` 对象。
     2. 从 D1 `messages` 表直接 `DELETE`（数据库外键级联清理 `voice_messages` 和 `message_receipts` 记录）。
   - 接口返回 `{ success: true, status: "burned" }`。
5. **后续访问**：
   - 任何端再次请求该音频或消息均直接返回 `HTTP 404 Not Found`。

### 9.2 TTL 自动过期与后台清理

- 默认所有消息有效期为 24 小时（发送方可按需传入自定义 `expires_in_seconds`）。
- 消息过期后，所有查询端点（`/sync`、`/messages`）均会自动过滤不予返回。
- 服务端配置了 Cloudflare Cron Triggers 定时任务，会自动批量物理清除过期的数据与 R2 音频对象。

---

## 10. 模块八：增量全局同步引擎 (Incremental Sync)

移动端与 Web 端建议在登录后维护一个轮询或切前台拉取的“增量同步通道”。

### 10.1 增量同步端点

- **接口路径**：`GET WORKER_BASE_URL/sync`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **查询参数**：
  - `since` (可选，数字毫秒时间戳)：拉取该时间戳之后所有会话的新消息。首次启动可传入 `0` 或留空。
  - `limit` (可选，数字)：最大返回条数，默认 `100`，最大 `200`。
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "messages": [
      {
        "id": "msg-1",
        "conversation_id": "conv-a",
        "sender_id": "user-bob",
        "sender_address": "0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "type": "text",
        "content": "Hey there!",
        "retention": "permanent",
        "status": "pending",
        "expires_at": 1788674257000,
        "delivered_at": null,
        "read_at": null,
        "created_at": 1788587860000
      }
    ],
    "sync_timestamp": 1788587865000,
    "has_more": false
  }
  ```

### 10.2 前端增量同步最佳实践架构

```typescript
let lastSyncTimestamp = Number(localStorage.getItem("chat_last_sync") || 0);

async function syncLoop() {
  try {
    const res = await api.getSyncUpdates(lastSyncTimestamp);
    if (res.messages.length > 0) {
      // 1. 本地状态库去重并合并消息
      chatStore.mergeMessages(res.messages);

      // 2. 筛选出属于别人发给我的 pending 消息，触发批量送达确认 (Delivery ACK)
      const unAckedIds = res.messages
        .filter(m => m.sender_id !== myUserId && m.status === "pending")
        .map(m => m.id);

      if (unAckedIds.length > 0) {
        await api.batchAcknowledgeDelivery(unAckedIds);
      }
    }

    // 3. 更新本地游标时间戳
    lastSyncTimestamp = res.sync_timestamp;
    localStorage.setItem("chat_last_sync", String(lastSyncTimestamp));
  } catch (err) {
    console.error("Sync error:", err);
  }
}

// 轮询策略：前台每 3 秒同步一次，切后台时暂停或每 30 秒拉一次
setInterval(syncLoop, 3000);
```

---

## 11. 前端 TypeScript 类型定义汇总

可以直接复制到前端项目的 `src/types/chat.ts` 中：

```typescript
export interface User {
  id: string;
  wallet_address: string;
  created_at: number;
  updated_at: number;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
}

export interface AuthVerifyResponse {
  token: string;
  user: User;
  session: Session;
}

export type ConversationType = "direct" | "group";
export type MemberRole = "owner" | "admin" | "member";

export interface ConversationMember {
  id: string;
  conversation_id: string;
  user_id: string;
  role: MemberRole;
  joined_at: number;
  last_read_message_id: string | null;
  wallet_address?: string;
}

export interface Conversation {
  id: string;
  type: ConversationType;
  name: string | null;
  created_at: number;
  updated_at: number;
  my_role?: MemberRole;
  role?: MemberRole;
  member_count?: number;
  members?: ConversationMember[];
}

export type MessageType = "text" | "voice";
export type RetentionType = "permanent" | "on_read";
export type MessageStatus = "pending" | "delivered" | "read" | "burned";

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_address?: string;
  type: MessageType;
  content: string | null;
  retention: RetentionType;
  status: MessageStatus;
  expires_at: number;
  delivered_at: number | null;
  read_at: number | null;
  created_at: number;
}

export interface VoiceMetadata {
  id: string;
  message_id: string;
  object_key: string;
  duration: number;
  mime_type: string;
  size: number;
  created_at: number;
}

export interface SyncResponse {
  messages: Message[];
  sync_timestamp: number;
  has_more: boolean;
}
```

---

## 12. 完整前端集成示例代码 (TypeScript SDK)

基于原生 `fetch` 与 `viem`（或 `ethers.js`），支持即拷即用的轻量客户端封装：

```typescript
import type {
  User,
  AuthVerifyResponse,
  Conversation,
  Message,
  VoiceMetadata,
  SyncResponse
} from "./types/chat";

export class Web3ChatClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  public setToken(token: string) {
    this.token = token;
  }

  public getToken(): string | null {
    return this.token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    if (this.token && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Request failed with status ${res.status}`);
    }

    return res.json();
  }

  // ==================== 1. 认证模块 (SIWE) ====================

  /** 步骤 1: 申请 Nonce 挑战码 */
  public async getNonce(walletAddress: string) {
    return this.request<{ nonce: string; message: string; expires_at: number }>("/auth/nonce", {
      method: "POST",
      body: JSON.stringify({ wallet_address: walletAddress }),
    });
  }

  /** 步骤 2: 提交签名换取 Session Token */
  public async verifySignature(walletAddress: string, signature: string, nonce: string): Promise<AuthVerifyResponse> {
    const data = await this.request<AuthVerifyResponse>("/auth/verify", {
      method: "POST",
      body: JSON.stringify({
        wallet_address: walletAddress,
        signature,
        nonce,
      }),
    });
    this.setToken(data.token);
    return data;
  }

  /** 配合浏览器钱包 (MetaMask 等) 一键登录 */
  public async loginWithInjectedWallet(walletAddress: string): Promise<AuthVerifyResponse> {
    const { nonce, message } = await this.getNonce(walletAddress);
  
    // 使用 window.ethereum 唤起 personal_sign
    const ethereum = (window as any).ethereum;
    if (!ethereum) throw new Error("No EVM wallet found");

    const signature = await ethereum.request({
      method: "personal_sign",
      params: [message, walletAddress],
    });

    return this.verifySignature(walletAddress, signature, nonce);
  }

  public async getMe(): Promise<{ user: User }> {
    return this.request<{ user: User }>("/auth/me");
  }

  public async logout(): Promise<void> {
    await this.request("/auth/logout", { method: "POST" });
    this.token = null;
  }

  // ==================== 2. 会话模块 ====================

  /** 创建或打开 1v1 私聊（强幂等） */
  public async openDirectConversation(targetAddressOrUserId: string): Promise<Conversation> {
    const payload = targetAddressOrUserId.startsWith("0x")
      ? { target_wallet_address: targetAddressOrUserId }
      : { target_user_id: targetAddressOrUserId };
    return this.request<Conversation>("/conversations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  public async listConversations(): Promise<{ conversations: Conversation[] }> {
    return this.request<{ conversations: Conversation[] }>("/conversations");
  }

  public async getConversation(conversationId: string): Promise<Conversation> {
    return this.request<Conversation>(`/conversations/${conversationId}`);
  }

  // ==================== 3. 群聊模块 ====================

  public async createGroup(name: string, memberIds: string[] = []): Promise<Conversation> {
    return this.request<Conversation>("/groups", {
      method: "POST",
      body: JSON.stringify({ name, member_ids: memberIds }),
    });
  }

  public async updateGroupName(groupId: string, name: string): Promise<Conversation> {
    return this.request<Conversation>(`/groups/${groupId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  public async addGroupMember(groupId: string, targetAddressOrId: string, role: "admin" | "member" = "member") {
    const payload = targetAddressOrId.startsWith("0x")
      ? { wallet_address: targetAddressOrId, role }
      : { user_id: targetAddressOrId, role };
    return this.request(`/groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  public async removeGroupMember(groupId: string, userId: string) {
    return this.request(`/groups/${groupId}/members/${userId}`, {
      method: "DELETE",
    });
  }

  // ==================== 4. 消息模块 ====================

  /** 发送普通文本消息 */
  public async sendTextMessage(
    conversationId: string,
    content: string,
    options?: { retention?: "permanent" | "on_read"; expiresInSeconds?: number }
  ): Promise<Message> {
    return this.request<Message>(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        type: "text",
        retention: options?.retention || "permanent",
        expires_in_seconds: options?.expiresInSeconds,
      }),
    });
  }

  /** 获取历史消息（分页游标） */
  public async getMessages(conversationId: string, afterId?: string, limit = 50) {
    const params = new URLSearchParams();
    if (afterId) params.set("after_id", afterId);
    if (limit) params.set("limit", limit.toString());
    return this.request<{ messages: Message[]; next_cursor: string | null; has_more: boolean }>(
      `/conversations/${conversationId}/messages?${params.toString()}`
    );
  }

  // ==================== 5. 显式确认 (ACK) 模块 ====================

  public async acknowledgeDelivery(messageId: string) {
    return this.request(`/messages/${messageId}/ack`, { method: "POST" });
  }

  public async batchAcknowledgeDelivery(messageIds: string[]) {
    return this.request<{ acknowledged: string[]; skipped: string[] }>("/messages/ack", {
      method: "POST",
      body: JSON.stringify({ message_ids: messageIds }),
    });
  }

  public async acknowledgeRead(messageId: string) {
    return this.request<{ success: boolean; message_id: string; status: "read" | "burned" }>(
      `/messages/${messageId}/read`,
      { method: "POST" }
    );
  }

  public async batchAcknowledgeRead(messageIds: string[]) {
    return this.request<{ read: string[]; burned: string[]; skipped: string[] }>("/messages/read", {
      method: "POST",
      body: JSON.stringify({ message_ids: messageIds }),
    });
  }

  // ==================== 6. 语音消息模块 (R2) ====================

  /** 上传语音（直接通过 FormData 二进制） */
  public async uploadVoice(
    conversationId: string,
    audioBlob: Blob,
    durationSeconds: number,
    options?: { retention?: "permanent" | "on_read"; expiresInSeconds?: number }
  ): Promise<{ message: Message; voice: VoiceMetadata }> {
    const formData = new FormData();
    formData.append("conversation_id", conversationId);
    formData.append("duration", durationSeconds.toString());
    formData.append("retention", options?.retention || "permanent");
    if (options?.expiresInSeconds) {
      formData.append("expires_in_seconds", options.expiresInSeconds.toString());
    }
    formData.append("file", audioBlob, "recording.webm");

    return this.request<{ message: Message; voice: VoiceMetadata }>("/voice/upload", {
      method: "POST",
      body: formData,
    });
  }

  /** 获取语音音频 Blob URL */
  public async getVoiceAudioUrl(messageId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/voice/${messageId}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Audio download failed: ${res.statusText}`);
    }

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  // ==================== 7. 全局增量同步 (Sync) ====================

  public async getSyncUpdates(sinceTimestamp = 0, limit = 100): Promise<SyncResponse> {
    const params = new URLSearchParams({
      since: sinceTimestamp.toString(),
      limit: limit.toString(),
    });
    return this.request<SyncResponse>(`/sync?${params.toString()}`);
  }
}

// 快捷工厂（使用 WORKER_BASE_URL 占位符）
export const createChatClient = (baseUrl: string = "WORKER_BASE_URL") => new Web3ChatClient(baseUrl);
```
