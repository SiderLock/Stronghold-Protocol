# DEV-20261009-06 · 预缓存入口与标题布局、持久保存反馈

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-09 / 2026-10-10，Asia/Shanghai |
| 状态 | 已完成，代码、测试与记录同属本次本地提交；未推送或部署 |
| 类型 | 修复 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`61ae2bf`；开始时工作区干净 |
| 上游基线 | 已合并 v0.2.2，`62eb113419123d9a3a63606107bbf85230c5dd2f`；本次不拉取 |
| 提交归属 | 与本文同一提交，通过 `git log -- docs/development/records/2026-10-09-06-asset-cache-ui.md` 查询 |
| 关联 | [前次预缓存开发](2026-10-09-05-asset-precache.md)、[D016](../DECISIONS.md#d016)；不改变 I004 中的生命周期边界 |

## 需求、范围与验收

用户对照四张截图报告：标题页设置、全屏按钮被挤窄；标题页不应有预缓存入口；大厅入口应有背景框并比右侧普通按钮醒目；本地导入标注「强烈推荐」；持久保存按钮需有背景框且点击有反馈。同时询问延迟图标的引入时间，不要求移动它。

修改仅涉及标题页局部布局、缓存导航及弹窗、持久保存结果状态、对应翻译、定向测试与文档。不修改玩法、服务器限流、素材包或资源清单。2026-10-10 用户明确要求本地提交；不推送或部署，不运行完整十四回合。

验收：标题页无预缓存入口，设置及全屏保持正方形；中文常用桌面尺寸状态栏不挤压，长翻译允许整项换行；大厅入口有清晰强调背景；导入推荐文案可见；持久保存能显示处理中、授权、未授予、不支持、异常，避免重复申请；测试进程、端口与浏览器关闭。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 图标按钮横向压缩 | `title.css` 固定宽度、`devices.css` 图标宽高及 Git 提交 `5fb686efe93628383c5754c5c9694b11b10ee5a8` | 已确认：此前新增公告入口使行内总宽超额，图标允许 Flex 收缩；缓存提交未改变这行 |
| 标题内容增高 | `ff20523` 对 `screens/title.js` 的差异 | 已确认：在代号框上方插入入口增加高度；按本次需求移除 |
| 延迟图标来源 | title 源码 Git 历史 `01a44cd288fb436efa23c3d1514d1a152c704e80`，2026-09-29 16:21:31 +08 | 已确认：初始提交已在同一状态行；原版截图未显示的原因未确定 |
| 持久保存点后无变化 | `requestPersistence()` 返回布尔值但 UI 忽略；入口使用 ghost 变体 | 已确认：未获许可或异常没有结果反馈，按钮也缺少可见边框 |
| 浏览器持久保存语义 | [MDN persist()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)，本次通过 AnySearch 提取核对 | API 返回是否授予；浏览器自行决定，可以不弹提示；不等于永久保存 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `public/js/screens/title.js`、`public/css/screens/title.css` | 移除标题页预缓存入口；状态栏局部缩小间距并锁定设置/全屏为不收缩的正方形，状态文字保留整项 | 恢复登录面板原有高度，避免公告入口挤压图标；长翻译仍可换行而不压扁控制 |
| `public/js/ui/assetCache.js`、`public/css/asset-cache.css`、四语言包 | 大厅/房间入口使用醒目的 primary 框；导入按钮显示「强烈推荐」；检查、校验、清理和持久保存按钮使用可见边框 | 让重要入口和可操作控件可识别，保持已有组件体系 |
| `public/js/assetCache.js` | 增加持久保存 `idle/requesting/granted/denied/error/unsupported` 状态，保留浏览器实际结果；配额或状态查询单独失败时不抹掉已获许可 | `persist()` 可能直接返回 false 或异常且通常不弹窗，界面必须给出明确结果并允许重试 |
| `test/asset-cache-manager.test.js`、`test/asset-cache-ui.browser.test.js` | 覆盖管理器结果状态及 Edge 真实页面布局、入口、推荐文案、四类申请结果和弹窗边界 | 验收本次 UI/交互改动，不运行完整素材导入或十四回合对局 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/asset-cache-manager.test.js` | Node.js 定向管理器测试 | 12/12 通过 |
| `node --test test/client-static.test.js` | Node.js 客户端静态与模块导入检查；与当时 9 项管理器测试一起运行，总计 353 | 客户端静态 344/344 通过 |
| `node tools/i18n.mjs check --all --strict` | 四语言资源完整性 | en/ja/ko/zh-TW 各 1248/1248，0 missing、0 errors |
| `node node_modules/eslint/bin/eslint.js public/js/screens/title.js public/js/ui/assetCache.js public/js/assetCache.js test/asset-cache-ui.browser.test.js test/asset-cache-manager.test.js` | 修改范围 ESLint | 通过，0 warnings |
| `node node_modules/typescript/bin/tsc --noEmit --checkJs -p jsconfig.json` | 现有项目类型检查 | 通过 |
| `node --test test/docs-paths.test.js test/docs-consistency.test.js` | 文档路径与代码一致性 | 31/31 通过；另人工核对本记录索引与说明表格 |
| `$env:SP_E2E='1'; node --test test/asset-cache-ui.browser.test.js` | Edge 154.0.4258.62；标题 3828×1931、1920×1080、1280×720；大厅与预缓存弹窗 1920×1080、1280×720 | 1/1 通过；图标保持正方形、标题页无入口、大厅入口有背景框、弹窗无横向溢出；授权/拒绝/异常/不支持反馈均可见；页面错误 0 |
| `git diff --check` | 当前工作区差异 | 通过 |

持久保存权限结果在 Edge 测试中注入，验证的是实际页面反馈，不代表生产域名已获浏览器授权。初轮浏览器脚本错误地等待无代号的新会话握手、之后误用了状态属性名，已修正测试夹具；随后尺寸断言识别 1280 下的换行，收紧标题页局部间距后通过。

未运行完整素材包重打包/全量导入或十四回合对局：本次未改变素材内容、ZIP 导入算法或玩法。Edge 测试在 `finally` 关闭浏览器和随机端口服务器；结束时未发现 3000/3001 监听的本项目服务。

## 结果、遗留与接手

- 实现结果：标题页布局与预缓存入口已按截图要求调整，持久保存申请现在显示实际结果；延迟图标保留原位置，来源为早期提交 `01a44cd`，不是本次缓存功能新增。
- 未确定或未完成：I004 所列的跨标签页生命周期边界、生产素材完整度、HTTPS/代理和百人真实带宽仍待单独处理；本次未扩大范围。
- 本次代码、测试与记录一起进行本地提交；未操作远程、部署或素材。原记录中「用户尚未授权」是对会话既有分批提交授权范围的错误判断，现已纠正，后续不重复请求已有适用授权。
- 接手入口：`public/js/ui/assetCache.js` 的 `persistenceText()`、`public/js/assetCache.js` 的 `requestPersistence()`，以及 Edge 定向测试。

## 后续补充

2026-10-10：用户指出既有本地分批提交授权应持续适用，随后明确要求提交。本次核对分支、HEAD、工作区及文件范围后统一提交这一 UI 修复任务；此前已通过的代码测试不重复运行，仅检查文档更新与暂存差异。
