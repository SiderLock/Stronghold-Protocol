# DEV-20261019-02 · 皮肤与服饰能力引入方案（取各家精华）

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-19 / 2026-10-19，Asia/Shanghai |
| 状态 | 计划中：本文只定方案与阶段，**尚未执行任何代码改动**；等用户确认范围后按 P0 → P3 逐阶段落地 |
| 类型 | 功能（调研与方案） |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`41f698a0` |
| 上游基线 | v0.3.1 `d905c146`；皮肤层来自上游 master（`58206c0b`、`f8c1da7d`、`9cc6c97e`、`01847bfb`），本分支无 0.3.2 内容 |
| 提交归属 | 与本文同一提交，按记录路径查询 |
| 关联 | [皮肤规范](../../SKINS.md)、[插件规范](../../PLUGINS.md)、[特效格式](../../design/vfx-format.md)、[前次记录 DEV-20261019-01](2026-10-19-01-gitignore-art.md) |

## 需求、范围与验收

用户要求（2026-10-19 原话）：「出个方案，取其精华，去其糟粕，为我们的分支引入皮肤/服饰相关内容。」

- **范围**：本分支已经有一套皮肤实现（上游的「外观插件 overlay」路线），所以本文**不动架构**，只盘点「别人有什么、我们缺什么」，把值得要的能力排成阶段。
- **不在范围**：不引入服务器安装通道、不让工具写 `data/*.json`、不把游戏素材放进仓库（见「明确不采纳」）。
- **方案层验收**：每条候选能力都有「采纳 / 改造 / 不做」的结论与依据；阶段之间互不阻塞；每阶段列出改动文件、验收命令、风险与不确定项。
- **实现层验收**（各阶段落地时）：定向测试通过、`npm run golden` 无移动、`node tools/i18n.mjs check --all --strict` 通过、文档一致性与路径测试通过。

## 结论速览

| 序号 | 能力 | 结论 | 来源 | 工作量 | 主要风险 |
|---|---|---|---|---|---|
| P0-1 | 只有头像/立绘的时装也能穿（「仅更换头像与立绘」） | **采纳**（摘上游 dev 的 0.3.2 补丁） | 上游 dev `77b91081`/`3f6c0786` | 小 | 会碰 4 个皮肤 pin 测试与全局开关语义 |
| P0-2 | `illust` 契约对齐（文档说详情页会显示，实际无调用方） | **必做**（接上或改文档，二选一） | 本分支自身不一致 | 小 | 需要用户定「界面要不要跟随皮肤」 |
| P0-3 | 顺手摘上游 #739 的 Windows 路径分隔符修复 | **采纳（先核实）** | 上游 PR #739 | 极小 | 无 |
| P1 | 召唤物换装（token 皮肤） | **采纳**（改造成 overlay 形态） | FengYuPrime 的 tokens 块 + 本分支灌通 | 中 | pack 路径分类、8 段路径上限 |
| P2 | 皮肤自带语音槽 | **采纳（可选，P1 之后）** | 上游 #733/#734 + YuriRestia | 中大 | 播放点多、必须同时改 schema |
| P3 | 官方时装特效（skinFx） | **先做小样本验证再做** | FengYuPrime `FORK-SKIN-VFX.md` | 大 | 体积 +100～200 MB（不确定）、需要提取机 |
| P4 | 小人实时预览、2D 界面跟随皮肤、商店立绘独立选择 | **暂缓 / 不做** | Misyra #652 等 | — | 收益与代价不匹配 |

## 我们现在的家底

`data/assets.json` 实测：210 个干员 / **0 个 `skins`** / 0 个 `illust` / 58 个 `tokens`——**本分支不含任何皮肤素材**，全部由外观插件 overlay 提供。已有的能力可以直接复用：

