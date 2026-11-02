# DEV-20261014-04 · 公告列表置顶与删除命令

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-14 / 2026-10-14，Asia/Shanghai |
| 状态 | 已完成 |
| 类型 | 修复 / 功能 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`4e0d0a9433415b99b1b8308add841d8689611e44`；开始时工作区干净 |
| 上游基线 | 已合并 v0.2.6，`488db49f11daf862b67ce26fa4cf89aa6cba2466`；仅核对本地记录与源码，未联网刷新 |
| 提交归属 | 列表置顶 `b5b6144b`；删除功能与本文最终记录同一提交，按记录路径查询 |
| 关联 | [D014](../DECISIONS.md#d014)、[D015](../DECISIONS.md#d015)、[前次手机公告修复](2026-10-12-04-announcement-mobile.md) |

## 需求、范围与验收

用户报告置顶只影响默认打开哪篇公告，历史列表仍按原发布位置展示，要求置顶期间列表首位显示；同时增加删除公告功能与对应管理命令。

范围为公告列表排序、私有文件管理/CLI、共享元数据与免提示兼容、定向测试及使用/开发文档。验收：置顶在列表首位，切换和取消置顶不破坏原发布顺序或当前选择；指定 ID 的公告可通过 CLI 删除，删除置顶自动清 pin，重启后仍生效；删除不使旧公告重新提醒；图片和用户手写草稿不自动删除，HTTP 仍无写入能力。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 列表没有真正置顶 | `AnnouncementDialog` 直接遍历 `state.items`；索引保存发布顺序 | 源码确认；仅派生展示数组，不重排持久索引 |
| 删除最新会回退提醒版本 | `readAnnouncementIndex` 原要求总体 revision 等于首项；免提示按总体版本匹配 | 源码确认；删除须保留最近发布 revision，删除为空时也保留；仅新发布更新它 |
| 删除涉及哪些文件 | 索引、`<id>.md` 由工具管理；图片 assets 可能被多篇共享 | 沿用单目录锁与原子索引替换，索引提交后删除对应正文；不删除共享图片、输入草稿或其他文件 |
| 紧急通知撤回 | 通知带不可变版本、浏览器独立队列，未设计远程撤回 | 删除不新增撤回协议；已显示正文无法远程抹除，尚未读取的删除正文返回现有不可用提示；具体边界在使用说明补充 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `announcementHistoryItems` / `AnnouncementDialog` | 派生置顶优先的展示数组，其余保持发布顺序 | 取消置顶即可恢复原位置，保留最新发布和免提示语义 |
| `AnnouncementStore.remove` | 校验 ID 并使用既有写锁严格读取；先原子删除索引项、清理对应 pin，提交后仅 unlink 对应正文并清缓存 | 索引写失败不先丢失正文；清理失败明确 warning「已删除但正文残留」，共享图片与草稿不动 |
| `readAnnouncementIndex` | 总体 revision 改为独立合法发布标记，允许删空后保留；既有版本 1 索引兼容读取 | 删除不回退最近发布版本，避免已有免提示失效而重弹旧公告 |
| `tools/announcements.mjs` | 新增 `delete <ID> [--dir <目录>]`、参数和 UTF-8 帮助/输出；普通 list 派生置顶优先，JSON 仍发布顺序 | 管理命令使用服务器同一目录与校验格式；公开 HTTP 仍没有删除能力 |
| 既有公告 controller | 不修改其状态机；新增删除后刷新、持久免提示、删空及迟到响应回归 | 验证删除当前详情后回到有效默认项/空状态，缓存不能通过晚响应复活已删正文 |
| 公告说明、D014、入口及索引 | 补齐列表顺序、删除命令、草稿/图片保留与紧急通知边界 | 维护用法与实际可验证行为一致，不写作者 CHANGELOG |

正文 unlink 失败时，撤下索引仍已生效，工具会准确警告需检查私有目录残留。删除不会自动清除共享图片，也没有新增远程撤回机制；浏览器此前已显示/已缓存正文无法被擦除。尚未读取的删除正文走现有不可用提示；服务端通知 monitor 本来就校验 ID 与公告版本，查不到正文便不会广播，命令按既有 TTL 到期。没有新增永久 ID 墓碑；使用说明建议恢复时用新 ID，旧通知的版本校验仍防止同 ID 新版串发。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/ui/announcements-ui.test.js test/ui/announcements-model.test.js test/docs-consistency.test.js test/docs-paths.test.js` | 列表置顶、取消、原发布顺序、选择与既有生命周期；文档 | 75/75 通过；一项旧列表顺序断言按用户要求更新，新加临时置顶/切换/取消测试 |
| `node node_modules/eslint/bin/eslint.js shared/announcements.js public/js/ui/announcements.js test/ui/announcements-ui.test.js`；`git diff --check` | 列表相关 JS 与差异 | 通过 |
| `node .cache/announcement-admin/pin-qa.mjs` | Edge 155.0.4283.45 无头；1280×720 桌面和 844×390 横屏触屏；真实标题入口及三条公告，未开房或开局 | 两种布局通过：旧 pin 首位、切换 pin、取消恢复时序、保留当前阅读与总体 revision；状态中原发布数组未变，无页面错误 |
| 置顶浏览器资源关闭 | PID 105720、端口 63643 | finally 关闭浏览器和服务；连接端口返回 ECONNREFUSED，浏览器进程退出 |
| `node --test test/announcements-store.test.js test/announcements-cli.test.js test/announcements-http.test.js test/announcement-notices-spool.test.js test/announcement-notices-monitor.test.js test/announcement-assets-http.test.js test/announcement-assets-shared.test.js` | 单目录文件读写、实际 CLI 子进程、临时 HTTP、现有通知与图片接口；由并行实现代理执行 | 79/79 通过，0 失败/跳过；覆盖旧/最新/置顶/最后删除、持久化、已加载缓存、非法/缺失 ID、写锁、原子索引失败、正文清理失败、草稿/图片保留、GET/HEAD 404、删除后 notify 拒绝；相关夹具与服务清理完成 |
| `node --test test/ui/announcements-model.test.js test/ui/announcements-ui.test.js` | 最终共享 revision 校验、两项新增删除客户端回归 | 45/45 通过；删除最新和删空后新页面仍保持免提示，真正新发布再提醒；晚到正文不能复活删空页面 |
| `node .cache/announcement-admin/delete-qa.mjs` | Edge 155.0.4283.45 无头；1280×720 桌面、844×390 横屏触屏；隔离目录，每种布局实际 CLI 删除四次，未开房或开局 | 两种布局均通过：删最新后列表更新及 HTTP 404、刷新不重弹；手动查看保留勾选；删正在阅读的 pin 自动切到剩余详情、清 pin；删空清正文/禁免提示；新发布恢复自动提醒；无页面错误 |
| 最终修改文件 ESLint、后端五文件 `node --check`、`git diff --check` | `server/announcements.js`、`tools/announcements.mjs`、共享文件及六个相关测试/界面文件 | 通过；不运行无关全库 lint/typecheck |
| 删除浏览器资源关闭 | PID 122860、端口 56933 | finally 关闭浏览器和服务，浏览器退出、端口连接 ECONNREFUSED；任务结束前另查 PID 与监听 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js`；`node .cache/announcement-admin/check-docs.mjs` | 最终五份文档；代码示例不作为本地文档链接 | 文档测试 32/32，通过 219 个相对链接目标和任务索引唯一检查 |

最终不同范围定向测试共 156 项（后台/CLI/HTTP/图片/通知 79、客户端 45、文档 32），全部通过。未运行完整十四回合、golden 或真人压测；本次不改变游戏规则或战斗流程。Edge 是本机无头触屏仿真，不代表真实手机或二十真人压力验证。本次没有改公告 CSS，保留前次非全屏高度、可复制正文和安全链接能力。

列表改动初次运行时，旧 UI 测试仍断言「置顶只带标记而保持原序」而失败；按本次明确需求调整该断言，并添加切 pin/取消/选择保持测试后通过。临时文档检查器初版误将行内代码的公告图片示例当成本地文档链接，排除代码示例后检查通过，没有改动原示例。未通过删除索引或取消安全校验来绕过失败。测试脚本、截图、公告数据与隔离浏览器目录仅在忽略的 `.cache/announcement-admin/`。

## 结果、遗留与接手

- 实现结果：列表临时置顶、取消恢复原序、私有 CLI 删除及保留免提示完成并通过定向检查。
- 未确定或未完成：不包含已发送通知的远程撤回；真实手机复核和线上部署不在本次本地验收中。
- 提交 / 远程 / 素材 / 线上：列表 `b5b6144b`，删除及最终记录另一本地功能提交；未操作远程、素材或部署，未操作真实 runtime 公告。
- 接手入口：`shared/announcements.js`、`server/announcements.js`、`tools/announcements.mjs`、`public/js/ui/announcements.js`、`announcementModel.js`、[公告说明](../../ANNOUNCEMENTS.md)。

## 后续补充

无。
