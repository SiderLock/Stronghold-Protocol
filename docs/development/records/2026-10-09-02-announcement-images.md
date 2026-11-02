# DEV-20261009-02 · 公告 Markdown 图片显示

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-09 / 2026-10-09，Asia/Shanghai |
| 状态 | 已完成 |
| 类型 | 修复 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`c2012ee5b49da842f39fec5373121d8300ffb384` |
| 上游基线 | v0.2.1 ＋ Windows ZIP 中文名修复，`3eced7bdba5aae11a325bd3dbe66cdf01361d2bd`；本次未联网刷新 |
| 提交归属 | 与本文同一提交，按记录路径查询 |
| 关联 | [D015](../DECISIONS.md#d015)、[D014](../DECISIONS.md#d014)、[前次公告开发](2026-10-09-01-announcements.md) |

## 需求、范围与验收

用户报告在 Markdown 中插入图片、放好 assets 后仍不显示。本次补上普通公告与紧急通知共用的图片渲染，说明网站路径与草稿路径的区别；不改发布、提醒版本或通知协议。开始时 `docs/ANNOUNCEMENTS.md` 已有用户修改，将发布示例的 `--file` 改为 `../notice1.md`，须保留且不混入本次提交。

验收：仅 `runtime/announcements/assets` 中的公告图片能显示，尺寸适应正文宽度；图片不随发布自动复制，不支持外链；危险地址、原始 HTML 和代码块不会执行；只做定向测试与 Edge 弹窗检查，不跑完整十四回合对局。用户随后澄清只禁止在 public 放图片，允许修改前端源码。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 图片为何不显示 | `announcementMarkdown.js` 对 `![…](…)` 明确保留文字；原测试要求无 img 节点 | 已确认：初版未实现图片，不是已确认的素材下载故障 |
| 本站图片放在哪里 | 用户要求与公告单独管理；原静态服务只公开 `public/` 等既有挂载 | 已确认：需要新增只读路由，映射公告存储目录的 `assets/`；不使用 `public/assets` |
| 发布是否复制草稿图片 | `tools/announcements.mjs` 只读取并保存 Markdown 正文 | 已确认：草稿同目录 assets 不会自动搬到静态目录 |
| 支持来源 | 用户明确选择只支持 `runtime/announcements/assets`；澄清只禁止在 `public` 放图片 | 已确认：素材单独管理，不支持外链，允许前端显示代码修改 |
| 用户现存图片与正文 | 只读检查 `runtime/announcements/welcome.md`，引用 `./assets/image-20261009134437176.png`；对应文件存在 | 已确认：该写法受支持，图片接口 200、PNG、3565 字节，与磁盘逐字节一致；已有正文完整性校验有效，无需重新发布 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| 旧图片来源方案 | 暂定的 public/assets 与 HTTPS 外链方案已取消，新增 CSS 已撤回 | 按用户最新要求改用公告运行目录的 assets |
| `shared/announcementAssets.js` | 统一图片目录、只读地址、位图格式及安全路径规则；完整编码 URL 不超过 4096 字符 | 服务端与前端使用同一校验，兼容中文、空格、嵌套目录，避免路径穿越或编码膨胀产生必失败图片 |
| `server/http/announcementAssets.js`、`routes.js` | 专用 `/api/announcement-assets/` 路由只读取已配置公告目录的普通图片文件；逐层拒绝符号链接、隐藏文件与越界路径 | 私有正文、索引和通知命令不经图片路由公开，自定义公告目录仍生效 |
| `server/http/files.js` | 添加 BMP MIME，复用现有流式读取、HEAD、ETag、Last-Modified、字节范围；公告图片强制可重新验证缓存 | 避免新增依赖或把图片整文件常驻内存，同名文件替换可热更新 |
| `announcementMarkdown.js` | 支持内联图片、alt、标题与图片链接，接受 `assets/`、`./assets/` 和专用 API 地址；固定 img 节点，懒加载、异步解码、无 referrer | 普通与紧急弹窗共用修复，保持 HTML、代码、引用式图片和无效图片为文字 |
| `public/css/announcements.css` | 恢复用户澄清后允许的显示样式，图片最大宽度为正文宽度、高度等比 | 大图不撑破弹窗；本次没有写入任何 public 图片素材 |
| 使用说明与开发入口 | 添加图片目录/写法/备份说明及 D015、任务索引 | 明确素材不跟随 `--file` 自动复制，用户原有发布示例改动保留在工作区 |

每篇最多显示 32 张，超出时复用截断提示；每个文件最多 16 MiB。允许 PNG/JPG/JPEG/GIF/WebP/AVIF/BMP，不支持外链及其他本站素材。允许素材需自行保证是有效图片；接口按扩展名限制格式，不解码所有图片内容。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| 渲染器定向测试 `node --test test/ui/announcementMarkdown.test.js` | 原 19 项加 8 项图片测试 | 27/27；支持路径、转义 alt/title、代码/HTML/无效地址回退、链接内图片、32 张预算及下一篇重置通过 |
| 图片 HTTP / 共享路径定向测试，`test/announcement-assets-http.test.js`、`test/announcement-assets-shared.test.js` | 真实本地 HTTP、自定义目录、Windows 文件 symlink 与目录 junction | 13＋3＝16/16，零跳过；GET/HEAD、格式、缓存、热更新、Range、16 MiB 边界、路径/隐藏/私有目录/符号链接拒绝通过 |
| `node --test test/ui/announcements-ui.test.js test/ui/urgent-announcements-ui.test.js test/announcements-http.test.js` | 公告消费者与现有只读 API | 19/19；合计本次定向检查 62/62 |
| 八个修改的 JS 文件目标 ESLint；`npm run typecheck`；`git diff --check` | Node.js、既有依赖，不跑完整 lint/test/golden | 全部通过 |
| `node tools/check-imports.mjs` | 既有导入边界检查，非 strict | 退出码 0；仍报告原有 `server/sim/nodeData.js` 的 3 个 Node builtin 边界提示，不将其记成零问题 |
| `node .cache/announcement-images/browser-qa.mjs` | Edge 154.0.4258.62 无头；1280×720 / 844×390；普通标题页与真实 20 席位开局（1 真人＋19 AI）的紧急弹窗 | 4 个场景通过：2400 像素原图与中文空格嵌套图片正常显示、宽度不超正文、无横向溢出、正文可滚动、无外链图片请求、无页面错误；读取原始 HTML 为文字，代码内图片不加载 |
| 现存公告只读检查 | 默认 runtime 目录，新服务临时随机端口；没有发布或改写已有公告 | 原图片 API 200，3565 字节与磁盘一致，`welcome` 正文可校验读取；检查结束关闭临时服务 |

本次未运行完整对局、golden、完整 npm test 或真实二十人/多房间压测，图片修复不改变战斗或人数规则。浏览器截图、生成测试图片、隔离公告数据与配置在忽略的 `.cache/announcement-images/`；未写入 public 素材目录，不加入提交。线上未部署。

## 结果、遗留与接手

- 实现结果：公告图片显示与独立目录读取完成；用户现有 `./assets/` 写法无需修改或重新发布，更新服务代码、重启服务并刷新网页后生效。
- 未确定或未完成：多机部署须分别同步完整公告目录，仍无自动跨机同步；其他用户图片若路径不同需按使用说明核对。本次只核验这张现存图片。
- 提交 / 远程 / 素材 / 线上：代码与本文同一功能提交，按记录路径查询；未操作远程或部署；既有图片和公告未修改，用户原有使用说明一行修改不进入本次提交。
- 接手入口：`shared/announcementAssets.js`、`server/http/announcementAssets.js`、`public/js/ui/announcementMarkdown.js`、对应测试、[使用说明](../../ANNOUNCEMENTS.md#在公告中放图片)。

## 后续补充

无。
