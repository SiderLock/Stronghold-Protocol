# DEV-20261124-01 · 合并上游 dev 第 84 轮增量（upstream/dev c7cea5a9）

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-11-24 / 2026-11-24，Asia/Shanghai |
| 状态 | 已完成（本地合并与定向验证；全量测试与浏览器套件交给推送后的 CI） |
| 类型 | 上游合并 |
| 分支与开始 HEAD | `dev`，`659ccb1e`（与 `origin/dev` 一致），工作区干净 |
| 上游基线 | 已合并 `c2b4ca01`（0.4.0，2026-11-19）；本次目标 `upstream/dev` `c7cea5a9`（2026-11-24 03:45:06 +08:00）。标签 `v0.4.0` = `b6d8b2ef`（2026-11-15），`upstream/master` = `55f528e9`（2026-11-15，发布后一条 CI 提交），**没有新版本发布**；以上为 `git fetch` 后的本地引用与 GitHub API 核对 |
| 合并库 | `git merge-base HEAD upstream/dev` = `c2b4ca01`，所以增量就是这 166 个提交 |
| 提交归属 | 与本文同一合并提交，`git log -- docs/development/UPSTREAM.md` 可查 |
| 关联 | [UPSTREAM §14](../UPSTREAM.md#14-dev-第-84-轮增量同步2026-11-24)；D004/D009/D010/D012/D013/D028/D029/D033/D035/D037/D045/D046 |

## 需求、范围与验收

用户 2026-11-24：「请你先看一下上游的内容，最近更新了什么内容，main 有无新发版本等；然后帮我对上游 dev 的新内容，
适配过来」。

按 [上游同步流程](../UPSTREAM.md) 与 [DECISIONS.md](../DECISIONS.md) 执行：核对上游最新提交与发布状态；把
`upstream/dev` 合入本分支 `dev`，保留二十人容量与本地规则；逐项解决冲突并做语义适配；重算 golden 并说明差异；
跑定向检查；写记录。本次**不推送、不打包、不部署**，也没有下载新版本素材（规程素材仍未补齐，见 I006）。

验收条件：冲突全部解决且有取舍说明；容量 / 分组 / 库存 / 轮选 / 联防 / AI / 发布门禁的定向测试通过；
五个版本的 golden 有可解释结果；lint、imports、typecheck、i18n、文档检查通过。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 上游是否有新发布 | `git fetch upstream --tags`、GitHub Releases / branches API | 最新发布仍是 `v0.4.0`（2026-11-15）；`upstream/master` = `55f528e9` 停在发布后的 CI 提交；`upstream/dev` = `c7cea5a9`（2026-11-24 03:45）仍在推进。已确认 |
| 增量规模 | `git rev-list --count c2b4ca01..upstream/dev`、`git diff --shortstat` | 166 个提交、394 个文件（+29,853 / −7,425）。已确认 |
| 文本冲突面 | `git merge-tree --write-tree HEAD upstream/dev` | 41 个文件（代码 27、文档 7、测试 6、工具 1）。已确认 |
| 上游主要内容 | 提交标题、diffstat、`docs/history/0.4.0.md` §37.2xx–§37.348 | 第 83/84 轮整合：规程数值与模板审计（「攻击力提升至」在防御前结算、收入 min(3+round,11)、地图地形、加农炮单位与原生特效、规程英文本、远见层数、奖励递延失效）、盟约圆盘外观、设置分类与跨类搜索、浮窗速查（`g.peek`）、跨时期名片干员、时装语音、朝向、场景变长分段传输。已确认 |
| 是否整体接受上游行为 | 上游 `docs`, 本分支决定 | 其他内容按上游；本分支只回接二十人 / 分组 / D004 / D028 / D033 / 自选库存等已确认决定。已确认 |
| golden 差异归因 | 临时把 `initDiyStock` 的 `gd.basePoolCopies` 换成 `gd.poolCopies` 后重跑 | 五个版本全部与上游目标一致 ⇒ 差异全部来自 D028 私人自选库存不乘联机倍数；恢复后按本分支重录。已确认 |
| 上游 `skins.py` 与本分支同名工具 | `git show` 两侧文件、`extract.py` 的 import | 上游 `skins.py` 是 `--only skins/--only library` 的插件导出模块（被 `extract.py` import）；本分支 `skins.py` 是安装版时装提取器（写 `public/assets/local` 与 `data/local-skins.json`）。已确认：本分支工具改名 `local-skins.py`，上游文件原样保留 |

## 实现或操作

### 合并与冲突（41 个文件）

在 `dev` 上 `git merge --no-commit --no-ff upstream/dev`，按「上游行为为底、回接二十人扩展」逐项解决：

| 文件 / 入口 | 处理 |
|---|---|
| `server/lobby.js` | `cardAllowed` 先问跨时期名录（不加载版本数据），再问房间内容，并保留本分支的敌人头像键（`enemyCardAllowed`）；`humanSeat` / `applyVersion` / `card` 用同一入口；`setAiPicksLast` 继续只接受旧客户端的 `on`，房间界面不再发送（D004） |
| `shared/protocol.js` | `room.card` 的 charId 接受干员、跨时期名录与 `enemy_*`（二十席位座席卡） |
| `shared/plugins/visual.js`、`schemas/overlay.schema.json` | 干员皮肤 = 外观 + 时装语音（上游）+ 召唤物替换映射 `tokens`（本分支）；召唤物自己的 `tokens[id].skins` 不带语音与映射（schema 同步拆成 `operatorSkinRecord` / `skinRecord`） |
| `server/plugins/identity.js` | `PRESENTATION_DATA` 并集：`assets`、`local-assets`、`local-fx`、`local-skins`、`emotes`、`card-roster` |
| `public/js/audio.js` | 统一 `voiceLine(audio, charId, slot, lang, random, allowChinese, outfit)`（上游签名）；保留本分支的同名中文回退顺序（时装中文 → 干员中文 → 干员中文随机）；`_selectedVoiceLine` 只用 `wornOutfit`，去掉本分支的跨干员扫描（上游的 `_unitOutfit` / `selectVoiceOutfit` 已给出正确的皮肤归属干员） |
| `public/js/screens/game.js` | `layersDisabled` 改用上游 `bondLayersFrozen(phase, config)`；分组轮选 `normalizeSp(..., myId, pub.poolGroups)`、组内 `total` / `clockPub` 保留；结算语音改上游 `resultSpeakerOf` + `ownerSkin` |
| `public/js/ui/teamPanel.js` | 上游的盟约速查浮窗（`g.peek`、测量、外部点击）与本分支的固定分组区块、队伍表情栏、`aria-label` 合并；行加 `data-pid` 供上游测量 |
| `public/js/screens/room.js` | 名片干员选择器合并：本分支的「敌人」页签与上游的「本房间版本 / 其他时期」分组、中文名搜索、名录载入 / 失败 / 重试提示并存；`cardContext` 同时收敌人与名录 |
| `public/js/ui/seatArt.js` | 本分支 `cardEnemies` / `cardPortraitUrl` 与上游 `cardName` / `rosterOperators` / `withCardZh` / `cardMatches` 并存；`cardContext` 兼容两种调用形式并接受 `extra` |
| `public/js/ui/loadoutSync.js` | 名片同步按「敌人 → 干员 → 自选 → 名录」判定，名录到达后补发；返回 `{ flush, dispose }` |
| `public/js/ui/settings.js` | 上游的设置分类 / 跨类搜索里保留本分支的「帧率上限」「自动调整渲染分辨率」行与官方特效三档说明 |
| `public/js/screens/bandDraft.js` | 名录 + 敌人卡片上下文、`skinPlayers`、`cardPortraitUrl`（含敌人键） |
| `public/js/screens/lobby.js` | `room.create` 保留容量 / 插件 / 模式字段，并在成功后串上游的 `sendRememberedAiLast`；本分支的快速匹配与目录加入保留 |
| `public/js/render/app.js`、`board3d/load.js`、`vfx/wiring.js` | 统计字段并集；场景载入保留本分支的空响应重试（单 `bin` 与上游 `binParts` 分段都覆盖）；`pose` 保留特效缩放与上游朝向 |
| `public/js/main.js` | 上游 `m.public` 的速查缓存失效 + 本分支的 `m.emergency` |
| `public/js/ui/detailPanel.js` | 选中语音改上游 `selectVoiceOutfit`（按卡片所属席位取时装） |
| `server/match/match/settle.js` | 保留本分支的 `layerGainRoom` 与 `plannedUniteSurvivors` |
| `tools/local-extract/skins.py` | 取舍见上表；本分支安装版提取器改名为 `tools/local-extract/local-skins.py`，`docs/SKINS.md`、`docs/LOCAL_ASSET_EXTRACTION.md`、`docs/ASSETS.md`、`test/release-plan.test.js` 与两个测试注释同步改名 |
| 文档 7 个 | `README.md`、`docs/ASSETS.md`、`docs/PLAYING.md`、`docs/SKINS.md`、`docs/design/client.md`、`docs/history/0.4.0.md` 两侧内容并存；`docs/design/network.md` 手工合并 `room.card`（敌人键 + 跨时期名录）、D033 2 小时重连与座席卡说明 |
| 测试 6 个 | `test/lobby-card`、`test/lobby-skins`、`test/plugins/schema`、`test/ui/ai-picks-last`、`test/ui/band-draft-badges`、`test/ui/card-sync`、`test/ui/skins-sync`、`test/fixtures/versions-default-guard.json`（规程 `i18n: ["en"]`）按合并后的实现与 D004 更新 |

### 按分支决定调整的测试

- `test/ui/audio.test.js`、`test/ui/operator-voice.test.js`、`test/local-skin-voices.test.js`：改用上游的
  `voiceLine` 参数顺序（`allowChinese` 第六、`outfit` 第七）；删除本分支 `skinRecordOf` 的用例（函数已移除）。
- `test/ui/ai-picks-last.test.js`：房间界面断言改为「不发送 `room.setAiPicksLast`、不存偏好」，`创建同盟` 仍由
  大厅发送记忆值（服务端接受 `on`、拒绝 `off`）。

### golden

| 版本 | 场景数（roster / bonds / fields / matches / standins / diy） | 结果 |
|---|---|---|
| 第二期下半（默认） | 49 / 46 / 22 / 21 / 10 / 143 | 仅 `coop2-NORMAL-70-diy`、`coop2-NORMAL-5-coverage-diy` 不同，按 D028 重录；复核 291 个全部匹配 |
| 第一期下半 | 41 / 36 / 20 / 16 / 12 / 95 | 同样两个场景不同，重录 |
| 第一期上半 | 41 / 36 / 20 / 16 / 12 / 93 | 同样两个场景不同，重录 |
| 第二期上半 | 49 / 46 / 22 / 16 / 10 / 126 | 同样两个场景不同，重录 |
| 规程·序列Ⅰ | 62 / 52 / 34 / 14 / 12 / 82 | 14 个联机场景全部不同（规程每个席位在 INFO_CHECK 都有选择自编），重录；复核 14 个全部匹配 |

重录后复核：默认版本 291 个、规程 14 个 matches、第一期下半 / 第一期上半 / 第二期上半各 16 个 matches，全部匹配。

归因证据：把 `server/match/player/diy.js` 的 `gd.basePoolCopies(slotId)` 临时换成 `gd.poolCopies(slotId)` 后，
默认版本两个场景、规程 14 个场景都与上游目标逐字段一致；换回后只有这些场景不同。因此差异来自 D028
（私人自选库存不乘联机 / 五人组倍数），不是合并错误。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `npm run golden` | Node 24.13.0，本机 | 默认版本 291 个场景全部匹配（重录 2 个后） |
| `node tools/golden.mjs --version …` | 其余四个版本 | 四个版本除上表列出的 D028 场景外全部匹配；规程 matches 重录后 14/14 匹配 |
| `npm run lint` | 全仓 | 0 error（162 个上游既有 warning） |
| `npm run typecheck` | `tsc --checkJs` | 通过 |
| `npm run check:imports` | 导入边界 | 仅 3 条既有基线（`server/sim/nodeData.js` 的 node:fs/path/url） |
| `node tools/i18n.mjs check --all --strict` | 四个语言包 | 2748 msgid × 4，100%，0 错误 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 文档 | 32 项通过 |
| `node --test test/lobby*.test.js`（非浏览器） | 大厅 / 房间 | 194 项通过 |
| `node --test "test/match/**/*.test.js"` | 对局 / 计算进程 | 1954 项：1945 通过、3 跳过；6 项在并行 golden 占满 CPU 时超时，单独复跑全部通过 |
| `node --test test/ui/{audio,skin-voice,operator-voice}.test.js` 等 | 语音 / 时装 | 66 项通过 |
| `node --test test/plugins/{schema,visual}.test.js` | 插件外观与 schema | 36 项通过 |
| `node --test test/versions-*.test.js test/data-versions.test.js` | 版本数据与 guard | 86 项：77 通过、9 跳过 |
| `node --test test/ui/{ai-picks-last,band-draft-badges,card-sync,skins-sync,seat-art,team-flyout,bond-covenant,bond-stage,settings-search,version-content}.test.js` | 界面单测 | 48 项通过 |

未运行：完整 `npm test`（含 `test/sim` 全量）、浏览器 E2E（`SP_E2E` / `REAL_E2E` / `RENDER_E2E` / `SIM_E2E`）。
按用户 2026-11-19 的要求，全量与浏览器套件交给推送后的 GitHub CI；本机只做上述定向验证。

## 结果、遗留与接手

- 实现结果：上游 166 个提交已合入 `dev`，41 个冲突全部解决，二十人容量、固定分组卡池 / 装备、D028 私人自选库存、
  D004 真人优先、D033 2 小时重连、多轮联防、D035 同组软避让、D046 发布门禁与规程 / 盟约两族的界面扩展保留。
- 未确定或未完成：未推送（因此 CI 尚未运行全量与浏览器套件）；未打包、未部署；规程素材（34 名干员语音、敌人模型 /
  特效、3D 场景）仍未下载（I006）；上游 `dev` 仍在推进，下次同步仍以当时的 `upstream/dev` 为基线。
- 提交 / 远程 / 素材 / 线上：本地合并提交；`origin/dev` 未更新；素材未变；线上仍是此前部署的版本。
- 接手入口：本记录、[UPSTREAM §14](../UPSTREAM.md#14-dev-第-84-轮增量同步2026-11-24)、
  `test/golden/*/matches.json` 的 D028 场景、`server/match/player/diy.js` 的 `basePoolCopies` 说明。

## 后续补充

（暂无）
