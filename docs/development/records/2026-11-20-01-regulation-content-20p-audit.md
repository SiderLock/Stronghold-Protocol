# 2026-11-20 规程新盟约与新策略的二十人适配复查

接续 [DEV-20261119-02](2026-11-19-02-group-pool-and-unite-chests.md)。本轮按用户要求复查 0.4.0 的新盟约（多人模式 26 个）
与新策略（61 个，含 40 个规程策略）在本分支二十人环境下的适配，重点看本分支的容量与性能改动是否引入意外行为。

## 复查范围与方法

1. **抽取与库存入口的代码审计**：`rollChess` / `rollPool` / `rollItem` / `rollItemId` / `acquireChess` / `acquireItem`、
   商店刷新、指令、奖励、选择自编、插件 offer。内容层（`server/sim/content/bonds|bands|garrisons`）没有任何跨玩家或
   全局池读取；`m.pool` / `m.itemPool` 只剩诊断与测试接缝。
2. **20 席位策略扫描**：4 批 × 20 名玩家覆盖全部 61 个策略，在 3+3+3+3+3+3 分组里逐个设组、发牌、发动指令，并推进到
   R3。结果 0 错误、0 不变量失败；3 个 `BAD_TARGET` 都是「该策略的盟约在本局被禁用」（同局 `disabledBonds` 含
   `yanShip` / `egirShip` / `ursusShip`）的合法拒绝，不是缺陷。
3. **长局**：20 席位规程推进到 R8，`clientCombat` 与服务端模拟各 2 个 seed；经历 INFO_CHECK / BAND_DRAFT /
   BATTLE_CHECK / ROUND_START / PREP / COMBAT / UNITE / SETTLE / SP_DRAFT，0 错误、0 调度错误。
4. **数据审计**：`node tools/bb-audit.mjs` 对 `act3autochess-v3_1`：0 个未知触发规则、0 个未实现机制；唯一的
   “version-only key no code names” 是 `garrison_103_a/b` 的 `battleRuneKey: "无"`（数据占位，`effectType: NONE`），
   其余为跨赛季字段差异。
5. **盟约计数语义**：v3_1 的盟约全部按本人棋盘计数（`BOARD` / `BOARD_AND_DECK` / `BOARD_ALL_CHESS`），二十人不会改变
   阈值含义；隐藏核心的门槛按人数缩放（既有规则，`coopHiddenLayerThreshold`）。

## 发现并修复

**`server/match/bot.js` 有 5 处 AI 分析仍读第一组卡池**（`bondReach` 的羁绊可达数、羁绊缺口、特殊刷新收益、
`bandRefreshGain` 与 `coreGap` 的库存判断）。6 人以上分固定组后，第二组起的 AI 会按第一组的库存误判「还能刷到」，
导致乱刷新、错买或错误的策略判断。改为读本人组的 `ps.pool`（`bondReach` 在 `ps` 缺失时回退到 `m.pool`）。

- 回归：`test/match/bot-pool-groups.test.js`——6 人 3+3 房，选一个两组都有的盟约、清空第二组该盟约的副本，
  断言第二组 AI 的 `bondReach` 为 0、第一组仍大于 0；把实现改回 `m.pool` 时该用例失败。
- 影响面：golden 的对局最多 4 人（单池，`ps.pool === m.pool`），行为不变；默认 21 个、规程 14 个 matches 场景均匹配。

## 未发现的问题

- 上一轮修复的分组保底与多轮联防宝箱在本轮扫描中未复现；
- 其余“优化”（分组卡池、分组装备、私有自选、多轮联防、AI 计算隔离、客户端战斗/渲染压缩）与新盟约、新策略组合的
  运行时检查均通过。

## 验证

- `test/match/bot-*.test.js` 等 120 项通过；
- 默认 `matches` 21 个、规程 `matches` 14 个 golden 场景匹配，无需重录；
- 扫描与长局见上（均 0 错误）。
