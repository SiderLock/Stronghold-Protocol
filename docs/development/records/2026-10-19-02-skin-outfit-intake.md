# DEV-20261019-02 · 皮肤与服饰增强方案（全量版）

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-19 / 2026-10-19，Asia/Shanghai |
| 状态 | 进行中：**P0（上游 B6 图片时装整批移植）已完成并验证**（2026-10-19）；P1 起待做 |
| 类型 | 功能（方案与实现记录） |
| 分支与开始 HEAD | `feat/skin-enhance`，从 `feat/IncreasePlayerCapacity` 的 `4ab2c8a0` 开出 |
| 上游基线 | v0.3.1 `d905c146`；皮肤层来自上游 master（`58206c0b`、`f8c1da7d`、`9cc6c97e`、`01847bfb`），本分支无 0.3.2 内容 |
| 提交归属 | 与本文同一提交，按记录路径查询；后续阶段各自提交并在本文「后续补充」追加 |
| 关联 | [皮肤规范](../../SKINS.md)、[插件规范](../../PLUGINS.md)、[特效格式](../../design/vfx-format.md)、[前次记录 DEV-20261019-01](2026-10-19-01-gitignore-art.md) |

## 需求、范围与验收

用户要求（2026-10-19）：

1. 「出个方案，取其精华，去其糟粕，为我们的分支引入皮肤/服饰相关内容。」
2. 追加口径（同日）：「**上游不做不一定是糟粕，我们如果能做就一起做**。」并指定从 `feat/IncreasePlayerCapacity` 开新分支 `feat/skin-enhance` 落地。

- **范围**：本分支已有上游的「外观插件 overlay」皮肤实现（`data/assets.json` 里自带 0 套皮肤、0 个立绘，全依赖插件）。本文**不动架构**，把各家值得要的能力**全部排进阶段**，包括先前被归入「暂缓/不做」但技术上可行、且与仓库规则不冲突的项目。
- **仍然不做的**：不是「上游没做」，而是**与仓库硬规则或安全边界冲突**的少数几条，理由逐条写在「真阻碍」一节；其中「一键装皮肤」的便利性由插件安装通道与（备选的）服主 CLI 满足。
- **验收（方案层）**：每条能力都有「做 / 怎么做 / 依据 / 风险」；阶段之间有依赖顺序；每阶段列出改动面与验收命令。
- **验收（实现层）**：定向测试通过、`npm run golden` 无移动、`node tools/i18n.mjs check --all --strict` 通过、文档一致性与路径测试通过、`npm run ci` 在阶段收尾通过。

## 结论速览

| 序号 | 能力 | 结论 | 依据/参考 | 工作量 | 依赖 |
|---|---|---|---|---|---|
| P0-1 | 只有头像/立绘的时装也能穿（「仅更换头像与立绘」） | 做 | 上游 dev 0.3.2 `77b91081`/`3f6c0786` | 小 | — |
| P0-2 | `illust` 契约对齐（文档说详情页显示，实际无调用方） | 做（接上页面，见 P3） | 本分支自身不一致 | 小 | P3 同批 |
| P0-3 | 上游 #739 的 Windows 路径分隔符守卫修复 | 做（先核实） | 上游 PR #739 | 极小 | — |
| P1 | **召唤物换装**（token 皮肤） | 做 | FengYuPrime 形状 + 本分支灌通 | 中 | P0 |
| P2 | **皮肤自带语音槽** | 做 | 上游 #733/#734 + YuriRestia | 中大 | P1 的反查 |
| P3 | **界面跟随皮肤**（商店卡、干员详情、结算、统计、编队卡、2D 回退渲染器）＋立绘偏好 | 做 | Misyra #652 的商店立绘 + 本分支 `illust` 缺口 | 中大 | P0-2 |
| P4 | **小人实时预览**（干员调配与自选编队） | 做 | Misyra #652 的 `spinePreview` | 中 | P3 的图源 |
| P5 | **官方时装特效**（skinFx） | 做（先小样本量体积） | FengYuPrime `FORK-SKIN-VFX.md` | 大 | 提取机 |
| P6 | **导出/导入携带皮肤**（干员调配与自选编队） | 做 | Misyra #652 的 envelope | 小 | P1/P2 的键 |
| P7 | 加分项：Studio 能按官方名找到皮肤；AI 队友穿皮肤（房主开关）；服主侧一键装官方时装 CLI | 逐个评估，按用户口径取舍 | 本分支 Known limitations；①路线的便利性诉求 | 小～中 | P1/P2 |

