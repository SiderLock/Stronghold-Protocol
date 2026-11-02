# DEV-20261010-12 · 素材目录改为本地导入与服主预缓存准入

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-10 / 2026-10-11，Asia/Shanghai |
| 状态 | 本地实现与验证完成；未推送、未部署 |
| 类型 | 修复 / 功能 / 网络验证 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`85d3716aca8dcab658641ab9afa83f2ceef46464`，开始时工作区干净 |
| 上游基线 | 已合并 v0.2.3 / `1db8e51023ae6abaec9370beb81a513d5c4d0b01`，本任务仅核对本地，不刷新远程 |
| 提交归属 | 目录阶段 `cb12b9e`；准入、补充回归及最终记录与本文本次同一功能提交，用 `git log -- <本文路径>` 查询；沿用既有分批本地提交授权，不推送 |
| 关联 | D016、D019、D021、D022、D023、D024；I002、I004；DEV-20261010-08、DEV-20261010-09 |

## 需求、范围与验收

用户在新版本线上短、长抓包后要求紧急消除完整素材目录流量。目录不允许在线获取，即使客户端没有导入任何素材；应从 ZIP 内的 `manifest.json` 或独立 JSON 目录导入，再与服务器进行小型摘要校验。预缓存面板与操作不应反复请求完整目录。已有内容缓存尽量保留，目录导入不能声称素材已完整。

新增服主动态配置：是否要求当前素材版本已完整缓存，才允许创建、加入、最快匹配和观战。用户分别确认默认允许、服主手动开启严格限制，以及观战同样限制；已经在对局中的断线续玩保留。客户端启动器明确暂缓。

验收包括：冷浏览器初始化、反复打开面板和执行管理操作均无完整目录网络请求；直接请求旧完整目录接口也只返回小型拒绝；当前完整 ZIP 自带目录可引导导入，独立目录导入及刷新持久复用正常；旧素材和增量导入按当前内容哈希复用；错误、篡改、旧目录和缺项不会得到正常客户端完整准入；服主配置在本机动态生效，创建 / 加入入口由服务器核验，默认模式与断线恢复回归通过。验证使用定向模块、真实 Edge 导入 / 缓存 / WebSocket 短流程；不运行完整 14 回合，不推送或部署。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 目录重复占用 | 用户长抓包 `biglocal.pcap`，研究目录聚合报告；392.102 秒、106 份相同目录，共 73,444,220 B | 已确认；不能在客户端缓存未就绪时回退在线完整目录 |
| 尖峰 | 同抓包本机 100 ms 最大 120.514 Mbps，其中目录约 92%；完整秒最大 26.932 Mbps | 已确认本机突发，不等于公网 200 Mbps 已复现 |
| 在线补齐与其他 HTTP | 补齐 390.764 MB / 80.919%，约 8 Mbps；其他 HTTP 合计 14.632 MB | 目录与补齐分别控制；本任务遵循用户要求优先目录，保留已批准的补齐限流 |
| 现有包内目录 | `tools/asset-cache-pack.mjs` 的 manifest 已含完整文件、别名、SHA 和内容版本 | 已确认；无需重打现有大包即可支持完整包引导 |
| 本地目录持久状态 | SW 已保存完整目录及 per-client pin；页面 `refreshCatalog` 仍取在线完整目录 | 已确认；恢复本地目录且与服务器小摘要校验，保留对局固定版本 |
| 服主开关默认 | 本轮用户结构化回复 | 已确认默认允许，动态开启严格模式 |
| 观战准入范围 | 本轮第二次用户结构化回复 | 已确认创建、加入、最快匹配、观战均限制；不影响已有对局断线恢复 |

## 实现或操作

### 第一阶段：目录线上出口与本地导入

