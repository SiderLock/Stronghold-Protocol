# 2026-11-20 规程新策略的主被动逐条复查

按用户要求，逐条复查 0.4.0 规程（`act3autochess@V3_1`）新加的 46 个策略（相对默认赛季），区分被动、主动与
未解锁占位行，核对官方数据与实现。默认赛季已有的 15 个策略只做回归检查。

## 结构

46 个新策略共 59 行：**主动 36 行、被动 17 行、未解锁占位 6 行**，涉及 41 个 buff key（全部有实现）。

- 主动：`server/match/bandCommandEffects.js` 的 `commandPlan` 与状态机（`bandCommands.js`）；标记类再分两路——
  战前输入改写（`commandBattleInput`：精英化、临时装备、联防替补）与战斗内安装（`installCommandMarks`，
  `server/sim/content/bands/commands.js` 的 `MARKS`）。
- 被动：`meta.js` 的 `K.*`（回合给牌/装备、华法琳层数、休露丝价格）、`commandPassive`（刷新/购买/合并/出售/
  休整期钩子）、`builtinMeta.js`（道具装备效果，如信标、寻呼模块）、战斗侧 `BY_KEY`（陈的弱点伤害与精锐加成、
  盟约效果替换经 `bondEffectOverrides`）。
- 占位行（但书/昆图斯/信仰搅拌机/歌蕾蒂娅/引星棘刺/琳琅诗怀雅）只负责解锁与显示，不参与结算。

## 核对方式

1. 把 41 个 key 在数据里用到的参数（`bb` + `bbStr`）与每个处理函数实际读取的字段一一对照，没有未读参数导致
   的“沉默失效”，也没有实现里凭空的硬编码。
2. 在真实对局里逐条验证回合类被动（探测脚本，非直连内部函数）：森蚺第 1 回合拿到「暴躁铁皮」、杰西卡第 4 回合
   拿到寻呼模块、芬第 8 回合拿到信标、耶拉第 4 回合拿到谢拉格不融冰、奥达第 3 回合拿到当前商店等级的装备；
   但书的「条文修正」在已激活盟约上 +9 层。
3. 标记类主动由既有战斗测试覆盖：百炼嘉维尔的击倒复活次数、桑葚的护盾 1 层上限、妮芙的恐惧地块、Misery 的
   替补上阵、寻宝人的宝箱（含多轮联防回执）、大嘴莫布的精英化与布丁的全场临时装备（`commandBattleInput`）。
4. 陈的被动（弱点伤害 + 精锐攻速/攻击）由 `regulation-battle.test.js` 覆盖；盟约效果替换（炎/萨尔贡/维多利亚/
   阿戈尔/叙拉古/卡西米尔/谢拉格七个键）由 `commandBondOverrides` + `playerBondRecord` 覆盖，双向都测过。

## 发现并修复

**规程贾维的刷新进度条永远停在 0/4**：`bandProgressView` 读的是下半赛季的累计计数器
`band:chiave:refreshes`，而规程的 `refresh_shop_count_gain_coin_bond_char_chess` 处理函数按
`roundStats().refreshes`（每回合清零）计数，从不写这个累计键。现在规程改用 `ps.round.refreshes`，与处理函数
同源；回合奖励上限仍用 `band:chiave` 的惰性回合计数。

- 回归：`test/match/band-progress.test.js` 新增规程用例——3 次刷新显示 3/4，第 4 次触发奖励后回到 0/4、
  `roundProgress` 显示 1/1；默认赛季的累计语义不变。
- 文档：`docs/META.md` 的「Read-only strategy progress」补一句规程的每回合来源。

## 未修改的观察（留待确认）

- `bandProgressView` 只服务贾维；洛洛（3 名维多利亚）、娜仁图亚（3 名萨尔贡）、休露丝/裁度（每回合首次）目前
  没有进度条。官方是否显示这些计数未确认，暂不扩展。
- 风丸的「同阶随机」有概率抽到原干员（同一次指令看不出变化）；官方未写明是否排除自身，未改。
- 寻呼模块的「其他干员」目前不排除携带者本体；与下半同款道具共用处理函数，改动会同时影响两个赛季，未改。

## 验证

- `node --test test/match/band-progress.test.js`：3/3 通过（含新规程用例；改回旧实现时失败）。
- `node --test test/bands/regulation-commands.test.js test/bands/regulation-battle.test.js`：全部通过。
- `node --test test/docs-consistency.test.js test/docs-paths.test.js`：32/32 通过。