## 我们现在的家底

`data/assets.json` 实测：210 个干员 / **0 个 `skins`** / 0 个 `illust` / 58 个 `tokens`——**本分支不含任何皮肤素材**，全部由外观插件 overlay 提供。已有能力可直接复用：

| 面 | 现状 | 位置 |
|---|---|---|
| overlay 数据与校验 | `chars[charId].skins[skinKey]` 白名单、每干员上限 64、合成流程完整 | `shared/plugins/visual.js:145-152`、`schemas/overlay.schema.json:675-727` |
| 选择通路 | `room.skins { [charId]: skinId }`（键是**干员**不是棋子），无阶段门 | `shared/protocol.js:272-308,544`、`server/lobby.js:1400-1413` |
| 服务端链路 | 会话/座位/比赛都带皮肤；补位穿 `backup.charId`、自选穿 pick | `server/match/player/basics.js:124-149`、`match/match/platform.js:107-127` |
| 3D 渲染 | 单位模型与头像跟随皮肤，`otherSkins` 开关默认开 | `public/js/render/app.js:1552-1610`、`public/js/assets.js` |
| sim | 只有 3 个文件碰 `.skin`，纯展示、`undefined` 时线格式不变 | `server/sim/units.js:41-44`、`battle/players.js:152/162/190`、`snapshot.js:40-43` |
| 打包期校验 | 图集页名等问题已在打包时拦截（等价于别家的 `normalize`） | `server/plugins/pack.js:174-178` |
| 测试 | 皮肤核心 5 个测试 + 插件 schema/visual 测试 + 守卫（`server/sim` 白名单 N=3） | `test/skins.test.js:302-315` 等 |
| i18n | 皮肤相关 34 条 msgid，en/ja/ko/zh-TW 四包齐平 | `public/i18n/*.json` |

**明确没有的**（逐条搜过）：召唤物换装、皮肤特效、只有图没模型的时装、皮肤自带语音、小人实时预览、2D 界面跟随皮肤（`ui/assetUrls.js` 全文件 0 skin，2D 回退渲染器同样）、导出/导入携带皮肤。

## 各家精华

| 来源 | 精华（我们要的部分） | 我们怎么用 |
|---|---|---|
| 上游 dev（0.3.2） | 「仅更换头像与立绘」：`skinHasPictures` / `playable = hasModel \|\| pictures` / `pictureOnly`、按座位主人取图的 `ownerSkin` | P0-1 直接摘补丁 |
| FengYuPrime（③ 打包期内置） | 召唤物换装的**数据形状**与 sim 继承两条路径；官方时装特效的 `skinFx` 段与提取做法；`normalize` 的必要性；下载源优先级与失败三分类 | P1 取形状、P5 取特效方案；`normalize` 我们已有等价物 |
| Misyra（① 服务器安装通道，#652） | 小人实时预览的实现与两条坑（单 canvas、bounds 缓存）；商店立绘的本地偏好；导出/导入携带皮肤 | P4 取预览、P3 取「界面立绘」思路、P6 取 envelope |
| YuriRestia（④ 自有 outfits） | 皮肤自带语音槽的语义（charword 槽名、缺槽回落）；召唤物外观的另一种数据落点 | P2 取语音语义（架构仍用我们的 overlay） |
| 上游 #733/#734 | `voice` 字段与「逐槽回落干员原声」规则 | P2 的规则来源 |

## 实施方案

### P0 · 契约与小修（小，先做）

**P0-1 只有头像/立绘的时装也能穿。** 现在插件给了立绘却没给模型的时装「列得出来、点不了」；做成可选后，插件作者只做立绘即可上架。

