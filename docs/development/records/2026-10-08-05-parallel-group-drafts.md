# DEV-20261008-05 · 分组并行策略与机变选择

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-08 / 2026-10-08，Asia/Shanghai |
| 状态 | 已完成：实现、针对性验证及记录已完成；未推送或部署 |
| 类型 | 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`e3ed66023367287e771160ebd7c8a8195c978dae`；工作区干净，用户报告已推送，本地跟踪一致 |
| 上游基线 | 已合并 v0.2.1，`c2a2ef778cf728ff29b953b9842b2a39b1e9cbea` |
| 提交归属 | 与本文同一提交；按 `git log -- docs/development/records/2026-10-08-05-parallel-group-drafts.md` 查询 |
| 关联 | [D012](../DECISIONS.md#d012) 替代 [D002](../DECISIONS.md#d002)，补充 [D004](../DECISIONS.md#d004)；[D010](../DECISIONS.md#d010)、[D011](../DECISIONS.md#d011)、[上一任务](2026-10-08-04-pool-group-ui.md) |

## 需求、范围与验收

用户要求开局策略、悬赏、道具补给、机密商店及战术决策改为按既有固定卡池组并行选择。组内仍逐人轮选，组间互不占用选项或等待对方轮次；所有组完成后进入下一阶段。

- 策略：同组禁止重复、跨组可重复；卡片右侧空白显示其他组选择后的 A–E 色标，成员轮选列表也显示分组。
- 机变：撤销全房 `人数+2` 卡片扩容，每组六张独立卡页；默认显示本人所在组，提供其他组的只读进度和选项页。
- 保留原赏金先抽候选组合及强弱分布，装备/战术原有允许重复位置的规则；单人和训练例外按上游规则保留。
- 保留组内手动真人优先、超时、跳过、AI、托管和断线重连的原有语义；每组独立截止时间，别组选卡不重置本组时钟。
- 信标继续跨全房存活队友赠送，干员使用接收组库存；不将私人自选库存并入公共池。
- 用户已确认：带全队标记的支援仍惠及全房存活队友；每次机变全房同一种事件类型、各组独立六张；完全独立抽取，允许偶然整套相同，不进行跨页去重或重抽。
- 使用针对性状态机、生成规则、客户端及 Edge 检查；不默认重跑完整测试、golden 或真人压力测试。

用户提供的 `机变选项与20人联机适配.md` 是外部 AI 的上游分析，包含建议和推定；以源码核实及用户本次明确要求为准，不自动采纳第七节的临时四人组、支援限组或缩短时限等建议。只读参考文件与截图，不修改项目外文件。本次仅本地开发及按功能提交，未授权推送或部署。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 分组来源 | `poolGroups`、D010 | 已确认：开局固定的三/四/五人组，淘汰不重新分组；空组不阻塞机变 |
| 当前轮选模型 | `phases.js`、`spDraft.js`、`views.js` | 已确认：全房共用 order/idx/时钟，须改为每组独立进度和时钟，再统一完成阶段 |
| 悬赏扩容 | `choices.js` | 已确认：扩容路径复制同一套六张；本次恢复六张独立生成 |
| 跨组重复策略 | `draft.picks`、`bandTaken` | 已确认：记录按 playerId 保存，禁重范围需从全房改为本组；外组选择只作提示 |
| 全队支援范围 | 用户异步答复 | 已决定：继续全房存活队友；不自动采用分析文档中的限组建议 |
| 事件与随机规则 | 用户两次异步答复 | 已决定：全房同一种事件类型，各组六张完全独立，单卡和整套偶然重复均允许 |
| 信标边界 | `builtinMeta.js`、`effectsMeta.js` 与既有 gift 测试 | 源码确认已跨组；私人自选干员按上游禁止赠送，本次保留 |
| 分析文档中的库存和等级说明 | `bondInPool`、默认/注册驰援处理器 | 源码与文档存在细节差异：当前检查盟约目录而非剩余数量，本级无候选时可退到任意等阶；不将其直接作为本次验收或擅改旧规则 |

## 实现或操作

| 范围 | 实现与边界 |
|---|---|
| 状态机与时钟 | `phases.js`、`spDraft.js` 改为固定 `groups` 各自维护 order/idx/picks/截止时间/定时器/token；全组完成屏障推进阶段。空组直接完成，成员退出、连接或托管变化只推进/重排本组，旧定时回调校验阶段及组 token。首组 facade 保留旧 fixture/诊断字段，实际权限路径显式按玩家找组。 |
| 策略 | 禁重、跳过和 AI 候选只检查本组；多组可以各有一个当前玩家。原逐轮 30 秒、超时采用高亮策略、单真人不限时继续保留；真人优先现在在每个固定组内执行，不让纯 AI 组等待外组真人。 |
| 机变生成 | `choices.js` 将抽事件类型与生成卡页分开，正式无参数入口一次抽 family 后独立生成各组页；删除旧六张复制扩容和多槽循环补位。保留原悬赏初始/领袖/猎手组合、强弱和原装备/战术重复槽位。不同组的 eventId 可不同，它是同一 family 下的事件条目，不是全房共同类型标识。 |
| 支援与信标 | `applyCard` 的全队范围不变；盟约驰援候选检查绑定本组卡池目录。信标原本已遍历全房存活队友，本次没有不必要地重写赠送实现，以跨组回归验证接收组副本。私有自选干员禁止赠送等上游边界保留。 |
| 协议与公开状态 | `draft/sp` 公开阶段 id 和每组成员、进度、卡页及计时；成员状态按本人组当前轮次计算。`g.band/bandSkip/bandFocus/choice` 增加可选 draftId/groupId 校验，服务端仍由 playerId 定位组。新客户端总是携带实际标识；旧调用省略未知标识，避免发送 null 破坏兼容。卡片最大页内索引恢复 0–5。阶段 id 使用独立序号，不消费棋子/装备 UID。 |
| 客户端规范化 | `gameLogic/groups.js` 和 `draft.js` 对新分组状态及旧单组字段提供统一读取；区分 stage id、固定 groupId 和查看页，每组选项占用不混用根聚合 picks。固定成员身份使淘汰者仍能找到本组。 |
| 策略界面 | 左侧用 A–E 角标与同色淡框连接组内成员；原策略卡的右侧空白显示最多四个其他组已选色标。本组已选仍显示原头像和禁用状态，跨组可重复。外组广播不关闭本人的本局信息窗口或改变高亮；原生命值塔素材保留。 |
| 机变界面 | A–E 页签显示已选人数、完成状态及本组标记，默认自己组，外组只读。本组轮到本人或阶段改变时回本组；本人当前轮次仍可主动看别组。切页清除 armed，确认前再次检查阶段/组，异步 busy 按阶段和组隔离。页内钟显示所看组，游戏顶栏显示本人组；本组完成后不留旧倒计时。淘汰者本组只读，观战初始首个未完成组。 |
| 工具与文档 | harness、botbench 和 audit 按玩家组读取轮次；审计检查完整选卡、组间时钟隔离、重复策略的本组边界。补充英文翻译、D012、入口和当前玩法说明，不写 CHANGELOG/change.md，不修改项目外参考文件。 |

用户确认前只推进不依赖随机规则取舍的结构及界面；确认后移除临时测试策略注入，正式入口和审计测试均使用最终默认规则。没有保留额外去重或各组不同事件类型等未采用的可配置分支。

## 验证

环境：Windows，Node `v24.21.0`，仓库根目录执行。以下是实际执行的针对性检查，不将不同阶段重叠的测试计数相加。

| 命令或检查 | 实际结果 |
|---|---|
| `node --test test/match/group-drafts.test.js test/match/draft-capacity.test.js test/match/draft.test.js` | 50 项通过；覆盖分组并行、局部禁重/跳过/超时、真人优先、退出及重连、组页隔离、过期请求、全队效果和单人边界。 |
| `node --test test/match/group-draft-generation.test.js` | 13 项通过；六张及原候选组合/槽位、共用一次 family 抽取、独立随机、自然同页不重抽、空组和无可生成数据。 |
| `node --test test/ui/group-drafts.test.js test/ui/poolGroups.test.js test/ui/gameLogic.test.js` | 73 项通过；新旧状态、固定组身份、各页选卡索引及计时读取。 |
| `node --test test/ui/group-draft-views.test.js test/ui/bandDraft.test.js test/ui/playtest4.test.js test/ui/playtest6-ui.test.js test/ui/feedback1-secret-shop.test.js test/ui/feedback1-tactic.test.js` | 50 项通过；原策略/商店/战术交互与新组页行为。 |
| `node --test test/ui/group-draft-views.test.js test/ui/playtest3.test.js test/ui/playtest4.test.js test/ui/bandDraft.test.js` | 62 项通过；二次确认、选中及 busy 行为。观战默认页调整后另执行 views + playtest4，18 项通过。 |
| `node --test test/match/group-draft-audit.test.js test/ui/group-draft-views.test.js test/i18n.test.js test/match/feedback3-gift.test.js` | 最终 35 项通过：9 审计、7 界面、10 国际化、9 信标。使用正式无参数默认机变入口；审计覆盖 6/9/20 席位全机变回合；信标覆盖 6/8/9/13 人接收组库存。 |
| `node --test --test-name-pattern="import.*graph" test/client-static.test.js` | 129 项通过；静态客户端模块导入图正常。 |
| `test/lobby-capacity.test.js` 中 protocol boundary 与 group draft requests 两项目标测试 | 2 项通过；可选标识、非法组/阶段字段和页内索引边界。 |
| `node tools/i18n.mjs check en --strict`；`npm run typecheck` | 翻译 1059/1059、0 缺失/0 错误；类型检查 exit 0。 |
| `npx eslint` 本次变更的 31 个 JS 文件（服务端、共享协议、客户端、测试、botbench） | exit 0，0 errors、6 warnings；未扩大到无关清理。 |
| `.cache/parallel-group-drafts/check-docs.mjs`；`git diff --check` | 五份变更文档的 105 个相对文件链接及锚点正常，D002 替代关系和任务索引存在；Git 差异无空白错误。 |
| `node tools/matchrun.mjs --players 20 --difficulty ABYSS --seed 21 --lp 200 --rehearsal 0 --check --quiet --json --humans 2` | 完整真实战斗模拟以胜利结束，roundsPassed=14，errors/simErrors/metaErrors=0；5188 次规则检查、67 次不变量检查，violations=[]。其中两个非 AI 席位由工具托管，其余 AI，不是真人联机压测；LP=200 用于保证晚期流程覆盖。 |

UI 首次预验出现一项旧策略 fixture 仅写聚合 picks、未写本组 picks 的失败，修正 fixture 后上述相关套件通过。英文翻译第一次严格检查缺八条新文案，补齐后通过。Edge 首批 21 个 fixture 场景中，20 个通过、一个发现观战者错误默认到已完成 A 组；改为初始首个未完成组后，仅补测受影响场景，全部通过。没有将失败的初次截图当作最终证据。

### Edge 检查与复现入口

- Edge `154.0.4258.62`，1920×1080、1280×720，5/6/9/20 席位；640×360 最小根字号场景。检查策略成员分组与滚动、最多四个外组选中色标、不遮挡头像/原塔/本组已选头像；机变六张、默认页、外组只读、两处计时来源、切页清空、阶段切换、淘汰/观战、忙状态竞态。最终无 pageerror。
- 真实 WebSocket 集成：本地 lobby/server，两个独立浏览器会话真人＋18 AI，分别安排在 A/B 组。两人同时有自己的轮次，A 选择华法琳后 B 仍可选择华法琳且 deadline 不变；两组真人确认后阶段正常推进。
- 机变集成使用本地测试服务器直接进入第 3 回合，以跳过重复长战斗；真实生成器、广播、界面、请求及奖励应用仍运行。五组各六张、family 一致，B 会话默认 B；A 选择索引 1 不占 B 的索引 1，B 时钟不变，外组页不可选；全组完成后推进，match.errorCount=0。请求包含真实 draftId/groupId。这一检查不是完整多人对局，完整战斗由上面的 matchrun 单独验证。
- 页面检查发现并修复观战初始默认已完成页；真实 WS 初次脚本误将不同事件条目 eventId 当成共用 family，修正 QA 断言后通过，没有据此改变正式生成器。
- 临时脚本、截图和日志保留在忽略的 `.cache/parallel-group-drafts/`，关键复现及结果已写入本记录。最终浏览器进程已退出，测试端口已释放并核实，没有把浏览器配置或缓存加入 Git。

未重跑完整 `npm test` 或 golden：本次不改战斗算法和黄金基准；上述针对性验证覆盖选择状态机、界面、效果应用及完整模拟。20 名真人、跨网络和多房间并发性能仍是 I002。

## 结果、遗留与接手

- 实现结果：固定组并行策略与机变已完成，六张独立页、跨组策略提示及客户端状态/请求边界已接入正式流程，见 D012。
- 未确定或未完成：本任务无待答复设计；既有 I001–I003 保留，第三次机变缺席未据此宣布修复，20 真人性能仍待实际压测。
- 提交 / 远程 / 素材 / 线上：按已获本地提交授权与本文同一功能提交；未拉取、推送、部署或修改远程 master，不需下载素材。
- 接手入口：`server/match/match/phases.js`、`spDraft.js`、`choices.js`、`public/js/screens/bandDraft.js`、`public/js/ui/choiceOverlay.js`。

## 后续补充

暂无。
