# 分红索引 API — 前端对接说明

Base URL：`https://api.chatnice.top`（与 ChainTalk IM 同一个 Worker，路径前缀 `/dividends`）

本模块由 Cloudflare Worker cron（每分钟）增量扫描 LHSwap 工厂下**全部**交易对的链上数据并落库（D1），解决分红中心页四项数据缺口：

| 前端痛点 | 对应接口 |
| --- | --- |
| 精确全网分红人数（替代 totalMinted 求和近似） | `GET /dividends/overview` → `holderCount`（按 Transfer 事件 holder 去重，balance>0） |
| 预期年化 APR（现显示 --） | `GET /dividends/pairs` → 每池 `apr7d` / `apr30d`；明细 `GET /dividends/pairs/:pair/apr` |
| 真·全网统计（覆盖全部池，非仅用户相关池） | `GET /dividends/overview` → `totalPoolUsd` / `totalFeesUsd` / `pairCount` |
| 跨设备领取流水 | `GET /dividends/claims/:address`（索引 RewardClaimed 事件，换机可查） |

所有接口**只读、无需鉴权**（数据均为公开链上数据聚合）。金额为 uint256 十进制**字符串**，前端用 BigInt 解析后按 `decimals` 换算。`null` 表示无法定价（缺价格或 TVL 为 0），前端显示 `--`。

## 通用参数

- `chainId`（query，默认 `56`）：BSC 主网 `56` / 测试网 `97`。前端映射沿用 `dividend_center_page.dart` 的 `_chainIdForStorage()` 口径。

## 1. 全网统计 `GET /dividends/overview?chainId=56`

```json
{
  "chainId": 56,
  "pairCount": 3,
  "holderCount": 128,
  "nftTotalMinted": 300,
  "totalPoolUsd": 15234.56,
  "totalFeesUsd": 88711.02,
  "pricesUpdatedAt": 1760000000000,
  "syncedBlock": 61234567,
  "updatedAt": 1760000000000
}
```

- `holderCount`：全网分红人数。由 Worker 对每个 DividendNFT 合约做 `ownerOf(1..totalMinted)` 全量枚举重建 holder 集合（燃烧 tokenId 自动剔除），再跨合约按地址去重（balance>0）。比 totalMinted 求和精确：转账去重、燃烧剔除。
- `totalPoolUsd` / `totalFeesUsd`：全部池分红池余额 / 累计手续费（`totalFees`）USD 合计；全部为不可定价代币时为 `null`。
- 价格源：Hyperliquid `allMids`（与 App 内 PriceUtil 一致，稳定币按 1 USD），Worker 侧缓存 10 分钟。
- `syncedBlock`：事件索引游标，可用于 UI 提示"同步至区块 #N"。
- 注意：公共 RPC（publicnode）只保留近期约 15 万块的 receipts。索引器 bootstrap 会从链头反向探测到首个事件或可用历史起点；早于可用历史起点的 FeeDeposited/RewardClaimed 无法补录（APR 只反映可用区间内的滚动手续费）。holderCount 不受影响（ownerOf 枚举不依赖历史事件）。如需完整历史，配置付费归档 RPC：`wrangler secret put` 或 vars 覆盖 `DIVIDEND_RPC_56` / `DIVIDEND_RPC_97` 即可，无需改代码。

## 2. 全部池列表 `GET /dividends/pairs?chainId=56`

```json
{
  "pricesUpdatedAt": 1760000000000,
  "pairs": [
    {
      "pairAddress": "0x...",
      "rewardContract": "0x...",
      "nftContract": "0x...",
      "token0": { "address": "0x...", "symbol": "USDT", "decimals": 18 },
      "token1": { "address": "0x...", "symbol": "BNB", "decimals": 18 },
      "poolBalance0": "1000000000000000000000",
      "poolBalance1": "2000000000000000000",
      "totalFees0": "...",
      "totalFees1": "...",
      "poolUsd": 2200.0,
      "totalFeesUsd": 300500.0,
      "tvlUsd": 400000.0,
      "nftTotalMinted": 2,
      "holderCount": 1,
      "apr7d": 1.34,
      "apr30d": null,
      "stateUpdatedAt": 1760000000000
    }
  ]
}
```

