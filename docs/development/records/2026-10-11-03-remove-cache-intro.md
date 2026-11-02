# DEV-20261011-03 · 删除预缓存顶部说明

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-11 / 2026-10-11，Asia/Shanghai |
| 状态 | 本地完成 |
| 类型 | 界面调整 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity` / `cedb4ef9ce3de787301c095efd53d75d0b32f246`，开始时工作区干净 |
| 上游基线 | 已合并 v0.2.3 / `1db8e51023ae6abaec9370beb81a513d5c4d0b01`；本次未刷新远程 |
| 提交归属 | 与本文同一提交，按记录路径查询 |
| 关联 | [DEV-20261011-02](2026-10-11-02-manual-catalog-update.md)，D025 |

## 需求、范围与验收

用户要求删除截图中标题下圈出的说明段落，并询问手动更新目录 JSON 的按钮位置。范围为删除该段及专属样式，保持已有目录更新条件和严格准入规则；更新按钮仅在目录过期且本地仍有素材缓存时出现。

验收：标题下直接显示缓存状态；过期目录仍能手动更新，版本已匹配时无需显示更新按钮。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 删除哪段文字 | 用户截图蓝圈与 `AssetCacheHost` 的 `asset-cache__intro` | 已确认：删除说明段落，保留标题及 `ASSET CACHE` |
| 为何截图未显示更新按钮 | 截图中本地与服务器目录版本一致；`canUpdateCatalog` 条件 | 已确认：当前目录不显示按钮；过期且 `readyFiles`、`readyBytes` 都大于零时显示在服务器版本下方 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `public/js/ui/assetCache.js` | 删除顶部说明段落 | 按用户圈定范围简化界面 |
| `public/css/asset-cache.css` | 删除专属 `.asset-cache__intro` 样式 | 清理已无引用的样式 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `SP_E2E=1 node --test --test-name-pattern='explicitly updates' test/asset-cache-admission.browser.test.js` | Node 24.21.0 / Edge 155.0.4283.45；两文件微型目录与缓存；1280×720、844×390 | 1/1 通过：旧目录按钮出现，显式下载一次、更新后隐藏；新增量补齐后通过准入，0 次旧完整目录接口请求、0 次在线补齐请求；两个布局无横向溢出 |
| 查看 `manual-catalog-1280.png` | 本次测试生成截图 | 标题下直接显示缓存状态，服务器版本下面显示更新按钮 |
| `node node_modules/eslint/bin/eslint.js public/js/ui/assetCache.js` | 定向界面静态检查 | 通过 |
| `node tools/i18n.mjs check --all --strict` | 四份翻译包 | 1329 个使用中的文案均完整，0 missing、0 errors |
| `git diff --check` 与子代理只读复查 | 说明段落、专属样式、按钮条件及引用 | 通过；没有剩余 class 引用，更新逻辑保留 |
| 测试资源释放 | `manual-catalog-report.json` | `browserClosed: true`、`serverClosed: true`，错误列表为空 |

不运行整局、完整素材包重复导入或全量测试；本次只有说明段落和样式变化。

## 结果、遗留与接手

- 实现结果：已删除段落及专属样式，定向验证完成。
- 未确定或未完成：本任务无遗留；实际线上展示取决于服主部署版本。
- 提交 / 远程 / 素材 / 线上：代码与本文同一本地提交，按路径查询；本次未推送、未修改素材、未部署。
- 接手入口：`public/js/ui/assetCache.js`、`test/asset-cache-admission.browser.test.js` 和 [前一次记录](2026-10-11-02-manual-catalog-update.md)。
