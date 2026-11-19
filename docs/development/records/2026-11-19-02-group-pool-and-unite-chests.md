# 2026-11-19 分组卡池与多轮联防宝箱的两个边界修复

接续 [DEV-20261119-01](2026-11-19-01-upstream-v0.4.0.md)。合并上游 0.4.0 后复查二十人玩法发现两处边界问题，均已在
`dev` 修复并补回归用例。

## 1. 特殊刷新的羁绊保底从第一组卡池抽卡

- **现象**：6 人以上房间分成固定卡池组（D010）后，规程「特殊刷新」的干员保底（`shop.bondRefresh`，如谢拉格保底）
  仍用 `m.pool` 抽取。`m.pool` 是第一组的池：第二组起可能刷出本组已无库存的干员，同时消耗第一组的副本。
- **原因**：`server/match/player/economy.js` 的 `_applyBondRefresh` 直接写了 `this.m.pool.roll(...)`，而其他抽取
  （普通刷新、指令、奖励）都用 `this.pool`（`basics.js` 的 getter → `m.poolFor(this)`）。
- **修复**：改为 `this.pool.roll(...)`。
- **回归**：`test/garrisons/regulation.test.js` 新增「draws from the drawer's own fixed pool group (D010)」：
  6 人 3 + 3 房，把第二组的谢拉格副本清空、第一组保留 10 份；把商店等级提到 6 后触发谢拉格保底，断言刷新结果
  没有谢拉格干员且第一组库存不变。把实现临时改回 `m.pool` 时该用例失败。

## 2. 多轮联防只把最后一波交给战斗结果钩子

- **现象**：D013 的多轮联防里，宝箱（模拟宝藏 `enemy_9038_achest`）在前一波被触碰摧毁后，后续波次仍会重建，
  甚至留到下一回合。
- **原因**：只有 `settle()` 会派发 `onBattleResult`；`_afterUniteWave` 把最后一波的 result 传给 `settle`，
  前面波次只进入 `plan.history`。指令被动只读 `ev.result` 和 `ev.unite`（最后一波），因此前面波次的
  `commandChests` 回执从未应用。
- **修复**：
  - `server/match/match/unitePhase.js`：`_afterUniteWave` 在决定下一波或结算前调用 `_reconcileUniteChests(waveResult)`，
    遍历该波 `perPlayer` 的 `commandChests` 并移除被摧毁的标记；
  - `server/match/bandCommandEffects.js`：`onBattleResult` 改为遍历 `ev.uniteResults`（`plan.history` + 最后一波），
    保留没有列表时的 `ev.unite` 回退。
- **回归**：新增 `test/bands/unite-chests.test.js`（2 项）：被触碰的宝箱在下一波前消失、站立宝箱保留；以及
  「回执先于下一波/结算应用」的次序断言。移除 `_afterUniteWave` 的调用时第二项失败。

## 验证

- 定向：`test/bands/*regulation*`、`test/bands/unite-chests`、`test/garrisons/regulation`、`test/bonds/regulation`、
  `test/match/group-*`、`test/match/unite-vote`、`test/match/bond-groups`、`test/match/diy-*`、`test/match/prep-*`、
  `test/match/garrison-upgrades`、`test/match/diy-shop` 共 263 项通过。
- Golden：规程 256 个场景、默认版本 291 个场景全部匹配，无需重录。
- 文档：`docs/PLAYER_CAPACITY.md`（所有抽取都用所属组池）、`docs/design/match.md`（特殊刷新的干员栏走分组池）、
  `docs/development/DECISIONS.md` D013（每波回执立即应用）、`docs/history/0.4.0.md` 分支说明。

## 遗留

- `server/match/bot.js` 仍有几处评估用分析读 `m.pool`（`bondPoolStats`、`bandRefreshGain`、`coreGap` 等）：
  不发放干员、只影响 AI 判断；改它们会移动含 AI 的 golden，留作单独任务。