- `server/http/assetCache.js`：旧完整目录 GET / HEAD / 条件 / 压缩请求全部 403，正文仅错误码，拒绝发生在构建目录前。状态接口仅返回摘要和政策；保留固定进程快照、文件允许列表及既有限流。
- `shared/assetCache.js`：规范化 schema 1 条目属性顺序并验证完整内容版本，维持现有 ZIP 哈希；提供目录、摘要和准入报告的纯校验函数，不信任裸 `ready:true`。
- `public/js/assetCache.js`：移除完整目录 URL 和 fetch / 回退；初始化读取 Cache Storage 的既有目录，并请求一次小摘要。面板重开只检查 SW 游玩标志。无目录可导入 JSON / 完整 ZIP，不能直接在线补齐；匹配后 Worker 按实际键扫描进度。
- Worker 在写入素材前限长读取 JSON / ZIP manifest，验证目录，再按当前哈希导入素材。已持有当前目录时允许旧 / 部分 ZIP 复用；错误、篡改、旧目录不升级 pin。SW 保留旧数据结构，并允许直接重连的初始 pin；活动对局仍禁止更换版本。
- 预缓存界面提供「导入目录 JSON」，冷浏览器显示需要目录，在线补齐和完整校验在当前目录就绪后启用。四个翻译包补齐。
- `tools/asset-cache-pack.mjs --catalog-only` 独立导出与完整包相同的 JSON，原子发布、拒绝覆盖，不重做大 ZIP，不上传。

### 第二阶段：服主准入

- `server/serverSettings.js` / `tools/server-settings.mjs`：私有 version 1 配置新增 `requireAssetCache`；默认 false、旧 AI-only 文件 false。`asset-cache required / optional` 原子更新并持久保存，运行中约一秒应用；更新 AI 或缓存要求各自保留另一字段。损坏配置保持最近有效值，部分命令拒绝丢弃另一政策；启动默认值支持 `SP_REQUIRE_ASSET_CACHE`。
- `server/index.js` / `server/lobby.js` / `server/lobbyDiscovery.js`：共享 HTTP 摘要快照。严格启动先预热，动态开启时在预热完成前拒绝新进入；创建、加入、最快匹配、观战均同步检查且先于成员移除。最快匹配转入 join 继续携带报告。无报告、旧版本、部分数量、服务器缺项和空数据不能满足严格要求；已经拒绝的动作不会稍后异步执行。
- 保留已有成员和开局，以及玩家 / 观战者凭原令牌 hello / 重连续玩。同房同角色重同步保留；观战转玩家是新准入。只切换准入不会踢人或结束对局。Network/Lobby 的同步处理接口保持原样。
- `public/js/net.js` / `public/js/assetCache.js`：四种新进入请求在发送前更新小摘要、扫描实际 SHA 缓存键、按目录条目计算逻辑文件数和原始字节数。异步本地扫描完成后才启动原 WebSocket 请求计时；hello、准备、玩法及断线恢复不扫描。能力 / 存储错误在客户端返回无报告，默认模式可用，严格模式由服务器拒绝。
- `shared/protocol.js`：可选 `assetCache: {schema,version,readyFiles,readyBytes}`；`welcome` / `lobby.state` 带政策，新增四语言 `ASSET_CACHE_REQUIRED` 提示。所有新信息使用 v1 既有扩展对象，未改 `wireSchema.js`、协议布局、枚举编号或指纹；覆盖测试显式登记四项扩展，往返仍还原原 JSON。
- 数量报告是普通客户端的带宽准入管理约定，导入 / 深校验实际 SHA、进入前扫描键；它不能独立证明远端浏览器未被用户修改。相同 SHA 去重存储，但逻辑数量仍按每个目录文件条目累计，alias 不另计。

## 验证

