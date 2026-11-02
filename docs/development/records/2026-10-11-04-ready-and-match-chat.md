# DEV-20261011-04 · 容量切换保留准备与局内文字聊天

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-11 / 2026-10-11，Asia/Shanghai |
| 状态 | 已完成（本地实现与定向验证，未推送或部署） |
| 类型 | 修复 / 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity` / `b4a19ea6823aebfef949462eb758df2a4b4cb9e3`；开始时工作区干净 |
| 上游基线 | v0.2.3 / `1db8e51023ae6abaec9370beb81a513d5c4d0b01`；本次未刷新远程 |
| 提交归属 | 容量修复 `50fb59f`；聊天服务端 `9eeee20`；客户端、界面与本文最终提交，按记录路径查询 |
| 关联 | D010、D020、D021、D026、D027；[房间管理](2026-10-10-07-room-management.md)、[紧凑协议](2026-10-10-09-compact-wire-bandwidth.md) |

## 需求、范围与验收

用户要求房主修改房间容量后不再让成员重新准备，并新增独立的局内文字聊天入口，优先左下角，不进入原版「交流」表情面板、不与已有 UI 冲突。聊天仅保存本局内存，对局结束清除，不写硬盘。

影响范围：等待室容量逻辑、独立聊天协议/内存生命周期、客户端聊天状态与组件、相关定向测试和开发记录。保留难度变化的准备重置、禁止缩容覆盖已占席位和局内固定组；不改战斗模拟，不默认运行完整对局或 golden。本地提交沿用已获授权，本次未获远程操作或部署授权。

用户已确认：全体真人及房间观战者可以发送和阅读，淘汰或 AI 托管的真人仍有权限，AI 不发送；从开局确认、策略轮选、休整、机变到战斗整局可用，最终对局结算时清除；每条最多 200 字，只保留本局最近 200 条。字数按 Unicode 码点计数，不截断合法表情字符。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 切容量丢准备状态 | `Lobby.setCapacity` 末尾主动将非房主真人 `ready=false` | 已确认，移除此重置；既有席位对象与配置保持原样 |
| 当前协议基线 | D021 / `shared/wireSchema.js` 与 fingerprint 测试 | 已发布 v1 字段目录不改；新聊天消息可用既有未知类型 JSON 回退，局标识可用既有扩展位 |
| 聊天需要跨阶段与重连 | `GameScreen` 负责确认/策略/对局/结算；`Lobby` 管成员与 matchCtx | 聊天独立于 battle/Match 玩法广播，历史只在开局及合法重同步单次发送，消息按事件发送 |
| 原交流左下空间 | `.gm__corner`、`.team--many`、折叠镜头及手机触摸范围 | 必须做实际 Edge 检查；不能仅新增一个横排图标就宣称无冲突 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `server/lobby.js` / `setCapacity` | 保留已有真人原准备状态，新增空席不影响其他成员 | 容量变化本身不改变现有人已确认的配置 |
| `test/lobby-capacity.test.js` | 新增准备/配置保持测试，旧真实 WS 测试使用隔离临时服务设置 | 不受本机 `requireAssetCache=true` 私有配置影响，不修改用户 runtime |
| `shared/matchChat.js`、`server/matchChat.js` | Unicode 输入、NFC、保留换行、每局标识、200 条历史、两层 TokenBucket | 统一各端输入规则，限定内存及广播量，不增加文件或轮询定时器 |
| `Lobby.chat` / `sendChatState`、`shared/protocol.js` | 权威成员鉴权、独立消息、开局/加入/重连单次快照，结束及销毁清理 | 观战者可发而不绕过游戏动作权限；不混入周期广播或回放 |
| `test/match-chat*.test.js`、`test/wire-codec.test.js` | 真实 WS 新旧混合协议、权限/生命周期和固定 v1 指纹 | 新增类型逐项登记 JSON 回退，不弱化协议目录覆盖要求 |
| `public/js/matchChat.js` / `main.js` | 独立 RAM store、安装监听、序号合并、未读、草稿与清空边界 | 不进入 appStore 战斗广播、统计或诊断；迟到历史不覆盖新消息，失败发送保留文本 |
| `public/js/ui/matchChat.js`、阶段屏幕、`match-chat.css` / `index.html` | 各阶段独立有框入口，局内交流上方、托管前景入口，纯文本可复制面板 | 独立于原表情，按钮有未读数；CSS 正式 link 参与 D022 的页面版本固定 |
| `fieldHost.hudBands` / `cornerBand`、限定 `.gm.has-chat` 样式 | 队伍/详情和表情面板避让，小屏底带取商店/角落较高值；折叠减少角落行数 | Edge 发现表情面板会盖住聊天入口，修正后两者可切换；小屏不能让新增按钮盖住整备区，折叠仍放大棋盘 |
| 四套 `public/i18n`、`docs/PLAYING.md` | 补全聊天文案和玩家说明，英文入口用 Text chat 区分原交流 Chat | 尊重既有五语言和文字大小设置，不改原表情文案 |

聊天服务端已实现上述规则。服务端历史仅放在 `matchCtx.chat`，新增消息独立广播，开局、观战加入与合法重连单次补发历史。每局独立 `matchId` 防止陈旧发送进入下一局；不把消息放入周期性状态、战斗回放或统计，不调用磁盘写入。初始规范化会将换行折为空格，审查发现不符合 Shift+Enter 提示，改为 CRLF / CR 统一 LF、水平空白归一和最多连续两个换行。

限频沿用现有 TokenBucket，单真人平均每两秒一条、最多连发三条；全房每秒十条、最多连发二十条。断线重连保留额度，永久离开释放身份额度。三个新增类型 `room.chat` / `m.chat` / `m.chatState` 使用 v1 既有 JSON 回退，`room.state.chatMatchId` 使用扩展位，已发布目录指纹保持不变。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/lobby-capacity.test.js test/room-management.test.js` | 容量与房主管理，隔离服务设置；StubMatch + 真实 WS | 13/13 通过，约 0.79 秒。覆盖 4→8→20→8→4、实际扩缩后直接开局、原未准备保留、AI/离线真人/观战/个人配置、P1 转让；非法缩容、局中修改和难度重置保留 |
| `git diff --check` | 容量修复差异 | 通过；测试服务/WS/计时器/临时设置已释放 |
| `node --test test/match-chat-ws.test.js test/match-chat.test.js test/wire-codec.test.js` | 最终含换行实现；5 项真实 WS、5 项核心、13 项编解码 | 23/23 通过，约 1.41 秒；权限、身份伪造、旧局/结算发送、重连额度、快照、退出及销毁、失败启动、不入日志/回放、200 条及 v1 指纹通过 |
| `npm run typecheck`；后端 7 文件定向 ESLint | 共享类型检查与聊天服务端代码/测试 | 通过，0 lint 错误；保留 Lobby 原有 `seed` 初始赋值警告 |
| 隔离 `SP_SERVER_SETTINGS_DIR` 后 `node --test test/wire-network.test.js test/check-imports.test.js` | 20 物理客户端加观战、新旧混合、压缩及重连；临时空设置目录 | 12/12 通过，约 1.39 秒。最初未隔离设置的组合检查因本机严格准入超时并中止，未改变私人配置；隔离复跑成功 |
| `npm run check:imports` | 未改模拟/Match 导入 | 命令正常退出，仍列出 `server/sim/nodeData.js` 原有 3 个 Node 导入；对应定向检查确认没有新增边界违反，不称为零违规 |
| `node --test test/ui/match-chat.test.js test/ui/issue5-fold-camera.test.js test/ui/match-chat-model.test.js test/i18n.test.js test/docs-paths.test.js` | 最终 UI / 模型 / 共享换行与 i18n 集成、文档引用 | 42/42 通过，约 0.90 秒；含 200 条合并、草稿/应答竞争、阶段及身份清理、输入法、相机避让、翻译和路径检查 |
| UI 定向 ESLint；四语言 strict 字典核验 | 新模块、阶段屏幕、相机及浏览器测试 | 0 错误；原 game/main 保留既有 unused-disable 警告；四语言 1343/1343，无缺项或占位错误 |
| `SP_E2E=1 node --test test/match-chat.browser.test.js` | Edge 155.0.4283.45；2 真人 + 18 AI + 1 观战；真实 WS + 可控短 Stub 阶段 | 最终 1/1 通过，18.13 秒。INFO→BAND→PREP→SP→COMBAT 同局记录；收发/观战/未读、恶意 HTML 字面显示、200/201 码点、IME/Enter/Shift+Enter/Escape、淘汰及托管发言、重连草稿及历史、RESULT 服务端/客户端/回放与浏览器存储不含消息通过 |
| Edge 布局与独立看图 | 1920×1080、1280×720、844×390、756×366，20 席位；844 横屏五语言 XL | 聊天、交流、原控件互不遮挡、按钮命中、标签无溢出。756 折叠稳态 tileScale 35.983459→36.363464，超过 1% 增大。390×844 仍由原「请横屏」提示覆盖，未改原纵屏约定 |
| 资源与范围核对 | 浏览器报告及 Node 进程命令行检查 | Edge / 服务器关闭且随机端口请求失败；最终只读查询未见本次 Node 测试遗留，私人 runtime 未改；无完整 14 回合、golden 或真人压力测试 |
| 修改文档的相对链接、D026/D027 与索引核对；`git diff --check` | 6 篇说明/记录，排除行内和围栏代码示例 | 相对文件链接、决定唯一性、任务与已有提交引用及差异格式通过 |

共 90 项上述不同分组 Node 定向测试及 1 项 Edge 短流程通过，不重复计算审查 agent 对相同测试的复跑。截图及汇总在忽略目录 `.cache/match-chat-ui/run-1791694827063/`；本记录保存关键结论，删除截图不影响接手。最终根 agent 独立查看 1920 中文与 844 英文 XL 截图，聊天有独立底框、原交流仍单行、原设置/指南/全屏框未压缩。

## 结果、遗留与接手

- 实现结果：容量调整保留原准备，整局独立真人/观战文字聊天及结算清理已完成并定向验证。
- 未确定或未完成：无本次已确认需求遗留；真实多人实战与生产压测未执行，不能用可控 Stub 短流程代替。
- 提交 / 远程 / 素材 / 线上：分批本地提交；未拉取或推送，未改素材，未部署。
- 接手入口：`Lobby.setCapacity`、`public/js/screens/game.js`、`shared/protocol.js`、相关聊天新模块。

## 后续补充

服务端测试首轮 fixture 调用错误参数导致清理未注册，修正为创建后立即注册 cleanup；只对命令行核实属于本次测试的父子进程 63512 / 64384 执行关闭，并确认不存在。修正后的五套真实 WS 服务与客户端正常退出。