| 面 | 现状 | 位置 |
|---|---|---|
| overlay 数据与校验 | `chars[charId].skins[skinKey]` 白名单、键上限 64、合成流程完整 | `shared/plugins/visual.js:145-152`、`schemas/overlay.schema.json:675-727` |
| 选择通路 | `room.skins { [charId]: skinId }`（键是**干员**不是棋子），无阶段门 | `shared/protocol.js:272-308,544`、`server/lobby.js:1400-1413` |
| 服务端链路 | 会话/座位/比赛都带皮肤；补位穿 `backup.charId`、自选穿 pick | `server/match/player/basics.js:124-149`、`match/match/platform.js:107-127` |
| 渲染 | 3D 单位模型与头像跟随皮肤，`otherSkins` 开关默认开 | `public/js/render/app.js:1552-1610`、`public/js/assets.js` |
| sim | 只有 3 个文件碰 `.skin`，纯展示、`undefined` 时线格式不变 | `server/sim/units.js:41-44`、`battle/players.js:152/162/190`、`snapshot.js:40-43` |
| 测试 | 皮肤相关 5 个核心测试 + 插件 schema/visual 测试 + 守卫测试（`server/sim` 白名单 N=3） | `test/skins.test.js:302-315` 等 |
| i18n | 皮肤相关 34 条 msgid，en/ja/ko/zh-TW 四包齐平 | `public/i18n/*.json` |

**明确没有的**（都逐条搜过）：

1. **召唤物换装**：`tokenSkin*` 全仓 0 命中；overlay 的 `tokens` 只有 `avatar`/`spine`（默认外观），没有「某套皮肤换哪个 token 模型」这一层。
2. **皮肤特效**：`docs/SKINS.md:207` 自己写着 No skin effects；VFX 挂点按**默认**模型（`public/js/render/vfx/wiring.js:312`）。
3. **只有图没模型的时装**：`playable` 要求有模型（`public/js/ui/skins.js:142`），全是 art-only 时整段隐藏（`:197-202`）。
4. **皮肤自带语音**：`SKIN_RECORD` 无 `voice`。
5. **小人实时预览**：只有静态放大立绘（`public/js/ui/skinPicker.js:74-77`）。
6. **商店立绘独立选择**：`ui/assetUrls.js` 全文件不含 skin，连 2D 界面跟随皮肤都没有。
7. **导出/导入携带皮肤**：三个 envelope（loadout / ownership / diy）都没有 `skins` 字段。

## 各家精华与糟粕

| 来源 | 精华（值得要） | 糟粕（不要） |
|---|---|---|
| 上游 dev（0.3.2） | 「仅更换头像与立绘」：`skinHasPictures` / `playable = hasModel \|\| pictures` / `pictureOnly`、按座位主人取图的 `ownerSkin` | 无（是同一套架构的自然延伸） |
| FengYuPrime（③ 打包期内置） | 召唤物换装的**数据形状**与 sim 继承两条路径；`normalize` 的必要性（图集首行空行 → pixi-spine 静默回退）；下载源优先级与失败三分类；写盘前试写探针 | 用 CLI 写 `data/assets.json`（非原子、把单行写成 12 万行）；owner 派生（我们数据里 58 个 token 只有 20 个有 owner）；372/526 全量本地库目录；仓库里提交的清单只有 19/62 条 token 画得出 |
| Misyra（① 服务器安装通道，#652） | 小人实时预览的实现与两条坑（单 canvas、bounds 缓存）——**暂缓**；商店立绘的本地偏好——**不做**（与我们每套皮肤自带 `portrait` 重复） | `room.skin.install`（上游已否决）、安装队列、写 `data/`、`setInterval` 轮询 |
| YuriRestia（④ 自有 outfits） | 皮肤自带语音槽的语义（`voiceId`/charword 槽名）与召唤物外观的另一种数据落点 | 另起一套平行 outfits 体系（会造成双真相）、`data/outfits.json` |
| 上游 #733/#734 | `voice` 字段与「逐槽回落干员原声」的规则 | **只改运行时不改 schema**——这正是它没合并的原因 |

## 实施方案

### P0 · 先把契约补齐（小，建议先做）

**P0-1 只有头像/立绘的时装也能穿。** 现在插件给了立绘却没给模型的时装在界面上「列得出来、点不了」；上游 dev 已把它做成可选，买点很清楚：插件作者只做立绘的门槛大幅降低。

