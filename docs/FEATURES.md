# Web3 Chat Worker 功能清单（除基础聊天与群聊外）

> 本文档汇总除「单聊（1:1）」和「普通群聊（1:N）」基础收发消息之外的所有扩展功能。

---

## 一、功能模块总览

| 模块 | 核心能力 | 存储/依赖 |
| :--- | :--- | :--- |
| **1. Web3 认证体系** | EVM 钱包签名免密登录（EIP-191）、防重放 Nonce、30天 Session Token | D1 |
| **2. 用户体系与资料** | 全局唯一用户名（@username）、双层元数据（公有/私有）、专属单头像管理 | D1 + R2 |
| **3. 社交图谱与好友** | 备注名/标签分类、好友申请流程（未读红点）、共同群聊智能推荐、黑名单 | D1 |
| **4. Web3 社群（Club）** | VIP 申请建群、链上代币/NFT持仓门禁、付费进群门票、社群发现与收藏 | D1 + 链上 RPC |
| **5. 朋友圈动态（Feed）** | 图文/短视频发布（HTTP Range 206 点播）、点赞/编辑/软删、超出配额付费发帖 | D1 + R2 |
| **6. 链上支付与会员权益** | BSC 多币种（USDT/BNB）支付、VIP 会员、群人数扩容、白名单免单、R2 权益快照 | D1 + R2 + 链上 RPC |
| **7. 链上分红索引器** | LHSwap 交易对及分红池自动扫描、全网分红人数去重统计、7d/30d 年化 APR、跨设备流水 | D1 + 链上 RPC |
| **8. 机器人开放平台** | 自助免审批注册 Bot、原生虚拟用户、OpenAPI（发消息/贴纸/群管禁言/踢人/监听） | D1 |
| **9. 聊天分类文件夹** | 类似 Telegram 的会话标签文件夹、自定义排序/隐藏、包含指定会话 | D1 |
| **10. 动图贴纸表情包** | R2 托管 Telemoji 动态 WebP 贴纸包、永久 CDN 缓存、原生贴纸消息类型 | R2 |
| **11. 举报与私有存证** | 8大类违规举报（用户/群）、R2 私有证据图绝对隔离、后台工单审核流 | D1 + R2 |
| **12. 社区运营与后台** | 运营 Banner 轮播图、全站限时公告横幅、社群封禁/打标（热门/认证）、审计日志 | D1 |
| **13. 官网与邀请落地页** | 官方 Android APK 分发、群/好友邀请落地页（智能唤起 `chaintalk://` 深链，未装引导下载） | R2 + Web |
| **14. 存储生命周期清理** | Cron 定期物理清扫过期阅后即焚、超期 Nonce、失效订单、孤立 R2 文件 | D1 + R2 |

---

## 二、各模块详细功能说明

### 1. Web3 钱包鉴权与用户资料 (`/auth`, `/users`)
- **EIP-191 签名登录**：`POST /auth/nonce` 生成一次性挑战码；`POST /auth/verify` 验证签名并下发 Session Token。
- **全局唯一用户名（@username）**：
  - `PUT /users/me/username`：设置/修改用户名（3~20位字母数字下划线，先到先得）。
  - `GET /users/check-username/:username`：实时查重与格式校验。
  - `GET /users/by-username/:username`：按用户名精确查找用户资料卡。
- **双层元数据（Metadata）**：
  - `public_metadata`：公开昵称、简介等，所有人可见。
  - `private_metadata`：仅用户本人可见（如界面主题、偏好配置）。
- **专属单头像管理**：`POST /users/me/avatar` 上传新头像，系统自动在 R2 物理销毁旧头像，杜绝存储膨胀。

---

### 2. 社交图谱与好友体系 (`/friends`, `/friend-requests`, `/blacklist`)
- **好友关系与标签**：
  - `POST /friends`：添加好友，支持设置备注名（alias）与多标签分类（tags）。
  - `GET /friends?tag=xxx`：按标签筛选好友。
  - `DELETE /friends/:address`：删除好友（严格单聊守卫：单方删除后双向禁聊）。
- **好友申请与验证（Friend Requests）**：
  - `POST /friend-requests`：提交好友申请，可附带最长 500 字验证留言。
  - `GET /friend-requests?direction=incoming`：查看收到的申请，**进入列表自动清零红点**。
  - `GET /friend-requests/unread-count`：右上角未读申请角标数量接口。
  - `POST /friend-requests/:id/accept`：同意申请，双向建立联系人。
- **智能好友推荐（“可能认识的人”）**：
  - `GET /friends/recommendations`：排除已是好友和黑名单后，**按“共同群聊数量”（`shared_groups`）倒序排序**，支持关键词模糊搜索。
