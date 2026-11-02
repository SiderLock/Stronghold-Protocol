# DEV-20261011-02 · 旧目录手动限速更新与增量包完整目录

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-11 / 2026-10-11，Asia/Shanghai |
| 状态 | 本地实现与定向验证完成；未推送、未部署 |
| 类型 | 功能 / 界面 / 打包 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`42481ecd176bc01bda5deae7a8d386f7c904e20f`，开始时工作区干净 |
| 上游基线 | 已合并 v0.2.3 / `1db8e51023ae6abaec9370beb81a513d5c4d0b01`，本次仅核对本地 |
| 提交归属 | 打包阶段 `cc25a76`；手动更新、界面和最终记录与本文本次同一功能提交，按记录路径查询；沿用既有本地提交授权，不推送 |
| 关联 | D023、D024、D025；[DEV-20261010-12](2026-10-10-12-offline-catalog-admission.md)、[DEV-20261011-01](2026-10-11-01-catalog-status-ui.md) |

## 需求、范围与验收

用户允许一个明确例外：本地已有目录且实际有素材缓存，只是目录版本落后时，可手动请求服务器更新完整目录。新按钮必须显式点击，服务端限流防重复与流量尖峰；无目录、空缓存和版本已匹配者不能通过正常客户端获取目录。既有检查、完整校验、面板重开与准入保持仅获取小摘要；严格准入仍要求当前目录与完整素材匹配，断线续玩边界不变。

新增量与完整素材包须携带当前完整目录。红色严格准入提示追加完整包内含目录、无需单独导入；在线补齐按钮标注“（限速）”。源码、定向测试、翻译与开发记录属于本次范围，不改变玩法，不运行完整 14 回合，不推送或部署。