| 检查 | 实际结果 |
|---|---|
| Node 定向模块 | `node --test test/asset-cache-shared.test.js test/asset-cache-catalog.test.js test/asset-cache-pack.test.js test/asset-cache-http.test.js test/asset-cache-manager.test.js test/asset-cache-sw.test.js`，61 项全部通过；含 50 个并发旧目录拒绝、构建次数为零、目录校验、缓存复用及生命周期 |
| Edge 真实缓存 | `SP_E2E=1 node --test test/asset-cache.browser.test.js test/asset-cache-ui.browser.test.js`：缓存文件对应 5 个场景全部通过，UI 首次超时见下；覆盖 JSON / 完整 ZIP 引导、旧部分 ZIP、音频 alias / Range、刷新 / 升级、跨标签、无目录 / 旧目录 / 错误重试；完整目录 HTTP 请求均零 |
| Edge 主界面 | 与缓存套件同时运行时首次导航等待 networkidle0 超时；改为 DOM 加载并等待具体 UI / 缓存状态后单独重测 `test/asset-cache-ui.browser.test.js`，1 项通过（3828×1931 / 1920×1080 / 1280×720，持久保存结果及本地目录按钮）。这是测试就绪判断调整，不宣称第一次通过 |
| 四语言严格检查 | `node tools/i18n.mjs check --all --strict`，每包 1316 个已用 msgid，0 missing / 0 errors |
| 类型与定向 ESLint | `tsc --noEmit --checkJs -p jsconfig.json` 和本次缓存 / 工具 / 测试相关文件 ESLint 均通过 |
| 文档与冷启动统计补充回归 | `node --test test/asset-cache-manager.test.js test/docs-consistency.test.js test/docs-paths.test.js`，46 项全部通过；`git diff --check` 通过 |
| 导入边界扫描 | `node tools/check-imports.mjs` 默认非 strict 返回 0，但报告 `server/sim/nodeData.js:11–13` 的 3 个 `sim-node` 违例；该文件及检查器与开始 `85d3716` 无差异，属既有 Node-only 加载器报告，本任务无新增违例。未将此报告称为完整通过或修改无关边界规则 |
| 当前真实包目录兼容 | `node tools/asset-cache-pack.mjs --catalog-only` 生成 4,585,419 B JSON；定向读取现有「素材包dd40447a61c1.zip」的 manifest（仅读取约 2.02 MB ZIP）后逐项相等，浏览器共享验证器确认内容版本及 12,562 文件 / 648,096,514 B |
| 配置与准入定向回归 | `node --test test/server-settings.test.js test/asset-cache-admission.test.js test/lobby-discovery.test.js test/docs-consistency.test.js test/docs-paths.test.js`，78 项通过；含 15 配置、12 真实 HTTP / WebSocket 准入、20 大厅及 31 文档。覆盖默认四入口、旧 JSON / v1、动态开启摘要准备、拒绝不换房、客户端扫描失败、实际 Match 玩家及观战断线恢复 |
| 平台 / 客户端 / 网络回归 | `node --test test/asset-cache-shared.test.js test/asset-cache-http.test.js test/asset-cache-manager.test.js test/wire-codec.test.js test/wire-network.test.js test/client-static.test.js test/client-identity-handshake.test.js test/client-identity-session.test.js test/lobby.test.js`：首次 500 项中 499 通过，唯一失败是旧字段覆盖检查要求新准入字段占 v1 位置。按 D021 登记四项可选扩展白名单后，仅重跑 wire-codec 13 项全部通过；未修改 v1 指纹。20 物理连接＋观战回归记录压缩 536,373 B / 原 JSON 27,610,800 B；这不是新一次线上实战带宽测量 |
| Edge 严格准入与界面 | `SP_E2E=1 node --test --test-name-pattern="strict admission follows" test/asset-cache-admission.browser.test.js`，1 项通过；真实 UI JSON / ZIP 导入、四入口缺缓存拒绝 / 满缓存放行、缓存清理、动态默认切换、断线恢复、刷新复用。5 次实际关闭 / 重开面板＋15 次相同初始化没有新增摘要请求；完整目录与补齐请求均零；1920×1080 / 1280×720 无横向溢出，实际截图复查 |
| Edge 当前真实整包 | `SP_REAL_ASSET_E2E=1 SP_ASSET_E2E_PACK="<现有素材包dd40447a61c1.zip>" node --test --test-name-pattern="existing real full ZIP" test/asset-cache-admission.browser.test.js`，1 项通过。实际本地 481.97 MiB ZIP，12562 目录条目、648096514 B；新存 12444 / 复用 118 / 不适用 0 / 失败 0，导入并完成收尾 57698 ms，整项 78782.862 ms。严格创建成功；20 个分散素材 SHA / 大小抽样均正确，源站普通素材请求没有增加；刷新后完整准入仍正确，完整目录请求 0、在线补齐 0 |
| 第二阶段语言 / 类型 / lint | 四包严格检查 1317 个已用 msgid，0 missing / 0 errors；checkJs 通过；第二阶段相关文件 ESLint 0 errors，2 条警告来自未改动的 hello token / match seed 赋值，未作无关修整 |
| 最终补充及文档范围 | 增补同房观战转玩家、空数据 0/0 拒绝后，`node --test test/asset-cache-admission.test.js test/asset-cache-shared.test.js test/docs-consistency.test.js test/docs-paths.test.js` 51 项通过；Edge 严格短流程复跑 1 项通过。10 份相关文档的 187 个本地链接及 D023 / D024 / 准入新锚点核验，`git diff --check` 通过；链接检查忽略代码块和行内示例，不将示意公告图片路径当实际文件 |

