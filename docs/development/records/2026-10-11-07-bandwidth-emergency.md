# DEV-20261011-07 · 带宽熔断与对局紧急冻结

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-11 / 2026-10-11，Asia/Shanghai |
| 状态 | 已完成：本地实现、定向验证与分批提交；线上触发校准仍待部署 |
| 类型 | 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`2e12cdfe`；开始工作区干净 |
| 上游基线 | 已合并 v0.2.4，`bc50cac01ff447eff3ab6c35f69d934bbc23b48f`；本次未访问远程 |
| 提交归属 | 服务端保护与冻结 `ea688b4b7c1d972cb3f76cceecce9ef8b37fe026`；客户端提示/取消与本文最终记录同一提交，按本文路径查询；不推送或部署 |
| 关联 | D016、D021、D023–D025、I002、I004；前次 [DEV-20261011-06](2026-10-11-06-upstream-v0.2.4.md) |

## 需求、范围与验收

用户观察阿里云出口资源争抢期间网卡实际出口约 2 Mbps，原在线补齐预算总 8 Mbps、单 IP 4 Mbps。此观察不能证明云厂商实时上限，自动判断必须结合真实下载需求、实际出口和持续窗口。

用户明确要求开发紧急保护，正在进行的对局优先于补齐和新访问：取消全部在线补齐，限制新访客、入房和开局；尽可能保留已建立的对局连接及原成员重连。紧急状态通过小型 WebSocket 消息提示，对局阶段倒计时、服务端 AI 和客户端模拟均冻结，恢复不补跑。用户后续选择每 **120 秒尝试恢复**；已有对局连接仍拥堵或某局全部真人离线时延后，放行后继续持续异常则重新熔断。

范围包括下载限流器、Linux 出口采样/检测、HTTP/WS 准入、Match 时钟、客户端提示及缓存取消、针对性验证与开发记录；不改素材、不操作远程或服务器部署。完整 14 回合、全量 golden 与真实阿里云雪崩验证不属于本次定向验证。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 能否取消正在下载的补齐 | `cacheLimiter.js` 持有活动 response/lease | 可运行时销毁响应并拒绝新 lease；不能调用永久 `close()` 代替可恢复熔断 |
| 是否直接封 WebSocket upgrade | `Network.admission` 升级时只有 IP，hello 后才识别 token | 保留有界升级，hello 时拒绝新身份和非对局令牌；原对局成员与原观战者令牌续连保留 |
| 单人暂停能否直接用于全局冻结 | `MatchPause` 只覆盖单人战斗计时 | 不混用 `paused`；独立可冻结 scheduler 覆盖全阶段和 AI intervals |
| 怎样判断恢复 | 切断补齐后无持续下载需求，空闲出口无法证明容量 | 用户确认每 120 秒试恢复；明确是尝试恢复，非已测得云带宽恢复 |
| 紧急提示能否保证送达 | 同一 WebSocket/TCP 出口和已有队列 | 小消息优先发，welcome/公共状态重复携带；出口完全堵塞时无法保证即时到达 |

## 实现或操作