- 改动面：`public/js/ui/skins.js`（`playable` 语义、`hasAnySkinChoices` 的计数口径）、`public/js/ui/skinPicker.js`（标签「仅更换头像与立绘」）、`public/css/screens/loadout.css`（角标）、4 个皮肤 pin 测试、i18n 四包。
- 需要用户定的一件事：**全局开关的计数口径**要不要跟着放宽（现在只数「穿得上」的，改了以后「只有立绘」的插件也会让所有人的皮肤区出现）。上游 dev 的做法与 `docs/SKINS.md:105-110` 的现有取舍不同，这一条按用户口径写进决定。
- 验收：`node --test test/skins.test.js test/ui/skin-picker.test.js test/render/skin-presentation.test.js`，i18n 严格检查，golden 不动。

**P0-2 `illust` 契约对齐。** `public/js/assets.js:123-135` 的 `illustUrl` **全仓没有调用方**，而 `docs/PLUGINS.md:342` 与 `docs/ASSETS.md:391` 都写着详情页会显示它。两条路：把详情页接上（顺带回答「2D 界面要不要跟随皮肤」），或把文档改回现状。按「文档跟随代码」的仓库规则，先取后者也能立即消除不一致；建议至少把**干员调配详情页**接上，因为那是玩家做选择的地方。

**P0-3 顺手核实并摘上游 #739。** 守卫测试遍历 `server/sim` 收集相对路径再与 POSIX 写法比对，Windows 上因为分隔符会误报；上游 #739 用 `.split(path.sep).join('/')` 修好并已合并。先确认本分支的守卫写法，再决定是否同批带入。

### P1 · 召唤物换装（中，玩家可见价值最高）

**目标**：主人穿皮肤时，他召唤出来的 token（瓶子、装置等）换成该皮肤的模型；没有对应模型时保持 token 自己的模型。

**数据形状（overlay）**：

```jsonc
chars["char_1033_swire2"].skins["char_1033_swire2@ambienceSynesthesia#4"] = {
  name, group, avatar, portrait,
  spine: { front, back? },
  tokens: {                                  // 新增：tokenId → 该皮肤下的 token 模型
    "token_10031_swire2_gdtrap": { tokenSkinId: "token_10031_swire2_gdtrap_ambienceSynesthesia#4", spine: { front } }
  }
}
```

- **`spine` 必填**（`tokenSkinId` 只是元数据）：只有真正带来模型的映射才有意义，缺模型就当没写。
- **不需要 owner 字段**。FengYuPrime 需要，是因为它要把记录写进 `data/assets.json` 并靠 `tokens[].owner` 反查；我们走 overlay，直接由**干员自己的皮肤记录**给出映射。实测我们清单里 58 个 token 只有 20 个有 `owner`，照抄 owner 会让 38 个永远画不出来。
- 客户端加一个 `skinId → charId` 的反查（合成清单时建一次），渲染时用 `(tokenId, 当前皮肤)` 直接命中；这个反查 P2 的语音也要用。

**改动清单**：

| 位置 | 改什么 |
|---|---|
| `shared/plugins/visual.js:151-152` | `SKIN_RECORD` 加 `tokens` + token 键校验；注意 `chars.<c>.skins.<k>.tokens.<t>.spine.front` 正好 8 段，是 `locateAssetPath` 的上限（`visual.js:610`），要一起确认 |
| `schemas/overlay.schema.json:675-727` | `skinRecord` 加 `tokens`，新增 `$defs.tokenSkinRecord`（`additionalProperties: false`） |
| `server/plugins/pack.js:160,266` | 打包时按路径判定容器，别把皮肤下的 token 变体骨架按干员规则解析（建议同批加一条 pack 测试） |
| `public/js/assets.js` | `skinId → charId` 反查 + token 分支（`:239-243`）优先皮肤变体、带 `fallback` 回默认模型 |
| `server/sim/battle/players.js:190, 60-64` | 两条继承路径：召唤时继承、棋盘上「先列 token 后列主人」的 late 链接（**都在守卫白名单内，不需要改 N=3**） |
| 文档 | `docs/PLUGINS.md:342-384`、`docs/SKINS.md` 的 New files / Edits / Known limitations |
| 测试 | `test/skins.test.js`（渲染回退）、`test/plugins/schema.test.js`（正例+反例）、sim 侧用战斗 harness 测「主人在前 / 主人在后 / 技能召唤 / 无皮肤时线格式不变」 |

**语义与边界**（照实写进文档，不在本功能里修）：