Node v24.21.0，Edge 155.0.4283.45 无头浏览器，Windows。新 Edge 测试前两次被本机已有自动公告遮挡代号入口，诊断后为测试隔离公告目录，通过；没有修改用户私人公告。真实整包首次仅等待数量满时仍处于 import/prune 收尾，准入返回 null，改为等待实际 `phase=ready` 后重测通过；未将首次尝试记为通过。目录封禁阶段的 UI 网络空闲超时另见上表。

既有抓包是调查依据，不冒充新实现线上效果。未运行完整 14 回合、golden、真实多人线上压测或全量 CI。Edge、测试服务器 / WebSocket / 动态配置轮询均在 finally / after 关闭；两个新增 Edge 报告均确认浏览器和监听服务器已关闭。结束前进程核对无本次 Node 测试或 Puppeteer Edge 残留；沙箱 WMI 查询被拒，授权后的同一只读查询返回空。ignored 报告在 `.cache/asset-cache-admission-ui/`，关键结果已写入本文，报告被清理也可按测试文件复现。

本地独立目录：`.cache/asset-cache-pack/Stronghold-Protocol-catalog-dd40447a61c1.json`，4.37 MiB，SHA-256 `046836292b8ef9adc7af57117204ba4555849cde46e7bdd0575fe96ac32de566`。内容版本 `dd40447a61c10c9d655907a5ce237cec8e2a5f485a5de202a5854c3f85bad0a9`；与已分发完整包一致，不需要重做大 ZIP。生成物为 Git 忽略内容，未上传。

## 结果、遗留与接手

- 实现结果：目录线上封禁、本地 JSON / 完整 ZIP 引导与持久复用、四入口动态严格准入均本地完成；默认允许。当前真实整包已通过 Edge SHA 导入 / 复用 / 刷新及准入；现有大包可继续分发，独立目录已就绪。
- 遗留：上线后的生产素材完整度、HTTPS、80–100 真人带宽、掉线峰值需部署后核验；目录流量归零不意味着页面、正常素材、WebSocket 或既有 8 Mbps 在线补齐消失。当前 Windows 便携包不含本任务源码，若分发服务器整合包须另做更新；启动器按用户要求暂缓。
- 提交 / 远程 / 素材 / 线上：目录 `cb12b9e`；准入和最终记录为另一功能提交；无远程操作，远程 master 不动；现有素材与 ZIP 未修改；未部署。
- 接手入口：`server/http/assetCache.js`、`public/js/assetCache.js`、`public/js/asset-cache-worker.js`、`public/asset-cache-sw.js`、`server/serverSettings.js`、`server/lobby.js`、本文。

## 后续补充

服主在对应服务器安装目录执行 `node tools/server-settings.mjs asset-cache required` 开启；`asset-cache optional` 关闭；`show --json` 查看同目录持久值。参见 [SERVER_SETTINGS](../../SERVER_SETTINGS.md#完整预缓存准入)。目录必须通过外部渠道提供，不能将导出的 4.37 MiB JSON 放到游戏站点重新制造目录下载流量。
