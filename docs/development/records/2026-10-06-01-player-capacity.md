# DEV-20261006-01 · 20 人容量扩展

## 基本信息

- 历史提交日期：2026-10-06；补录：2026-10-08，Asia/Shanghai。
- 状态：实现已完成；20 名真人及多房间性能验证仍待补（I002）。
- 分支：`feat/IncreasePlayerCapacity`。
- 提交：`e32edbb`（对局与协议）、`309c7a1`（房间与 UI）、`90bb5a4`（规则文档）。
- 关联决定：[D001](../DECISIONS.md#d001)、[D002](../DECISIONS.md#d002)、[D003](../DECISIONS.md#d003)、[D005](../DECISIONS.md#d005)、[D006](../DECISIONS.md#d006)。

## 需求与最终约定

原版和先前同人版最多四人，同人版另有 AI 队友。用户要求至少八人，最终确认可选 4/8/10/16/20、默认八人；适配机变、共享卡池、领袖血量、联防、信标和界面，并按实际人数生成内容。

卡池最初考虑按每组人数缩放；用户随后明确三人组也使用完整原版数量，最终按 D003 实施。联防采用最多两轮、四名不同队友，八名存活玩家起才考虑第二轮。

## 实现与理由

| 实现入口 | 做法与目的 |
|---|---|
| [playerCapacity.js](../../../shared/playerCapacity.js)、[protocol.js](../../../shared/protocol.js)、[lobby.js](../../../server/lobby.js) | 集中人数与分组规则，扩展座位和机变索引，校验实际占用，避免客户端与服务端各自硬编码四人。 |
| [pool.js](../../../server/match/pool.js)、[PlayerState.js](../../../server/match/PlayerState.js)、[effectsMeta.js](../../../server/match/effectsMeta.js) | 固定分组并处理副本归还、信标跨组接收，避免多人单池竞争和赠送组别错误。 |
| [choices.js](../../../server/match/choices.js) | 按存活人数补足机变选项，悬赏延续原六张强弱分布，允许独立重复位置。 |
| [gamedata.js](../../../server/match/gamedata.js)、[finalAssault.js](../../../server/match/finalAssault.js)、[unite.js](../../../server/match/unite.js) | 领袖共享血池随存活人数变化；联防在需要时增加另一组队友，最终漏怪仍归属原玩家。 |
| 房间、机变、队伍与准备 UI | 多行席位、可滚动选项及队伍栏，避免人数扩展后遮挡或索引越界。表情的最终修正见后续反馈记录。 |

当前详细规则集中在 [PLAYER_CAPACITY.md](../../PLAYER_CAPACITY.md)，本记录保存来由而不重复整个数量表。

## 验证依据与限制

提交中包含以下相关测试，可作为后续针对性验证入口：

- [lobby-capacity.test.js](../../../test/lobby-capacity.test.js)：开房与容量边界。
- [player-capacity.test.js](../../../test/match/player-capacity.test.js)：分组和卡池。
- [draft-capacity.test.js](../../../test/match/draft-capacity.test.js)：扩容机变与较大索引。
- [unite-capacity.test.js](../../../test/match/unite-capacity.test.js)、[finalAssault.test.js](../../../test/match/finalAssault.test.js)：联防与领袖。
- [feedback3-gift.test.js](../../../test/match/feedback3-gift.test.js)：信标跨组赠送。

原始测试输出未随这些提交完整保存，补录不猜测通过数量，也没有为文档整理重跑历史测试。实现测试不能代替 20 名真人同时连接的设备、网络和并发房间测试。

## 后续

随后合并上游 v0.1.4，审计、runner 与双人 golden 另有适配，见 [同步记录](2026-10-07-01-upstream-v0.1.4.md)。真人优先轮选、百分比领袖机制和联防投票是之后新增的需求，分别见后续记录。
