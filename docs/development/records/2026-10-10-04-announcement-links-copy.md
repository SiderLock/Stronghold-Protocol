# DEV-20261010-04 · 公告网址点击与正文复制

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-10 / 2026-10-10，Asia/Shanghai |
| 状态 | 已完成 |
| 类型 | 修复 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`066efb9fcd68a05f91ff5990a8ef0d6080f4f46c`；开始时工作区干净 |
| 上游基线 | 已合并 v0.2.2，`62eb113419123d9a3a63606107bbf85230c5dd2f`；本次未联网刷新 |
| 提交归属 | 与本文同一提交，按记录路径查询 |
| 关联 | [D014](../DECISIONS.md#d014)、[D015](../DECISIONS.md#d015)、[前次公告图片修复](2026-10-09-02-announcement-images.md) |

## 需求、范围与验收

用户希望公告中的网盘等链接能直接打开，并报告公告内容无法选中复制。补齐直接粘贴的 HTTP/HTTPS 网址与尖括号网址自动链接；正文允许使用原生鼠标选中、Ctrl+C/右键复制。标准 Markdown 链接保留现有新标签页行为。

仅修改普通/紧急公告共用渲染器、公告文字样式及相关测试/使用说明/开发记录。不改发布工具、图片目录、公告存储、游戏玩法或其他界面。选择复制为浏览器原生操作，不新增一键复制按钮、权限请求或剪贴板依赖。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 链接是否已有支持 | `announcementMarkdown.js` 的 inline links 分支与 renderInline | 已确认：`[标题](https://...)` 可点击，HTTP/HTTPS 打开新标签页，带 noopener/noreferrer；裸 URL 尚未转成链接 |
| 正文为何无法选中 | `public/css/theme.css` 的 body `user-select: none`；公告样式没有覆盖 | 已确认：公告继承禁止选择文字，添加局部 text 覆盖即可，不需取消全游戏限制 |
| 复制快捷键会否被抢占 | Modal 仅处理 Tab/Escape，游戏快捷键拒绝 ctrl/meta 修饰键；Edge 鼠标拖选后真实 Ctrl+C | 已确认：普通与紧急通知的提取码可选中，读取到的剪贴板文本与所选文字一致 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `public/css/announcements.css` | 共用 Markdown 正文设置 `-webkit-user-select: text` / `user-select: text` | 恢复普通/紧急正文、代码与链接文字选中能力 |
| `announcementMarkdown.js` 的 `bareUrlAt`、`parseInline` | 识别直接粘贴 HTTP/HTTPS 与尖括号网址，复用安全链接 AST；保留查询参数、下划线和片段，尾部句读作为文字 | 网盘分享链接无需人为改成 Markdown，提取码和句末标点不混入地址 |
| 既有代码/HTML/链接/图片解析 | 在相应语法之后识别裸网址，显式链接标签内关闭自动链接；无效或未闭合链接/图片继续文字回退 | 不产生嵌套锚点，不使外链图片重新加载；固定 Preact 节点不拼接 HTML |
| `test/ui/announcementMarkdown.test.js` | 8 项自动链接用例，包括分享参数、安全拒绝、语法优先级和节点预算 | 对实际行为与安全边界做回归；不为一行 CSS 添加镜像测试 |
| `docs/ANNOUNCEMENTS.md`、D014、入口及索引 | 增加三种链接写法、提取码与原生复制说明 | 使用说明与共享渲染器实际能力一致 |

本次仅增加已有链接渲染器的识别能力与公告正文选择样式，没有修改服务器或发布格式；已发布公告刷新网页后可受益，不需为了显示能力重新发布。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `node --test test/ui/announcementMarkdown.test.js` | 原 27 项＋新增 8 项 | 35/35；裸/尖括号网址、网盘 query/fragment、下划线与平衡括号、尾部句读、危险地址、代码/HTML/链接/图片优先级和长输入预算通过 |
| `node --test test/ui/announcements-ui.test.js test/ui/urgent-announcements-ui.test.js test/docs-consistency.test.js test/docs-paths.test.js` | 普通/紧急消费者 17 项，既有文档 31 项 | 48/48；本次定向模块及文档检查合计 83/83 |
| `npx eslint public/js/ui/announcementMarkdown.js test/ui/announcementMarkdown.test.js`；`git diff --check` | 修改的 JS 与最终差异范围 | 通过 |
| 修改文档相对链接检查 | 去除围栏示例，核对本次五份文档本地目标 | 126 个目标存在；记录索引保持同一 Markdown 表格 |
| `node .cache/announcement-links-copy/browser-qa.mjs` | Edge 154.0.4258.62 无头；1280×720 / 844×390；标题页普通公告、真实 20 席位开局紧急通知（1 真人＋19 AI） | 4 场景通过：每场三种链接真实点击打开新标签页，原游戏页面保留、opener 为 null、query/fragment 逐字一致；鼠标拖选「提取码：a1b2」、实际 Ctrl+C 后剪贴板与选中文字一致；代码文字 user-select=text；无页面错误或横向溢出 |
| 测试资源释放检查 | 浏览器 PID 248988、临时服务器端口 59890；弹出页均在 finally 关闭 | 浏览器退出，PID 不存在；服务关闭后本机连接返回 ECONNREFUSED，最终监听检查无记录；短测试进程结束，没有遗留本次浏览器或服务器 |

浏览器点击使用本机 `/healthz` 测试目标，避免访问真实私人网盘或外部站点；HTTPS 网盘地址及分享参数由解析器测试验证。浏览器测试权限仅用于读取测试剪贴板结果，产品没有新增剪贴板权限申请。没有验证真实网盘分享是否有效，也未运行完整对局、golden、完整测试集或真人压测；本任务不改变战斗流程。测试图片、结果与隔离浏览器目录只留在忽略缓存。

## 结果、遗留与接手

- 实现结果：普通公告及紧急通知可点击三种 HTTP/HTTPS 链接，并原生选中复制正文；现有公告刷新网页后生效。
- 未确定或未完成：未联网访问真实网盘，不验证网盘内容有效性；验证公告向指定地址打开的行为。
- 提交 / 远程 / 素材 / 线上：代码与本文同一修复提交，按记录路径查询；未操作远程、素材或部署。
- 接手入口：`public/js/ui/announcementMarkdown.js`、`public/css/announcements.css`、`test/ui/announcementMarkdown.test.js`、[使用说明](../../ANNOUNCEMENTS.md)。

## 后续补充

无。