- **黑名单机制**：`POST /blacklist`，被拉黑用户无法发起单聊、无法发消息、无法发送好友申请。

---

### 3. Web3 社群（Club）与智能门禁 (`/clubs`)
- **社群发现与收藏**：`GET /clubs`（搜索发现社群广场）、`POST/DELETE /clubs/:id/favorite`（收藏/取消收藏）、`GET /clubs/:id`（社群主页）。
- **会员建群申请制**：
  - `POST /clubs/apply`：仅 VIP 会员有资格提交建群申请。
  - `GET /clubs/my-application`：查询个人申请进度，后台审批通过后自动初始化群。
- **多级智能门禁（Join Gates）**：
  - **链上持仓门禁（Holdings Gate）**：进群前校验钱包链上 ERC-20 或 NFT 余额，未达标拒绝入群（403 并返回缺口）。
  - **付费门禁（Payment Gate）**：社群可设置 `join_price`，入群需先通过链上支付完成订单。
  - **审批门禁（Approval Gate）**：开启后需管理员在后台/群内审批。
  - **容量控制（Capacity Gate）**：群员达上限时拦截并引导群主购买扩容包。
- **社群私域动态**：`GET /clubs/:id/feed`，按板块（`all`, `featured`, `admins`, `media`, `files`）过滤群内沉淀的内容。

---

### 4. 朋友圈动态（Moments / Social Feed） (`/feed`)
- **图文与短视频发布**：
  - `POST /feed/images`：上传动态图片（≤10MB）。
  - `POST /feed/videos`：上传短视频（≤50MB）。
  - `POST /feed/posts`：发布动态（支持 ≤2000 字、最多 9 张图、短视频附件、指定所属社群与板块）。
- **视频分段流式点播（Range 206）**：`GET /feed/videos/*`，深度兼容移动端播放器（ExoPlayer 等），支持分段拉流，防止画面花屏。
- **互动与管理**：
  - `POST/DELETE /feed/posts/:id/like`：点赞 / 取消点赞（维护原子点赞数）。
  - `PATCH /feed/posts/:id`：修改动态内容。
  - `DELETE /feed/posts/:id`：作者或所属 Club 群主/管理员可执行软删除。
- **发帖微付费（Feed Post Monetization）**：社群设置免费发帖额度，超额后每次发帖需核销已支付订单（`kind='feed_post'`）。

---

### 5. 链上支付、VIP 会员与容量扩容 (`/payments`, `/entitlements`)
- **多代币支持**：支持 BSC 等链的 USDT、BNB 支付与独立定价。
- **四大消费品类**：
  1. `membership_month` / `membership_year`：VIP 会员月卡（30天）/ 年卡（365天）。
  2. `group_capacity`：群人数扩容（50人免费 → 100/200/300/400/500人梯度包），会员专享折扣。
  3. `club_join`：付费社群入群门票。
  4. `feed_post`：超量动态按篇付费。
- **订单流程与安全**：
  - `POST /payments/quote-preview`：纯报价计算，不产生脏订单。
  - `POST /payments/quote`：生成冻结订单（锁定代币、金额、收款地址与过期时间）。
  - `POST /payments/orders/:id/submit`：提交链上交易哈希（txHash），防一笔交易重复认领，即时验证 + 后台 Cron 自动兜底对账。
- **白名单免单**：白名单钱包创建订单直接免单（金额为 0）并赋予永久 VIP。
- **R2 快照加速**：钱包权益生成 JSON 快照存入 R2，`GET /entitlements/me` 实现毫秒级读取。

---

### 6. LHSwap 链上分红聚合索引器 (`/dividends`)
- **自动化索引**：Worker Cron 每分钟扫描 LHSwap 全部交易对与分红合约，公开免鉴权读取。
- **全网数据总览 (`GET /dividends/overview`)**：
  - 全网分红人数（`holderCount`）：枚举 NFT 持有者并剔除燃烧地址，获得真实去重人数。
  - 汇总全网分红池余额（`totalPoolUsd`）与累计手续费（`totalFeesUsd`）。
- **池列表与预期年化 (`GET /dividends/pairs`)**：实时计算每池 7 天年化（`apr7d`）与 30 天年化（`apr30d`）。
- **单池日明细 (`GET /dividends/pairs/:pair/apr`)**：近 30 天手续费日聚合数据。
- **跨设备流水与持仓**：
  - `GET /dividends/claims/:address`：索引链上 `RewardClaimed` 事件，换机也能查询历史领取明细。
  - `GET /dividends/holders/:address`：跨设备查询分红 NFT 持仓。

---

