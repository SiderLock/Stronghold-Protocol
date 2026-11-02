# DEV-20261012-02 · 大厅游玩人数、匹配开关与目录观战

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-12 / 2026-10-12，Asia/Shanghai |
| 状态 | 本地完成：后端、界面、定向验证与资源清理完成；未推送或部署 |
| 类型 | 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`c106fb7c812839899a357a5c871aafd8589d27af`；开始时工作区干净 |
| 上游基线 | 已合并 v0.2.4，`bc50cac01ff447eff3ab6c35f69d934bbc23b48f`；仅核对本地记录，本次不访问远程 |
| 提交归属 | 后端、协议与首轮记录：`38845bdfe67225dcec3d5a652600e4e68522d4bf`；界面与本文最终记录同一提交，通过 `git log -- docs/development/records/2026-10-12-02-lobby-access-spectate.md` 查询。本次沿用分批本地提交授权，不推送或部署 |
| 关联 | [D017](../DECISIONS.md#d017)、[大厅目录](2026-10-10-03-lobby-discovery.md)、[房间管理](2026-10-10-07-room-management.md) |

## 需求、范围与验收

用户要求优化已有联机大厅板块，增加正在游玩人数；创建房间后由房主手动决定能否匹配加入，关闭时公共列表隐藏房间码；为房间列表增加观战入口。保持紧凑布局，并遵循已存在的匹配、房主、观战席、素材准入与紧急冻结规则。

用户确认：正在游玩人数为当前对局中在线的真人，包含淘汰和托管，不含 AI、观战或掉线；关闭匹配后停用最快匹配及列表加入，隐藏公共房间码，已知邀请码仍可加入；禁止匹配的房间仍允许公开观战。开关在等候房中由当前房主设置，同盟房沿用两个观战席。验证选择状态/协议定向测试和 Edge 短流程，不运行十四回合对局或完整模拟回归。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 大厅统计 | `LobbyDiscovery.projection/snapshot`、客户端发现控制器 | 已确认：当前只有在线身份、总房间、进行中房间、可加入房间数，未统计游玩人数 |
| 公共房间号 | `roomSummary`、`LobbyRoomRow` | 已确认：所有房间码进入公共目录；隐藏不能仅改显示文本 |
| 现有观战 | `Lobby.spectate`、共享 `MAX_SPECTATORS`、协议 `room.spectate` | 已确认：同盟房支持等候及开战后观战，每房两席；独立房拒绝观战 |
| 已有规则替代 | D017 旧版不提供目录观战按钮 | 用户此次明确要求新增，需记录后续规则修订 |
| 关闭匹配与公开观战 | 用户三项选择；`Lobby.join/spectate` | 已确认：控制公开加入，不构成私密房；观战后作为成员仍会收到邀请码 |

## 实现或操作

采用后端、客户端及浏览器验证分工，根代理维护协议兼容测试、开发与参考文档。服务端房间增加独立生命周期 UUID、匹配标志和公开观战摘要；目录动作由服务器按最新 UUID 解析，再复用已有加入/观战处理器。关闭匹配时公共摘要的 `code` 为 `null`；实际房间状态仍包含邀请码。新增游玩人数只扫描当前对局的在线真人席位。

客户端沿用已有大厅面板及按钮组件，增加第四项统计；目录行以 UUID 作身份，加入和观战均按 UUID 请求。等候房容量控制区提供房主开关。新 C2S 类型走 JSON fallback，服务端与客户端新增摘要字段走 compact-v1 扩展，冻结的位置表不改动。目录观战纳入原重请求限流，素材准入与紧急保护继续适用。

长期规则见 [D032](../DECISIONS.md#d032)，协议、META 与本分支后续历史同步解释，玩法说明记录玩家入口。`docs/SERVER_SETTINGS.md` 的既有加粗改动由其他编辑产生，不属于本任务，保留且不纳入提交。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| Git 状态、HEAD、远程地址读取 | Windows PowerShell，本地核心分支 | 分支与 HEAD 如上；工作区干净；origin 为用户 fork，未访问远端 |
| `node --test test/lobby-access.test.js test/lobby-discovery.test.js test/room-management.test.js` | Node，内存状态机与真实临时 HTTP/WebSocket；JSON / compact-v1 | 40/40 通过；随后仅新后端测试 12/12 通过。覆盖真人口径、房主转让、隐藏码、旧摘要与末席竞态、观战断线占席、素材准入和熔断 |
| `node --test test/wire-codec.test.js test/asset-cache-admission.test.js` | Node；冻结 wire-v1 指纹、扩展与真实 Net | 首轮 27/27 通过；扩充准入至六入口后仅准入 12/12 通过；新目录入口由 Net 实际自动携带 readiness，拒绝切房不改变原成员关系 |
| `node --test test/ui/lobby-discovery-model.test.js test/ui/lobby-discovery-ui.test.js test/ui/room-management.test.js` | Node，前端状态与组件 | 29/29 通过；补充匹配开关触控类后 room-management 6/6 通过 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 本地文档与源码 | 31/31 通过 |
| 本次 8 份文档的相对链接检查 | Node 只读扫描，排除行内代码示例 | 214 个本地链接均存在；不访问外部 URL |
| 变更 JS / 测试的 scoped ESLint | `node node_modules/eslint/bin/eslint.js` / `npx eslint` | 0 errors；后端存在 2 条基线已有的 `no-useless-assignment` 警告，通过 `git show HEAD` 核对；本次界面、wire 及准入测试无警告 |
| `node tools/i18n.mjs check --all --strict` | en / ja / ko / zh-TW | 未通过：四语言各 1363 used / 1362 translated / 1 missing / 0 errors。唯一缺项为基线已有的 `public/js/ui/assetCache.js:45`「请先获取或导入当前素材目录 JSON。」；本次新增 10 条全部覆盖，未混入无关修复 |
| `node tools/check-imports.mjs` | 现有工具默认报告模式，exit 0 | 输出 `server/sim/nodeData.js` 的 3 条 Node 内置导入违规及 3 allowed notes；文件没有本次差异，不能把 exit 0 写成无违规 |
| 分别执行 `node --test test/lobby-access.browser.test.js` 与 `node --test test/lobby-discovery.browser.test.js` | `SP_E2E=1`，`Edg/155.0.4283.45`；临时端口、独立浏览器身份与服主配置，StubMatch 短流程 | 各 1/1 通过，约 32.65 / 6.62 秒；覆盖房主实际切换、等候/进行中观战、两席满员、人数断线/重连/离开变化，无 JS 错误；不运行完整对局 |
| Edge 布局人工复查与缺陷修正 | 1920×1080、1280×720、844×390；简中/en/ja/ko/zh-TW，最大字号另测后两种尺寸 | 首轮截图人工复查发现 844×390 / en / XL 标题实际文字与统计标签相交，原断言只量容器漏检。添加装饰文字/标题/统计的实际文字 Range 断言；统计栏不收缩，≤900px 仅收紧本板块标题、装饰文字及间距，保留单行和面板高度 |
| `node --test test/lobby-access.browser.test.js` 局部布局补验 | PowerShell 设置 `SP_E2E=1`、`SP_E2E_PANEL_ONLY=1`；Edge 155，以上 3 个常规尺寸及五语言 XL × 后两种尺寸 | 1/1 通过，约 17.08 秒；13 个面板场景的实际文字无交叠，按钮中心点击可达，JS errors 为空；最终 844×390 英文 XL 截图人工复核正常。未重跑已通过的观战和断重连段 |
| 浏览器 / 连接 / 服务释放 | 各测试 `finally` 关闭自有资源，另查进程与监听 | 全部报告 browserClosed / browserProcessExited / clientsClosed / serverClosed / portClosed 为 true；PID 45536 / 64124 / 52288 不存在，随机端口 58575 / 59661 / 64581 无监听；未占用或关闭生产 3000 端口 |

## 结果、遗留与接手

- 实现结果：大厅新增在线参战真人统计；等候房房主可控制公开匹配，公共列表隐藏邀请码并禁止加入，原邀请码加入与两席公开观战保留。紧凑界面及多语言、小屏最大字号验证完成。
- 未确定或未完成：生产服务器人数及实际多人使用待部署后核验；既存非本次翻译缺项与 Node 导入违规保留。未执行全量 CI、golden、十四回合流程或百人实战压测，本次没有战斗规则变化。
- 提交 / 远程 / 素材 / 线上：按功能分两次本地提交，归属见基本信息；未操作远程；不涉及素材更新；未部署。无关 `docs/SERVER_SETTINGS.md` 加粗改动保留且不提交。
- 接手入口：`server/lobbyDiscovery.js`、`server/lobby.js`、`shared/protocol.js`、`public/js/lobbyDiscovery.js`、`public/js/ui/lobbyDiscovery.js`、`public/js/screens/lobby.js`、`public/js/screens/room.js`。

## 后续补充

只读代码审查未发现新的具体缺陷；人数变化通知、房主转让后的权限、服务端最新准入重检、邀请码隐藏及 frozen compact-v1 均已核对。新客户端若连接旧服务器且没有目录 UUID，目录动作安全停用；不承诺混用新客户端与旧服务端。现有同版本 JSON/compact-v1 两种传输已验证。

可丢弃的截图与机器报告保留在 Git 忽略的 `.cache/lobby-access-ui/run-1791778243362`（完整流程）、`.cache/lobby-discovery-ui/run-1791778314287`（旧目录回归）及 `.cache/lobby-access-ui/run-1791778994653`（最终布局）；关键发现、实际验证与资源释放证据已写入本文，不依赖缓存作为唯一记录。