验收：手动更新受客户端实际扫描、管理锁和游玩保护；服务器更新响应共享在线补齐字节预算，并限制同 IP 重复请求；失败、取消、版本变更不破坏旧目录与缓存；更新后仅重扫复用，不自动补齐。新增量包只装变化内容，却包含最新完整目录，旧包仍可在当前目录下复用。Edge 短流程确认无隐式目录请求及提示布局。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 当前目录线上行为 | `server/http/assetCache.js`、`public/js/assetCache.js` | 原 `/catalog` 403；管理器只读取本地目录、小摘要和缓存；新增独立显式更新路由，保留旧路由封禁 |
| 当前严格准入 | D024 与服务端 / 客户端报告核验 | 不因本次例外放宽；目录更新本身不授予准入 |
| 原有素材限流 | `CacheDownloadLimiter`，默认总 1,000,000 B/s、单 IP 500,000 B/s | 更新目录也共享预算、并发槽；每 IP 另加 30 秒冷却 |
| 现有打包 | `tools/asset-cache-pack.mjs` | 完整包已有完整 manifest；缺少标准增量 CLI，需要可维护入口 |
| 客户端磁盘报告的边界 | 与 D024 的 `readyFiles / readyBytes` 一样 | 正常客户端扫描证明实际有缓存；服务端不能独立读取远端磁盘，不能把自报字段描述为密码学证明 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| 服务端、客户端和打包三个子代理；主代理负责界面与集成 | 各自只写分配文件；额外子代理只读审查未发现阻断问题 | 并行开发，同时保留最终统一审查和提交 |
| `tools/asset-cache-pack.mjs` | 正式增加 `--delta --base-catalog OLD.json`，可与 dry-run 合用；完整 / 增量 / 导出 JSON 的 manifest 一致 | 增量只打包变化 SHA 内容，重命名及相同内容复用，不因 ZIP 不全而丢失完整目录 |
| `test/asset-cache-pack.test.js`、`test/asset-cache-pack-worker.test.js` | 小样本核对清单一致、独占发布、同版本拒绝；真实 Worker 验证冷增量与旧素材复用 | 不重打历史 500 MB 大包，验证目录完整与素材完整的区别 |
| `server/http/assetCache.js` | 新增严格参数与手动请求头的 GET `catalog-update`；30 秒/IP 冷却最多保留 4096 个活跃键；原 `/catalog` 403 不变 | 取消隐式/冷目录下载，仅保留用户批准的手动例外；取消不恢复冷却 |
| `server/http/cacheLimiter.js` | 增加共享 `streamBuffer`，目录原文 / gzip 和素材文件共用字节调度、并发槽及背压 | 默认总 8 Mbps / IP 4 Mbps 不变；只保留共享正文的最多 8 KiB 视图，不为每客户端复制完整目录 |
| `public/js/assetCache.js` | 显式 `updateCatalog` 重扫旧缓存，120 秒可取消下载；解压后 32 MiB 与 SHA 校验，传输后重新核对摘要及游玩锁再固定 | 不自动请求、补齐或清理旧素材；失败/暂停保留旧目录。503 只在明确错误码时提示禁用，下载退出均 abort 释放网络 |
| `public/js/ui/assetCache.js`、CSS、四个翻译包 | 旧目录且非空缓存时显示小型“手动更新目录（限速）”，展示冷却；追加完整包内含目录说明，补齐按钮标注限速 | 让玩家明确选择；已有目录版本显示、严格准入含义和旧缓存边界保留 |
| ASSET_CACHE / network / 0.2.3 history / D025 | 文档明确旧路由仍封禁、手动限流例外、增量完整目录与历史部分包兼容 | 保留 D023 原因并标明补充关系，便于后续开发还原约定 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/asset-cache-pack.test.js test/asset-cache-pack-worker.test.js` | 子代理执行；真实 zip.js、Worker VM、可清理的小样本 | 15 通过，0 失败 |
| `node --test test/asset-cache-catalog.test.js test/asset-cache-shared.test.js` | 打包子代理核对目录与共享约定 | 22 通过，0 失败 |
| 打包三个修改文件 ESLint / diff --check | 子代理执行，主代理已读差异 | 通过 |
| `node --test test/asset-cache-http.test.js` | 服务端子代理执行；真实 HTTP、gzip / identity、共享低速预算、背压、取消 | 19 通过，0 失败；覆盖参数、旧路由禁用、版本、30 秒冷却、online-disable、共同并发/字节预算及释放 |
| `node --test test/asset-cache-manager.test.js` | 客户端子代理执行；异步流、损坏 / 32 MiB 早拒绝、503 / 429、版本变更及取消 | 27 通过，0 失败；旧 PIN 保留，非显式动作目录请求为 0，超时 / 跨标签 / destroy 可取消 |
| `SP_E2E=1 node --test test/asset-cache-admission.browser.test.js` | 主代理；Node 24.21.0、Edge 155.0.4283.45，应用 / Worker / SW / WebSocket 小样本 | 最终 3 通过，0 失败，1 个历史整包重复导入跳过；旧缓存旧目录严格拒绝，点击仅下载 1 次，复用音频后仍缺 1 文件，当前完整目录增量导入后准入通过 |
| Edge 网络与布局 | 1920×1080、1280×720；匹配目录 844×390 / 640×360，手动按钮 1280×720 / 844×390 | 常规两场景完整 / 手动目录请求均 0；手动场景旧路由 0、新路由仅显式 1、在线补齐 0。7 个布局无横向溢出；1280 / 844 手动截图和1280提示截图实际查看 |
| `node tools/i18n.mjs check --all --strict` | 主代理；四个完整翻译包 | 1330 条 msgid，100% 翻译，0 缺项 / 错误 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 主代理；当前代码及规则文档 | 31 通过，0 失败 |
| 修改的十个 JS / mjs 文件 ESLint；全项目 `tsc --noEmit --checkJs -p jsconfig.json`；diff --check | 主代理统一检查 | 均通过 |
| 修改文档本地链接检查 | 7 份文档，193 条真实 Markdown 本地引用；排除代码中的示例链接 | 全部路径存在，D025 等决定锚点有效；未修改原有代码示例 |

初次新增 Edge 手动流程因测试直接写缓存时漏掉已有 Worker 约定的 Request 哈希 / 大小头，扫描正确识别为 0、按钮未出现；这是 fixture 不完整。修复测试元数据后，单场景和最终完整短流程通过，产品扫描规则未放宽。

服务端子代理只读测量当前独立目录：原文 4,585,419 B，gzip 789,051 B，减少 82.79%；这是当前本地 JSON 的压缩测量，不是已部署的公网带宽数据。三份最终 Edge 报告均确认 `browserClosed=true`、`serverClosed=true`；HTTP 与 Worker fixtures 由 finally / t.after 关闭客户端、limiter 和临时目录，未清理用户原有浏览器或进程。

没有执行完整 14 回合、全量 CI / golden、重复 500 MB 整包导入或真实公网百人压测：本次没有玩法变化，相关目录 / HTTP / Worker 与短流程已覆盖；线上负载需部署后观察。

## 结果、遗留与接手

- 实现结果：显式手动目录更新、共用限速及冷却、增量完整目录、界面文案和定向验证本地完成。
- 未确定或未完成：线上真实带宽、部署和分发另行核实；不重打已分发的旧大包。
- 提交 / 远程 / 素材 / 线上：打包 `cc25a76`，手动更新与本文最终更新同一提交；无远程操作，无游戏素材修改，未部署。历史分发包保持原样，正式 CLI 用于今后新包。
- 接手入口：`server/http/assetCache.js`、`public/js/assetCache.js`、`tools/asset-cache-pack.mjs`、[ASSET_CACHE](../../ASSET_CACHE.md)。
