# Cloudflare Worker 多节点 / 跨库数据合并指南 (CLOUDFLARE_DATA_MERGE.md)

本文档面向运维与开发者，详细说明在 **Web3 主权群组（Sovereign Groups）** 与 **钱包地址即身份（Address-as-User-ID）** 架构下，如何将不同 Cloudflare Worker 节点（或不同 Cloudflare 账号下的 D1 数据库）的数据进行**无冲突合并（Conflict-Free State Merging）**。

---

## 1. 架构无冲突保障理论 (Mathematical Conflict-Free Guarantees)

在本项目升级至 Sovereign Groups 架构后，数据合并具备以下数学和密码学级别的无冲突保证：

| 实体 | 标识符 (ID) 规则 | 跨节点合并冲突解决策略 | 理论保障 |
| :--- | :--- | :--- | :--- |
| **用户 (users)** | `0x<wallet_address>` | `INSERT OR IGNORE` | 全局唯一，以太坊私钥主权，无任何 ID 碰撞可能。 |
| **单聊会话 (direct)** | `direct:min(addr1, addr2):max(addr1, addr2)` | `INSERT OR IGNORE` | 任意两个钱包之间的私聊 ID 全网唯一且确定。 |
| **群聊会话 (groups)** | `0x<owner_address>:<slug_or_salt>` | **LWW (Last-Write-Wins)** 基于 `updated_at` | 群 ID 绑定群主地址，仅群主单权威有权修改，无脑裂可能。 |
| **群成员关系 (members)** | `PRIMARY KEY (conversation_id, user_id)` | `INSERT OR IGNORE` | 自然复合主键，幂等集合并集，重复合并 100 次无副作用。 |
| **消息 (messages)** | `UUIDv4` | `INSERT OR IGNORE` | 服务端作为临时信箱（Ephemeral Relay），按时间戳排序游标拉取。 |

---

## 2. 准备工作

假设你要将 **源节点 (Node A)** 的群组与用户数据，合并到 **目标节点 (Node B)**。

### 必备工具
- `wrangler` CLI (已登录 Cloudflare)
- `pnpm`

### 识别数据库名称或 ID
- 源数据库：`web3_chat_db_node_a` (或本地备份 `node_a_dump.sql`)
- 目标数据库：`web3_chat_db_node_b`

---

## 3. 标准合并实操步骤 (SOP)

### 步骤 1：从源节点导出群组与成员核心数据

你可以直接使用 `wrangler d1 execute` 导出精准的无冲突数据集，或者只导出群组资产：

```bash
# 1. 导出源节点的会话表 (conversations)
wrangler d1 execute web3_chat_db_node_a --remote --json \
  --command="SELECT * FROM conversations" > conversations_a.json

# 2. 导出源节点的群成员表 (conversation_members)
wrangler d1 execute web3_chat_db_node_a --remote --json \
  --command="SELECT * FROM conversation_members" > members_a.json

# 3. (可选) 导出源节点的用户表 (users)
wrangler d1 execute web3_chat_db_node_a --remote --json \
  --command="SELECT * FROM users" > users_a.json
```

---

### 步骤 2：在目标节点执行无冲突导入 (Conflict-Free Merge SQL)

将导出的数据转换为下列具有**幂等性（Idempotent）**与**最后写入胜出（LWW）**特性的 SQL 批处理语句并执行：

#### 2.1 用户表合并 (Users)
```sql
-- 幂等合并用户，如果已存在则保留，不存在则写入
INSERT INTO users (id, wallet_address, created_at, updated_at)
VALUES 
  ('0xalice...', '0xalice...', 1710000000000, 1710000000000),
  ('0xbob...', '0xbob...', 1710000000000, 1710000000000)
ON CONFLICT(id) DO NOTHING;
```

