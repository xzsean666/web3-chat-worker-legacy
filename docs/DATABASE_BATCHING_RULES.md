# Cloudflare D1 数据库写入与 Auto-Batch 架构规范

本文档为工程团队及 AI Agent 编写后续所有数据库相关功能时的**强制开发规范与架构参考手册**。

---

## 1. 背景与核心设计约束

Cloudflare D1 底层基于分布式 SQLite 实现，具有以下独特的运行时约束：
1. **单写者并发限制（Single-Writer Lock）**：SQLite 在处理写入事务时需要获取独占写锁。如果高并发请求频繁发起独立的离散写入（单条 `.run()`），会导致剧烈的锁争用（Lock Contention）、排队延迟甚至超时报错。
2. **IPC/网络往返开销**：在 Cloudflare Worker 中，每一次对 D1 的查询往返都包含 Worker Runtime 到 D1 服务的内部通讯开销。
3. **参数与语句上限**：
   - D1 单个 SQL 语句绑定参数硬上限为 **100 个**（超限直接抛错）。
   - D1 单次 `db.batch()` 推荐最大语句数为 **50 ~ 100 条**。
4. **不支持交互式事务字符串**：D1 不支持直接执行 `BEGIN TRANSACTION` / `COMMIT`，原子事务**必须**通过 `db.batch([stmt1, stmt2, ...])` 提交。

为了彻底解决上述痛点，本项目在系统最底层实现了 **Auto-Batch（自动微批写入缓冲与防抖合并引擎）**，并在核心业务中全面应用了 **显式 Batch**。

---

## 2. 底层 Auto-Batch 运行机制 (透明全托管)

项目底层已在运行时实现三层全自动拦截，开发者在编写新功能时**无需做任何特殊适配，常规写操作会自动受到保护**：

### 2.1 三层拦截与生命周期
1. **运行时顶层注入 (`src/index.ts` -> `export default.fetch`)**：
   在任何 HTTP 请求进入框架之前，Worker 顶层入口自动将 `env.DB` 代理包装为 `withAutoBatch(env.DB, { ctx })`。
2. **框架中间件层 (`src/index.ts` -> `app.use('*')`)**：
   所有 Hono 路由上下文中通过 `c.env.DB` 获取的数据库均为自动微批实例，并在请求生命周期结束（`finally` 钩子）时自动确保未落盘队列全量刷盘（`db.flush()`）。
3. **SQL 预编译语句拦截层 (`src/db/batcher.ts`)**：
   无论是否使用参数绑定，所有突变语句（`INSERT` / `UPDATE` / `DELETE` / `REPLACE`）的 `.run()` 均被底层 `D1WriteBatcher` 拦截，汇聚到内存微批池中，在微批防抖窗口（默认 `20ms` 或达到 `100` 条）内自动聚合为原生 `db.batch()` 提交。

### 2.2 严格读己之写保证 (Read-Your-Own-Writes, RYOW)
为了避免异步批处理导致的脏读问题：
- 当业务代码在当前请求/Worker 实例内执行了写操作后，紧接着调用任何读方法（`.first()`、`.all()`、`.raw()`、`db.batch()`、`db.exec()`）：
- **底层代理会自动在执行读取前，先行触发 `writeBatcher.flush()`**，确保当前 Isolate 内存中的写入已完全落盘到 D1，随后执行查询，严格保证强一致性。

### 2.3 Cloudflare Worker 运行时保活
在计时器等待微批刷盘期间，引擎会自动通过 `ctx.waitUntil(this.waitForPendingDrain())` 向 Cloudflare 运行时注册保活 Promise，防止 Worker 实例因请求返回而提前被运行时挂起或销毁。

### 2.4 内存内聚合机制与边界 (In-Memory Aggregation Scope)
1. **当前实现的聚合（语句队列级批处理聚合，Statement-level Batching）**：
   - 将 Isolate 内存中所有零散的 Prepared Statement（带绑定参数）暂存入 FIFO 队列。
   - 刷盘时一并打包为 D1 原生原子事务 `rawDb.batch([stmt1, stmt2, ...])` 提交，把多次跨网络 RPC 与 SQLite 独立写锁争用削减为单次原子批量事务。
2. **为什么不做通用 SQL 字符串/AST 级合并（如拼接多行 INSERT 或抵消 UPDATE）？**：
   - **调用方元数据隔离**：每个 `await stmt.run()` 调用者依赖专属于自身的 `D1Result`（`meta.changes`、`last_row_id`）。如果粗暴拼成单条多行 SQL，无法将底层单份结果准确拆分回传给各自独立的 Promise。
   - **约束与错误隔离**：如果其中一条存在唯一性冲突或外键错误，单独语句执行能精准定位并回滚；拼装字符串会导致整批语法或执行直接失败。
   - **无服务器 CPU 预算**：在 Worker 限制内运行完整 SQL AST 解析器的消耗往往超过 D1 `batch` 执行几条预编译语句。
3. **参数配置权衡（100 条 vs 20ms/100ms）**：
   - `maxBatchSize = 100`：完全适配 D1 单次原子批处理安全上限。
   - `maxWaitMs = 20ms`：对于需要 `await stmt.run()` 等待写入落盘的在线 HTTP 请求，20ms 是兼顾吞吐量与极低用户感应延迟的黄金窗口；若设为 100ms 则会给每个单次写入硬性增加 100ms 响应延迟，并在串行测试或高频循环中引发超时。

