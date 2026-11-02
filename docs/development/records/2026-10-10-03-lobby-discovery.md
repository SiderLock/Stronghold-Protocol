# DEV-20261010-03 · 大厅在线统计、房间列表与最快匹配

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-10 / 2026-10-10，Asia/Shanghai |
| 状态 | 已完成：后端与界面分阶段本地提交，未推送或部署 |
| 类型 | 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`ae7ce89`；开始时工作区干净 |
| 上游基线 | 已合并 v0.2.2，`62eb113419123d9a3a63606107bbf85230c5dd2f`；本次不访问远程 |
| 提交归属 | 后端 `8490d0f`；界面与文档 `23dea17`，按记录路径查询 |
| 关联 | [D017](../DECISIONS.md#d017)、[前次单 IP 限速](2026-10-10-02-asset-cache-ip-limit.md) |

## 需求、范围与验收

用户要求在大厅左上显示小尺寸在线人数，在模式卡片与输入房间号之间增加紧凑的联机板块，显示总房间数、进行中对局数，提供可加入的房间列表与最快匹配。房间列表必须显示房间号、等待/进行中状态；容量偏好与已有 `ROOM_CAPACITIES` 同源。保持原有导航、右侧创建房间及手动加入功能。

已确认：AI 和暂时掉线的保留席位仍占位置；仅匹配有实际空席的等候同盟，按空席最少优先，不替换 AI，不因房主掉线排除房间。容量偏好优先，没有合适房间时回退最快匹配；并列候选随机选择。进行中对局只显示状态，不新增观战入口。独立模拟、已满房间也列出，但不能从列表加入。

验收包括准确的人类在线连接计数（不含 AI/未 hello/断线身份）、原子加入和并发最后空席、按需订阅及分页、断线恢复与离开清理、翻页时的旧响应保护，以及 Edge 常用分辨率下的布局与实际交互。此次不改变玩法，不运行完整十四回合，不推送或部署。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 席位占用与加入边界 | `Room.freeSeat()`、`Lobby.join()` 和用户回复 | 已确认：空席为 null，真人加入不替换 AI；沿用现有加入校验 |
| 在线人数 | `SessionRegistry.all()` 与 `Session.connected` | 已确认：统计已 hello 的连接身份，而非席位或原始 WebSocket 数 |
| 默认匹配与容量偏好 | 用户四项回复 | 已确认：按实际空席排序，容量优先允许回退，忽略房主连接状态 |
| 避免增加对局广播 | 当前网络层与订阅设计 | 采用仅大厅订阅：摘要常驻，明细仅打开列表时发送；变化合并、无变化不发送 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `server/lobbyDiscovery.js`、`shared/lobbyDiscovery.js` | 50 条分页、2 秒变化合并、公开房间摘要与同步选房/加入 | 摘要常驻、明细按需，不追加对局广播 |
| `server/lobby.js` | 接入创建、加入、观战、退出、断线和关闭事件 | 席位变化更新目录；入房及断线立即清订阅 |
| `shared/protocol.js`、`server/net.js` | watch / quickMatch 协议，带 rid 的视图回复，分页请求重限流 | 首次视图与旧响应可区分；关闭列表及取消订阅不受重请求额度阻碍 |
| 分页收缩修复 | 响应和各订阅者同时归一到有效页 | 审查发现 51→50→51 房间变化会使双方页码不同；双订阅者回归已覆盖 |
| 取消订阅限流修复 | 仅打开列表的 watch 消耗 heavy 额度，摘要/关闭仍经过普通消息限流 | 审查发现快速刷新耗尽额度后返回标题可能继续接收目录；耗尽后降级/清理回归已覆盖 |
| `public/js/lobbyDiscovery.js`、`public/js/ui/lobbyDiscovery.js` | 独立订阅控制器、重连/过期响应保护、统计 pill、列表分页、容量优先与无房反馈 | 让路由生命周期与呈现组件可分别测试；加入始终由服务器执行 |
| `public/js/screens/lobby.js`、`public/css/screens/lobby.css` | 左上在线人数；模式卡片下方紧凑联机板块；不透明房间目录弹窗；保留 4/8/10/16/20 容量来源 | 不改变右侧创建房间逻辑，回收模式卡片多余留白，避免标题/资源按钮重叠 |
| `public/i18n/{en,ja,ko,zh-TW}.json` | 增加统计、目录、匹配和状态文案 | 四语言保持完整包严格检查 |
| `test/lobby-discovery.browser.test.js`、`test/ui/lobby-discovery-*.test.js` | Edge 短流程、模型和呈现回归 | 覆盖真实 WS 加入、容量回退、无房反馈、断开清理和布局 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/lobby-discovery.test.js test/lobby-capacity.test.js` | Windows / Node，含真实 WebSocket 并发最后空席、20 真人容量、分页及清理 | **21/21 通过**；新目录 17 项、容量 4 项 |
| `node --test test/client-static.test.js test/docs-paths.test.js test/docs-consistency.test.js test/lobby-ownership.test.js test/lobby-kick.test.js test/ui/lobby-discovery-ui.test.js test/ui/lobby-discovery-model.test.js` | 静态、现有房间回归与新增客户端模型/呈现 | **405/405 通过**；其中新模型 13 项、呈现 5 项 |
| `SP_E2E=1 node --test test/lobby-discovery.browser.test.js` | Edge 154.0.4258.62；1920×1080 / 1280×720；5 个真实 WS 建立的房间、6 名人类连接及 21 AI；match 使用 Stub，仅目录状态 | **1/1 通过**：在线计数、列表手动加入、容量无候选回退、无房反馈、路由清理；无页面异常 |
| `npm run typecheck` | 当前仓库既有检查切片（共享模块及指定模拟文件） | 通过；不等于全仓库 JS 类型检查 |
| 四语言 `node tools/i18n.mjs check en ja ko zh-TW --strict` | 每包 1276 条使用文本 | 四包均零缺失、零错误 |
| 范围 ESLint | 后端/共享协议/前端新文件 | 零错误；`server/lobby.js` 原有 seed 赋值警告保留 |
| `node tools/check-imports.mjs` | 默认报告模式 | 报告 `server/sim/nodeData.js` 三条 Node 内置导入，与开始 HEAD 内容相同；不是本任务新增，未宣称 strict 通过 |

Edge 第一轮暴露新增板块增加留白、弹窗透明度问题，已局部收紧模式卡片及采用深色不透明背景；测试脚本最初直接请求离开而未调用现有 UI 清本地状态，导致等待大厅超时，改用真实离开按钮后通过。未运行完整测试集、golden、真实十四回合或百人生产压测；本任务不修改战斗状态机。

## 结果、遗留与接手

- 实现结果：后端 `8490d0f` 与界面分阶段提交均完成；大厅统计、目录、加入和最快匹配可用。
- 未确定或未完成：I002 的多房间/20 名真人生产性能仍待真实服务器测量；本任务只做短流程。
- 提交 / 远程 / 素材 / 线上：后端 `8490d0f`、界面与文档 `23dea17`；无远程操作、无素材更改、未部署。
- 接手入口：`server/lobbyDiscovery.js`、`public/js/lobbyDiscovery.js`、`public/js/ui/lobbyDiscovery.js` 与对应测试。

## 后续补充

2026-10-10 收尾复核：目录/模型/呈现 35 项和文档 31 项通过。Edge 与客户端连接在 finally 中关闭，服务器关闭；最后验收端口 60970 及前次 52616、62550 本机连接均返回 ECONNREFUSED。两档界面新增后滚动范围与原卡片版式对照相同（1080 高为 54 px、720 高为 39 px），创建按钮完整可见。截图改为每次运行独立缓存目录，避免 Windows 预览占用旧图片时重写失败。