- 改动面：`public/js/ui/skins.js`（`playable` 语义、`hasAnySkinChoices` 计数口径）、`public/js/ui/skinPicker.js`（标签「仅更换头像与立绘」）、`public/css/screens/loadout.css`、皮肤 pin 测试、i18n 四包。
- 需用户拍板：全局开关是否把「只有立绘」也算进去（现在只数穿得上的）。按用户「能做的都做」的口径，**默认跟随上游 dev 的宽松口径**；如要保留严格口径在此记录里改写。

**P0-3 核实并摘上游 #739。** 守卫测试 `test/skins.test.js:302-315` 收集相对路径与 POSIX 写法比对，Windows 上会因分隔符误报；上游用 `.split(path.sep).join('/')` 修好并已合并。

### P1 · 召唤物换装（中，价值最高）

**数据形状（overlay）**：

```jsonc
chars["char_1033_swire2"].skins["char_1033_swire2@ambienceSynesthesia#4"] = {
  name, group, avatar, portrait,
  spine: { front, back? },
  tokens: { "token_10031_swire2_gdtrap": { tokenSkinId: "…_ambienceSynesthesia#4", spine: { front } } }
}
```

- **`spine` 必填**，`tokenSkinId` 只是元数据；缺模型等于没写。
- **不需要 owner**：我们走 overlay，直接由干员自己的皮肤记录给出映射。实测清单 58 个 token 只有 20 个有 owner，照抄 owner 会让 38 个永远画不出来。
- 客户端加 `skinId → charId` 反查（合成清单时建一次），P2 语音共用。

| 位置 | 改什么 |
|---|---|
| `shared/plugins/visual.js:151-152` | `SKIN_RECORD` 加 `tokens` 与 token 键校验；`chars.<c>.skins.<k>.tokens.<t>.spine.front` 正好 8 段，是 `locateAssetPath` 上限（`:610`），一并确认 |
| `schemas/overlay.schema.json:675-727` | `skinRecord` 加 `tokens`，新增 `$defs.tokenSkinRecord`（`additionalProperties: false`） |
| `server/plugins/pack.js:160,266` | 按路径判定容器，别把皮肤下的 token 变体骨架按干员规则解析；加一条 pack 测试 |
| `public/js/assets.js` | `skinId → charId` 反查 + token 分支（`:239-243`）优先皮肤变体、`fallback` 回默认模型 |
| `server/sim/battle/players.js:190, 60-64` | 两条继承（召唤继承 + late 链接），**都在守卫白名单内，N=3 不变** |
| 文档与测试 | `docs/PLUGINS.md:342-384`、`docs/SKINS.md`；`test/skins.test.js`、`test/plugins/schema.test.js`（正反例）、sim harness |

**边界（写进文档）**：选择立即同步，模型本场固定、下一场生效；备战/手牌里的 token 棋子不穿；token 头像不换；「显示其他玩家的皮肤」关闭时队友 token 一并回落。

### P2 · 皮肤自带语音（中大）

- 形状：`skins[key].voice`（中文树）+ 可选 `voiceJp/voiceEn/voiceKr/voiceNative`；值 = 单文件或 1–16 条列表。
- 取值链：皮肤该语言槽 → 干员该语言槽 → 皮肤中文槽 → 干员中文槽 → 静音；外语优先于皮肤中文行；干员无语音时皮肤行照播。
- **必须同批改**：`shared/plugins/visual.js` + `schemas/overlay.schema.json`（`$defs.voiceRecord`，自由槽不枚举）+ `test/plugins/schema.test.js` fixture + 文档——只改运行时会造成「作者侧非法、运行时静默忽略」（上游 #734 的死因）。
- 播放点：`public/js/audio.js` 的 `voiceLine`/`voice()`/`_track`、干员详情、结算；试听可不做（那样零新增文案）。

### P3 · 界面跟随皮肤（中大）

**目标**：皮肤不只是 3D 小人，2D 界面也认它——商店卡、干员详情、结算、统计、编队卡、以及无 WebGL 时的 2D 回退渲染器。

