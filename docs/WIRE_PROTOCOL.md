# 紧凑网络协议与带宽维护说明

2026-10-23 收发维护：`pong.d` 使用 v1 既有扩展对象，携带服务器处理、事件循环及该连接的发送等待 / 队列证据，保留原有 `c` / `s` 及所有位置编号。客户端结合发生时间和页面卡顿测量，连续异常才提示；单凭 RTT 不判定用户故障。慢连接下相邻同阶段全量公共状态只保留最新一份，其他消息及阶段 / 时限变化形成顺序屏障。阈值、诊断边界和回归入口见 [网络设计](design/network.md#8-network-protocol-sharedprotocoljs-is-normative)。

本分支使用业务对象与传输编码分开的协议。业务逻辑、校验和 UI 始终使用原来的 `{ t: 'm.public', phase: 'COMBAT', ... }`；紧凑数组只出现在 WebSocket 网络边界。解码恢复完整字段名和枚举字符串，不改变战斗、卡池、机变或联防规则。

入口：[位置与枚举目录](../shared/wireSchema.js)、[纯 ESM 编解码器](../shared/wireCodec.js)、[开发记录](development/records/2026-10-10-09-compact-wire-bandwidth.md)。业务语义仍以 [protocol.js](../shared/protocol.js)、[网络设计](design/network.md)和 [META](META.md) 为准。

## 1. 三个独立版本

- 应用版本：`APP_VERSION` / `package.json`，当前 0.2.3。
- 业务协议版本：`PROTOCOL_VERSION = 1`，控制消息含义和原 JSON 的兼容性。
- 数组布局版本：`WIRE_VERSION = 1`，控制本说明的位置表。改变布局不能只修改业务版本或应用版本。

协议目录中的 ID、字段顺序和枚举编号属于永久约定。**已发布的 v1 不允许重排、删除、复用编号或插入字段；布局变化须引入新 wire 版本并保留旧版解码。** 尚未登记的字段通过扩展对象完整传输；尚未登记的消息保持原 JSON；尚未登记的枚举字符串保持字符串。新增业务字段不会被静默丢弃。

队友申请重刷（[PR #857](https://github.com/sganggs/Stronghold-Protocol/pull/857)、[D041](development/DECISIONS.md#d041)）的 `room.requestReroll {setupRevision}` 沿用 JSON 回退；`m.public.rerollRequests: [{playerId}]` 使用既有扩展对象，空列表也完整保留。登记字段覆盖白名单并验证非空请求及 6 / 9 / 13 / 20 席真实视图往返；v1 指纹不变。

预缓存准入的 `room.create`、`room.join`、`lobby.quickMatch`、`room.spectate` 可选字段 `assetCache: {schema:1,version:<64位SHA>,readyFiles:<整数>,readyBytes:<整数>}`，以及 `welcome` / `lobby.state` 的 `requireAssetCache`，使用既有扩展对象，**没有新增 v1 字段位置**。解码后完整还原同名标准 JSON；新错误码 `ASSET_CACHE_REQUIRED` 依照现有未知枚举字符串规则传输。字段覆盖测试为这四项报告登记明确的扩展白名单，同时保留 v1 指纹和往返测试；不放宽其他字段的目录要求。详见 [准入约定](SERVER_SETTINGS.md#完整预缓存准入) 与 [任务记录](development/records/2026-10-10-12-offline-catalog-admission.md)。

带宽紧急保护的 `m.emergency {active,reason,since,retryAt}` 使用原 JSON 回退，不新增 v1 消息 ID。`welcome.emergency` 及紧急期间 `m.public` 的 `emergencyFrozen`、`emergencyFrozenAt`、`emergencyReason` 使用既有扩展对象；正常与恢复后的公共快照省略这三项。`SERVER_EMERGENCY` 沿用未知枚举字符串规则，已发布字段位置、枚举顺序、目录指纹与固定字节样本均保持不动。通知和原成员续连规则见 [紧急保护](ASSET_CACHE.md#带宽紧急保护)。

## 2. 消息外层

```text
[wireVersion, messageId, presenceMaskHex, ...presentValues]
```

`messageId` 对应 `WIRE_MESSAGES` 中明确指定的整数，不从对象遍历顺序或 `S2C` 数组动态生成。0–20 为当前服务器消息，32–81 为当前客户端消息；空余编号保留。`m.public = 8`，`m.private = 9`，`b.start = 16`，`b.progress = 79`。

每种消息的字段位置首先是 `rid`（位 0），随后依照目录中该消息的字段顺序。`t` 由消息编号恢复，不占字段位置。存在位图是无前导零的小写十六进制字符串（空对象为 `"0"`）。位 `i` 为 1，表示位置 `i` 有值；只按位置升序存放有值的字段。**位图表示字段是否存在，字段值可以是 `null`、`false`、0 或空数组，不能用它们代替缺失。**

例如：

```json
{"t":"m.public","phase":"COMBAT","round":11}
```

编码为：

```json
[1,8,"6",7,11]
```

`"6" = 二进制 110`：rid 缺失，phase 和 round 存在；阶段编号 7 恢复为 `COMBAT`。这不是字符拼接协议：JSON 数组保留数值、布尔和字符串边界，名字和中文文本不会造成分隔符歧义。

## 3. 嵌套位置数组

已登记的对象用 `[presenceMaskHex, ...presentValues]`。对象类型由父字段目录确定，因此不用反复携带字段名或对象类型编号。

目录写法：

| 目录项 | 网络含义 |
|---|---|
| `"round"` | 原 JSON 值，字段名由位置还原 |
| `["bossHp", "hpPool"]` | 使用 `WIRE_RECORDS.hpPool` 的嵌套位置数组；null 保留 |
| `["players", ["list", "publicPlayer"]]` | 数组顺序不变，每个元素使用 publicPlayer 布局 |
| `["loadout", ["map", "loadout"]]` | 动态干员 ID 保留为对象键，值使用 loadout 布局 |
| `["phase", ["enum", "phase"]]` | 已知字符串换成对应整数编号 |

完整公共状态有明确的根位置及嵌套玩家、羁绊、战场进度、卡池组、开局重刷、分队、三种机变、联防投票和结算布局。个人商店、棋子、装备、效果、观战、战斗开场和结果也有各自布局。动态玩家 ID / 干员 ID 映射、数值快照及事件元组本来就是数据，保留原 JSON 结构；不把 ID 的内容当成字段名目录。

扩展位是**最后一个已登记字段之后的下一位**。该位为 1 时，最后附一个原 JSON 对象，容纳此结构尚未登记的字段。例如 publicPlayer 的新字段随最后的扩展对象发送。扩展不能覆盖已登记字段，消息根扩展不能覆盖 `t`。所有键都作为自身数据属性恢复，`__proto__` / `constructor` 不影响原型。

字段数量、类型和长度必须依据目录严格解码。不接受未知消息编号 / 数组版本、越界位图、缺值、多值或未知枚举编号。已知枚举位置如果原值不是字符串，用 `[-1, originalValue]` 明确转义，保证调试与结构测试仍可无损恢复；业务校验仍会拒绝非法值。

## 4. 阶段目录

| 编号 | 原字符串 | 编号 | 原字符串 |
|---|---|---|---|
| 0 | LOBBY | 7 | COMBAT |
| 1 | INFO_CHECK | 8 | UNITE |
| 2 | BAND_DRAFT | 9 | SETTLE |
| 3 | BATTLE_CHECK | 10 | FINAL_ASSAULT |
| 4 | ROUND_START | 11 | HIDDEN_CORE |
| 5 | SP_DRAFT | 12 | RESULT |
| 6 | PREP | | |

其他枚举（难度、房间模式、战斗模式、玩家状态、战场类型、机变家族、棋子类型、朝向）同样在 `WIRE_ENUMS` 中按固定下标定义。下面的命令输出**全部消息 ID、全部字段位置、全部嵌套布局与全部枚举**，可直接给维护者或其他 AI 使用，不依赖本文摘录表。

```powershell
node tools/wire.mjs schema
node tools/wire.mjs encode original.jsonl
node tools/wire.mjs decode compact.jsonl
```

工具直接读取 UTF-8 文件（兼容首行 BOM），也可省略文件名或用 `-` 读取标准输入。直接读文件避免旧 PowerShell 将管道文本重新编码成 ASCII/OEM；输出遵循 UTF-8，并等待标准输出背压，不在大文件转换时堆积全部输出。失败会报行号并返回非零状态。输入为解压后的 WebSocket 文本；不会读取房间、连接远程或上传内容。往返比较按 JSON 语义进行，对象键的显示顺序可能改变。

## 5. 协商与重连约定

hello 始终使用原 JSON，并声明 `wire: 1`；服务器先返回原 JSON welcome，确认 `wire: 1` 后才使用紧凑数组。没有 wire 能力的旧页面继续收到原 JSON，新页面连接旧服务器时也继续使用原 JSON。每条连接独立协商，不能把某玩家或全房间的编码设置套用给另一条连接。

业务层允许 JSON 和数组混用；输入数组仍须符合本方向的消息目录，再经过现有 C2S 业务校验。旧客户端、观战、保留结算重放均走同一发送边界。重连重新握手，服务器发送完整视图；不依赖上一次连接留下的增量基线。

客户端遇到无法解码的紧凑帧时，不把残缺对象交给 UI：关闭当前连接、保留身份，重新连接并关闭本页紧凑能力，恢复原 JSON。这条降级路径必须回归测试，不能静默忽略错误后让界面永久停在陈旧状态。

## 6. 压缩、频率与进一步验证

紧凑编码减少 JSON 文本；WebSocket `permessage-deflate` 再压缩这些文本，浏览器自动解压。服务端保留同一连接的压缩上下文以利用相邻完整视图的大量重复，连接关闭即释放；每个客户端有独立上下文，不能共用压缩字节。明文 JSON 的旧客户端也可通过标准 WebSocket 扩展获得压缩。

常规公共视图以 125 ms 合并变动（最高 8 Hz），完整相同状态仍去重；显式强制重同步仍立即发送。用户已在代码调整频率，v0.2.6 合并时核实并补齐文档与断言。完整快照继续保留，不依赖上次业务快照的增量基线。必要的分队/机变响应、个人状态、战斗开场和结算没有统一延迟 125 ms。

v0.2.6 合并保留服务端跨消息字典、32 KiB 窗口与 `SP_WS_DEFLATE=0` 回退，接纳上游连接协商兼容修复及 `/healthz?traffic=1` 统计；窄窗口客户端按实际配置检查并回退到不压缩的连接。上游单人独立压缩参数及其测量不能代替本分支的 20 人测量，取舍见 [合并记录](development/records/2026-10-14-02-upstream-v0.2.6.md)。

当前 WebSocket 压缩参数：服务端保留 15 位窗口（32 KiB 字典），客户端不保留上下文，zlib level 6 / memLevel 7，全局压缩并发上限 4。解压后输入仍限制 64 KiB；现有消息速率、身份、方向校验与发送队列保护保留。压缩上下文包含该连接的全部消息，不可以把一份压缩结果直接复制给其他玩家。

应急开关：启动服务器前设置 `SP_COMPACT_WIRE=0` 可关闭数组协商，设置 `SP_WS_DEFLATE=0` 可关闭 WebSocket 压缩。两者独立；关闭数组仍可压缩原 JSON。开关在进程启动时生效，修改后须重启，重启仍遵守内存房间无法热迁移的现有限制。HTTP 策略见 [HTTP_CACHE](HTTP_CACHE.md)，实际测量与限制见本任务记录。

维护时至少运行 `node --test test/wire-codec.test.js` 和对应网络、房间、匹配与客户端测试。目录覆盖测试会发现新 C2S / S2C 类型漏登记；真实公共视图测试会发现新公共字段只落入扩展位。修改目录不能仅更新截图或说明而跳过往返、协商和重连测试。

完整 v1 目录还用规范化 JSON 的 SHA-256 固定为 `ea41ddd24cfb8234de364c3890560797892705390ac4ac5cf0c5206b320f71de`。规范化只递归排序对象键，数组顺序保持原样；目录指纹测试防止字段、消息及枚举意外改号。另将 2840 组固定样例的编码字节指纹固定在测试中，防止只靠同版本往返测试漏掉算法对旧格式的不兼容修改。新增布局时归档并保留 v1 编解码和测试，再引入新版本；不能只修改指纹让检查通过。新增业务信息在新布局发布前可以继续通过原 JSON / 扩展位传输。

## 7. 实际抓包复测与复现

2026-10-10 用用户的 `game-local.pcap` 重放 82 条物理连接的全部 22,221 条服务器 JSON。主 20 真人房的 7,570 个公共状态副本，保留原消息次数，测得：

| 方案 | WebSocket 字节，十进制 MB | 比旧原 JSON 少 |
|---|---|---|
| 原 JSON | 180.20 | 0% |
| 位置数组，不压缩 | 85.34 | 52.64% |
| 每条原 JSON 独立压缩 | 21.52 | 88.06% |
| 每条位置数组独立压缩 | 17.15 | 90.48% |
| 原 JSON，保留连接字典 | 2.80 | 98.45% |
| **位置数组，保留连接字典（当前设计）** | **1.28** | **99.29%** |

数组在保留字典的压缩基础上仍减少约 54.16%；两者共同有效。全体 WebSocket JSON 从 213.12 MB 降到 2.51 MB。所有消息逐条检查解压、还原后的 JSON 深度相等。**这是同一旧抓包的离线编码对比，没有计入当时 5 Hz 的额外收益，也不包含 HTTP、TCP/IP、TLS 或重传开销；不能当作服务器总出口减少 99%。** 抓包版本为 0.2.2，本地为 0.2.3；当前公共状态已改为 8 Hz，该历史测量没有重新采样为 8 Hz。

`tools/wire-bench.mjs` 接收 JSONL，每行如下；输出只有汇总量，不包含捕获的身份、名称、会话凭证或消息正文：

```json
{"connection":1,"start":0,"end":0.001,"message":{"t":"m.public","phase":"COMBAT","round":11}}
```

```powershell
node tools/wire-bench.mjs capture-out.jsonl --duration 375.02509593963623
node --test test/wire-codec.test.js test/wire-bench.test.js test/wire-network.test.js
node --test test/wire-pressure.test.js
```

可附 `capturePayloadBytes` / `captureWireBytes` 检查旧量。工具按物理连接维护独立字典，包含该连接所有服务器消息，welcome 保持原 JSON；不能只截取公共状态或每阶段重新建字典。`--max-contexts` 默认 256，最多 4096；这是本机研究工具的内存边界。阶段平均速率采用抓包交付时间窗口，可能相互重叠；不足一秒的过渡只报告字节，不推算持续带宽。耗时包含六种方案和语义校验，不代表生产编码 CPU。

压力测试默认四个 20 席位房＋四名观战、全部使用新协议，5 Hz 合成完整状态，同时下载四个大型 JSON；所有连接共享 100000 B/s（0.8 Mbps）测试预算。检查操作延迟、意外关闭、同身份重连和端口释放。它不是 80 名真人实际游玩，不模拟云端 QoS 或公网包开销。可临时设置测试变量 `SP_WIRE_PRESSURE_MIXED=1` 检查过渡期的一半旧 JSON 连接；相同低带宽、很大的完整快照下该场景未通过延迟要求，旧页面应通过现有安全刷新流程更新。普通带宽下新旧连接共存已有单独回归，不能把兼容性等同于相同带宽成本。具体结果和失败条件见任务记录。

## 8. 本局文字聊天的独立消息

文字聊天使用三个明确登记的业务类型，通过既有 v1 未知类型 JSON 回退发送；不添加或重排消息 ID、字段位置与枚举，v1 指纹保持原值。`room.state.chatMatchId` 使用原扩展位；空闲或已结束时为 `null`，运行中为本局独立标识。

| 类型 | 方向 | 内容与用途 |
|---|---|---|
| `room.chat` | C2S | `{matchId, text}`，走正常请求确认；成员身份、姓名与座位不接受客户端指定 |
| `m.chat` | S2C | `{matchId, seq, playerId, name, seat, spectator, text, at}`，全房在线真人与观战者收到单条新增消息 |
| `m.chatState` | S2C | `{matchId, seq, messages}`，开局、观战加入或已有重同步时补发最近至多 200 条；每条只含上述身份、文本、顺序与时间字段 |

`seat` 为从零开始的固定玩家席位，观战者为 `null`；`at` 是服务端毫秒时间。消息 `seq` 在同局内单调递增，客户端按序号去重合并，较早快照可补缺但不能覆盖较晚推送。所有接收与发送都核对当前局标识，前一局的陈旧消息被拒绝。临时断线不重置发送额度或客户端草稿。

每条最多 200 个 Unicode 码点，原始输入最多 400 个 UTF-16 单元并拒绝孤立代理项；NFC 和控制字符处理在共享模块统一执行。单真人平均两秒一条、最多连发三条，全房每秒十条、最多连发二十条；非法文本不进入历史。观战、淘汰或托管真人可发送，AI、离开的成员、外部身份与结算阶段不能发送。

历史只在服务器 `matchCtx.chat` 和独立浏览器 `chatStore` 的 RAM 中存在，最终结算、失败或销毁按生命周期清空。不进入 `m.public` / `m.private`、周期性房间快照、战斗结果、回放、诊断、战绩或磁盘文件；正常消息不会触发额外历史请求。查看面板不请求服务器记录。

维护定向测试：`test/match-chat.test.js`、`test/match-chat-ws.test.js`、`test/ui/match-chat-model.test.js` 以及 `test/wire-codec.test.js`。容量准备和聊天的完整依据见 [DEV-20261011-04](development/records/2026-10-11-04-ready-and-match-chat.md)。

## 9. 状态同步的重复计算（2026-10-26）

`m.state` 的完整快照与补丁格式保持不变。服务端在原有快照 / 补丁弱引用缓存中保存一次 UTF-8 字节数；
每位接收者只计算含自身序号的短消息头，选定完整帧时才拼接完整正文。补丁仍必须严格小于完整帧，
中文、表情与各连接序号的位数均按实际字节计算。连接独立基线、发送成功后提交、重连与慢连接合并规则不变。

客户端在一次 `applyStatePatch` 调用内复用已经复制的对象和数组。同一批操作修改多个玩家或同一棋盘时，
根对象、玩家列表及各修改分支各复制一次；替换操作带入的对象仍须先复制，不能直接修改补丁内容。
复制对象的所有权不跨调用共享，未修改的分支继续引用旧值。后续非法路径仍整体拒绝，既有快照与输入补丁均不改变。

本机 Node 24.19.0、以真实二十席位 `publicView()` 为基础，每席 174 项已安装皮肤选择，完整消息 164,188 B。
重放 120 份快照，每次广播使用新对象，预热后交替执行原 / 新实现各十次：20 接收者中位耗时
460.72 → 143.22 ms；84 接收者 1,281.87 → 134.24 ms。两侧发送文本逐条相同。
这些是消息准备的离线耗时，不包括网络、压缩、服务端其他工作或玩家响应延迟；发送字节未减少，
原 84 连接共享 0.8 Mbps 压力目标仍未解决。

客户端样本来自二十席位 Match 前两轮（1 人 / 19 AI，seed 19，FakeBattle 仅跳过战斗计算），27 份非空补丁、
315 条操作，最多一份 81 条。数组复制从 277 次降到 25 次；桌面及移动视口 Edge 的输出逐条与原实现相同。
每个样本重放 500 次，预热三轮后正反顺序交替各十二次：1280×720 DPR1 的中位耗时
27.70 → 23.80 ms；844×390 DPR2 触屏视口、页面 CPU 4×限速为 118.10 → 102.20 ms。
这减少主线程临时分配及补丁应用开销，不代表整体 FPS 或手机真机性能提高相同比例。

回归入口：`test/state-delta-format.test.js`、`test/state-transport-size.test.js`、`test/state-delta-e2e.test.js`、
`test/network-quality.test.js`、`test/wire-network.test.js` 和 `test/compact-wire.browser.test.js`。