- `apr7d` / `apr30d`：滚动年化百分比（%），公式 = 近 N 天已索引手续费 USD ÷ N × 365 ÷ 池 TVL（LP 储备 × 价格）× 100。数据不足为 `null` → 显示 `--`。
- `holderCount`：该池分红 NFT 持有地址数（去重、balance>0）。
- 池余额 / 手续费 / 储备由 cron 每分钟轮询刷新（每 tick 刷新若干池，轮换全覆盖）。

## 3. 单池 APR 明细 `GET /dividends/pairs/:pair/apr?chainId=56`

`:pair` 为交易对地址。在上条字段基础上附带近 30 天手续费日聚合：

```json
{
  "...": "同上字段",
  "daily": [
    { "dayIndex": 20500, "date": "2026-09-22", "feesUsd": 12.34, "tokens": { "0x...": "10000000000000000000" } }
  ]
}
```

未索引的池返回 `404 { "error": "pair not indexed" }`（新池最长一分钟内被 cron 发现）。

## 4. 领取流水（跨设备） `GET /dividends/claims/:address?chainId=56&pair=0x...&limit=50&beforeBlock=61200000`

```json
{
  "items": [
    {
      "txHash": "0x...",
      "logIndex": 3,
      "pairAddress": "0x...",
      "rewardContract": "0x...",
      "userAddress": "0x...",
      "tokenAddress": "0x...",
      "tokenSymbol": "USDT",
      "tokenDecimals": 18,
      "amount": "3000000000000000000",
      "dayIndex": 20499,
      "blockNumber": 61200001,
      "timestamp": 1759999000000
    }
  ],
  "hasMore": true,
  "nextBeforeBlock": 61200001
}
```

- `timestamp` 为毫秒（0 表示区块时间尚未回填）。
- 分页：下一次请求带 `beforeBlock=nextBeforeBlock`。`limit` 1–200，默认 50。`pair` 可选，限定单池流水。
- 一笔 `claimRewards` 可能产出两条记录（token0/token1 各一），同 `txHash` 不同 `logIndex`，前端如需合并按 txHash 聚合。

## 5. 我的持仓（跨设备 NFT 余额） `GET /dividends/holders/:address?chainId=56`

```json
{
  "address": "0x...",
  "chainId": 56,
  "totalBalance": 2,
  "positions": [
    { "nftContract": "0x...", "pairAddress": "0x...", "balance": 2, "nftTotalMinted": 100, "holderCount": 40 }
  ]
}
```

## 6. 运维接口 `POST /dividends/sync`

手动触发一次索引 tick（与 cron 同逻辑），用于部署后立即补数。返回每链统计：

```json
{ "ran": true, "timestamp": 1760000000000, "chains": [ { "chainId": 56, "pairsAdded": 1, "rewardEvents": 2, "transferEvents": 3, "poolsRefreshed": 1, "lastBlock": 61234567, "latestBlock": 61234567 } ] }
```

## 前端改造建议（对应 `dividend_center_page.dart`）

1. **统计 2×2**：`分红池总金额` / `全网累计手续费` 改用 `/dividends/overview` 的 `totalPoolUsd` / `totalFeesUsd`（口径从"您的相关池"升级为全网），`全网分红人数` 用 `holderCount`；本地仍有价的用户池数据可作兜底（接口失败时回退现有链上直读逻辑）。
2. **预期年化**：池卡 `apr7d` 来自 `/dividends/pairs`（按 `pairAddress` 匹配）；`null` 保持 `--`。
3. **专属分红流水**：优先 `/dividends/claims/:address?pair=`，失败回退现有 `eth_getLogs` + 本地记录合并逻辑；本地记录仍保留用于领取后即时展示（索引延迟最长约 1–2 分钟）。
4. **轮询节奏**：页内现有 30s 定时刷新可直接复用；索引数据每分钟更新，无需更高频。
5. **降级**：接口 4xx/5xx 或 `error` 字段 → 整体回退现有纯链上逻辑，不阻塞领取链路（领取本身仍走 `SwapRouter.claimRewards` 链上交易，与本索引无关）。
