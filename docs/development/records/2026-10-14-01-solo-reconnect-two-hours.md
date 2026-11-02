# DEV-20261014-01 · 独立模拟断线保留缩短至两小时

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-14 / 2026-10-14，Asia/Shanghai |
| 状态 | 已完成：本地实现、定向验证及提交；未推送或部署 |
| 类型 | 功能 / 房间生命周期调整 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`6a2b72bb97d1469194fd758b3001017a632ce23f`；开始时工作区干净 |
| 上游基线 | 已合并 v0.2.4，`bc50cac01ff447eff3ab6c35f69d934bbc23b48f`；仅核对现有本地记录，本次未拉取 |
| 提交归属 | 与本文同一功能提交，通过 `git log -- docs/development/records/2026-10-14-01-solo-reconnect-two-hours.md` 查询 |
| 关联 | D017、D033；[前次房间管理](2026-10-10-07-room-management.md) |

## 需求、范围与验收

用户报告大厅经常存在大量房主断线保留的房间，希望将现有 24 小时保留缩短为 2 小时，并要求先复习项目 AGENTS.md。

当前源码确认 24 小时适用于进行中独立模拟的断线续玩；同盟对局默认重连 10 分钟，等候房掉线席位保留 60 秒。此次调整独立模拟默认期限至 2 小时，保留已有正数 `soloReconnectWindowMs` 显式覆盖与其他房间规则。同步当前玩家、部署、架构和大厅提示文案；官方生成数据与历史研究保持原样。

验收：默认期限为 7,200,000 ms；期限内原身份和对局可恢复，超过期限后旧 token 不再恢复、最后真人离开触发删房；重连后再次掉线重新计时；同盟与等候房规则不变。选择模拟时钟边界与现有短 WebSocket 回归，不运行完整 14 回合。按用户后续要求完成本地提交，不执行远程操作或部署。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 24 小时来源 | `Lobby.soloResumeWindowMs()` 优先正数覆盖，否则读取 `config.constants.singleReconnectTime`，缺失回退 86,400 秒 | 已确认：独立模拟默认直接采用官方数据；同盟与等候房并不保留 24 小时 |
| 计时及超期清理 | `Lobby.onDisconnect` 每次设置 `resumeWindowMs`；`SessionRegistry.isExpired` 按 `disconnectedAt` 判断；`Network.sweep` 调用 `Lobby.onExpire` / `removeMember` | 已确认：现有清理路径可复用，只需更换默认期限；普通 sweep 最长间隔 15 秒 |
| 正在使用的其他房间 | 同盟使用 `NET_DEFAULTS.reconnectWindowMs`；等候房使用 `lobbyGraceMs` | 已确认：不应依据房主离线直接销毁仍有其他真人的房间 |
| 既有覆盖与保护边界 | `SessionRegistry.windowOf` 取全局窗口与个人扩展的较大值；带宽紧急保护暂缓当前成员 expiry | 已确认：保留现有调用方显式覆盖和紧急保护行为 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `server/lobby.js` / `LOBBY_DEFAULTS.soloReconnectWindowMs` | 从 null（官方数据默认 24 小时）改为 `2 * 60 * 60_000`，注释同步；现有 expiry / onLeave / disposeRoom 复用 | 直接覆盖本分支默认，避免手改生成数据或另建房间定时器 |
| `server/net.js` | 两处独立模拟默认期限注释更新为 2 小时 | 注释与实际默认保持一致，网络清理和保护逻辑不变 |
| `server/http/config.js`、`server/index.js` | 只对 `soloReconnectWindowMs` 透传显式 null，更新参数类型为 number 或 null | 审查发现启动路径原先过滤 null；新默认改为 2 小时后需区分未提供与显式官方数据回退，不改变其他参数过滤 |
| `test/lobby.test.js` | 更新默认断言；新增模拟时钟检查默认两小时、重连重计时、超期拒绝 token、移除身份、最后真人退出删房及 match.dispose；实际 startServer 的 null 回退验证 | 检查真实生命周期和公开启动链路，无须等待两小时 |
| `test/docs-consistency.test.js` | 区分分支默认 2 小时与官方数据 / fallback 24 小时，并检查玩家文档没有旧承诺 | 防止后续文档或上游同步误恢复旧默认说明 |
| README、PLAYING、DEPLOY、META、DATA、design/network、SERVER_SETTINGS | 当前行为改为默认 2 小时；DATA 和设计保留官方 86,400 秒来源与 null fallback 语义 | 分别说明用户实际体验及数据来源，历史任务与研究不重写 |
| `public/js/ui/lobbyDiscovery.js`、四份 i18n | 「按原有断线期限」改为「按对应断线期限」并同步翻译 | 目录含独立、同盟与等候房，提示不承诺所有房间都保留同一期限 |
| 开发入口、决定表与记录索引 | 新增 D033，链接本次记录，说明 D017 的后续期限修订 | 保留旧规则依据并提供当前接手入口 |

