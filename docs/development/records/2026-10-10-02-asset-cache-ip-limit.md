# DEV-20261010-02 · 在线补齐单 IP 上限调整为 4 Mbps

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-10 / 2026-10-10，Asia/Shanghai |
| 状态 | 已完成，代码、测试与记录同属本次本地提交；未推送或部署 |
| 类型 | 调整 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`6817247`；工作区干净 |
| 上游基线 | 已合并 v0.2.2，`62eb113419123d9a3a63606107bbf85230c5dd2f`；本次不拉取 |
| 提交归属 | 与本文同一提交，按记录路径查询 |
| 关联 | [D016](../DECISIONS.md#d016)、[预缓存实现](2026-10-09-05-asset-precache.md) |

## 需求、范围与验收

用户实测单人在线补齐约 128 kB/s，明确要求单 IP 上限由 1 Mbps 提升到 4 Mbps，全服 8 Mbps 不变。仅调整默认速率、对应测试断言和配置说明，不修改队列、公平性、并发数或素材加载算法。

验收：默认 `totalBps=1000000`、`clientBps=500000`，环境变量覆盖继续生效；两个不同 IP 有各约 0.5 MB/s 的理论预算，同 IP 多玩家仍共享 4 Mbps。真实端到端速度还受链路和文件校验等因素影响。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 速率单位 | `ASSET_CACHE_LIMIT_DEFAULTS` 及环境变量说明 | 已确认：代码和 `*_BPS` 环境变量实际使用 B/s；4 Mbps 对应 500000 B/s，8 Mbps 对应 1000000 B/s |
| 部署覆盖 | `assetCacheLimitOptions()` | 已确认：显式环境变量优先于默认值，生产若设置旧值 125000 需同步改为 500000 并重启 |
| 当前速度 | 用户本次实测反馈 | 用户报告；本次不连接或测试生产服务器 |

## 实现或操作

- `server/http/cacheLimiter.js` 将默认 `clientBps` 从 `125000` 改为 `500000`，总预算保持 `1000000`。
- HTTP 默认策略断言、浏览器测试清单夹具中的对应策略同步更新，不改算法或增加并发。
- 配置说明与 D016 更新，明确旧环境变量需调整；原实现记录保留当时 1 Mbps 方案及验证事实。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/asset-cache-http.test.js` | 本机 Node.js，随机端口 HTTP 测试 | 12/12 通过，含默认总/单 IP 策略、按 IP 公平轮转、总预算、取消、背压、IP 解析及速率配置 |
| `node node_modules/eslint/bin/eslint.js server/http/cacheLimiter.js test/asset-cache-http.test.js test/asset-cache.browser.test.js` | 三个修改模块 | 通过 |
| `git diff --check` | 当前差异 | 通过 |
| `node --test test/docs-paths.test.js test/docs-consistency.test.js` | 文档路径及代码一致性 | 31/31 通过 |

不运行完整对局或重复浏览器/全量导入：只改默认参数，HTTP 测试覆盖策略与调度；未测生产端到端下载速度。HTTP 测试服务器在 fixture 的 `finally` 关闭，测试进程已结束。

## 结果、遗留与接手

- 已完成默认值与测试/文档调整；沿用既有本地提交授权，未推送、部署或连接生产服务器。
- 部署后重启生效；若生产设置旧环境变量，应改为新值，否则仍按显式配置限流。
- 接手入口：`server/http/cacheLimiter.js` 的 `ASSET_CACHE_LIMIT_DEFAULTS`。

## 后续补充

无。