---

## 3. 开发者编写新功能的最佳实践规范

后续增加新业务、新增路由或 Service 时，请遵循以下开发准则：

### 3.1 规则一：常规单条写操作，保持极简正常书写
由于底层已经全托管，对于独立的增删改，您直接编写标准的 D1 代码即可，底层会自动进行微批合并：

```typescript
// ✅ 推荐：正常编写，底层自动入队微批并防抖合并
export async function updateUserStatus(db: D1Database, userId: string, status: string) {
  await db
    .prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, Date.now(), userId)
    .run();
}
```

---

### 3.2 规则二：同一业务内多条强关联写入，优先使用显式 `db.batch()`
如果一个操作在逻辑上需要同时更新多张表或多条记录（例如：创建群组并插入成员、接受好友并建立双向关系），**应当显式调用 `db.batch([stmt1, stmt2, ...])`**。

- **收益**：D1 会将整个数组打包在同一个 SQLite 事务（`BEGIN...COMMIT`）中原子执行，不仅保证强事务性（要么全成功、要么全失败），还能将多次网络往返直接压缩为 1 次。

```typescript
// ✅ 推荐：多语句使用显式 batch 打包
export async function createDirectConversation(db: D1Database, convId: string, userA: string, userB: string) {
  const now = Date.now();
  const convStmt = db
    .prepare('INSERT INTO conversations (id, type, created_at, updated_at) VALUES (?, "direct", ?, ?)')
    .bind(convId, now, now);
  const memberAStmt = db
    .prepare('INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, "member", ?)')
    .bind(`${convId}:${userA}`, convId, userA, now);
  const memberBStmt = db
    .prepare('INSERT INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, "member", ?)')
    .bind(`${convId}:${userB}`, convId, userB, now);

  // 原子执行 3 条语句，1 次 D1 往返
  await db.batch([convStmt, memberAStmt, memberBStmt]);
}
```

---

### 3.3 规则三：大批量数据操作必须使用 `src/db/chunker.ts` 分块
当需要对几十甚至上百个目标进行批量插入、更新或删除时，**严禁一次性传入超长数组**，必须使用工程内置的切块工具：

1. **语句批次分块**：使用 `chunkArray(statements, 50)`，每批控制在 50 条以内。
2. **参数限制分块**：多参数构建语句或大 `IN (...)` 查询时，参数量不得超过 80（D1 上限为 100），使用 `chunkByParamCount` 或分批 `IN` 查询。

```typescript
import { chunkArray } from '../db';

// ✅ 推荐：大批量成员导入分块处理
export async function addManyMembers(db: D1Database, groupId: string, userIds: string[]) {
  const now = Date.now();
  const stmts = userIds.map((userId) =>
    db
      .prepare('INSERT OR IGNORE INTO conversation_members (id, conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, "member", ?)')
      .bind(`${groupId}:${userId}`, groupId, userId, now)
  );

  // 按 50 条安全切块，防止超限与长事务
  const chunks = chunkArray(stmts, 50);
  for (const chunk of chunks) {
    await db.batch(chunk);
  }
}
```

---

### 3.4 规则四：严禁的反模式 (Anti-Patterns)

| 严禁行为 | 原因 | 正确做法 |
| :--- | :--- | :--- |
| ❌ 执行 `db.exec('BEGIN TRANSACTION')` | D1 驱动不支持原生事务 SQL 控制，会直接抛异常 | 使用 `db.batch([stmt1, stmt2])` |
| ❌ 在循环中执行独立 `await stmt.run()`（上百次） | 频繁占用单写者锁，造成 Worker CPU/排队超时 | 将语句收集到数组中，使用 `db.batch()` 或分块提交 |
| ❌ 单个 `IN (?, ?, ...)` 拼接超过 100 个占位符 | 触发 D1 `too many SQL variables` 硬限制报错 | 使用 `chunkArray(ids, 50)` 分批查询 |
| ❌ 绕过 `c.env.DB` 重新初始化未经包装的数据库连接 | 会失去全局微批合并与生命周期保活能力 | 统一使用传入的 `c.env.DB` 或 Service 传入的 `db` 参数 |

---

## 4. 核心文件与模块索引

| 文件路径 | 职责定位 |
| :--- | :--- |
| [`src/db/batcher.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/db/batcher.ts) | Auto-Batch 核心引擎：`D1WriteBatcher` 队列、`withAutoBatch` 代理、RYOW 拦截 |
| [`src/db/chunker.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/db/chunker.ts) | 安全分块工具：`chunkArray`、`chunkByParamCount`、参数上限守卫 |
| [`src/index.ts`](file:///ssd0/git/web3-chat-worker-legacy/src/index.ts) | 顶层中间件及 Worker 生命周期挂载（`fetch` / `scheduled`） |
| [`test/batcher.test.ts`](file:///ssd0/git/web3-chat-worker-legacy/test/batcher.test.ts) | 针对 Auto-Batch 与 Chunker 的完整测试套件（18 项单元测试） |
| [`docs/AI/DECISIONS.md`](file:///ssd0/git/web3-chat-worker-legacy/docs/AI/DECISIONS.md) | 架构决策记录（ADR-012） |
