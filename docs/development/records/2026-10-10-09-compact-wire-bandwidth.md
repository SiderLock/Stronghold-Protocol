# DEV-20261010-09 · 紧凑网络协议与多人带宽优化

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-10 / 2026-10-10，Asia/Shanghai |
| 状态 | 已完成本地实现与定向验证；独立测试分支保留，未推送或部署，线上真人并发仍待验证 |
| 类型 | 性能优化、协议架构、调查与验证 |
| 本地执行环境 | Windows 11 / PowerShell；Node.js v24.21.0，Python 3.12.10，Edge 155.0.4283.45 |
| 分支与开始 HEAD | 从核心 `feat/IncreasePlayerCapacity` 的 `cf30fb2980fe27363dcafdfb677317f80c503b49` 创建 `perf/compact-wire-bandwidth`；开始工作区干净 |
| 上游基线 | 本地已合并 v0.2.3，`1db8e51023ae6abaec9370beb81a513d5c4d0b01`；本任务未联网刷新远程 |
| 提交归属 | 目录 `721081b`；网络 `ec9084c`；HTTP `70978fd`；测量工具、深入回归与最终记录同一提交，按记录路径查询 |
| 关联 | 多人压力待办 I002；素材缓存决定 D016；协议决定 D021 与 [WIRE_PROTOCOL](../../WIRE_PROTOCOL.md) |

## 需求、范围与验收

用户完整授权在新测试分支开发位置数组、消息类型与阶段枚举协议，降低公共状态最高发送频率至约 5 Hz，实施压缩以及稳定的页面代码 / 数据优化；允许进一步研究和深入测试。保留原 JSON 的业务语义，维护完整协议说明和恢复工具，不改变玩法、卡池、联防或战斗结果。沿用已授权的分批本地提交；不推送、不合并回核心分支、不部署。

