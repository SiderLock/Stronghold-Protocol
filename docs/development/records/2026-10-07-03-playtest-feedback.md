# DEV-20261007-03 · 领袖、联防投票、表情及机变反馈

## 基本信息

- 历史提交日期：2026-10-07；补录：2026-10-08，Asia/Shanghai。
- 状态：相关修复已完成；第三次机变缺席报告待复现（I001）。
- 分支：`feat/IncreasePlayerCapacity`；上游基线 v0.1.4 / `9f93096`。
- 提交：`0a1fe03`（领袖机制）、`8fbac6d`（联防投票及一次表情调整）、`cccb55e`（表情最终修正及机变说明）。
- 关联决定：[D005](../DECISIONS.md#d005)、[D006](../DECISIONS.md#d006)、[D007](../DECISIONS.md#d007)。

## 1. 胄的无人机机制与限伤

扩容血池使死亡集群无人机死亡的 2% 扣血可能达到 72 万，超过 300000 普通攻击限伤而被取消。`0a1fe03` 在 [Battle.js](../../../server/sim/Battle.js) 的 `loseHp` 增加内部机制豁免，由 [bosses.js](../../../server/sim/content/bosses.js) 的 `boss:droneLink` 使用，继续计入击杀玩家伤害；普通攻击和部件传递仍保留限伤。

相关验证落在 [playtest6_limits.test.js](../../../test/sim/playtest6_limits.test.js)，包括胄的普通/隐秘核心血池与百分比机制边界。本次补录不把这一修复扩大解释为取消所有限伤。

## 2. 首轮联防投票跳过第二轮

用户报告多人漏怪过量时第二轮可能拖慢游戏，要求首轮提供人类多数票跳过。用户进一步确认：留在对局的淘汰人类计入，掉线和托管不计入。

`8fbac6d` 实现 `g.uniteSkipVote`、投票资格与门槛更新、通过后锁定、首轮照常打完和剩余漏怪结算。入口为 [Match.js](../../../server/match/Match.js)、[unite.js](../../../server/match/unite.js)、[hud.js](../../../public/js/ui/hud.js)、[protocol.js](../../../shared/protocol.js)。规则边界以 D006 为准。

持久测试见 [match/unite-vote.test.js](../../../test/match/unite-vote.test.js) 与 [ui/unite-vote.test.js](../../../test/ui/unite-vote.test.js)，涵盖资格、断线/托管变化、投票多数和结算。

## 3. 队伍栏和表情：保留被否定的理由

最初调整把表情放在成员信息与滚动条之间，且头像/名字与表情分两行。用户随后指出此空间还要显示状态图标，明确要求恢复右侧的一行表情，同时将过远的滚动条向内容收拢。

最终 `cccb55e` 调整 [game.css](../../../public/css/screens/game.css)：队伍栏 `width: max-content`，保留最大宽度，恢复图标不换行；表情位于栏右侧，头像、名字和表情使用一行 flex 布局。后续维护以这次最终决定为准。

上次开发的实际检查记录为：Edge、1920×1080 与 1280×720、休整与联防共四组，20 席位可滚动，图标能容纳，滚动成员列表后表情仍可见。另运行机变容量、联防 HUD、文档一致性相关测试，共 44 项通过。来源是上次会话的检查输出及项目缓存中的报告；本次只补录关键结果，没有重新执行这组浏览器测试。

## 4. 第三次机变：调查完成，缺席未确诊

用户说明当局为终极、自己仍存活且没有托管，随后表示可能没操作而自动选择，记忆并不确定。

核对当前配置与已合并 v0.1.4 后确认：同盟标准第 3/9 回合、险境第 3/6/9 回合、绝境与终极第 3/9/11 回合有机变。终极第 11 回合可生成悬赏、机密商店或战术决策，不能把「没有装备/支援」直接等同于「没有第三次机变」。

上次调查使用现有 Match 测试 harness 驱动 20 人终极流程进入第 11 回合机变；一位真人 + 19 AI 等待 40 秒仍停在该玩家选择，多位真人的房间则会在倒计时后自动选。200 个种子的选项生成覆盖了上述三种类型。这是状态机和生成逻辑检查，未证明用户当局具体发生了什么，也不是 20 真人联机测试。

接手入口：[Match.js](../../../server/match/Match.js) 的 `loneHuman`、`soloUntimed`、`afterRoundStart`、`enterSpDraft`、`startSpTurn`，[choices.js](../../../server/match/choices.js)、[config.json](../../../data/config.json) 与 [harness.js](../../../test/match/harness.js)。I001 继续待复现；再次出现应保存开局真人数、回合状态和当次选项类型，不预先归因为挂机。