- 选择立即同步给队友，但**模型本场固定、下一场战斗生效**：皮肤在战斗输入构建时取一次，`setSkins` 只改状态、没有回写 `Unit` 的路径。
- **备战区/手牌里的 token 棋子不穿**（`server/match/player/views.js:14-27` 只给棋子本体取 skin），进战斗才换。
- **token 头像不换**（`assets.js:143-147` 的 token 头像入口不接 `opts`）。
- 「显示其他玩家的皮肤」关掉时，队友的 token 一并回落——这是现成且正确的行为。

### P2 · 皮肤自带语音（中大，P1 之后，可选）

**数据形状**：`skins[key].voice`（中文树，槽名与 `audio.voice[charId]` 同一套）+ 可选 `voiceJp` / `voiceEn` / `voiceKr` / `voiceNative`；值是单文件或 1–16 条列表。

**取值链**（皮肤该语言槽 → 干员该语言槽 → 皮肤中文槽 → 干员中文槽 → 静音），外语优先于皮肤中文行；干员本身没有语音时，皮肤的行照播。

**为什么必须一次改对三处**：运行时白名单在 `shared/plugins/visual.js`，对外契约在 `schemas/overlay.schema.json`（随包发布），护栏在 `test/plugins/schema.test.js` 的 fixture。只改运行时的话，作者侧编辑器与 CI 判非法，运行时却只是 warning + 忽略——**静默丢数据**；上游 #734 就是这么卡住的。所以 `visual.js` + `schema` + fixture + 文档必须同一提交。

**播放点**：`public/js/audio.js` 的 `voiceLine` 加皮肤参数、`voice()` 加 `skinKey`、`_track` 记住皮肤、详情页与结算的调用点；试听功能可以不做，那样**零新增界面文案**。

### P3 · 官方时装特效（大，先小样本验证）

**结论：能做，但只能走「本地 FX 清单」，插件 overlay 提供不了官方时装特效。** 原因：官方单位不可被插件覆盖，且官方游戏文件禁止进插件。

- **做**：`public/assets/local/fx/index.json` 新增顶层 `skinFx` 段（`{ <官方皮肤id>: { replace: { 原键 → 新键 }, points?, graphic? } }`，逐特效键替换），运行时按 `skinKey` 查表、`skinOfView` 取挂点、命中行带 `skinFrom`、预载键一起进；提取器读客户端 `CharacterSkinHooker`，并把替换键**两侧**都导出（否则会出现「皮肤特效没有、原版也没有」）。
- **注意命名坑**：现有 `skins` 段**不是时装**，是默认模型的挂点（uid），不要复用，必须新开 `skinFx`。
- **零改动**：sim / golden / protocol / i18n / Docker 都不需要动。
- **前置与不确定**：需要一台有游戏客户端的提取机（含热更覆盖层）、皮肤 id 口径要与插件（允许 stem 形态）对齐；体积估算 **+100～200 MB（不确定，没有受控前后对比）**，所以先拿 2–3 套（例如音律联觉那几套）做小样本，量准了再决定是否全量。

### P4 · 暂缓或不做

- **小人实时预览**（Misyra #652 独有）：价值中等，但要处理「渲染器只有一个 canvas」、bounds 缓存、异步挂载取消三处坑；我们已有放大立绘 Modal，暂缓。
- **2D 界面跟随皮肤**（商店卡、干员详情、结算、统计卡）：需要给 `public/js/ui/assetUrls.js` 铺 `opts.skin` 并改所有调用点，工作量被低估；是否要做取决于用户对「界面可见」的期待——这正是 P0-2 要回答的问题。
- **商店立绘独立选择**：与我们「每套皮肤自带 `portrait`」重复，引入第二真相，不做。

## 明确不采纳