- 铺 `public/js/ui/assetUrls.js` 的 `opts.skin`（现在全文件 0 skin：`chessPortraitUrl` 等），改调用点 `ui/shopBar.js:108`、`ui/detailPanel.js:429`、结算与统计、`render/fallbackField.js`。
- 顺带补齐 P0-2：`public/js/assets.js:123-135` 的 `illustUrl` 接上干员调配详情页（现在全仓无调用方，与 `docs/PLUGINS.md:342`、`docs/ASSETS.md:391` 的说法不一致）。
- 立绘偏好：是否要「同一干员单独挑一张界面立绘」（Misyra 的商店立绘）——与本分支「每套皮肤自带 `portrait`」重复，**默认不做单独选择**，只做「跟随所选皮肤」；若用户要独立选择，加一个本机偏好（`sp.local`，不上行、不进导出以外的任何服务端数据）。

### P4 · 小人实时预览（中）

- 现状：只有静态放大立绘（`public/js/ui/skinPicker.js:74-77`）。
- 做法：把选中皮肤的真实骨骼放进共享 PIXI 渲染器实时播放，按钮按骨骼自己的 clip 生成（部署/待机/攻击/技能…），静态图作为首帧与无 WebGL 的回退。
- 三条必守：**渲染器只有一个 canvas**（帧盒保持恒定 vdom 形状，`img ↔ null` 翻转会把 canvas 冲掉）；**mount 前检查取消标记**（异步加载晚到会把 canvas 挂进已消失的节点）；**别在 `getLocalBounds()` 前调 `updateTransform()`**（bounds 缓存变 0，模型缩成一点）。
- 入口：干员调配与自选编队各一处；同时只开一个预览面板。

### P5 · 官方时装特效（大，先小样本）

- **只能走本地 FX 清单**：官方单位不可被插件覆盖、官方文件禁止进插件。
- 做法：`public/assets/local/fx/index.json` 新增顶层 `skinFx`（`{ <官方皮肤id>: { replace: { 原键 → 新键 }, points?, graphic? } }`，逐特效键替换）；运行时按 `skinKey` 查表、`skinOfView` 取挂点、命中行带 `skinFrom`、预载键一起进；提取器读客户端 `CharacterSkinHooker`，并把替换键**两侧**都导出。
- **命名坑**：现有 `skins` 段不是时装，是默认模型挂点（uid），必须新开 `skinFx`。
- **零改动**：sim / golden / protocol / i18n / Docker。
- 前置：一台有游戏客户端的提取机（含热更覆盖层）；体积先量（估算 +100～200 MB，不确定）。

### P6 · 导出/导入携带皮肤（小）

- 现状：三个 envelope（`loadoutModel.js:164-186`、`ownershipModel.js:22,133`、`diyModel.js:25,166-175`）都没有 `skins`。
- 做法：干员调配文件带 roster 的皮肤（键 = charId），自选编队文件带槽位皮肤（键 = 槽 id），两张表互不覆盖；字段缺失视为旧版导出、保持现状。语音随皮肤一并带（若 P2 已做）。

### P7 · 加分项（按用户口径逐个定）

| 项 | 说明 | 备注 |
|---|---|---|
| Studio 找得到皮肤 | `server/studio/targets.js` 目前只能按官方名找干员/敌人/界面图；让作者能搜到皮肤键 | 现状写在 `docs/SKINS.md:205-206` |
| AI 队友穿皮肤 | 现在 `setSkins` 直接拒绝 bot；可加「房主开关 + 按种子选择」，纯展示、所有人看到同一套 | 属产品口径，改动小；要写清与 `otherSkins` 的关系 |
| 服主侧一键装官方时装 | ① 路线的便利性诉求，但**不能**做成任何客户端可触发的服务端下载 | 只做服主本机 CLI（不暴露协议接口）；或直接复用插件 ZIP 导入 |

## 实施进度

### P0 · 已完成（2026-10-19）

移植上游 0.3.2 的 **B6「图片时装可穿戴」整批改动**（提交 `77b91081`，分支 dev）。这一批同时覆盖本文的 P0-1 与先前归在 P3 的「界面跟随皮肤」——上游把两件事一起做了。

