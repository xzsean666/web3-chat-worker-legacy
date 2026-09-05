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
9. [模块七：图片与文件消息上传与下载 (Images, Files &amp; R2)](#9-模块七图片与文件消息上传与下载-images-files--r2)
10. [模块八：阅后即焚 (Burn-on-Read) 与消息过期 (TTL)](#10-模块八阅后即焚-burn-on-read-与消息过期-ttl)
11. [模块九：增量全局同步引擎 (Incremental Sync)](#11-模块九增量全局同步引擎-incremental-sync)
12. [前端 TypeScript 类型定义汇总](#12-前端-typescript-类型定义汇总)
13. [完整前端集成示例代码 (TypeScript SDK)](#13-完整前端集成示例代码-typescript-sdk)

---

## 1. 核心架构与设计规范

1. **单节点无状态 Worker + D1 关系型存储 + R2 对象存储**：
   - 关系数据（用户、会话、成员、消息、回执、元数据）存储在 Cloudflare D1（SQLite）。
   - 多媒体二进制文件（语音音频、图片、文件附件）存储在 Cloudflare R2。
2. **Web3 身份标准**：
   - 用户身份通过 EVM 钱包地址识别。
   - 所有地址入库时强制格式化为小写 `0x...`。
   - 登录鉴权采用 EIP-191 挑战-应答签名（SIWE 流程），无需私钥上链，防重放攻击。
3. **显式 ACK 投递模型 (Explicit ACK)**：
   - 发送消息接口返回 `HTTP 201` **仅代表服务端已收妥并入库（API Receipt）**，并不代表接收方已收到。
   - 接收方客户端获取消息后，须主动调用 `POST /messages/:id/ack`（投递确认，状态转为 `delivered`）。
   - 用户点击或查看消息后，须主动调用 `POST /messages/:id/read`（已读确认，状态转为 `read`）。
4. **双重物理销毁 (Dual-Storage Burn-on-Read)**：
   - 设置为 `retention: "on_read"` 的消息在被接收方调用已读接口后，服务端会**立即同时从 D1 数据库删除消息记录**并**从 R2 存储桶中物理删除对应的多媒体文件（音频/图片/文件）**。
5. **增量拉取与同步 (Sync)**：
   - 推荐使用增量拉取端点 `GET WORKER_BASE_URL/sync?since=<timestamp>`，根据时间戳仅同步新增变更，并自动关联媒体元数据，大幅优化客户端性能与流量。

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
      "id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
      "wallet_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
      "created_at": 1788587857000,
      "updated_at": 1788587857000
    },
    "session": {
      "id": "18f50fa5-c496-4100-bda4-4861219b1650",
      "user_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
      "expires_at": 1789192657000,
      "created_at": 1788587857000
    }
  }
  ```

  - `token`：会话凭证，前端存入 `localStorage` 或安全存储区，有效期默认 **30 天**。

### 3.3 获取当前登录用户信息

- **接口路径**：`GET WORKER_BASE_URL/auth/me`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "user": {
      "id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
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
  支持通过 `target_user_id` 或 `target_wallet_address` 传参（均统一为小写 0x 地址）：

  ```json
  {
    "target_wallet_address": "0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2"
  }
  ```

  或
  ```json
  {
    "target_user_id": "0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2"
  }
  ```
- **幂等特性**：如果当前用户与对方已存在 1v1 会话，不会重复创建，直接返回既有会话详情。单聊 ID 采用确定性格式：`direct:min(addrA, addrB):max(addrA, addrB)`。
- **成功响应 (`HTTP 201`)**：

  ```json
  {
    "id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
    "type": "direct",
    "name": null,
    "created_at": 1788587857000,
    "updated_at": 1788587857000,
    "my_role": "member",
    "members": [
      {
        "id": "direct:0x16107...:0x2c3dd...:0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "user_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "role": "member",
        "joined_at": 1788587857000,
        "last_read_message_id": null,
        "wallet_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa"
      },
      {
        "id": "direct:0x16107...:0x2c3dd...:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "user_id": "0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
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
        "id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "type": "direct",
        "owner_address": null,
        "name": null,
        "created_at": 1788587857000,
        "updated_at": 1788587860000,
        "role": "member",
        "member_count": 2
      },
      {
        "id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa:buidlers",
        "type": "group",
        "owner_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
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

## 5. 模块三：主权群聊管理 (Sovereign Groups)

系统采用 **Web3 自主权群组（Sovereign Groups）** 架构：
- **群 ID 规范**：格式为 `${owner_address}:${slug}`（例如 `0xa284...:buidlers`）。群 ID 与创建者钱包地址永久强绑定。
- **单主权管理模型**：一个群永久属于创建者（`owner`），**群主不可移交**。只有群主有权修改群名、邀请成员、移除成员；其他成员仅有权在群内发言及主动退群。这保证了跨节点合并数据时永远不会发生权限冲突。

### 5.1 创建主权群聊

- **接口路径**：`POST WORKER_BASE_URL/groups`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求体 (Content-Type: application/json)**：
  ```json
  {
    "name": "Web3 BUIDLers DAO",
    "member_ids": [
      "0x3162ad998c5df9376b6700f379816dc71c9ebf28",
      "0x10b0da00e5319fbcf1e494de53874c8a23aecb55"
    ],
    "slug": "buidlers" // 可选自定义标识符，默认由后端自动生成 8 位随机 hex
  }
  ```

  - `member_ids`：可选的初始成员钱包地址列表。创建者默认加入并拥有不可转让的 `owner` 角色。
- **成功响应 (`HTTP 201`)**：返回新建群会话详情，ID 为 `0xcreatorAddress:slug`。

### 5.2 修改群聊名称

- **接口路径**：`PATCH WORKER_BASE_URL/groups/:id`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **权限要求**：**仅群主（`owner`）有权修改**，其他成员调用直接返回 `HTTP 403`。
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
- **权限要求**：**仅群主（`owner`）有权邀请新成员**。
- **请求体 (Content-Type: application/json)**：
  支持通过 `wallet_address` 或 `user_id`（均统一为小写 0x 地址）：
  ```json
  {
    "wallet_address": "0x41a0706a3636ce383a69054f52b46ac980743a1d"
  }
  ```
- **成功响应 (`HTTP 201`)**：
  ```json
  {
    "id": "0xowner...:buidlers:0x41a0...",
    "conversation_id": "0xowner...:buidlers",
    "user_id": "0x41a0706a3636ce383a69054f52b46ac980743a1d",
    "role": "member",
    "joined_at": 1788587865000,
    "last_read_message_id": null
  }
  ```

### 5.4 移除群成员 / 主动退群

- **接口路径**：`DELETE WORKER_BASE_URL/groups/:id/members/:userId`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **权限逻辑**：
  - **普通成员主动退群**：当 `:userId` 为当前登录用户本人时，成功退出并从成员名单移除。
  - **群主踢人**：群主（`owner`）可移除任何成员。
  - **群主退出**：因为群所有权不可移交，群主退群将触发**解散并删除整个群会话**。
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "success": true,
    "message": "Left group successfully"
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
    "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
    "sender_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
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
        "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "sender_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "sender_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "type": "text",
        "content": "Hello, Bob! Are you ready for Web3?",
        "retention": "permanent",
        "status": "pending",
        "expires_at": 1788674257000,
        "delivered_at": null,
        "read_at": null,
        "created_at": 1788587857000
      },
      {
        "id": "img-msg-uuid",
        "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "sender_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "sender_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "type": "image",
        "content": "Architecture Diagram",
        "retention": "permanent",
        "status": "pending",
        "expires_at": 1788674257000,
        "delivered_at": null,
        "read_at": null,
        "created_at": 1788587860000,
        "image": {
          "id": "img-meta-uuid",
          "message_id": "img-msg-uuid",
          "object_key": "images/img-msg-uuid.png",
          "file_name": "diagram.png",
          "mime_type": "image/png",
          "size": 1048576,
          "width": 1920,
          "height": 1080,
          "created_at": 1788587860000
        }
      },
      {
        "id": "file-msg-uuid",
        "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "sender_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "sender_address": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
        "type": "file",
        "content": "Protocol Spec (whitepaper.pdf)",
        "retention": "permanent",
        "status": "pending",
        "expires_at": 1788674257000,
        "delivered_at": null,
        "read_at": null,
        "created_at": 1788587862000,
        "file": {
          "id": "file-meta-uuid",
          "message_id": "file-msg-uuid",
          "object_key": "files/file-msg-uuid/whitepaper.pdf",
          "file_name": "whitepaper.pdf",
          "mime_type": "application/pdf",
          "size": 4194304,
          "created_at": 1788587862000
        }
      }
    ],
    "next_cursor": "file-msg-uuid",
    "has_more": false
  }
  ```

  - `sender_address`：服务端自动关联了发送者的钱包地址，前端无需二次查询。
  - `image` / `file` / `voice`：当消息为对应媒体类型时，服务端自动关联元数据对象，前端可直接读取尺寸、文件名称与大小等，无需额外查询。
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

### 7.5 查询消息送达与已读明细 (Message Receipts)

在群聊中，发送方或群成员可以通过此接口查询消息在各成员设备上的具体接收与阅读状态（解决群聊 1:N 状态下谁收到、谁未收到的精准感知）：

- **接口路径**：`GET WORKER_BASE_URL/messages/:id/receipts`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`（必须为该会话成员）
- **群聊 1:N 聚合判定规则**：
  - **全员送达 (`all_delivered`)**：当且仅当群内所有其他成员都上报了 `delivered` 回执时为 `true`；此时主消息 `messages.status` 才会流转为 `"delivered"`。
  - **群聊阅后即焚 (`on_read`)**：遵循「**每人即读即焚 (Per-Recipient Burn) + 全员物理擦除 (All-Read Dual Destruction)**」机制：
    - 对已读成员：调用 `/messages/:id/read` 统一返回 `"status": "burned"`，且后续该成员调用 `/messages`、`/sync` 或 `/voice` 时服务端自动屏蔽已读的 `on_read` 消息（防复现与防重放）；
    - 对服务端与未读成员：消息在 D1/R2 中为未读成员保留，直到所有接收者均完成阅读 (`all_read === true`)，服务端才真正触发 D1 + R2 物理销毁。若超时未全员阅读，由 `expires_at` cron 定时任务兜底擦除。
- **成功响应 (`HTTP 200`)**：
  ```json
  {
    "message_id": "36037617-81d9-4226-aecc-317d53dabd7a",
    "conversation_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa:buidlers",
    "sender_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
    "total_recipients": 3,
    "delivered_count": 2,
    "read_count": 1,
    "all_delivered": false,
    "all_read": false,
    "receipts": [
      {
        "user_id": "0x41a0706a3636ce383a69054f52b46ac980743a1d",
        "wallet_address": "0x41a0706a3636ce383a69054f52b46ac980743a1d",
        "status": "read",
        "delivered_at": 1788587860000,
        "read_at": 1788587865000
      },
      {
        "user_id": "0x52b0806a3636ce383a69054f52b46ac980743b2e",
        "wallet_address": "0x52b0806a3636ce383a69054f52b46ac980743b2e",
        "status": "delivered",
        "delivered_at": 1788587862000,
        "read_at": null
      },
      {
        "user_id": "0x63c0906a3636ce383a69054f52b46ac980743c3f",
        "wallet_address": "0x63c0906a3636ce383a69054f52b46ac980743c3f",
        "status": "pending",
        "delivered_at": null,
        "read_at": null
      }
    ]
  }
  ```

### 7.6 客户端本地存储与服务端中继定位 (Local-First Sovereign Storage)

前端集成时请遵循 Web3 **Local-First（本地优先）** 架构模式：
1. **服务端为无状态暂存中继（Ephemeral Transit Node）**：消息完成全员阅后即焚或 TTL 到期后，服务端会彻底清空 D1 与 R2 数据，不维护永久云端档案。
2. **客户端为主权数据中心（Sovereign Store）**：前端调用 `/sync` 或 `/conversations/:id/messages` 收到数据后，应立即落盘至客户端本地沙盒（如浏览器的 **IndexedDB / OPFS**，移动端的 **SQLite**）。
3. 即使服务端后续销毁了中继副本，只要接收方在销毁前已成功拉取入库，用户即可永久离线查阅自己的聊天记录。

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
      "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
      "sender_id": "0x1610725056c027d5ae4e2fce73bb925c82c59eaa",
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
    "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
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

### 8.4 查询语音元数据 (GET /voice/:messageId/meta)

- **接口路径**：`GET WORKER_BASE_URL/voice/:messageId/meta`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **成功响应 (`HTTP 200`)**：返回音频时长、大小、MIME 等元数据 JSON（格式同上传时返回的 `voice` 对象），无需下载音频二进制文件即可感知时长。

---

## 9. 模块七：图片与文件消息上传与下载 (Images, Files & R2)

图片与文件二进制存储在 Cloudflare R2，支持阅后即焚、TTL 过期自动清理与增量同步自动挂载元数据。

- **图片规格**：支持 `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/svg+xml`, `image/bmp`, `image/heic`, `image/avif`，单文件上限 **20MB**。
- **文件规格**：支持任意文件格式（PDF, DOC, ZIP, TXT 等），单文件上限 **50MB**。

### 9.1 图片消息上传 (POST /images/upload)

支持 `multipart/form-data`（浏览器 File 对象）与 `application/json`（Base64 字符串）。

#### 方式一：FormData 上传 (推荐)
- **请求路径**：`POST WORKER_BASE_URL/images/upload`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求格式**：`multipart/form-data`
- **表单字段**：
  - `conversation_id` (文本，必填)：所属会话 ID
  - `file` 或 `image` (二进制文件，必填)：图片 File / Blob
  - `caption` 或 `content` (文本，可选)：图片说明文字
  - `width` (数字，可选)：图片宽度 (像素)
  - `height` (数字，可选)：图片高度 (像素)
  - `retention` (文本，可选)：`"permanent"` (默认) 或 `"on_read"` (阅后即焚)
  - `expires_in_seconds` (数字，可选)：过期时间（秒）
- **成功响应 (`HTTP 201`)**：
  ```json
  {
    "message": {
      "id": "img-msg-uuid",
      "conversation_id": "direct:0x1610...:0x2c3d...",
      "sender_id": "0x1610...",
      "type": "image",
      "content": "Architecture Diagram",
      "retention": "permanent",
      "status": "pending",
      "expires_at": 1788674257000,
      "delivered_at": null,
      "read_at": null,
      "created_at": 1788587857000
    },
    "image": {
      "id": "img-meta-uuid",
      "message_id": "img-msg-uuid",
      "object_key": "images/img-msg-uuid.png",
      "file_name": "diagram.png",
      "mime_type": "image/png",
      "size": 1048576,
      "width": 1920,
      "height": 1080,
      "created_at": 1788587857000
    }
  }
  ```

#### 方式二：Base64 上传
- **请求路径**：`POST WORKER_BASE_URL/images/upload`
- **请求体 (application/json)**：
  ```json
  {
    "conversation_id": "direct:0x1610...:0x2c3d...",
    "image_base64": "iVBORw0KGgoAAAANSUhEUgAA...",
    "mime_type": "image/png",
    "file_name": "screenshot.png",
    "caption": "Screenshot",
    "width": 1280,
    "height": 720,
    "retention": "permanent"
  }
  ```

### 9.2 图片查看与流式下载 (GET /images/:messageId)

- **接口路径**：`GET WORKER_BASE_URL/images/:messageId`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **响应头**：
  - `Content-Type`: 原始图片 MIME（如 `image/png`）
  - `Content-Disposition`: `inline; filename="photo.png"`（浏览器可直接内联展示）
  - `Cache-Control`: `no-store, no-cache, must-revalidate`
- **元数据单独查询**：`GET WORKER_BASE_URL/images/:messageId/meta` 返回图片详细信息 JSON。
- **前端图片展示代码示例**：
  ```typescript
  // 使用 fetch 携带 Authorization 头下载图片 Blob 并生成预览链接
  async function renderSecureImage(messageId: string, token: string): Promise<string> {
    const res = await fetch(`WORKER_BASE_URL/images/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("Image unavailable or burned");
    const blob = await res.blob();
    return URL.createObjectURL(blob); // 可直接赋值给 <img src={url} />
  }
  ```

---

### 9.3 文件消息上传 (POST /files/upload)

#### 方式一：FormData 上传 (推荐)
- **请求路径**：`POST WORKER_BASE_URL/files/upload`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **请求格式**：`multipart/form-data`
- **表单字段**：
  - `conversation_id` (文本，必填)
  - `file` (二进制文件，必填)
  - `file_name` (文本，可选，默认取文件本身名称)
  - `caption` 或 `content` (文本，可选)
  - `retention` (文本，可选)：`"permanent"` 或 `"on_read"`
  - `expires_in_seconds` (数字，可选)
- **成功响应 (`HTTP 201`)**：
  ```json
  {
    "message": {
      "id": "file-msg-uuid",
      "conversation_id": "direct:0x1610...:0x2c3d...",
      "sender_id": "0x1610...",
      "type": "file",
      "content": "Protocol Spec (whitepaper.pdf)",
      "retention": "permanent",
      "status": "pending",
      "expires_at": 1788674257000,
      "delivered_at": null,
      "read_at": null,
      "created_at": 1788587857000
    },
    "file": {
      "id": "file-meta-uuid",
      "message_id": "file-msg-uuid",
      "object_key": "files/file-msg-uuid/whitepaper.pdf",
      "file_name": "whitepaper.pdf",
      "mime_type": "application/pdf",
      "size": 4194304,
      "created_at": 1788587857000
    }
  }
  ```

#### 方式二：Base64 上传
- **请求路径**：`POST WORKER_BASE_URL/files/upload`
- **请求体 (application/json)**：
  ```json
  {
    "conversation_id": "direct:0x1610...:0x2c3d...",
    "file_base64": "JVBERi0xLjQK...",
    "file_name": "whitepaper.pdf",
    "mime_type": "application/pdf",
    "caption": "Protocol Spec"
  }
  ```

### 9.4 文件流式下载与另存为 (GET /files/:messageId)

- **接口路径**：`GET WORKER_BASE_URL/files/:messageId`
- **认证要求**：需要 `Authorization: Bearer <TOKEN>`
- **响应头**：
  - `Content-Type`: 文件 MIME 类型
  - `Content-Disposition`: `attachment; filename="whitepaper.pdf"; filename*=UTF-8''whitepaper.pdf`（触发浏览器标准另存为下载）
  - `Cache-Control`: `no-store, no-cache, must-revalidate`
- **元数据单独查询**：`GET WORKER_BASE_URL/files/:messageId/meta` 返回文件详细信息 JSON。
- **前端文件另存为下载代码示例**：
  ```typescript
  // 使用 fetch 携带 Authorization 头下载文件 Blob 并触发浏览器下载
  async function downloadSecureFile(messageId: string, fileName: string, token: string) {
    const res = await fetch(`WORKER_BASE_URL/files/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("File unavailable or burned");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  ```

---

## 10. 模块八：阅后即焚 (Burn-on-Read) 与消息过期 (TTL)

### 10.1 阅后即焚生命周期流转 (1v1 私聊 与 1:N 群聊)

1. **发送消息**：发送者指定 `retention: "on_read"`（支持文本、语音、图片、文件所有类型消息）。
2. **拉取与展示**：接收方拉取到消息，UI 上展示“阅后即焚”占位符与标识。
3. **播放/查看与已读上报**：
   - 客户端查看文本，或调用 `GET WORKER_BASE_URL/voice/:id`、`GET WORKER_BASE_URL/images/:id`、`GET WORKER_BASE_URL/files/:id` 下载内容。
   - 用户阅读完毕或查看结束后，客户端主动调用 `POST WORKER_BASE_URL/messages/:id/read`。
4. **即时返回 `burned` 状态（前端体验一致）**：
   - 无论 1v1 私聊还是群聊，服务端成功记录已读后，均返回：
     ```json
     {
       "success": true,
       "message_id": "b315c4ec-d41f-48bb-b1dc-9a85f39cce93",
       "status": "burned"
     }
     ```
   - 前端接收到 `"status": "burned"` 后，可立即在当前设备上触发销毁动画并抹除本地该条消息。
5. **已读用户的服务端防护（防死灰复燃与防重放）**：
   - 已读成员后续请求 `/conversations/:id/messages` 或增量同步 `/sync` 时，服务端自动在 SQL 层排除该成员已读的 `on_read` 消息，刷新聊天界面绝不再现。
   - 已读成员后续再次请求 `/voice/:messageId`、`/images/:messageId` 或 `/files/:messageId` 下载媒体流时，服务端直接返回 `HTTP 404`（已焚毁）。
6. **服务端的彻底双重物理擦除 (Dual Destruction)**：
   - **1v1 私聊**：单个接收方阅读后，即视为全员阅读，立即执行 D1 `messages` 表行物理删除与 R2 媒体对象（音频/图片/文件）物理删除。
   - **1:N 群聊**：消息在 D1/R2 中保留给尚未阅读的其余群成员。当群内**所有非发送者成员均完成已读确认 (`all_read === true`)** 时，服务端自动执行物理删除；若有成员长期离线未读，则在达到 `expires_at`（默认 24h）后由定时清理任务彻底清空。

### 10.2 TTL 自动过期与后台清理

- 默认所有消息有效期为 24 小时（发送方可按需传入自定义 `expires_in_seconds`）。
- 消息过期后，所有查询端点（`/sync`、`/messages`）均会自动过滤不予返回。
- 服务端配置了 Cloudflare Cron Triggers 定时任务，会自动批量物理清除过期的数据与 R2 媒体对象（音频、图片、文件）。

---

## 11. 模块九：增量全局同步引擎 (Incremental Sync)

移动端与 Web 端建议在登录后维护一个轮询或切前台拉取的“增量同步通道”。

### 11.1 增量同步端点

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
        "conversation_id": "direct:0x1610725056c027d5ae4e2fce73bb925c82c59eaa:0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
        "sender_id": "0x2c3dda511fd990cfa846acba9242c8aed3fbc7c2",
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

### 11.2 前端增量同步最佳实践架构

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

## 12. 前端 TypeScript 类型定义汇总

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
export type MemberRole = "owner" | "member";

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
  owner_address?: string | null;
  name: string | null;
  created_at: number;
  updated_at: number;
  my_role?: MemberRole;
  role?: MemberRole;
  member_count?: number;
  members?: ConversationMember[];
}

export type MessageType = "text" | "voice" | "image" | "file";
export type RetentionType = "permanent" | "on_read";
export type MessageStatus = "pending" | "delivered" | "read" | "burned";

export interface VoiceMetadata {
  id: string;
  message_id: string;
  object_key: string;
  duration: number;
  mime_type: string;
  size: number;
  created_at: number;
}

export interface ImageMetadata {
  id: string;
  message_id: string;
  object_key: string;
  file_name: string | null;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface FileMetadata {
  id: string;
  message_id: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  size: number;
  created_at: number;
}

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
  voice?: VoiceMetadata | null;
  image?: ImageMetadata | null;
  file?: FileMetadata | null;
}

export interface SyncResponse {
  messages: Message[];
  sync_timestamp: number;
  has_more: boolean;
}
```

---

## 13. 完整前端集成示例代码 (TypeScript SDK)

基于原生 `fetch` 与 `viem`（或 `ethers.js`），支持即拷即用的轻量客户端封装：

```typescript
import type {
  User,
  AuthVerifyResponse,
  Conversation,
  Message,
  VoiceMetadata,
  ImageMetadata,
  FileMetadata,
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

  public async createGroup(name: string, memberIds: string[] = [], slug?: string): Promise<Conversation> {
    return this.request<Conversation>("/groups", {
      method: "POST",
      body: JSON.stringify({ name, member_ids: memberIds, slug }),
    });
  }

  public async updateGroupName(groupId: string, name: string): Promise<Conversation> {
    return this.request<Conversation>(`/groups/${groupId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  public async addGroupMember(groupId: string, targetAddressOrId: string) {
    const payload = targetAddressOrId.startsWith("0x")
      ? { wallet_address: targetAddressOrId }
      : { user_id: targetAddressOrId };
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

  /** 获取语音元数据 */
  public async getVoiceMetadata(messageId: string): Promise<VoiceMetadata> {
    return this.request<VoiceMetadata>(`/voice/${messageId}/meta`);
  }

  // ==================== 7. 图片消息模块 (R2) ====================

  /** 上传图片（FormData 二进制） */
  public async uploadImage(
    conversationId: string,
    imageBlob: Blob,
    fileName = "image.png",
    options?: {
      caption?: string;
      width?: number;
      height?: number;
      retention?: "permanent" | "on_read";
      expiresInSeconds?: number;
    }
  ): Promise<{ message: Message; image: ImageMetadata }> {
    const formData = new FormData();
    formData.append("conversation_id", conversationId);
    formData.append("file", imageBlob, fileName);
    if (options?.caption) formData.append("caption", options.caption);
    if (options?.width) formData.append("width", options.width.toString());
    if (options?.height) formData.append("height", options.height.toString());
    formData.append("retention", options?.retention || "permanent");
    if (options?.expiresInSeconds) {
      formData.append("expires_in_seconds", options.expiresInSeconds.toString());
    }

    return this.request<{ message: Message; image: ImageMetadata }>("/images/upload", {
      method: "POST",
      body: formData,
    });
  }

  /** 获取图片 Blob URL */
  public async getImageUrl(messageId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/images/${messageId}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Image download failed: ${res.statusText}`);
    }

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  /** 获取图片元数据 */
  public async getImageMetadata(messageId: string): Promise<ImageMetadata> {
    return this.request<ImageMetadata>(`/images/${messageId}/meta`);
  }

  // ==================== 8. 文件消息模块 (R2) ====================

  /** 上传文件（FormData 二进制） */
  public async uploadFile(
    conversationId: string,
    fileBlob: Blob,
    fileName: string,
    options?: {
      caption?: string;
      retention?: "permanent" | "on_read";
      expiresInSeconds?: number;
    }
  ): Promise<{ message: Message; file: FileMetadata }> {
    const formData = new FormData();
    formData.append("conversation_id", conversationId);
    formData.append("file", fileBlob, fileName);
    formData.append("file_name", fileName);
    if (options?.caption) formData.append("caption", options.caption);
    formData.append("retention", options?.retention || "permanent");
    if (options?.expiresInSeconds) {
      formData.append("expires_in_seconds", options.expiresInSeconds.toString());
    }

    return this.request<{ message: Message; file: FileMetadata }>("/files/upload", {
      method: "POST",
      body: formData,
    });
  }

  /** 获取文件下载 Blob URL */
  public async getFileUrl(messageId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/files/${messageId}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      throw new Error(`File download failed: ${res.statusText}`);
    }

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  /** 获取文件元数据 */
  public async getFileMetadata(messageId: string): Promise<FileMetadata> {
    return this.request<FileMetadata>(`/files/${messageId}/meta`);
  }

  // ==================== 9. 全局增量同步 (Sync) ====================

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