1. **服务器安装通道**（`room.skin.install` 一类）：上游已否决，理由写在 `docs/SKINS.md:8-11`，本分支的测试也会直接判失败（`test/skins.test.js:111-122,442-451`）。
2. **用工具写 `data/assets.json` / `data/skins-installed.json`**：破坏「`data/*.json` 是生成物」的仓库规则，且各家的实现都有非原子写或格式副作用。
3. **把皮肤素材随仓库分发**：版权与体积（全量约 328 MB）双重不合适；「No game art in git」是硬规则。
4. **owner 派生**：见 P1 的数据形状说明，我们在 overlay 上不需要，抄了反而画不出来。
5. **全量本地库目录**（372 干员/523 套）：会把永远不能出场的干员列进玩家的换装表。
6. **客户端轮询兜底**（`setInterval`）与**非原子整文件写**：我们有 `cosmetics.subscribe` 与打包期校验，不需要这些补丁。

## 必须守住的不变量（每条改动都要过）

- **sim 不读规则**：`skin`/`token` 只是展示数据；守卫测试 `test/skins.test.js:302-315` 要求 `server/sim` 下只有 3 个文件出现 `.skin`（`units.js`、`battle/players.js`、`snapshot.js`）——P1 的两行都在白名单内，新增 sim 文件才需要改期望列表。
- **golden 不动**：`npm run golden` 无移动；皮肤相关改动理论上零影响，仍要跑一次确认。
- **不写 `data/`**：任何阶段都不新增对 `data/*.json` 的写入。
- **素材不进 git**：`public/assets/` 保持忽略；特效素材由提取机产出或随完整包分发。
- **坏 map 整条拒**：协议、大厅、`PlayerState` 三层校验口径不变；客户端 `parseStoredSkins` 仍按 `SKIN_LIMITS` 截断。
- **schema / 运行时 / fixture / 文档同一提交**：任何 overlay 字段新增都走这一套，避免出现「作者侧非法、运行时忽略」的静默丢数据。

## 验证

| 命令 | 用途 |
|---|---|
| `node --test test/skins.test.js test/lobby-skins.test.js test/ui/skin-picker.test.js test/ui/fieldHost-skins.test.js test/render/skin-presentation.test.js` | 皮肤定向回归 |
| `node --test test/plugins/schema.test.js test/plugins/visual.test.js` | overlay 字段与 schema fixture |
| `node tools/i18n.mjs check --all --strict` | 四包文案齐平 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 文档与路径一致性 |
| `npm run golden` | 黄金结果无移动 |
| `npm run ci` | 阶段收尾的整体检查 |

浏览器侧（多人可见性、3D 皮肤与特效）按仓库惯例用 Edge 手测，记录分辨率与人数；无头检查不能替代真人对局。

## 风险与不确定

- **P3 体积**：`+100～200 MB` 是按套数外推的估值，没有受控前后对比；先做小样本测量再定全量。
- **P1 打包分类**：`pack.js` 目前按 `op.at[0]` 判定容器，皮肤下的 token 变体骨架可能被按干员规则解析；未实测，靠新增的 pack 测试钉住。
- **P0-1 的开关语义**：全局计数要不要把「只有立绘」也算进去，是产品口径而不是技术问题，需要用户确认后写进决定。
- **P2 的外语行为**：只带中文的皮肤语音对选外语的玩家不生效（外语槽优先），这条要在文档里写清楚，否则会被当成 bug 报。
- **官方映射清单**：上游提到的「22 套带 voiceId」等清单我们无法独立核对；方案不依赖它。

## 结果、遗留与接手

- **方案结论**：采纳 3 项（P0-1 立绘时装、P1 召唤物换装、P2 皮肤语音，另加 P0-2/P0-3 两个小修），P3 特效先验证后决定，其余暂缓或不做。
- **未执行**：本文没有任何代码改动；各阶段的实现、测试与提交都在后续任务里做，各自新建记录或在本记录「后续补充」里追加证据。
- **下一步**：请用户确认三件事——① 阶段顺序与范围（是否先做 P0+P1）；② P0-1 的全局计数口径；③ P0-2 走「接上详情页」还是「改文档」。
- **接手入口**：[皮肤规范](../../SKINS.md)、[插件规范](../../PLUGINS.md)、`shared/plugins/visual.js`、`schemas/overlay.schema.json`、`public/js/assets.js`、`test/skins.test.js`。

## 后续补充

- 2026-10-19：本文成立，依据是本地基线审计、上游 PR #733/#734/#776 与 dev 差异、FengYuPrime/Paper-Yuan/lilyco-42/YuriRestia/Misyra 五家实现的比对。方案阶段未运行任何代码测试。
