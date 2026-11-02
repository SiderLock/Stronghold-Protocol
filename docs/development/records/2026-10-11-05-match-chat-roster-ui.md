# DEV-20261011-05 · 局内聊天紧凑布局与玩家身份行

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-11 / 2026-10-11，Asia/Shanghai |
| 状态 | 已完成 |
| 类型 | 修复 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`b35b1ee` |
| 上游基线 | v0.2.3，`1db8e51023ae6abaec9370beb81a513d5c4d0b01`；本任务未同步上游 |
| 提交归属 | 与本文同一提交，按记录路径查询 |
| 关联 | [D027](../DECISIONS.md#d027)、[DEV-20261011-04](2026-10-11-04-ready-and-match-chat.md) |

## 需求、范围与验收

用户要求收紧局内聊天面板：字体和上下间距略缩小，面板向右加宽并降低最大高度，输入框高度略降；聊天记录删除“仅保留本局”的说明行；每条消息同时展示头像、固定卡池组标、P 座位号和名字，策略图标沿用头像中的现有显示。聊天协议、原交流表情入口和消息保留规则不变。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 玩家身份和分组是否需要改协议 | 当前 `m.public.players[]` 提供 `playerId`、`seat`、`name`、`bandId` 等字段，`poolGroups[]` 提供固定组成员；聊天消息已有 `playerId`、`seat`、`name` | 已确认：客户端按公开状态派生显示数据，不扩展聊天消息字段 |
| 策略图标如何放入聊天行 | `PlayerAvatar` 在 `bandId` 存在时直接显示策略图标，并已有死亡、离线、AI 和名字首字回退 | 已确认：复用 `PlayerAvatar size="sm"`，不重复添加策略图标 |
| 历史消息的玩家已离开或观战者不在公开玩家表时如何显示 | 消息自身保留发送者名字、座位和观战标记；房间状态提供 `spectators[]` | 已确认：优先当前玩家/观战者资料，缺失时回退消息字段；观战者不显示卡池组标 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `public/js/ui/matchChat.js` · `MatchChatPanel` | 构建玩家/观战者索引与组索引；每条消息显示小头像、组标、`P1` 座位号和名字；删除说明行 | 利用现有公开状态完成身份可视化，避免改变服务端协议和内存模型 |
| `public/js/ui/matchChat.js` · `MatchChatHost` | 将 `match.public.players`、`room.spectators` 和公开状态传给面板 | 让所有阶段的同一聊天面板都能显示最新身份与分组 |
| `public/css/match-chat.css` | 面板最小宽度从 300px 调至 360px，最大高度从 5.9rem 调至 5.35rem；收紧行距、字号、页脚和输入框高度；短屏宽度同步调整 | 为玩家身份行腾出横向空间，同时减少聊天面板对战场的遮挡 |
| `test/match-chat.browser.test.js` | 测试夹具提供两个卡池组；Edge 测试断言头像、A 组、P1、名字、提示行移除及紧凑几何 | 防止后续布局或公开状态改动回退用户要求 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/ui/match-chat.test.js test/ui/match-chat-model.test.js test/match-chat.test.js` | Node.js，本地聊天输入、模型、服务端定向测试 | 18 项通过 |
| `node --test test/i18n.test.js test/docs-paths.test.js test/match-chat.test.js test/match-chat-ws.test.js test/ui/match-chat.test.js test/ui/match-chat-model.test.js` | Node.js，翻译、文档路径、WebSocket 与聊天回归 | 40 项通过 |
| `SP_E2E=1 node --test test/match-chat.browser.test.js` | Microsoft Edge 155.0.4283.45；2 真人 + 18 AI + 1 观战者；1920×1080、1280×720、844×390、756×366、390×844；五语言 XL；无战斗模拟 | 1 项通过；身份行、面板边界、发送/关闭命中、短屏和原表情入口均通过；浏览器、测试服务器和端口已在 finally 中释放 |
| `node --check public/js/ui/matchChat.js; node --check test/match-chat.browser.test.js` | Node.js 静态语法检查 | 通过 |

跳过完整十四回合实战和远程部署验证：本任务仅涉及客户端聊天呈现与定向测试，未改变战斗状态机、服务端协议或线上部署。

## 结果、遗留与接手

- 实现结果：聊天面板更紧凑且横向加宽；消息行显示头像（含策略图标）、组标、P 座位号和名字；说明行移除，输入框高度降低。
- 未确定或未完成：无新增待复现事项；策略图标加载仍受本地素材目录状态影响，资源缺失时沿用 `PlayerAvatar` 的名字首字回退。
- 提交 / 远程 / 素材 / 线上：本地提交待创建；未推送远程，未部署服务器，未修改素材。
- 接手入口：`public/js/ui/matchChat.js`、`public/css/match-chat.css`、`test/match-chat.browser.test.js`；聊天长期规则见 [D027](../DECISIONS.md#d027)。

## 后续补充

本记录为 DEV-20261011-04 的独立 UI 后续任务；服务端消息协议和本局内存清理规则保持原决定。
