# DEV-20261012-03 · 带宽紧急监测默认关闭与服主开关

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-12 / 2026-10-12，Asia/Shanghai |
| 状态 | 已完成 |
| 类型 | 修复 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`8e5b779eaae49f85cacb88048b308efbe6d52fe0` |
| 上游基线 | 当前核心分支 v0.2.4 及既有带宽保护实现；本任务未拉取或修改远程 |
| 提交归属 | 与本文同一提交，按记录路径查询 |
| 关联 | [D030](../DECISIONS.md#d030)、[DEV-20261011-07](2026-10-11-07-bandwidth-emergency.md)、[I005](../README.md#待办与未确定事项) |

## 需求、范围与验收

用户担心带宽判定在其他服务器上误触发，要求把自动检测改为默认关闭；关闭时停止网卡、缓存需求、对局拥堵读取和检测定时器，避免无用采样。服主需要能通过命令在运行中开启或关闭功能；自动试恢复间隔从 120 秒改为 60 秒。已有熔断、对局冻结和访问保护逻辑保持不变。

本任务只修改服务端配置、检测器、CLI、定向测试和开发文档；不修改远程，不部署，不改变既有用户已有的 `docs/SERVER_SETTINGS.md` 工作区改动。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 低出口是否能直接证明阿里云雪崩 | `server/bandwidthEmergency.js` 的检测规则；出口速率还需要需求和背压/对局拥堵佐证 | 不能直接证明。检测器采用 5 秒窗口、15 秒持续异常、60% 比例和需求/多网络联合证据，仍可能受共享出口、网卡选择或反代路径影响；已将默认开关改为关闭，减少普通服务器误触发。已确认 |
| 关闭状态是否仍消耗检测工作 | 原实现 `start()` 会启动 poll/interval，`poll()` 先读取需求再检查 enabled | 原实现即使关闭也会读取需求并可能建立定时器；本任务修复为关闭时不启动首次 poll、不建立定时器，poll 入口直接返回。已确认 |
| 运行中的服主如何控制 | 既有私有 `server-settings.json` 轮询和 `tools/server-settings.mjs` | 增加 `bandwidth-emergency on|off [--dir]`。持久字段优先于启动环境变量，约 1 秒由运行中服务读取。关闭已有保护时主动释放保护状态，这是服主明确关闭保护的操作语义。已确认 |
| 试恢复周期 | 用户本轮要求修改为 60 秒 | 默认 `SP_BANDWIDTH_AUTO_RESUME_MS=60000`；保护条件未满足时每次再延后 60 秒。已确认 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `server/bandwidthEmergency.js`：默认配置、`poll`、`start`、`setEnabled` | 默认 `enabled=false`、`autoResumeMs=60000`；增加运行时 `setEnabled(boolean)`；关闭时清证据、清定时器并跳过需求/拥堵/网卡读取；开启后在已启动控制器上重新建立定时器 | 满足默认关闭和零监测开销，同时保留已有自动熔断实现 |
| `server/serverSettings.js`：配置校验、原子写入、刷新比较 | 允许可选 `bandwidthEmergencyEnabled` 字段；缺少该字段时仍回退到启动/环境默认，保留旧配置文件形状 | 不破坏现有 AI、准入和限速配置；CLI 只改自己的字段 |
| `server/index.js`：`applySettings` 与控制器创建 | 启动时读取持久开关；运行中配置轮询调用 `setEnabled`，持久值优先于环境值 | 不增加公开 HTTP 管理入口，沿用既有服主私有配置机制 |
| `tools/server-settings.mjs` | 增加 `bandwidth-emergency on|off`、帮助和 `show` 输出 | 便于服务器现场快速解除或启用保护 |
| `test/bandwidth-emergency.test.js`、`test/server-settings.test.js` | 调整 60 秒断言；增加关闭无读取/无定时器、运行时切换及 CLI 配置传播测试 | 覆盖开关的实际边界，而不是只验证常量 |
| `docs/ASSET_CACHE.md`、`docs/development/DECISIONS.md`、`docs/development/README.md` | 同步默认关闭、CLI、60 秒和误触发边界 | 让运行手册、长期决定和待办保持一致 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/bandwidth-emergency.test.js` | Node 本地检测器夹具 | 通过，22/22；覆盖 60 秒重试、关闭无读取/无定时器和运行时切换 |
| `node --test test/server-settings.test.js` | Node 临时配置目录、真实 `startServer` 控制器 | 通过，17/17；覆盖 CLI 持久字段和运行中控制器同步 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 开发文档链接、路径和索引 | 通过，31/31；路径检查另有 7/7 通过 |
| `node node_modules/eslint/bin/eslint.js server/bandwidthEmergency.js server/serverSettings.js server/index.js tools/server-settings.mjs test/bandwidth-emergency.test.js test/server-settings.test.js` | 本任务修改的服务端、CLI、测试文件 | 通过，无 lint 输出 |
| `npm run typecheck` | `tsc --noEmit --checkJs -p jsconfig.json` | 通过，进程退出码 0 |

未运行浏览器测试、完整 14 回合测试或阿里云线上雪崩演练：本任务没有前端改动，且线上误报率、默认出口网卡和反代是否绕过 Node 仍必须部署后观察 `healthz.bandwidthEmergency.lastTrigger` 才能校准。

## 结果、遗留与接手

- 实现结果：带宽紧急检测默认关闭；关闭时不执行采样、缓存需求/对局拥堵读取或检测定时器；服主可用私有 CLI 运行时开关；自动试恢复默认改为 60 秒。
- 未确定或未完成：I005 仍需真实服务器校准。该判定不是阿里云带宽容量的直接证明；共享出口、错误网卡、代理绕过 Node 等情况仍需现场核对。
- 提交 / 远程 / 素材 / 线上：本地提交将在验证后创建；未推送、未部署、未修改素材；`docs/SERVER_SETTINGS.md` 的既有工作区修改保留且不归本任务。
- 接手入口：`server/bandwidthEmergency.js`、`server/serverSettings.js`、`server/index.js`、`tools/server-settings.mjs`；运行 `node tools/server-settings.mjs bandwidth-emergency on|off`；配置说明见 [ASSET_CACHE](../../ASSET_CACHE.md#带宽紧急保护)。

## 后续补充

无。