#### 2.2 会话表合并 (Conversations) - 核心 LWW 逻辑
```sql
-- 1. 单聊会话：确定性 ID，重复则忽略
INSERT INTO conversations (id, type, owner_address, name, created_at, updated_at)
VALUES 
  ('direct:0xalice...:0xbob...', 'direct', NULL, NULL, 1710000000000, 1710000000000)
ON CONFLICT(id) DO NOTHING;

-- 2. 主权群组：只有群主能修改，按 updated_at 自动合并最新群名
INSERT INTO conversations (id, type, owner_address, name, created_at, updated_at)
VALUES 
  ('0xalice...:alpha-dao', 'group', '0xalice...', 'Web3 BUIDLers', 1710000000000, 1710005000000)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  updated_at = excluded.updated_at
WHERE excluded.updated_at > conversations.updated_at;
```

#### 2.3 群成员关系合并 (Conversation Members)
```sql
-- 幂等添加成员，复合唯一键 (conversation_id, user_id) 自动去重
INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at, last_read_message_id)
VALUES 
  ('0xalice...:alpha-dao:0xalice...', '0xalice...:alpha-dao', '0xalice...', 'owner', 1710000000000, NULL),
  ('0xalice...:alpha-dao:0xbob...', '0xalice...:alpha-dao', '0xbob...', 'member', 1710001000000, NULL)
ON CONFLICT(conversation_id, user_id) DO NOTHING;
```

---

### 步骤 3：跨节点执行 SQL 导入

将上述生成的 SQL 保存为 `merge_node_a_to_b.sql`，通过 wrangler 应用到目标库：

```bash
wrangler d1 execute web3_chat_db_node_b --remote --file=./merge_node_a_to_b.sql
```

---

## 4. 语音文件（R2）的合并策略

1. **若遵循“轻量信箱 / 仅保留群”原则**：
   - **完全无需同步 R2 存储桶**。
   - 服务端消息本身带有阅后即焚（Burn-on-Read）和 TTL 过期删除机制，历史音频已在用户端本地完成同步。
2. **若需要同步未读语音**：
   - 使用 `rclone` 或 Cloudflare Super Slurper 执行桶间同步：
     ```bash
     rclone copy r2_source:web3-chat-voice r2_dest:web3-chat-voice --transfers=16 -P
     ```

---

## 5. 合并后验证清单 (Verification Checklist)

执行下列校验语句，确保合并完整无误：

```sql
-- 1. 验证群组数量与群主一致性 (所有群的 ID 必须与 owner_address 严格前缀匹配)
SELECT id, owner_address FROM conversations 
WHERE type = 'group' AND id NOT LIKE (owner_address || ':%');
-- 预期返回: 0 行 (若 > 0 说明存在非法群组 ID)

-- 2. 验证每个群聊均有且仅有一位 owner
SELECT conversation_id, COUNT(*) AS owner_count 
FROM conversation_members 
WHERE role = 'owner' 
GROUP BY conversation_id 
HAVING owner_count != 1;
-- 预期返回: 0 行

-- 3. 验证单聊格式符合 direct:min:max
SELECT id FROM conversations 
WHERE type = 'direct' AND id NOT LIKE 'direct:0x%';
-- 预期返回: 0 行
```

---

## 6. 常见问题解答 (FAQ)

### Q1: 节点 A 和节点 B 同时有人创建了群名相同的群，会冲突吗？
**绝不冲突**。因为群 ID 强制包含创建者钱包前缀：
- Alice 在 Node A 创建 `Devs` -> ID 为 `0xalice:slug_1`
- Bob 在 Node B 创建 `Devs` -> ID 为 `0xbob:slug_2`
合并后，这是两个独立的合法群，互不干扰。

### Q2: 为什么群主不能移交？
因为去中心化状态合并中最棘手的问题是“所有权脑裂”：
- 若 Node A 记录 Alice 移交给了 Bob；
- Node B 因网络隔离同时记录 Alice 移交给了 Charlie；
合并时将无法以轻量级算法裁决谁是合法群主。
通过**群主与群 ID 终生内生绑定**，世界上只有群主本人的 EVM 私钥能够发起合法变更，实现数学层面的确定性与零争端。
