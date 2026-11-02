# DEV-20261012-01 · 修复素材准入阻塞、缪尔赛思库存与在线补齐设置

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-12 / 2026-10-12，Asia/Shanghai |
| 状态 | 已完成 |
| 类型 | 修复 / 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`371092e8`（`feat(client): 提示紧急冻结并停止补齐与本地作战`） |
| 上游基线 | v0.2.4 已合并到本分支；本任务未执行上游同步 |
| 提交归属 | 代码按功能分批本地提交；记录与文档提交按路径查询 |
| 关联 | D016、D023、D024、D025、D030、D031；I004；[预缓存准入](2026-10-10-12-offline-catalog-admission.md)、[旧目录更新](2026-10-11-02-manual-catalog-update.md)、[带宽熔断](2026-10-11-07-bandwidth-emergency.md) |

## 需求、范围与验收

用户要求只修复创建房间前的阻塞扫描，不改局内卡牌刷新；在线补齐的原总 8 Mbps / 单 IP 4 Mbps 改为服主可用命令调整，默认不限速；继续修复项目内 `缪尔赛思bug.md` 所述上游库存问题；删除“没有目录文件就禁止在线下载”的门槛，允许用户明确在线获取完整目录并继续下载全部素材。远程仓库和部署不在本次范围。

验收条件是：创建请求不再等待完整本地缓存扫描；冷浏览器明确点击后可获取目录并补齐；自动初始化、检查和准入不自动下载完整目录；限速可持久配置并动态生效；固定身份装备仍计入共享库存但不会因库存上限被拒绝；既有测试保持通过。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 创建房间为何有秒级停顿 | `net.js` 在发送 `room.create` 前调用准入；原 `assetCache.admission()` 强制 `scan({refresh:true})`，会等待 Service Worker、缓存键枚举和存储统计 | 已确认：创建前缓存扫描是阻塞链路 |
| 创建是否应绕过严格准入 | 用户只要求修复创建前阻塞；服务端仍负责严格模式准入，客户端报告在后台刷新 | 已确认：仅 `room.create` 采用快速准入，加入/匹配/观战保持严格扫描 |
| 冷浏览器目录限制 | 原客户端无目录直接返回 `ASSET_CACHE_CATALOG_REQUIRED`，服务器旧目录接口对冷请求返回 403 | 已确认：改为用户明确动作调用当前目录接口；自动路径仍只取小摘要 |
| 在线限速默认值 | 用户要求默认无限制，同时保留服务器端可调总量 / 单 IP | 已确认：持久 CLI 默认 unlimited，环境变量继续支持字节/秒启动默认 |
| 缪尔赛思固定装备的库存关系 | `缪尔赛思bug.md` 最新规则：固定白送装备占池，可超过上限，但不应因上限拒绝；商店普通装备仍受库存 | 已确认：固定身份使用受限 `noPool` 获取，`held()` 仍计数，普通 band 不豁免 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `public/js/net.js`、`public/js/assetCache.js` | `room.create` 使用 `admission({fast:true})`；完整本地缓存可立即返回，冷/部分缓存不在创建请求前扫描，后台刷新报告 | 解除创建前阻塞，同时保留严格入口的服务端校验 |
| `public/js/assetCache.js`、`public/js/ui/assetCache.js` | 增加冷浏览器完整目录获取路径；显式补齐可先请求 `/api/asset-cache/catalog`；面板提供「在线获取完整目录（限速）」 | 允许用户主动下载完整资源，又避免初始化自动拉取大目录 |
| `server/http/assetCache.js` | `/api/asset-cache/catalog` 对 GET 提供当前完整目录，和文件补齐共用限速、紧急保护；`catalog-update` 保留旧目录手动更新语义 | 目录和素材走同一保护链路，关闭在线传输时统一返回轻量错误 |
| `server/http/cacheLimiter.js`、`server/serverSettings.js`、`server/index.js`、`tools/server-settings.mjs` | 总量 / 单 IP 默认 unlimited；新增 `asset-cache-limit <总Mbps> [单IPMbps]`，持久配置约 1 秒动态读取，`0` 可关闭在线传输 | 服主能按云带宽现场调节，不把旧预算写死 |
| 缪尔赛思相关 match 文件 | 固定身份装备只绕过获取门禁，仍占共享池；升级/全固定件合成继承标记；普通装备与普通 band 仍受上限 | 兼容白送固定装备规则，避免普通装备库存失控 |
| `test/*.test.js` | 增加创建快速准入、冷目录下载、限速动态设置和库存回归覆盖 | 只验证本次变更，不运行完整游戏或打包 |
| `docs/ASSET_CACHE.md`、`docs/SERVER_SETTINGS.md`、`docs/HTTP_CACHE.md`、`docs/development/DECISIONS.md` | 更新冷下载、默认限速和 D031 长期决定 | 避免运行文档继续宣称目录永久封禁或默认 8/4 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/asset-cache-manager.test.js test/asset-cache-admission.test.js test/asset-cache-http.test.js test/cache-limiter-emergency.test.js test/server-settings.test.js test/match/shared-stock.test.js test/content/garrisons_meta.test.js test/docs-consistency.test.js test/docs-paths.test.js test/asset-cache.browser.test.js` | Node.js，本地 fixture；包含 20 人分支库存、熔断限速边界、文档路径和浏览器逻辑夹具 | 171 项：166 通过、5 项 Edge E2E 按环境跳过、0 失败 |
| `node --test test/match/shared-stock.test.js test/content/garrisons_meta.test.js` | Node.js，缪尔赛思固定装备与普通库存回归 | 49/49 通过（包含在上面的组合验证范围内） |
| `git diff --check` | 当前工作区 | 通过 |
| Edge 浏览器 E2E、完整多人对局、完整素材打包 | 本任务要求快速定向修复，未启动浏览器或长流程 | 未执行；线上部署与生产带宽仍待验证 |

## 结果、遗留与接手

- 实现结果：创建请求不再同步等待全量缓存扫描；冷浏览器可明确在线获取目录并下载全部缺项；服主可用 CLI 恢复 8/4 Mbps 或设置任意预算，默认无限制；缪尔赛思固定装备库存规则已修复。
- 未确定或未完成：生产环境是否需要重新设为 8/4 取决于阿里云出口；Edge E2E 和真实服务器部署尚未验证。局内卡牌刷新未改动。
- 提交 / 远程 / 素材 / 线上：本地提交已按功能分批创建；远程未推送；未重新生成素材包；未部署服务器。
- 接手入口：查看 `public/js/assetCache.js` 的 `perform` / `admission`、`server/http/assetCache.js` 的 `serveCatalog`、`tools/server-settings.mjs` 的 `asset-cache-limit`，以及本记录与 D031。

## 后续补充

2026-10-12：本记录初建。用户随后要求允许冷浏览器直接在线获取目录，已纳入同一任务范围。