| 部分 | 实现、理由与边界 |
|---|---|
| 检测与恢复 | `server/bandwidthEmergency.js` 每秒读取 Linux 默认出口；5 秒窗口后持续 15 秒异常才触发，默认最早约 20 秒。至少 64 KiB 待发、实际出口低于期望预算 60%，结合两个独立下载网络背压或对局拥堵；IPv6 `/64` 合并佐证。短文件连续需求可触发，磁盘准备、短波动及需求空档不累计。无补齐时，至少两个且不少于半数对局网络持续受阻可单独佐证。 |
| 熔断下载 | `cacheLimiter.js` 跟踪准备与传输 response，trip 销毁全部并中止旧 lease；恢复仅接收新请求，不让未完成的旧磁盘读取重新发送。永久关闭和服主禁用仍独立生效，原总 8 Mbps / 每 IP 4 Mbps 不变。 |
| HTTP 与准入 | `routes.js` 除 `/healthz` 外前置轻量 503，关闭连接并提供 Retry-After；取消普通页面/素材等在途响应。`index.js` 另调用 `closeAllConnections()`，覆盖已 finish 但尚在 TCP 排队的普通 HTTP，保留升级 WS。hello 在创建身份前拒新访客；大厅发现、入场/开局、额外聊天等操作停止，同成员重同步/查看/退出保留。 |
| 原成员连接 | `Network.setEmergency` 先发不到 200 B 的提示，再冻结并发公共状态；welcome 重复带状态。原对局成员和原观战续连保留，冻结时间不消耗续连窗口；普通等待房已有连接保留，新续连仍拒绝。保护期间硬队列已满时不继续追加、不因广播主动 terminate。心跳保存最早未应答时间，重复 ping 不把断流误判为正常。 |
| 全阶段冻结 | `FreezeScheduler` 保持稳定 timer 句柄和剩余时间，暂停 timer/interval 与 AI；Match 独立 emergency 状态覆盖 INFO、并行分队/机变、PREP、COMBAT、UNITE、领袖/隐藏阶段。推进意图和战斗报告拒绝；生命周期先更新席位连接/离开，玩法后果延后到恢复。恢复平移全部相关 deadline、场地时钟和 pacer，不补跑；单人主动暂停与紧急冻结重叠不重复计时。 |
| 客户端 | `store.js`/`components.js`/`game.js` 冻结倒计时和编辑，runner 停本地模拟、保留并恢复重交结果。全页面常驻提示与连接提示独立，开局预留顶部提示区，PREP 不遮准备按钮。取消在线补齐/目录更新，保留已完成缓存；恢复仅手动继续。重连时暂停原 1.5 秒清状态宽限，解除后重新给宽限，避免快照迟到丢对局。被 hello 拒绝的访客遵守服务器恢复窗口（30–120 秒加少量抖动），原对局成员保持普通快速重连。 |
| 协议与观察 | wire v1 的 ID、字段位置、枚举与指纹不改，`m.emergency` JSON 回退，welcome/public 用已有扩展位；正常与恢复后的 public 省略紧急字段。`/healthz.bandwidthEmergency.lastTrigger` 保留触发时汇总证据，不含身份/IP。错误与提示补全四种语言包。配置和服主查询命令见 [ASSET_CACHE](../../ASSET_CACHE.md#带宽紧急保护)。 |

复审额外修正：普通 HTTP 的 finish 不代表已经出站，原 session 保留但 `byToken` 过期仍拒绝，以及紧急小帧可能触发旧 WS 硬上限，均有真实 HTTP/WS 或隔离回归。检测器自动恢复不是带宽探针；当前对局仍受阻时保留保护，再等 120 秒。

## 验证

环境为 Windows、项目现有 Node/npm，定向测试使用本地随机端口、注入 Linux 累计出口样本和 VirtualScheduler；不是实测阿里云带宽。

| 实际命令 / 检查 | 结果与限制 |
|---|---|
| `node --test test/emergency-network.test.js test/asset-cache-http.test.js test/bandwidth-emergency.test.js test/cache-limiter-emergency.test.js` | 当次 53/53 通过；真实 HTTP 下载、尾部 TCP 取消、小 503、原成员续连与默认 120 秒，下载检测与预算兼容。后续增加心跳和触发证据用下列定向命令验证。 |
| `node --test test/bandwidth-emergency.test.js test/cache-limiter-emergency.test.js` | 最终 28/28 通过；含持续小文件、空档重置、网卡变化、无下载通信受阻、恢复延后及 lastTrigger 拷贝/隐私边界。 |
| `node --test test/emergency-network.test.js test/wire-codec.test.js test/match/emergency-freeze.test.js test/match/freeze-scheduler.test.js` | 最终 33/33 通过；含反复心跳不清失联证据、13 项全阶段/计时冻结检查，v1 指纹与固定字节样本一致，2840 种编解码组合及 1–20 席位阶段夹具。领袖夹具直接跳入目标阶段，没有完整打 14 回合。 |
| `node --test test/match/freeze-scheduler.test.js test/match/emergency-freeze.test.js test/match/group-unite-rounds.test.js test/match/setup-reroll.test.js test/match/ai-picks-last.test.js` | 46/46 通过；固定组联防、开局重刷与真人优先兼容。 |
| `node --test test/ui/emergency-state.test.js test/match/runner.test.js test/match/runner-pending.test.js test/asset-cache-manager.test.js test/ui/group-draft-views.test.js` | 71/71 通过；客户端计时、模拟与报告保留、补齐中断、既有分组显示。 |
| `node --test --test-name-pattern='net.js\|emergency' test/client-static.test.js test/ui/emergency-state.test.js` | 29/29 通过；访客限重连、恢复宽限和原对局快速续连；与上组重叠两项，不相加。 |
| `node tools/i18n.mjs check --all --strict shared/constants.js public/js/main.js public/js/ui/emergencyBanner.js public/js/ui/assetCache.js` | 四个语言包各 170 项，100% 覆盖、0 缺失/错误；仅本次涉及字符串范围。 |
| 修改的服务端、shared 与测试执行 `npx eslint` | 0 错误、5 项既有 warning（lobby seed、intents key、prep r、spDraft id、unite key）；未混入无关清理。客户端及浏览器测试 lint 0 错误、8 项既有 warning 保留。 |
| `npm run typecheck` | 通过；覆盖项目 jsconfig 已配置范围，不等于所有动态客户端/服务端文件静态检查。 |
| `npm run check:imports` | 返回 0；报告现存 `server/sim/nodeData.js` 的 3 个 sim-node 导入诊断及 3 个 allowed note，相关文件本次未变，无新增边界诊断。 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` / `git diff --check` | 31/31 通过；相对链接/源码路径及现有规则一致性通过，差异无空白错误。 |

**Edge 短烟测**：`$env:SP_E2E='1'; node --test test/emergency.browser.test.js`，1/1 通过。使用测试默认 Edge 路径，版本 155.0.4283.45，1920×1080 与 1280×720；2 真人会话 + 18 AI，INFO_CHECK/PREP。冻结后提示持久、倒计时保持；welcome 后 m.public 延迟 1.8 秒不清对局，恢复时提示消失、保留剩余时长；新 HTTP 返回 503。提示无屏幕按钮交叠，z-index 高于普通遮罩。PREP WebGL 初始化失败使用既有 DOM fallback，仅验证准备 UI，不是完整渲染/真实窄带作战验证。截图与 report 留在忽略目录 `.cache/emergency-ui/`，本段保留关键结论，不依赖缓存存续。

**未纳入通过结论的既有夹具**：兼容组合 `node --test test/match/freeze-scheduler.test.js test/match/emergency-freeze.test.js test/match/connection.test.js test/match/setup-reroll.test.js test/match/runner.test.js test/match/leftovers.test.js` 为 58 通过 / 1 失败。`connection.test.js` 最后一项只 advance(150)，而当前 PUBLIC_THROTTLE 为 200 ms，public 仍为旧商店等级。内联隔离分别启用 wrapper / 直接原 VirtualScheduler，两者实际 shop 均已升级，150 ms public 都旧、200 ms 都更新；证据排除 wrapper 引入的这项差异，未声称 checkout 旧版本验证，未修改此无关夹具。

未执行全量 CI、golden、完整 14 回合、20 真人实战或 Linux/阿里云真实雪崩。模拟算法和 golden 未改；此次按用户要求选择性验证。

## 结果、遗留与接手

- 实现结果：服务端保护和客户端配套均已实现，完成定向检查并分两阶段本地提交。
- 未确定或未完成：I005 的 Linux/阿里云实际触发、误报与参数校准待部署后观察。应用无法取消 Nginx/其他进程直接提供的文件，无法撤回已到反代/链路的字节；尊重 `X-Accel-Buffering: no` 且经 Node 转发才受保护。小提示共用原 WS/TCP，完全堵塞时不能保证立即送达；服务端冻结独立执行。旧网页需刷新，新代码不热替换已有旧客户端。
- 提交 / 远程 / 素材 / 线上：后台 `ea688b4b`，客户端与最终记录同一提交；远程未操作，素材未改动，未部署。
- 资源释放：定向服务端测试通过 finally/t.after 关闭连接、server 与采样/Match timers。Edge 烟测 finally 关闭 browser/server，报告两项均 true，端口 52547 无监听；未占用用户的 3000 端口。
- 接手入口：`server/bandwidthEmergency.js`、`server/match/freezeScheduler.js`、`test/emergency-network.test.js`、`test/match/emergency-freeze.test.js`、`test/emergency.browser.test.js`；部署参数与观察入口见 ASSET_CACHE/D030。

## 后续补充

无。