## 验证

环境：Windows，Node v24.21.0；模拟时钟测试使用实际 7,200,000 ms 窗口，真实 WebSocket / RealMatch 回归使用现有 1,500 ms 覆盖验证相同清理路径。

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test --test-reporter=spec --test-name-pattern='a dropped solo run\|default solo retention\|solo resume window\|reconnect window expiry during a match\|match ending while a human is disconnected\|lobby grace:\|SessionRegistry:' test/lobby.test.js` | 模拟两小时边界、短真实 WebSocket、StubMatch / RealMatch、注册表 | 10/10 通过，约 15.03 秒；默认值、断线重计时、超过窗口 token 失效 / 删房、同盟 / 等候房规则及结束后 grace 通过 |
| `node --test --test-reporter=spec --test-name-pattern='a dropped solo run\|explicit null solo retention\|default solo retention' test/lobby.test.js` | 审查修正后再次核对默认值 / 模拟时钟，以及 startServer 的 null 透传 | 3/3 通过，约 0.65 秒；其中 1 项新测试，2 项重复验证，合计 41 项不同的定向测试 |
| `node --test --test-reporter=spec --test-name-pattern='reconnect windows:' test/docs-consistency.test.js` | 当前代码 / 官方数据 / DESIGN / META / 玩家与部署说明 | 1/1 通过，约 5.15 秒 |
| `node --test --test-reporter=spec test/lobby-discovery.test.js test/ui/lobby-discovery-ui.test.js` | 目录订阅、分页、匹配、断线保留排序 / 恢复与 Preact 提示 | 29/29 通过，约 5.12 秒 |
| `node --test --test-reporter=spec test/docs-consistency.test.js test/docs-paths.test.js` | 提交前按项目 AGENTS 核对完整文档一致性与路径 | 31/31 通过，约 13.37 秒；包含此前 1 项重连文档检查，不重复计入 41 项定向测试 |
| `node node_modules/eslint/bin/eslint.js server/lobby.js server/net.js server/http/config.js server/index.js public/js/ui/lobbyDiscovery.js test/lobby.test.js test/docs-consistency.test.js` | 修改的代码与测试，含最终 null 透传修正 | 0 错误；lobby 的 seed 与 lobby.test 的 c 两处既有 `no-useless-assignment` 警告，不在本次改动行 |
| `node tools/i18n.mjs check --all --strict public/js/ui/lobbyDiscovery.js` | en / ja / ko / zh-TW | 每份 46/46，0 缺失、0 错误 |
| 修改文档的相对链接检查 | 11 份文档，排除代码示例与 GitHub Releases 相对网址 | 278 个本地文件链接目标均存在；D033 与本次记录引用已核对 |
| `git diff --check` | 最终源码、翻译与文档差异 | 通过 |

未执行完整游戏测试、golden、完整 14 回合或 Edge：本次没有布局变化，现有短真实连接和派生界面测试覆盖所改行为。未验证生产服务器房间数量或运行两小时的真实网络环境；测试服务与连接通过各套件收尾关闭，命令正常退出。最终 Get-Process 检查未发现测试所用 `E:\develop\NodeJS\node.exe` 的残留进程；现存 Node 均为 Codex 内置 CUA 运行时，未操作它们。

## 结果、遗留与接手

- 实现结果：独立模拟普通默认断线续玩由 24 小时缩短为 2 小时，复用原清理路径，源码 / 当前说明 / 四语言提示同步；41 项不同的定向测试通过。
- 未确定或未完成：未检查生产服务器；用户报告的房间数量以线上现象为准。
- 提交 / 远程 / 素材 / 线上：代码、测试及本文同一功能提交；未拉取、推送或部署；未修改素材；线上版本未验证。
- 接手入口：`server/lobby.js`、`server/net.js`、`test/lobby.test.js`、`test/docs-consistency.test.js`。

## 后续补充

无。
