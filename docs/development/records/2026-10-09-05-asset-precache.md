# DEV-20261009-05 · 浏览器素材预缓存与完整导入包

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-09 / 2026-10-09，Asia/Shanghai |
| 状态 | 本地实现、定向验证及分批提交完成；浏览器生命周期边界待修复，未推送、未部署 |
| 类型 | 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`bcf38f7`（用户已提交 39 套召唤物清单） |
| 上游基线 | 已合并 v0.2.2，`62eb113419123d9a3a63606107bbf85230c5dd2f`；本次不拉取 |
| 提交归属 | 服务端与打包 `6fc816c`；浏览器与界面 `ff20523`；记录和索引收尾与本文最终更新同一提交，可用 `git log -- docs/development/records/2026-10-09-05-asset-precache.md` 查询 |
| 关联 | [召唤物补齐记录](2026-10-09-04-local-token-assets.md)、[D016](../DECISIONS.md#d016)、D014/D015 公告边界 |

## 需求、范围与验收

用户确认完整包统一分发、本地 ZIP 导入优先、在线仅补缺项、更新按文件增量处理。完整包必须包含新补入的 39 套模型、117 个文件（3.48 MiB）。站点主体部署为 HTTPS；HTTP/IP 保持正常游戏加载，但没有完整持久预缓存支持。

本次修改限于素材清单生成/打包、服务端在线补齐端点及限流、浏览器持久缓存/导入、导航入口与界面、相关测试及文档。无玩法、公共广播、远程 Git 或服务器部署操作。

验收包括：按实际服务器素材生成逐文件 SHA-256 清单；缓存命中不访问素材服务器；音频 `/media/` 别名命中；ZIP 逐文件校验/导入、中断可接续、不完整/旧包可复用；仅补缺失/变化文件；快速检查与深度校验；新版本不污染正在使用的旧素材；HTTP/存储不足安全降级；在线下载全服预算与取消/背压；Edge 短流程和新召唤物覆盖。不运行完整十四回合对局。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 服务器链路 | 用户报告阿里云标称峰值 200 Mbps，近百人在线时可能突然降速并集体断线 | 未实测实时出口；不能从标称峰值自动推断可用余量 |
| 在线补齐预算 | 用户选择全服 8 Mbps、接受固定预算内按活跃下载动态分配 | 初始总上限 1000000 B/s，每来源上限 125000 B/s；可配置；不宣称可以消除出口骤降 |
| 首次填充 | 用户确认本地包优先；讨论文档 `Astra初步评估.md` | 外部分发 ZIP 可避开游戏服务器首次素材流量；在线预取仍有首次下载流量 |
| 现有素材缓存 | `public/js/assets.js`、`audio.js`、`server/http/files.js` | 运行时解码缓存和普通 HTTP 缓存不能代替可校验的 ZIP 导入持久缓存 |
| 别名及隐式依赖 | `shared/media.js`、`render/boardArt.js`、`board3d/load.js` | 纳入音频别名和 `tiles.json`，不能只遍历两个 JSON 而漏掉棋盘依赖 |

## 实现或操作

- `server/assetCacheCatalog.js` 根据标准/本地清单、字体、实际字节和运行时隐式依赖生成排序稳定的 SHA-256 目录。`/media` 别名遵循原服务端音频扩展优先级及缺失回退；音频声明缺失仍记缺项，但可播放的安全替代文件可以缓存。
- 查到未注册到运行时模型表的 `trap_1096_acshopup.atlas` 缺少隐含 PNG；作者本地整合包也缺少该 PNG，当前源码无模型引用。保留显式素材，将未使用 TextAsset 的隐含依赖记为告警；真正注册的 Spine 图集缺页仍阻断完整性，没有复制其他模型或伪造素材。
- `tools/asset-cache-pack.mjs` / `tools/asset-cache/zip.mjs` 使用流式 UTF-8 ZIP32、逐文件压缩和二次 SHA 核对，仅发布完整包、不覆盖现有成品、失败只移除自己创建的部分文件。新增 `npm run assets:pack`，发布工具、文档和脚本入口已同步。
- `server/http/assetCache.js` 提供状态、gzip/ETag 清单与指定文件哈希的补齐端点；只读、拒绝符号链接、在响应前核对实际内容。HTTP ETag 覆盖完整响应实体，素材版本只覆盖文件内容；修复告警或完整性时不会因内容版本不变而误发 304。
- `server/http/cacheLimiter.js` 采用总预算和 IP 预算令牌桶，客户端及请求轮转、背压、取消、全局 24 / 单 IP 2 并发。允许环境变量停用，最低正速率也能积累一字节。普通 HTTP / WebSocket 不使用此队列，不能保证云链路骤降时不掉线。
- `public/js/assetCache.js` / `asset-cache-worker.js` 在专用 Worker 中逐文件导入、下载和深校验；Cache Storage 按 SHA 复用。清单来自当前服务器，ZIP 不可信，拒绝异常路径、加密、重复或超大条目；坏内容跳过并报告，成功文件保留。
- `public/asset-cache-sw.js` 只处理清单内 assets/fonts/media，支持完整与单 Range 音频响应、按需回填、逐页面固定版本和旧内容保留。元数据消息串行，批量与被动写入共用 Web Locks；无页面 PIN 时走正常网络，避免部署后用旧资源解释新页面。
- 标题页、大厅左侧、房间左侧加入入口与进度窗口；扫描、完整校验、清理、持久保存、失败重试均接入。进入对局或同站点其他标签页游玩时停止批量任务，返回大厅手动继续；HTTPS/能力不足时不阻断原游戏。四语言文案和 zip.js 2.23.0 BSD 声明已补齐。
- [ASSET_CACHE.md](../../ASSET_CACHE.md) 说明玩家操作、人工分发、真实 IP、反向代理流式转发、配置及素材更新后重启。测试产物、完整包和下载素材均为 Git 忽略内容；没有修改素材清单或既有游戏资源。

## 验证

环境为 Windows 11、Node.js、本机 Edge 154.0.4258.62，测试服务器使用随机端口并在 `finally` 关闭；没有留下 3000 端口服务。基线工作区干净，本地分支较缓存远程领先用户素材提交一条。

| 检查 | 实际结果 |
|---|---|
| `node --test test/asset-cache-catalog.test.js test/asset-cache-http.test.js test/asset-cache-pack.test.js test/asset-cache-shared.test.js test/asset-cache-manager.test.js test/asset-cache-sw.test.js test/build.test.js test/package.test.js` | 63/63 通过，包含真实 HTTP 总速率/公平性/取消/背压、元数据 ETag、低速预算、损坏/缺失文件、ZIP 与发布边界 |
| `SP_E2E=1 node --test test/asset-cache.browser.test.js`，Edge | 3/3 通过：增量只补一项、刷新持久命中、音频别名/Range、旧/部分 ZIP、非法路径、损坏修复、跨标签暂停及互斥 |
| `node --test test/client-static.test.js` | 344/344 通过 |
| `node --test test/build.test.js test/docs-paths.test.js test/docs-consistency.test.js test/announcements-http.test.js test/announcement-assets-http.test.js` | 首轮 54/54；随后新增 Service Worker buildTag 用例随上述 63 项通过 |
| 类型、导入、ESLint | `tsc --noEmit --checkJs -p jsconfig.json`、`tools/check-imports.mjs`、修改模块定向 ESLint 通过；导入检查仅有既有三个 sim-node 允许项；main.js 既有未使用 disable 警告保留 |
| `node tools/i18n.mjs check --all --strict` | en/ja/ko/zh-TW 各 1242/1242，0 missing、0 errors |
| 完整包逐项审计 | 12,249 文件全部解压 SHA-256 通过，原始 641,482,945 bytes（611.77 MiB），ZIP 500,285,695 bytes（477.11 MiB）；包含全部新增 117 项 token |
| Edge 真实完整包导入 | 最终核心版本约 60 秒到 ready；导入及探测/刷新/导航检查共约 68 秒。12,249/12,249，0 invalid、0 absent；12,131 个独立导入、118 个已缓存/重复内容复用，0 在线补齐请求 |
| Edge 实际素材命中 | 全部 token 117 项＋5 个音频别名＋7 个字体共 129 个逐内容哈希请求，服务端素材请求为 0；刷新后 0 缺项，0 页面脚本错误 |
| 界面 | 1920×1080 / 1280×720 标题弹窗与大厅左侧入口检查通过；1280 弹窗位于 x=380–900 / y≈49–671，正文无横向溢出；截图在忽略测试目录，不提交 |
| 本地提交收尾 | `node --test test/docs-paths.test.js test/docs-consistency.test.js` 31/31 通过；各阶段 `git diff --cached --check` 通过；没有因本轮提交重跑完整游戏或浏览器测试 |

完整 ZIP 为 `.cache/asset-cache-pack/Stronghold-Protocol-assets-c746f84563a3.zip`，SHA-256 为 `c00aeaea9e8a8964e8c18c570dd4081059d8340fb392a77b5e70a8a26730d357`。关键命令与结果留在本文，`.cache` 中脚本/截图/报告仅作辅助。

未执行：完整 CI/golden、十四回合对局、100 人真实服务器带宽压力测试、手机浏览器实测和服务器部署。资源缓存不改变玩法，不据本机夹具宣称线上抖动已解决。

## 结果、遗留与接手

- 实现结果：本地源码、统一包、定向验证及功能分批提交完成。
- 未确定或未完成：限流默认已确认，真实百人多房间带宽压测仍需部署环境；以下两个浏览器生命周期边界由独立复核确认，暂未修复。
- 浏览器遗留：其他游玩标签页关闭后，已打开的缓存窗口可能仍保留暂停状态，需要关闭并重新打开窗口；直接刷新或重连进入进行中的对局时，若当前页面尚未固定缓存版本，会沿用正常网络加载，返回大厅后才恢复缓存初始化。这两项影响缓存可用性，不改变游戏流程。
- 提交 / 远程 / 素材 / 线上：服务端与打包 `6fc816c`，浏览器与界面 `ff20523`，文档收尾与本文最终更新同一提交；未拉取/推送、未部署；素材保持用户补齐状态。
- 本地验收预览：额外启动 `http://127.0.0.1:3001`，进程 188732（仅为本次本机进程号，不是部署信息），状态接口 200 且清单完整；随机端口自动化测试服务与 Edge 测试进程均已关闭，3000 未被本次占用。
- 接手入口：本记录、D016、ASSET_CACHE.md 与新增 asset-cache 模块；后续先按实际服务器素材生成清单/包，核对 HTTPS 和代理来源，再在无进行中对局时部署重启。

## 后续补充

此前仅暂存而未分阶段提交，用户指出不符合当前开发约定，并明确要求现在进行多次本地提交、不要推送。今后大型任务应在功能阶段完成后及时提交，不等对话结束才统一提交。ZIP 可直接人工分发，无网盘 API 或自动上传操作。