### 7. Telegram 式机器人开放平台 (`/bots`, `/bot/*`)
- **用户侧机器人管理 (`/bots`)**：
  - `POST /bots`：无需 BotFather，直接注册生成 `bot_id` 与明文 `api_key`。
  - `PATCH /bots/:id`、`POST /bots/:id/reset-key`：修改 Bot 资料或重置密钥。
- **机器人原生虚拟用户**：机器人底层是原生 User，拥有专属 ID 与数据表，无缝融入各业务流程。
- **开放操作接口 (`/bot/*`，凭 `bot_id` + `api_key` 鉴权)**：
  - **消息功能**：`POST /bot/messages/send`，发送文本、动态贴纸、@艾特提醒、限时自毁消息。
  - **群管功能**：违规踢人（`/kick`）、全员禁言（`/mute`）、单人限时禁言（`/mute-member`）、修改群公告/资料。
  - **管理员特权**：Bot 被设为管理员后，全群禁言下依然可以正常广播消息。
  - **长轮询监听**：`GET /bot/sync`，增量同步消息，方便外部程序或 AI Agent 实时响应。

---

### 8. 聊天分类文件夹 (`/chat-folders`)
- **会话分组管理**：用户可创建多个标签文件夹（如“同事”、“DeFi”、“DAO”）。
- **灵活规则配置**：
  - 过滤范围：全部（all）、仅单聊（direct）、仅群聊（group）。
  - 自定义排序权重（`sort_order`）、文件夹隐藏开关（`hidden`）。
  - 指定收录会话 ID 列表（`member_conversation_ids`）。

---

### 9. 动图贴纸表情包 (`/stickers`)
- **R2 静态托管**：由 Cloudflare R2 直接托管 Telemoji 动态 WebP 贴纸资源与配置文件。
- **永久高速缓存**：设置 `Cache-Control: public, max-age=31536000, immutable`，边缘节点极速分发。
- **原生贴纸消息**：消息表原生支持 `type: "sticker"`。

---

### 10. 安全合规、举报存证与私有证据链 (`/reports`)
- **私有证据上传**：`POST /reports/evidence`，截图上传至 R2 私有路径（`report-evidence/`），绝对隔离，不在任何会话中流转，被举报人无法查看。
- **提交举报**：`POST /reports`，支持针对“用户”或“群聊”维度，覆盖 8 大违规类型（欺诈、骚扰、盗号、侵权、假冒、未成年人保护等），关联消息 ID 与证据图。
- **管理后台审核**：提供完整工单流（received → under_review → resolved / rejected），保护社区环境。

---

### 11. 社区运营与管理后台 (`/community`, `/internal/admin/*`)
- **运营 Banner 轮播图**：`GET /community/banners`（客户端拉取启用项）；管理端支持 CRUD、排序权重、跳转链接配置。
- **全站公告横幅（Community Announcement）**：`GET /community/announcement`，支持富文本公告内容与生效起止时间窗（`start_at`/`end_at`）。
- **内部管理接口（HMAC 鉴权）**：
  - 违规社群封禁与解封（`setGroupBanned`）。
  - 社群打标推荐（`hot` 热门、`verified` 官方认证）。
  - Club 建群申请审批（`approve` / `reject`）。
  - 动态 Feed 内容巡检、编辑与违规下架。
  - 全量操作审计日志（Audit Log）。

---

### 12. 官方下载与邀请裂变落地页 (`/`, `/download`, `/g/*`, `/u/*`)
- **官方 Android 安装包分发**：
  - `GET /`、`GET /download`：官网展示 App 功能特性与版本信息。
  - `GET /app/lh-latest.apk`：流式直链下载最新安装包。
  - `GET /app/version.json`：应用内自动检查更新接口。
- **统一邀请裂变落地页**：
  - 群邀请：`https://api.chatnice.top/g/<token|slug>`
  - 好友邀请：`https://api.chatnice.top/u/<address>`
  - **智能唤起策略**：页面立即尝试拉起 `chaintalk://` 客户端深链；若 1.6 秒内未检测到打开（未安装），自动切换展示 App 下载引导，实现平滑拉新转化。

---

### 13. 存储生命周期管理与定时清理 (`/internal/admin/storage/*`)
- **每分钟 Cron 清扫**：自动物理清理超期未读焚毁消息、临时 Nonce，并同步删除 R2 中的多媒体文件。
- **小时级生命周期**：扫描超期失效的支付订单、已软删 Feed 遗留的音视频附件、孤立未引用文件，保持 D1 与 R2 存储精简。
- **管理端预览与手动触发**：支持 `dry_run` 预览待清理统计（`GET /internal/admin/storage/stats`）与按表指定执行（`POST /internal/admin/storage/cleanup`）。