| 面 | 落地内容 |
|---|---|
| 目录与选择 | `public/js/ui/skins.js` 取上游 dev 版：`skinHasPictures`、`playable = 有模型或图片`、`pictureOnly`、`ownerSkin(...)`（按席位主人解析，含 `otherSkins` 与「清空优先于旧单位元数据」）；`public/js/ui/skinPicker.js` 增加「仅更换头像与立绘」标注 |
| 图片解析 | `public/js/ui/assetUrls.js` 新增 `skinPicture()`，`chessAvatarUrl` / `chessPortraitUrl` 接受 `{ skin }`（精英二 → 普通 → 立绘回退）；`public/js/assets.js` 的 `spineEntry` / `hasBackSpine` 改为「没有 Front 的不完整 spine 沿用干员默认模型」 |
| 界面 | 商店卡、干员详情（`resolveDetail` 带 `ownerId`/`skin`）、结算 `OpCard` 与阵容、结果页 `LineupThumb`、缩略图与整备（`OperatorImage` / `UnitThumb`）、2D 回退渲染器、禁用干员提示、Studio 预览卡：一律按席位主人取图 |
| 偏好 | 新增 `public/js/ui/settingsStore.js`（读 `otherSkins` 等不必加载设置弹窗与音频），`settings.js` 改为从它再导出 |
| 文案 | 四包新增「仅更换头像与立绘」；`node tools/i18n.mjs check --all --strict` 通过（2325 条 × 4 包） |
| 文档 | `docs/SKINS.md`、`docs/PLUGINS.md` 取上游 dev 版；`docs/PLAYING.md`、`docs/design/client.md`、`docs/DESIGN.md` 按 B6 落点改写（去掉指向上游 0.3.2 历史文件的小节号） |
| 测试 | 上游 B6 的新测试 `test/ui/picture-skins.test.js`、`test/helpers/pictureSkins.js`、`test/ui/picture-skins.e2e.test.js` 一并带入，并更新 `test/ui/skin-picker.test.js`、`test/ui/standin-ui.test.js`、`test/match/combat-metrics.test.js` |

**P0-2（`illust` 契约）**：上游两处文档自相矛盾——`docs/PLUGINS.md` 说 `illust` 是「详情页显示的图」，`docs/SKINS.md` 说「默认瓦片是它唯一的展示处」。B6 之后**皮肤自己的 `illust`** 已成为各界面立绘的回退（`skinPicture`），但**干员级 `chars[charId].illust`**（插件只给图、不给时装）仍只在选择器的默认瓦片出现。按「文档跟随代码」，本轮只改 `docs/PLUGINS.md` 的表述，**不改行为**；若要让干员级立绘也出现在商店卡/详情，需要另立决定。

**P0-3（上游 #739）**：核实后**本分支已有**该修复（`test/skins.test.js` 的守卫使用 `path.relative(...).split(path.sep).join('/')`），无需再摘。

**P0 验证**（2026-10-19，本分支 `feat/skin-enhance`）：

| 命令 | 结果 |
|---|---|
| `node --test`（皮肤定向 11 个文件） | 118/118 通过 |
| `npm run golden` | 288 场全匹配（49/46/22/21/10/140），**无移动** |
| `node tools/i18n.mjs check --all --strict` | 四包 2325 条，0 缺失、0 错误 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 32/32 通过 |
| `npx eslint`（改动文件） | 0 error（7 条既有 warning） |

**未验证**：浏览器 E2E（`SP_E2E=1` 下的 `test/ui/picture-skins.e2e.test.js` 等）未跑；商店卡与结算页的真实观感需要 Edge 手测。**数据面观察**：`server/match/results.js` 的阵容不带 `skin`，所以结算里 `u.skin` 实际是 undefined，靠 `OperatorImage → ownerSkin` 按 `m.public.players` 解析席位——要让**对局记录回看**也带皮肤，需要另给结果阵容补 `skin`（未列入本轮）。

## 真阻碍（不是「上游没做」，而是我们不做）