验收包括：编码后能无损恢复标准 JSON；新旧客户端和重连安全；公共视图各阶段、私有消息、房间 / 大厅、战斗报告正常；常规公共广播不超过 5 Hz，必要的阶段切换和重同步立即送达；用可复现测量比较原 JSON、紧凑协议和实际压缩流量；检查 HTTP 缓存、压缩、并发和削峰边界；执行有针对性的回归及 Edge 短流程，记录测试限制并释放本次资源。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 公共状态是主要带宽来源 | 用户提供的明文 `game-local.pcap`，分析输出位于项目外的 `../网络报文研究/分析结果/` | 抓包全体 `m.public` 约 198.67 MB，占 TCP 下行 56.95%；主房间约 180.16 MB 原 JSON。该抓包在线版本为 0.2.2，不等于本次本地 0.2.3；已确认 |
| 微小变动重发重型字段 | 主房间战斗阶段 219 次相邻视图比较，218 次羁绊未变、178 次玩家数组未变；当前 `messaging.js` 去重只比较完整对象 | 需要同时减少字段名、利用跨消息重复及合并发送；已确认 |
| 压缩被显式禁用 | `server/http/websocket.js` 的 `perMessageDeflate: false` | 浏览器与服务器没有协商 WebSocket 压缩；已确认 |
| 常规公共广播上限 | `server/match/match/common.js` 的 `DELAYS.PUBLIC_THROTTLE` 与 `messaging.js` | 原设计最短 100 ms；已改为 200 ms，保留关键强制路径与完整快照去重；虚拟时钟定向验证通过 |
| 页面代码 / 数据峰值 | 抓包代码 / 数据约 27.78 MB，峰值秒约 15.74 Mbps；原实现已有 gzip 和条件请求 | 已按真实内容固定完整公开依赖图，并实施 Brotli / 原生缓存复用；首次冷下载仍竞争出口 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `git switch -c perf/compact-wire-bandwidth` | 在当前核心 HEAD 创建测试分支，未触及远程 | 满足隔离测试要求，保留核心分支作为回退点 |
| `shared/wireSchema.js`、`shared/wireCodec.js` | 建立独立 v1 位置表：全部 21 种 S2C、50 种 C2S、9 组枚举及嵌套记录；存在位图与扩展位保持字段语义 | 可无损恢复原 JSON，未知字段不静默丢弃，编号不会跟着业务验证器遍历顺序漂移 |
| `tools/wire.mjs`、`docs/WIRE_PROTOCOL.md` | UTF-8 JSONL 编解码与完整目录导出；支持直接读 UTF-8 文件和标准输出背压；目录指纹固定 v1 约定 | 后续维护者可还原抓包文本，避免旧 PowerShell 管道乱码或不兼容改号；位置目录以代码为唯一来源 |
| `server/net.js`、`server/lobby.js`、`public/js/net.js` | 每条物理连接独立协商；一次广播只生成一次原 JSON / 紧凑文本；旧格式存储的结果仍通过协商边界重放；异常解码重连并退回 JSON | 新旧客户端、观战和持久身份共存；界面只接收还原后的业务对象 |
| `server/http/websocket.js` | permessage-deflate，服务端保留 32 KiB 字典、客户端不保留，level 6 / memLevel 7、并发 4；SP_WS_DEFLATE 应急关闭 | 浏览器原生解压，利用跨消息重复；压缩工作与解压后输入有边界 |
| `server/match/match/common.js` | 公共状态常规节流 200 ms，原有强制同步与去重保留 | 降至最高 5 Hz，不降低模拟步长或个人操作响应频率 |
| `server/http/runtimeCache.js`、`static.js`、`public/js/runtime.js` | 内容 SHA-256 地址及完整 import map，数据 / 经典脚本使用相同版本目录；拒绝过期 rv，缓存有界 | 让二次访问复用整个依赖图，按文件独立失效；不只缓存入口，避免混版 |
| `server/http/files.js`、`assetCache.js` | 异步 Brotli / gzip 协商，变体 ETag、并发 2、压缩 LRU；素材目录去掉同步 gzip；旧代码 ?v 不再被误标一年 immutable | 减少正文和事件循环阻塞，保留 HEAD / 304 / Range 及素材填充规则 |
| `docs/HTTP_CACHE.md`、D022、buildTag vendor 覆盖 | 说明图版本、缓存失效、重启、原生模块 / Worker 边界、回退和验证 | 后续维护者能正确增加依赖和部署更新；首次冷访问仍会使用带宽 |
| `tools/wire-bench.mjs`、研究目录 `export_wire_optimization.py` | 逐物理连接重放全部服务器 JSON，比较六种编码/压缩模式，逐条检查语义与解压；项目内工具只输出汇总 | 避免每个阶段重置字典、只测公共消息、预先假定 5 Hz 节省量等误差；原抓包不修改 |
| `test/helpers/bandwidthProxy.js`、`test/wire-pressure.test.js` | 测试专用共享出口预算，四房 84 真实连接、冷 HTTP、独立 5 Hz 发布与操作探测；处理限速队列后再转发 HTTP FIN | 检查低带宽下的响应、原身份恢复和清理；桥接器不加入生产路径，不冒充公网 QoS |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| 基线检查 | Windows，Git 分支 / HEAD / status / remotes，项目级 AGENTS 与开发规范 | 核实核心 HEAD 和干净工作区，读取现有规范 |
| `node --test test/wire-codec.test.js` | 当前 v0.2.3，Windows Node；覆盖 2840 种结构组合、1–20 席位真实视图、UTF-8 CLI、异常和原型边界 | 8 项通过；网络接入仍待后续阶段 |
| `node --test test/docs-paths.test.js test/docs-consistency.test.js` | 协议模块第一阶段 | 31 项通过 |
| `tsc --noEmit --checkJs -p jsconfig.json`、新模块 ESLint 与 `git diff --check` | 协议模块第一阶段 | 初次类型检查暴露推断问题，补充元组与输出数组类型后复验；全部通过 |
| `node --test test/wire-network.test.js` | 20 独立实际 WebSocket 玩家连接＋1 观战，新数组 / 旧 JSON 各 10 玩家；40 次代表性完整视图，非真实 20 人游玩 | 8 项通过；原 JSON 总计 27,610,800 B，实际压缩网络数据 536,011 B（含 WebSocket 帧），此场景减少约 98.06%；5 Hz、异常降级、RATE rid、解压后 64 KiB 限制通过 |
| `node --test test/match/realtime.test.js` | 真实双客户端（数组 / JSON 混用）＋2 AI，运行到第 4 回合休整；Windows Node | 1 项通过，约 25 s；未跑完整 14 回合 |
| 网络、房间与身份定向批次 | lobby / lobby-discovery / room-management / client-static / client-identity-handshake / client-identity-session / lobby-capacity / setup-reroll-ws；日志保留 `.cache/compact-wire/network-regression.log` | 475 项通过，0 失败；包含掉线保留、重连及旧 JSON 结算重放 |
| 协议 / 网络 / 文档合并复验，类型检查及相关文件 ESLint | 网络阶段提交前，补齐真实战斗输入/结果的嵌套目录；`.cache/compact-wire/wire-stage.log` | 47 项通过，类型检查通过；ESLint 0 错误，2 条原有 no-useless-assignment 警告（net.js token / lobby.js seed） |
| HTTP / 客户端定向批次 | runtime-http / asset-cache-http / data / assets / assets-diy / runner / runner-pending / buildGuard / build；`.cache/compact-wire/http-client-regression.log` | 156 项：154 通过、2 跳过、0 失败；跳过原因均为没有 `.cache/gamedata` 原始表（独立重推导与离线数据重建）；首次检查修正了小目录压缩阈值与错误响应缓存断言，修正后通过 |
| `SP_E2E=1 node --test test/compact-wire.browser.test.js` | Edge 155.0.4283.45；1920×1080 / 1280×720；真实 UI＋19 独立 WS 客户端，混合编码，首回合休整；`.cache/compact-wire/edge-1791631495441/report.json` | 1 项通过（约 11 s）；449 资源首次 2,855,933 B、再次正文 0 B，447 个 Brotli 响应；模拟数据实例身份一致，60 个数组帧，JSON 降级同身份恢复；截图人工检查通过，无页面异常，浏览器 / 客户端 / 端口均释放。首次运行仅因测试误用 .game-screen 选择器失败，改用实际 canvas 后复验 |
| 相关 ESLint 与导入扫描 | HTTP、客户端、Edge 新测试 | 新文件 0 错误 / 0 警告；触及旧文件有 5 条原有无用赋值警告；导入扫描仍列出私有 nodeData 的 3 个已知 Node 内建依赖，无新增违规，HTTP 私有边界测试通过 |
| HTTP 阶段最终复验 | lobby / runtime-http / asset-cache-http / static-local-art / simServe / build / docs-paths / docs-consistency；`.cache/compact-wire/http-final.log` | 131 项通过，0 跳过、0 失败；任意旧 v 查询不再把代码/数据标为 immutable，素材 v 策略仍通过回归；git diff --check 通过 |
| 抓包逐连接导出和真实数据重放 | 82 条连接，375.02509593963623 s，22,221 条 S2C JSON；`../网络报文研究/优化验证/compact-wire-benchmark.json` | 全部编码、还原深度相等与逐条解压校验通过；原 JSON 总字节量与抓包一致；主房公共 WS 180,195,108 B → 1,281,896 B（−99.29%），位置数组单独 −52.64%；未计 5 Hz 的额外收益 |
| 当前版本阶段定向回归 | `node --test test/wire-codec.test.js test/wire-bench.test.js test/match/group-unite-rounds.test.js test/match/group-drafts.test.js test/match/upstream-v023-capacity.test.js test/match/boss-hp-scaling.test.js`；`.cache/compact-wire/deep-phase-regression.log` | 最终 72 项通过，0 失败/跳过；覆盖四类 20 席位机变、五轮联防客户端报告、领袖/隐藏核心退出与重连、结算、UTF-8 文件 CLI 与完整目录指纹。领袖夹具直接从 R1 跳到目标阶段，没有完整长流程 |
| 四房受限链路 | 80 玩家连接＋4 观战，全部数组；每房 40 次 5 Hz 合成丰富状态；同时下载 chess/backups/assets/enemies JSON；应用字节共享 0.8 Mbps；`.cache/compact-wire/pressure-report.json` | 通过：估计原 JSON 149,943,360 B → 实际 WS 713,729 B；672 次 ping，p95 1353.88 ms，最大 1758.90 ms；无意外断连，同身份/席位和私有状态恢复；客户端、代理、服务器及端口释放。Node 客户端和服务器同进程，ws 全局并发按生产参数 4 初始化；不是 80 真人游戏/阿里云压测 |
| 最终文档、版本、类型与静态检查 | docs-paths / docs-consistency / version；`.cache/compact-wire/final-docs.log`；`tsc --noEmit --checkJs -p jsconfig.json`；只对本任务变动 JS/MJS 执行 ESLint | 37 项通过，类型检查通过；ESLint 0 错误、9 个既有警告（7 个旧业务赋值、2 个旧测试代码）；新增编解码、HTTP 辅助、工具和测试没有警告。文档索引表格式及链接、Git 差异范围复核 |
| 收尾工具与协议契约复验 | `.cache/compact-wire/final-confirmation.log`：上述阶段/工具 72 项＋文档/版本 37 项；UTF-8 BOM 文件、目录及固定 2840 组编码字节指纹 | 109 项通过，0 失败/跳过；捕获源 SHA-256 未变；新工具/测试 ESLint 无错误/警告；仅已授权测试分支和忽略目录有本次改动 |

