# DEV-20261009-01 · 文件公告中心与服主紧急通知

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-09 / 2026-10-09，Asia/Shanghai |
| 状态 | 已完成；普通公告与局内显式通知分别提交及验证 |
| 类型 | 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`af5e647bd97db4b83061dc4b97add1c6417f1c13`；开始时工作区干净 |
| 上游基线 | 已合并 v0.2.1 与 ZIP 修复 #311，`3eced7bdba5aae11a325bd3dbe66cdf01361d2bd`；本次不联网核对远端 |
| 提交归属 | 普通公告 `5fb686efe93628383c5754c5c9694b11b10ee5a8`；局内通知与本文第二阶段更新同一提交，按路径查询 |
| 关联 | [D014](../DECISIONS.md#d014)；[部署使用说明](../../ANNOUNCEMENTS.md) |

## 需求、范围与验收

用户希望服主在没有账号、数据库和管理后台的情况下发布全服公告。讨论后采用 Markdown 文件和历史标题列表，默认详情为置顶公告，没有置顶则选最新发布的公告。

- 有公告时首次连接自动打开，置顶不是自动显示的前提；空安装不自动打开空弹窗。
- 「下次不再显示」在该浏览器中持续到新公告发布，不能用日期重置；手动公告按钮始终可用。
- 发布顺序独立于日期；置顶调整不算新发布。标题页和大厅提供入口，正文及历史列表独立滚动，小屏切换列表和详情。
- 服务器文件为持久化源，运行中可读取更新；HTTP 只提供读取，发布由服主在服务器终端操作。
- 普通公告不自动打断对局及断线恢复。局内紧急弹窗只允许服主显式命令触发，不能随发布自动发送。
- 用户要求普通公告、局内弹窗分为两次提交；本地分批提交已有授权，远程和部署无本次授权。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 是否需要账密或数据库 | 用户取消原账号计划，公告要降低他人部署成本 | 已确认：本地文件加 CLI，无后台 |
| 自动显示与免提示 | 用户本次明确要求 | 已确认：无论置顶与否均可自动显示；新发布使免提示失效 |
| 重连入口可能先进入大厅再恢复比赛 | `main.js` welcome 与恢复流程，`RESTORE_GRACE_MS=1500` | 已确认：已进入用户须等待 welcome 和恢复宽限，迟到请求再次核对路由 |
| 公告渲染 | 现有 Preact、htm、Modal | 已确认：不引入外部依赖；原始 HTML、图片仅显示文字，安全链接及常用 Markdown 子集 |
| 发布与置顶顺序 | 每次发布生成随机持久版本，列表保留实际发布顺序 | 已确认：不按可补录日期或不透明版本排序 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `shared/announcements.js`、`server/announcements.js`、`tools/announcements.mjs` | 普通公告元数据、正文、原子发布、置顶及列表命令 | 与浏览器共享边界校验；运行数据置于忽略的 `runtime/announcements` |
| `server/http/routes.js`、`server/index.js` | `/api/announcements` 及单篇只读接口 | 首次只取元数据，点开按需取正文，避免随对局帧广播全文 |
| `public/js/ui/announcement*`、`public/css/announcements.css` | 公告模型、显示条件、常用 Markdown 和弹窗 | 保留游戏现有样式及 Modal 焦点管理 |
| `main.js`、标题页、大厅、`index.html` | 全局挂载、恢复防护及入口 | 手动入口和自动提醒共用公告中心 |

第一阶段已独立提交 `5fb686e`，未包含局内功能。第二阶段新增 `shared/announcementNotices.js`、`server/announcementNotices.js`、CLI `notify`：一个命令文件对应一次发送，服务端每秒只读检查，初始快照跳过旧命令；向现有 `Network.conns` 广播不含正文的 `announcement.notice` 引用。队列和有效期与普通发布版本互不关联，命令文件只在显式发送时清理已到期的有效项。

客户端使用独立 `urgentAnnouncementModel.js`、`urgentAnnouncements.js`，不改普通免提示及 Game 防护；支持消息去重、队列、迟到请求无效、加载失败重试，复用已有安全 Markdown。默认以服务器校时计算有效期，未完成校时的连接用首条可信消息建立临时时间基准，避免本机时间偏差使通知丢失。

紧急弹窗位于其他弹窗之上，Esc 优先关闭它，支持焦点防护；不调用暂停、离开、重连或刷新接口。队列最多 32 条，等待项五分钟后丢弃，已显示项直到玩家关闭。

补充核对发布工具白名单时发现 `tools/package.mjs` 会漏掉公告 CLI 和使用说明，已加入 `PLAYER_TOOLS` / `PLAYER_DOCS`，并将 `runtime` 明确列入拒绝清单，防止误打包服主公告和发送命令；对应样例及 dry-run 选择测试同步更新，没有生成完整发行 ZIP。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/announcements-store.test.js test/announcements-cli.test.js test/announcements-http.test.js test/ui/announcementMarkdown.test.js test/ui/announcements-model.test.js test/ui/announcements-ui.test.js test/i18n.test.js` | Node 24.21.0，Windows；发布/索引/正文损坏与路径边界、真实 CLI 和 HTTP、免提示及迟到请求 | 首轮 89 项通过；之后增加手机焦点 2 项、Windows 交互编码 1 项，相关文件单跑通过，合计 92 个不同测试已通过，0 跳过 |
| 相关新增及改动 JS 的 `npx eslint`；`npm run typecheck`；`git diff --check` | 当前分支 | 无 ESLint 错误；`main.js` 原有 unused-disable 警告 1 条；类型及差异检查通过 |
| `npm run check:imports` | 当前仓库，非 strict | 命令退出 0，仍报告 `server/sim/nodeData.js` 原有 3 条 Node 内置模块边界提示；核对开始 HEAD 存在相同导入，本次未新增，未据此声称全仓零违规 |
| Edge 普通公告真实页面 | Edge 154.0.4258.62；1920×1080、1280×720、844×390；1 浏览器会话，无战斗模拟 | 无置顶首访、刷新免提示、新发布恢复提醒、pin 不重置、手动置顶详情、22 篇历史、独立滚动、小屏选择及焦点恢复、HTML/图片不执行均通过，页面错误 0 |
| 普通公告游戏边界 | Edge 实际 app 的 store 路由切换；另有模型及生命周期测试 | Game 路由发布/刷新/focus 不弹；单元测试覆盖 welcome 宽限和恢复到 Game，未据此宣称真人对局重连压测 |
| 390×844 布局检查 | Edge 竖屏 | 布局未越界；原有「请将设备横屏」遮罩阻挡操作，交互在横屏验证，不修改该遮罩 |

Edge 首轮发现横屏列表切换后焦点落到 body，已修正并回归通过。随后两次检查失败分别来自竖屏原有横屏提示遮罩、测试未等待 Modal 的 30ms 焦点延迟；核实后调整检查场景及等待，最终以上场景通过。截图与详细几何输出在忽略的 `.cache/announcements/`，关键结论保存在本文。

跳过完整对局、完整 golden、全量测试及真人并发带宽测试，按本次 UI/存储影响选择验证。索引替换失败可留下未发布的孤立 `.md`，已有目标测试确认旧索引和锁正常；仅在核实该文件未被索引引用后由服主清理。

### 第二阶段验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/announcement-notices-spool.test.js test/announcement-notices-monitor.test.js test/announcement-notices-live.test.js test/announcements-cli.test.js test/ui/urgent-announcements-model.test.js test/ui/urgent-announcements-ui.test.js test/i18n.test.js` | Node 24.21.0，Windows；存储/生命周期/界面模型，真实独立 CLI 与 WebSocket | 74 项通过，0 跳过；包含普通 CLI 的回归，命令时序、并发、目录异常、缓存版本恢复、去重、队列、校时和加载竞态 |
| 真实服务器在线分发 | 实际 `startServer`，游戏玩家＋观战者＋大厅＋prehello 共四个真实 socket；仅用 StubMatch 入口，不跑战斗 | 四类均收到同一引用；普通发布/pin/启动旧命令均不发，正文不在 WS 帧内；玩家发送请求被拒，关闭及重启后不回放 |
| Edge 实际对局入口及首回合作战 | Edge 154.0.4258.62；1920×1080、1280×720、844×390；1 真人＋19 AI，终极模式 | 显式 CLI 后弹窗、普通发布不弹、免提示不受影响、两条通知依次查看、Esc、字体/滚动/焦点及无越界通过；刷新恢复到原 20 席位对局，旧通知不重放、普通公告不挡恢复；首回合 BATTLE 中弹窗出现，`battle.paused=false`、未退出/刷新，页面错误 0 |
| `node --test --test-name-pattern='selection:|refusal list:|the real tracked tree:|dry-run on a temporary checkout:' test/package.test.js` | 样例和真实 tracked tree，小型临时目录 dry-run；无素材下载或完整打包 | 4 个选定测试通过：公告 CLI/文档会打包，运行数据不会打包，导入链齐全；初次失败为旧样例数量未更新及新增模块未暂存，修正后通过 |
| 第二阶段新增/改动 JS 的目标 `npx eslint`、`npm run typecheck`、`node tools/i18n.mjs check --strict`、两种 `git diff --check` | 当前代码及暂存区 | 无 lint 错误；仍只有 `main.js` 原有 unused-disable 警告；类型通过；1077/1077 词条译文完整，0 missing / 0 errors；差异通过 |

第二阶段共 78 个选定检查测试通过，复用普通阶段的已验证 Markdown 和入口边界，不重复完整套件。Edge 是真实 WS/CLI 与 20 席位前段验证，仍不能等同于 20 真人或多服务器带宽压力验证；未跑到第 14 回合。临时浏览器均关闭，本地测试服务器关闭，截图及详细结果在忽略的 `.cache/announcements/`。

## 结果、遗留与接手

- 实现结果：普通公告中心、终端发布及置顶、持续免提示、只读接口和恢复防护完成；显式 `notify`、局内独立队列弹窗及分发验证完成，两部分分开提交。
- 未确定或未完成：无本任务待开发项。多机各自使用本地公告文件，跨机器自动同步不在本次范围；I002 真人性能仍待验证。通知不补发给掉线者、不提供阅读确认。
- 故障边界：命令目录的首次快照失败时，恢复后首次成功快照中的命令仍视作历史并跳过；发送时须确认服务器正常运行。旧缓存的公告版本暂不匹配时在五分钟内重试，避免发错版本；过期后不发。
- 提交 / 远程 / 素材 / 线上：普通 `5fb686e`，局内与本文第二阶段更新同一提交，使用 `git log -- docs/development/records/2026-10-09-01-announcements.md` 查询；本次未操作远程；未更改素材；未部署。
- 接手入口：本记录、`server/announcements.js`、`public/js/ui/announcementModel.js` 及相关目标测试。

## 后续补充

2026-10-09：普通提交后独立开发紧急通知，并完成上述第二阶段检查；未通过的临时检查按实际原因记录，不以最终通过覆盖历史原因。