| 项 | 为什么不做 | 便利性替代 |
|---|---|---|
| `room.skin.install` 服务器安装通道 | 任何已连接的匿名客户端都能让服务器下载文件并改写全员共读的清单；还会让随包发布的安装状态与更新校验对不上（`docs/SKINS.md:8-11`，本分支测试直接判失败 `test/skins.test.js:111-122,442-451`） | 插件安装/Studio/ZIP 导入本来就是「装皮肤」的入口；如需官方时装，用 P7 的**服主本机 CLI** |
| 工具写 `data/*.json` | 生成物约定（AGENTS.md:37）：清单由构建管线产出，运行期改写会造成脏工作树与拉取冲突 | 皮肤素材走插件 `/p/<id>/<hash>/…` |
| 把皮肤素材提交进仓库 | 版权与体积（全量约 328 MB），且「No game art in git」是硬规则（AGENTS.md:38） | 插件分发、完整包、本机提取 |
| owner 派生 | 我们清单里 58 个 token 只有 20 个有 owner，抄过来会让 38 个画不出来；overlay 也无处写该字段 | 由干员自己的皮肤记录直接给映射（P1） |
| 另起一套平行 outfits 体系 | 与现有 overlay 形成双真相，键与优先级会打架 | 只取它的语义（语音槽、召唤物外观） |

## 必须守住的不变量

- **sim 不读规则**：守卫 `test/skins.test.js:302-315` 要求 `server/sim` 只有 3 个文件出现 `.skin`（`units.js`、`battle/players.js`、`snapshot.js`）；新增 sim 文件才改期望列表。
- **golden 不动**：`npm run golden` 无移动。
- **不写 `data/`**、**素材不进 git**。
- **坏 map 整条拒**：协议/大厅/`PlayerState` 三层校验口径不变；客户端 `parseStoredSkins` 仍按 `SKIN_LIMITS` 截断。
- **schema / 运行时 / fixture / 文档同一提交**：任何 overlay 字段新增都走这一套，避免静默丢数据。
- **界面与模型的回退链一致**：任何新界面入口在缺件时回落到干员自己的图，不留空格。

## 验证

| 命令 | 用途 |
|---|---|
| `node --test test/skins.test.js test/lobby-skins.test.js test/ui/skin-picker.test.js test/ui/fieldHost-skins.test.js test/render/skin-presentation.test.js` | 皮肤定向回归 |
| `node --test test/plugins/schema.test.js test/plugins/visual.test.js` | overlay 字段与 schema fixture |
| `node tools/i18n.mjs check --all --strict` | 四包文案齐平 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 文档与路径一致性 |
| `npm run golden` | 黄金结果无移动 |
| `npm run ci` | 阶段收尾整体检查 |

浏览器侧按仓库惯例用 Edge 手测（记录分辨率与人数）；无头检查不能替代真人对局。

## 风险与不确定

- **P5 体积**：`+100～200 MB` 是外推估值，先小样本测量再全量。
- **P1 打包分类**：`pack.js` 按 `op.at[0]` 判定容器，皮肤下的 token 变体骨架可能被按干员规则解析；未实测，靠新增 pack 测试钉住。
- **P0-1 开关口径**：全局计数是否算「只有立绘」，按本记录默认取宽松口径，用户可否决。
- **P2 外语行为**：只带中文的皮肤语音对选外语的玩家不生效（外语槽优先），需在文档写明。
- **P4 渲染约束**：单 canvas + 异步挂载，属易回归区，必须有 e2e 或至少闭包级测试。
- **官方映射清单**：上游提到的「22 套带 voiceId」等清单无法独立核对；方案不依赖它。

## 结果、遗留与接手

- **方案结论**：P0–P6 全做，P7 逐项评估；真阻碍 5 条不做并给出替代。
- **当前进度**：P0 已完成并验证（见上「实施进度」）；P1 召唤物换装、P2 皮肤语音、P4 实时预览、P5 官方时装特效、P6 导出导入、P7 加分项待做。
- **接手入口**：[皮肤规范](../../SKINS.md)、[插件规范](../../PLUGINS.md)、`shared/plugins/visual.js`、`schemas/overlay.schema.json`、`public/js/assets.js`、`test/skins.test.js`。

## 后续补充

- 2026-10-19：首版方案（P0–P3 + 暂缓项）成立；同日用户追加「能做的就一起做」口径并指定分支 `feat/skin-enhance`，方案扩为 P0–P7，并单列「真阻碍」。
- 验证边界：方案阶段未运行任何代码测试；`node --test test/docs-consistency.test.js test/docs-paths.test.js` 在首版入库时 32 项通过。