不自动进行从开局到第 14 回合结束的完整长流程；各阶段采用定向状态机测试和短浏览器流程。生产链路与真实多机真人压测需要部署环境，不能将本机检查写成线上验证。

## 结果、遗留与接手

- 实现结果：独立分支、完整可逆 v1 目录、协商与标准压缩及 5 Hz、HTTP 内容缓存 / Brotli、还原与测量工具已完成；抓包 22,221 条往返、当前版本阶段回归、Edge 及四房新协议受限链路通过。
- 未确定或未完成：服务器真实多人、多房间及首次下载的出口 / CPU / 内存表现仍需部署后测量；未增加全局 HTTP 字节调度或公网 QoS。旧 JSON 大快照在极低带宽下的性能边界见后文，不能承诺 1 Mbps 时所有场景零卡顿。
- 提交 / 远程 / 素材 / 线上：`721081b`、`ec9084c`、`70978fd` 与最终工具/验证提交按功能划分；核心分支仍是 `cf30fb2980fe27363dcafdfb677317f80c503b49`，本任务未操作远程、素材或部署，不合并回核心。
- 接手入口：`shared/protocol.js`、`server/net.js`、`public/js/net.js`、`server/lobby.js`、`server/match/match/messaging.js`、`server/http/`。

## 后续补充

