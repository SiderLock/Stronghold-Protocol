# DEV-20261014-03 · 旧预缓存目录更新与清理后恢复

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-14 / 2026-10-14，Asia/Shanghai |
| 状态 | 已完成：兼容修复、5 秒冷却、定向 Node / Edge 验证与资源释放完成；未推送或部署 |
| 类型 | 调查 / 修复 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`bc4ee0c64c4cb293a8875509f55c7e0546808354`；工作区初始干净 |
| 上游基线 | v0.2.6，`488db49f11daf862b67ce26fa4cf89aa6cba2466`，沿用上次已核实来源；本次不拉取 |
| 提交归属 | 代码与本文同一功能提交，按本文路径的 Git 历史查询 |
| 关联 | D016、D025、D031、[D038](../DECISIONS.md#d038)；[目录手动更新](2026-10-11-02-manual-catalog-update.md)、[冷浏览器在线获取](2026-10-12-01-asset-admission-limit-mlyss.md)、[v0.2.6 合并](2026-10-14-02-upstream-v0.2.6.md) |

## 需求、范围与验收

用户报告：普通 Edge 窗口保留旧素材缓存时，点击在线更新目录仅显示等待 30 秒，等待后仍失败；使用游戏预缓存面板的「清理本地缓存」后，在线更新目录入口消失，在线补齐也未恢复；无痕窗口的目录与在线补齐似乎正常。用户询问是否与 localhost 有关，以及 30 秒等待的来源和能否调整。

范围仅为素材预缓存的跨版本 Service Worker、显式目录获取、清理后的恢复路径和冷却反馈；保持常规初始化 / 检查 / 准入不自动下载完整目录，保留对局目录固定及跨标签游玩锁。按功能修复并定向测试，Edge 使用独立测试缓存和短流程；不清理用户浏览器资料、不运行完整对局，不推送、打包或部署。用户确认冷却由 30 秒缩短至 5 秒；另说明本机 3000 由其测试服务占用，允许后续直接在工作区测试。本次全程在项目工作区运行，浏览器服务使用随机端口，未停止或修改其 3000 服务。

验收：旧缓存无需删除即可取得并使用新目录；游戏内清理后可显式取得新目录并在线补齐；显示实际故障而非把所有失败归因于冷却；缓存升级不绕过对局互斥；测试资源结束后释放。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 30 秒来源 | `server/http/assetCache.js` 的 `UPDATE_COOLDOWN_MS`，客户端 `fetchCatalogUpdate` 请求前无条件设置 `catalogUpdateRetryAt` | 已确认：本分支防连续请求策略，非 localhost 限制；客户端尚未成功下载也会显示等待 |
| 游戏内清理的效果 | SW `ASSET_CACHE_CLEAR` 仅删除素材正文缓存，保留目录元数据；更新按钮要求非空缓存，补齐旧目录时拒绝 | 已确认源码缺口：旧目录且实际缓存为零会失去目录获取入口，无法靠补齐恢复 |
| 普通与无痕的差异 | 本次新目录有 6,352 项音频含 17 条别名；合并前校验器上限 16，当前上限 32；旧 SW 会等待旧页面关闭，新页面的 PIN 仍优先发给旧 controller | 已确认兼容缺口：Edge 独立旧 SW 场景使用合并基线 manager 时报 `ASSET_CACHE_BAD_CATALOG`，修复后同场景通过；未读取用户实际 profile，不能声称已核实其当时 controller |
| 冷却策略 | 用户在异步选择中明确选择「缩短为 5 秒」 | 已确认：服务端旧目录接口保留防连点并缩短至 5 秒；客户端仅实际 429 使用服务器剩余等待，不对所有错误强制倒计时 |
| 升级时用户暂停或进入对局 | 代码复审发现安装等待期间可能收到 pause / destroy / PLAYING；安装完成后仍发 ACTIVATE | 已修正并回归：激活前检查 job 暂停及跨标签游玩状态；等待中的 SW 重新读取现役组件写入的持久 pin |

复现和接手步骤：以当前 `test/asset-cache.browser.test.js` 的 `legacy:true` 小素材 fixture 安装不支持能力协议、上限 16 别名的旧 SW，写入旧目录与 3 个经过哈希校验的素材；切换服务端至当前目录（音频 17 别名）和新 SW，保留两个普通标签。基线 manager 的显式更新下载成功后在 PIN 时报错；修复版本先安全升级组件，更新目录并复用原正文。测试 fixture 固定旧能力边界，不依赖未来本地保留 Git 历史。

普通初始化、重新打开、检查和准入仍不下载完整目录。原有 30 秒小摘要复用时间与目录更新冷却是两个不同用途，本次没有把摘要复用改为 5 秒。

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `shared/assetCache.js`、`public/asset-cache-sw.js` | 独立 SW 协调协议及能力消息；显式 ACTIVATE 重新读取全部 live pin，仅无对局时 skipWaiting；保留目录 / pin / 正文 | 旧页面存在时自然更新会等待，不能让新页面把超出旧校验能力的目录发给旧组件 |
| `public/js/assetCache.js` | 显式维护前等待安装、激活和 controller 切换；暂停、销毁、进入对局阻止激活；新目录验证失败保留旧内容 | 处理浏览器跨版本生命周期，避免无条件抢占仍在游玩的标签 |
| `acquireCurrentCatalog`、`downloadMissing` | 重扫旧缓存后选择有缓存的更新接口或空缓存的冷目录接口；明确补齐可先取得当前目录；普通扫描保持仅摘要 | 修复清理后保留旧目录而无法恢复的死路，不伪造非空报告 |
| 客户端目录传输与 `server/http/assetCache.js` | 删除请求前统一 30 秒客户端等待；仅 429 按实际 Retry-After 倒计时；服务端旧目录更新改为 5 秒/IP | 显示真实故障，按用户选择缩短等待，保留取消后的服务端冷却及限速保护 |
| `public/js/ui/assetCache.js` 与四语言包 | 空旧目录显示在线获取，旧完整缓存也可明确补齐；组件升级失败给出关闭全部本站标签重开的指引 | 不要求用户清空素材解决组件升级问题；中文仍作为源字符串 |
| 定向 Node、SW、Edge 测试及固定 legacy fixture | 覆盖跨版本升级、旧 pin 保留、游玩 / 暂停互斥、清理后恢复、真实短 / 长 Retry-After 和 5 秒/IP HTTP 限制 | 原 stub 永远回成功，未覆盖旧 SW 校验不兼容 |
| [玩家说明](../../ASSET_CACHE.md)、[决定表](../DECISIONS.md#d038)、入口与索引 | 更新生效规则并保留最初 30 秒的历史理由 | 文档不再把清空旧缓存后的在线获取视为禁止场景 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| 旧 / 新 `verifyAssetCatalog` 对当前核验 JSON | 12562 文件；旧校验来自合并第一父，新校验来自当前 HEAD | 旧校验报 `ASSET_CACHE_BAD_CATALOG`；新校验通过；这是内存验证，不等同于用户 profile 的复现 |
| 基线 manager 的 Edge 旧 SW 更新 | `SP_E2E=1`，用测试专用 `SP_ASSET_CACHE_TEST_MANAGER` 指向 `bc4ee0c6` 版 manager；`--test-name-pattern='legacy cache SW migrates'` | 预期失败：1 项，`ASSET_CACHE_BAD_CATALOG` 在正式更新 PIN 时发生，耗时约 3.34 秒；这是修复前复现，不列为通过 |
| `node --test test/asset-cache-manager.test.js test/asset-cache-sw.test.js test/asset-cache-shared.test.js test/asset-cache-http.test.js test/asset-cache-admission.test.js test/asset-cache-pack-worker.test.js` | Windows / Node，最终修复；包括 5 秒冷却、短 / 长 429、暂停和跨标签准入 | **88/88 通过**，0 失败 / 跳过，约 7.40 秒 |
| `SP_E2E=1 node --test test/asset-cache.browser.test.js` | Edge 155.0.4283.45，无头、默认 800×600、随机 loopback 端口、3 个小素材、双标签；含 3 个新增升级 / 清理场景 | **8/8 通过**，约 20.45 秒；更新后 3 份正文相同，哈希音频本地命中，升级不重下素材；旧在线补齐拒绝断言按明确补齐新语义修正 |
| `SP_E2E=1 node --test test/asset-cache-ui.browser.test.js` | 实际应用 Edge 155.0.4283.45，无头；1920×1080 / 1280×720；无对局，空旧目录 UI 状态夹具及持久保存反馈 | **1/1 通过**，约 8.85 秒；截图检查获取 / 补齐按钮与弹窗边界。首轮原初始化等待曾 10 秒超时，页面未报告 JS 错误；增加失败状态诊断后重跑通过，未确认超时原因，不把该偶发等待记成已修复 |
| `node tools/i18n.mjs check --all --strict` | 英 / 日 / 韩 / 繁四包，当前使用 1369 条源消息 | 每包 1369/1369，0 缺失、0 错误；旧状态源消息移除、新组件消息加入 |
| `node node_modules/typescript/bin/tsc --noEmit --checkJs -p jsconfig.json` | 修改后的生产模块 | exit 0 |
| ESLint 本次源码 / 测试文件；`git diff --check` | 明确列出本次缓存、SW、HTTP 与 Edge fixture 范围 | exit 0，无告警 / 错误 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 本次说明、决定、任务记录和索引 | **32/32 通过**，0 失败 / 跳过，约 9.55 秒 |
| 资源释放 | 所有 Edge fixture await browser / server close；实际应用报告 cleanup 均 true；沙箱外只读进程检查与 TCP 探测 | 无本次 asset-cache 测试 Node / Puppeteer Edge 进程；主 UI 两轮临时端口 57301 / 62565 均关闭；沙箱内 CIM 初次被拒后仅以只读方式重查，不停止用户进程 |

未运行完整游戏、全量 CI / golden、650 MB 的重新下载或用户实际普通 profile 操作；测试针对缓存协议和小素材生命周期。用户原浏览器普通 / 无痕当时的组件状态仍属未直接读取的现场信息。

## 结果、遗留与接手

- 实现结果：兼容缺口与清理后恢复死路均已复现并修复；真实限流才倒计时，服务端 5 秒冷却按用户选择通过测试。目录格式、版本和实际素材内容不因本次修复变化。
- 未确定或未完成：未直接读取用户实际普通 profile；首次 UI 初始化超时原因未复现，保留诊断供再次发生时定位，不扩展为新源码修复。服务器生产部署仍属 I004 的后续验证。
- 提交 / 远程 / 素材 / 线上：代码、测试和记录同一功能提交；没有远程操作、打包或部署，不改 master。本次没有下载游戏素材或清理用户缓存；浏览器回归只在独立测试配置中清理小素材。
- 使用修复：重启本地服务以刷新进程内代码版本快照，重新加载页面，再明确获取 / 更新目录或补齐；组件会在所有本站标签无对局时升级，升级失败才需要关闭本站全部标签后重开，无需先清空素材。
- 接手入口：`public/js/assetCache.js`、`public/js/ui/assetCache.js`、`public/asset-cache-sw.js`、`server/http/assetCache.js`、`test/asset-cache-manager.test.js`、`test/asset-cache.browser.test.js`、`test/fixtures/asset-cache-legacy-sw.js`。
