# DEV-20261007-02 · 真人优先轮选

## 基本信息

- 历史提交日期：2026-10-07；补录：2026-10-08，Asia/Shanghai。
- 状态：已完成。
- 分支：`feat/IncreasePlayerCapacity`；上游基线为 v0.1.4 / `9f93096`。
- 提交：`1422876`。
- 关联决定：[D004](../DECISIONS.md#d004)。

## 需求与关键边界

用户要求开局分队策略和后续每次机变都由人类优先选择，随后确认「能手动操作的人优先，托管/掉线与 AI 后选」。因此排序依据是当前操作资格，不能只检查席位是否 `isBot`。

## 实现与理由

| 入口 | 做法 |
|---|---|
| [Match.js](../../../server/match/Match.js) 的 `prioritizeDraftOrder` | 将未选席位稳定分成手动真人与自动/掉线两组，保留组内随机顺序；连接与托管变化更新剩余队列。 |
| 策略的跳过处理 | 将当前玩家排到其他未选手动真人之后、自动席位之前；没有其他手动真人时不提供无效跳过。 |
| [bandDraft.js](../../../public/js/screens/bandDraft.js) | 界面中的跳过能力和排序显示跟随服务端口径。 |

AI 与托管席位仍自动选择，掉线席位保留原超时行为；单真人房不限时的已有规则没有被改成多真人计时。

## 验证依据与限制

提交中更新了 [draft.test.js](../../../test/match/draft.test.js)、[connection.test.js](../../../test/match/connection.test.js)、[lobby-integration.test.js](../../../test/match/lobby-integration.test.js)、[realtime.test.js](../../../test/match/realtime.test.js) 及 [bandDraft.test.js](../../../test/ui/bandDraft.test.js)。它们是后续轮选、托管和重连修改的回归入口。

原始通过数量未在 Git 中保存，补录没有补猜或重跑。后续机变调查验证了单真人与多真人超时差异，见 [反馈记录](2026-10-07-03-playtest-feedback.md)。