### 抓包复测证据及解释

原文件 `../网络报文研究/game-local.pcap` 为 368,465,781 B，SHA-256 `53b182c5530c4e2a46f9c91910ce88458616181eaf78870afe0ec1aa89074d4c`；结束前复核未变。研究脚本复用已有 TCP 序号重组 / HTTP / WebSocket 解析器，导出每条连接全部服务器 JSON 到 `优化验证/capture-out.jsonl`，附导出元数据；导出包含原捕获内容，留在研究目录，不进项目 Git。项目测量工具输出只有统计。

复现：在研究目录运行 `node ../Stronghold-Protocol/tools/wire-bench.mjs 优化验证/capture-out.jsonl --duration 375.02509593963623`。输入模式、字典边界、输出含义和测试命令见 [WIRE_PROTOCOL](../../WIRE_PROTOCOL.md#7-实际抓包复测与复现)。本次处理约 17.80 s，包含六种压缩/编码方案及往返校验，不能作为生产 CPU 占用。

| 数据范围 / 方案 | WS 字节（包含帧头） | 比相同原 JSON 少 |
|---|---|---|
| 主 20 真人房，原 JSON | 180,195,108 | 0% |
| 主房，位置数组无压缩 | 85,336,358 | 52.64% |
| 主房，每条原 JSON 独立 deflate | 21,516,488 | 88.06% |
| 主房，每条数组独立 deflate | 17,149,012 | 90.48% |
| 主房，原 JSON 保留连接字典 | 2,796,652 | 98.45% |
| 主房，数组保留连接字典 | 1,281,896 | 99.29% |
| 全部房间/连接 JSON 原文 | 213,117,774 | 0% |
| 全部房间/连接数组保留字典 | 2,511,511 | 98.82% |

主房 R11 COMBAT 在抓包交付窗口约 101.27 s 内，公共状态从约 8.714 Mbps 降到 0.0571 Mbps；它是对相同内容/次数的离线计算，不是新服务器已实测的出口。HTTP、TCP/IP/TLS、重传、源抓包前的字典历史均未计入；5 Hz 没有重采样或重复计收益。阶段交付窗口可能重叠，SETTLE/ROUND_START 的亚秒过渡平均速率已设为空，避免把几个瞬间包推算成持续巨峰。

### 未通过的压力场景与校正

初版受限测试混用一半旧 JSON。默认请求期限 2 s 先发生超时；提高观测期限后记录 p95 约 3.64 s，超过预设 2 s 要求。检查发现探测等待会阻塞测试发布者，随后制造追赶突发；改成独立探测，保持 5 Hz 发布不受探测回复影响。测试桥接器同时修正上游 HTTP FIN 提前销毁待发队列的问题，并用 Connection: close 的冷下载覆盖，避免测试基础设施截断响应。

随后以相同发布器/预算及 ws 并发 4 单独检查过渡期混合连接（测试变量 `SP_WIRE_PRESSURE_MIXED=1`）。一半旧 JSON 连接、每条原快照约 44.6 KB、4 房和冷 HTTP 的极低带宽场景仍未通过：最终快照没有在 8 s 等待期限内送达，已完成的 434 次探测 p95 约 7445.93 ms、最大 7976.82 ms；因为还有超时请求，这不是全部 672 次的最终分布。测试终止前代理待发峰值约 2.01 MB，未观测到意外连接关闭；所有资源最终释放。大旧文本超过 32 KiB 字典窗口，保留字典不能提供与数组相同的压缩效率。日志及失败报告保留 `.cache/compact-wire/pressure-mixed-test.log` / `pressure-mixed-report.json`；它是有意深入的性能边界检查，未改成宽松断言冒充通过。正常带宽的 20 玩家数组/JSON 混房、观战和恢复回归已通过。

最终默认全部新协议的四房受限测试通过，包含独立协商、生产 ws 并发参数、HTTP 完整正文、672 次控制回复及同身份重连。这里模拟的是共享应用字节瓶颈，公平轮转不等于阿里云内核/QoS，且同进程 Node 测试客户端也占 CPU。上线前后让旧页面沿用安全阶段更新、另抓真实公网/本机明文流量；不能把这组结果宣传为旧页面或 1 Mbps 出口永不延迟。

### 最终维护约定

保留本任务的 v1 目录指纹，不重排已发布位置。业务字段仍使用标准 JSON，只有网络边界处理数组；恢复、测量、回退命令集中在 [WIRE_PROTOCOL](../../WIRE_PROTOCOL.md) 和 [HTTP_CACHE](../../HTTP_CACHE.md)。后续性能研究先比较真实消息量、连接数和缓存命中；压缩 / 内容寻址本地完成、核心合并、远端推送与服务器部署是四件不同的事。

### 2026-10-10 · 后续核心合并

用户随后授权将本任务成果合并回核心，明确要求非快进合并并保留优化分支。四个功能提交完整接纳，`perf/compact-wire-bandwidth` 保留在 `dbe724995aca08b0fe18f5c8b4ad90f00bc2e466`；合并记录、验证和远程边界见 [DEV-20261010-10](2026-10-10-10-merge-compact-wire.md)。本文原有“未核心合并”等描述保留为本任务结束时的历史状态。
