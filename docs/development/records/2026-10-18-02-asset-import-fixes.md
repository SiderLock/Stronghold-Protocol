# DEV-20261018-02 · 素材导入与在线补齐：合并 Service Worker、缓存索引与互认

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-18 / 2026-10-18，Asia/Shanghai |
| 状态 | 已完成：本地修复、定向 Node / 浏览器回归与文档；未推送、未部署、未重启服务器 |
| 类型 | 调查 / 修复 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`7206c0dedaa5c95542a109c7a710646ef4d5b2e8` |
| 上游基线 | v0.3.1，沿用 [DEV-20261018-01](2026-10-18-01-upstream-v0.3.1.md) 的 `d905c146`；本次不拉取 |
| 提交归属 | 代码、测试、文档同一功能提交，按本文路径的 Git 历史查询 |
| 关联 | D016、D025、D038、[D039](../DECISIONS.md#d039)；[v0.3.1 合并](2026-10-18-01-upstream-v0.3.1.md)、[预缓存实现](2026-10-09-05-asset-precache.md)、[目录恢复](2026-10-14-03-asset-catalog-recovery.md) |

## 需求、范围与验收

用户报告：v0.3.1 适配基本完成后，浏览器导入本地素材包仍有 bug，预缓存面板的「在线补齐」也坏了；要求这次直接修好，去重采用「两套入口相互识别兼容」，并询问服务器上的素材是否已是 0.3.1 最新。用户授权访问 `101.201.232.183` 做测试和看日志，但明确不得私自重启服务器进程。

范围仅客户端素材导入、预缓存与 Service Worker；标题页导入与大厅预缓存两套入口都保留。不修改服务器数据、不重启服务、不推送或部署；浏览器测试只用临时测试服务器与临时配置，线上只读探测与下载公开素材包。

验收：标题页导入、大厅导入、在线补齐、检查与清理在普通刷新后可连续使用；两个导入入口互相识别，不重复写同一份字节；全量目录（18,372 文件 / 801.6 MiB）不再因 `Cache.keys()` 报错；对局期间的升级保护与已有目录、pin、正文保留规则不变。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 线上现象复现 | 无头 Chrome 访问 `https://101.201.232.183/`；标题页导入 636 MB ZIP 成功；大厅「在线获取完整目录」「导入本地素材包」约 10 秒后 `ASSET_CACHE_SW_UNAVAILABLE`；强制切换 SW 后全量导入显示 18372/18372、仍需补齐 0，随后状态 `error`、错误码 20、无错误文案 | 已确认：导入与补齐不是同一个表象，是两个独立根因 |
| 两个 worker 抢作用域 | `public/js/main.js:414` 注册 `/sw.js`、`:433` 的 `installAssetCache()` 经 `public/js/assetCache.js:324` 注册 `/asset-cache-sw.js`，两者 `scope: '/'`；浏览器实测 active `/sw.js`、waiting `/asset-cache-sw.js`，刷新后仍如此 | 已确认：同一作用域只能有一个 worker；经典 worker 没有消息处理器，所有预缓存动作先超时 |
| 失败发生在升级之前 | `perform()` 先 `assertMutable()`（`assetCache.js:507`）再 `ensureCompatibleSW()`（`:508`）；旧 controller 不回应 `ASSET_CACHE_CAN_MUTATE`，10 秒超时即失败，waiting 的新 worker 永远等不到激活 | 已确认：把升级移到 guard 之前并允许对 waiting worker 校验游玩 pin 后，目录获取 7 秒成功 |
| 全量包超过查询上限 | 线上目录 18,372 文件、18,242 个唯一 SHA；预缓存 `sp-asset-cache-v1` 实际 18,242 个内容键；Chrome 151 对 15,000 条带 header 的内容键 `keys()` 即抛 `AbortError` code 20（普通短键 19,500 条才失败），Chromium 错误为 `kErrorQueryTooLarge` | 已确认：限制是查询结果体积而非固定条数；worker 开头和 SW prune 都调用 `keys()` |
| 收尾报错而非导入失败 | 全量导入最后 `ASSET_CACHE_PRUNE` 抛 code 20；`perform` 把它当整体失败；数字错误码又不进 `cacheErrorText` 的字符串分支，所以只显示「操作未完成」 | 已确认，与用户看到的「导完却报错」一致 |
| 两套缓存不互认 | 标题导入写 `sp-imported-assets-v1`，大厅写 `sp-asset-cache-v1`；标题导入实测 30,436 条（含音频 `/media` 别名），大厅 18,242 条；按公告从两处各导一次会重复占用 | 已确认：用户选择保留两套入口、相互识别兼容；本次按完整 SHA 与目录别名做互认与复用 |
| 服务器素材版本 | 服务器 `data/assets.json` SHA-256 与仓库 HEAD 完全一致（`15b75931…`），catalog `app: 0.3.1`、完整、18372 文件；启动检查另报 local 美术 75/76 组、缺 `mesh/trap_110`，官方特效未提取 | 官方素材已是 0.3.1；本地客户端提取物和官方特效是独立可选缺口，不在本次代码修复范围 |

线上定位期间只读访问服务器：文件、catalog/status、日志；没有执行 systemctl 重启，也没有修改服务器文件。用户浏览器的历史导入记录与既有缓存未读取。

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `shared/assetCache.js` | 加入导入缓存常量、`ASSET_CACHE_INDEX_URL`、借用索引 URL；worker、module SW、页面共用同一份定义 | 避免三处常量漂移，合并后的 worker 能直接识别两套缓存 |
| `public/asset-cache-sw.js` | 成为唯一 module worker：先按 catalog pin 命中预缓存，再按精确 URL 命中标题导入缓存，最后走网络；prune 读 SHA 索引删除，不再 `Cache.keys()`；无索引且无法枚举时跳过清理而非报错；clear 同时删除借用索引 | 一个作用域一个 worker；全量包不能靠枚举清理；导入页与预缓存共用命中逻辑 |
| `public/js/main.js` | 不再注册 `/sw.js`，由 `installAssetCache()` 注册合并 worker | 移除冲突源；`/sw.js` 保留给旧页面与不支持模块 worker 的浏览器 |
| `public/js/assetCache.js` | 新增短时能力探测、waiting worker 激活与 `ensureCompatibleSW` 前置；`swMessage` 可设超时并把数字错误码归一为存储错误；初始化不再在页面加载时抢占旧 worker；扫描在没有兼容 worker 时仍可本地完成；import/download 收尾 prune 失败不再否定已完成导入；旧经典 worker 下用 localStorage 20 秒播放租约（5 秒心跳、pagehide 释放）让其他页面仍能阻止迁移升级 | 修复 10 秒超时与 code 20 放大；旧 `/sw.js` 没有持久 pin，租约补上跨标签对局保护 |
| `public/js/asset-cache-worker.js` | 开头不再 `cache.keys()`，改为分批 `cache.match` 探测；读取标题导入索引按 URL/别名计入 ready；计数按目录条目而非唯一 SHA；结束时写 SHA 索引；深校验只重读自有内容 | 绕过 Chrome 查询上限；两套缓存互认；重复/改名文件计数正确 |
| `public/js/assetPack.js` | 增加完整 SHA-256；写缓存前查预缓存同一内容，命中则记借用、计 `复用`；模型组成员逐项复用；结束同时写存储索引与借用索引；阶段完成条件计入复用 | 两套入口互相识别且不重复写字节；标题导入仍只读清单、不上传 |
| `public/js/ui/assetImport.js`、四语言包 | 结果显示复用数；补齐既有两条预缓存错误文案的翻译 | 数字错误码不再静默；界面文案完整 |
| `public/sw.js` | 原样保留为经典回退，不再由主页面注册 | 兼容旧页面与不支持 module SW 的浏览器；合并 worker 已覆盖其命中逻辑 |
| `docs/ASSETS.md`、`docs/ASSET_CACHE.md`、记录索引、D039 | 说明单一 worker、互认、索引与全量上限 | 文档跟随代码；接手者不需要重新踩一次 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| 线上只读复现（修复前） | 本机无头 Chrome 151，`https://101.201.232.183/`，公开 801.6 MiB 素材包；未登录、未改服务器 | 标题导入 18,371 接受、0 拒绝、2 跳过；大厅目录/导入 10 秒 `ASSET_CACHE_SW_UNAVAILABLE`；强制激活后全量导入 18,242 新增 + 130 复用、仍需补齐 0，收尾 `error: 20`；`sp-asset-cache-v1` 18372/18372 可见但 `keys()` 抛 code 20 |
| `node --test test/ui/asset-import.test.js test/ui/asset-download.test.js test/asset-cache-shared.test.js test/asset-cache-catalog.test.js test/asset-cache-pack.test.js test/asset-cache-admission.test.js test/asset-cache-http.test.js test/asset-cache-sw.test.js test/asset-cache-pack-worker.test.js test/asset-cache-manager.test.js` | Node 22；含借用/清理、no-keys、互认、按 URL 重复内容、旧 controller 先升级 | **155/155 通过**，0 失败 / 跳过，约 311 秒；改动收尾（localStorage 播放租约 / pagehide 释放）后，manager / SW / worker / import / download **83/83 复跑通过**，约 13 秒 |
| `SP_E2E=1 CHROME_PATH=/usr/bin/google-chrome node --test test/ui/asset-import.browser.test.js` | 真实应用 + `assetIndex:false` 临时服务器 + 小 ZIP；单 worker 断言 | **1/1 通过**，约 69.5 秒；scope `/` 仅一个 registration，controller 为 `asset-cache-sw.js` |
| `SP_E2E=1 CHROME_PATH=/usr/bin/google-chrome node --test test/asset-cache.browser.test.js` | 临时服务器，小而全的目录，导入、在线补齐、旧 SW 升级、跨标签游玩锁 | **8/8 通过**，约 60 秒（最终能力标志 / 互认调整后复跑） |
| `SP_E2E=1 CHROME_PATH=/usr/bin/google-chrome node --test test/asset-cache-ui.browser.test.js` | 本机检出无 `public/assets`，真实应用 | 未通过：`startServer` 在本机超过 30 秒，`page.goto` 导航超时；同条件手工启动服务器也可复现且不涉及本次改动，故本机无法验证此 UI 套件，未记为代码失败 |
| `node tools/i18n.mjs check --all --strict` | 四语言包 | 每包 2324/2324，0 缺失、0 错误 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 本次文档 | **32/32 通过**，约 56 秒 |
| ESLint 本次改动文件；`node tools/check-imports.mjs`；`tsc --noEmit --checkJs` | 本次源码、测试、SW | 本次文件 0 错误；imports 仅保留既有 3 条 sim-node 提示；typecheck exit 0。全量 `npm run lint` 在未改动的 `server/match/match/phases.js:66` 有 1 个既有 `no-constant-binary-expression` 错误，本次不触碰 |

未运行：`npm run ci` 全量、golden、14 回合真人压测、真实 801.6 MiB 在线补齐复测。线上全量导入在修复前跑过一次；修复后不再向生产服务器重复拉 800 MB 级包，改以小 ZIP / 合成目录覆盖相同代码路径。

## 结果、遗留与接手

- 实现结果：标题页导入与大厅预缓存共享一个 worker；预缓存动作不再先超时；全量目录不再调用 `Cache.keys()`；两套入口按完整 SHA 与目录别名互相识别，标题导入对预缓存已有文件只记复用。官方素材确认是 0.3.1。
- 未确定或未完成：修复后的真实 801.6 MiB 在线补齐与真实浏览器普通 profile 未重跑，属于发布前验证；服务器 local 美术提取物过期（75/76 组、缺 `mesh/trap_110`，官方特效未提取）需重跑 `tools/setup.mjs --local` / 特效提取，可能改服务器数据，需用户另行同意。
- 提交 / 远程 / 素材 / 线上：本地提交，**未推送、未部署、未重启服务**；没有修改服务器数据；测试生成的缓存均在临时浏览器配置中。
