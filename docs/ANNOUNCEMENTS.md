## 用法

```bash
# 发布；--pin 同时置顶。--id 设置公告编号，如果省略--id会自动生成编号
# 下面命令请在项目根目录执行
# 公告内容采用.md文件编写，并且--file后面的路径要指向你要发布的公告的文件的位置,比如下面./notice.md，“./”表示当前命令所在目录下

node tools/announcements.mjs publish --id welcome --title "开服公告" --file ./notice.md
--pin

# 查看编号和发布时间
node tools/announcements.mjs list

# 更改置顶或取消置顶，pin后面是编号
node tools/announcements.mjs pin welcome
node tools/announcements.mjs unpin

# 删除指定编号的公告；先用 list 找到编号
node tools/announcements.mjs delete welcome
```

# 下面都是AI写的，用法看上面我写的

# 服务器公告

公告不需要账号、数据库或网页管理后台。服主在运行游戏的服务器终端发布 UTF-8 Markdown 文件，游戏运行中读取更新，无需重启。

## 玩家看到什么

- 输入代号的标题页和大厅提供「公告」按钮；历史标题和正文独立滚动，小屏可在列表与正文间切换。
- 默认打开唯一的置顶公告；没有置顶时打开最新发布的公告。置顶期间该公告也排在历史列表首位，其余按发布先后而非日期；取消置顶后恢复原发布位置。
- 有公告时进入网站自动打开；「下次不再显示」保存在当前浏览器，直到发布新公告后恢复提醒。手动按钮不受影响。
- 调整置顶不重置免提示；不同浏览器、设备和不同站点地址分别保存偏好。清理站点数据会清理偏好。
- 对局中及恢复对局时，普通发布不会自动弹窗。空安装没有公告时仅保留按钮，不自动打开空弹窗。

## 发布、置顶和查看

在项目目录中准备正文，例如 `runtime/welcome.md`：

```markdown
# 欢迎博士

本服务器已更新，请留意以下安排。

- 20:30 计划重启服务器。
- 请提前结束对局。
```

```bash
# 发布；--pin 同时置顶。省略 --id 会自动生成公告编号
node tools/announcements.mjs publish --id welcome --title "开服公告" --file runtime/welcome.md --pin

# 查看编号和发布时间
node tools/announcements.mjs list

# 更改置顶或取消置顶
node tools/announcements.mjs pin welcome
node tools/announcements.mjs unpin

# 此命令可以向正在局内的玩家发布紧急通知，紧急通知只能指定之前发过的公告，maintenance就是编号示例
node tools/announcements.mjs notify maintenance
```

已有编号不能重复发布或覆盖；修正或恢复公告时用新编号发布，产生新的提醒版本。请使用工具发布，不手工修改已发布的正文或索引；完整性检查会拒绝未登记的修改。

支持标题、段落、粗体、斜体、列表、引用、分隔线、行内代码、围栏代码、安全链接和公告图片等常用 Markdown。原始 HTML 显示为文字；不是完整 Markdown 扩展实现，不支持任意网页或脚本。标题最多 120 个 Unicode 字符，正文最多 50,000 个 UTF-16 字符且不超过 128 KiB，最多保存 2,000 条公告。

## 删除公告

先查看公告编号，再删除对应的一条。命令在游戏服务器的项目目录执行：

```bash
node tools/announcements.mjs list
node tools/announcements.mjs delete welcome

# 使用了自定义公告目录时，和服务器保持一致
node tools/announcements.mjs delete welcome --dir /srv/stronghold-data/announcements
```

`welcome` 换成要删除的公告 ID。删除后，公告从历史列表和公开详情中移除，工具保存的对应 `<ID>.md` 正文也会删除；如果它正被置顶，会同时取消置顶。游戏服务器无需重启，网页下次检查、刷新公告列表或重新打开时更新；已经显示的内容不会被远程立即抹掉。

删除不产生新发布版本，不会使已勾选「下次不再显示」的玩家重新收到旧公告；删除最新一篇或删空也一样。之后真正发布新公告才恢复提醒。取消置顶和删除都不会隐式发送局内紧急通知。

删除保留你用 `--file` 指定的原始草稿和公告目录的 `assets/` 图片，避免误删其他公告共用的素材。若工具提示正文文件清理失败，公告已经从列表撤下，按提示检查该私有目录的残留文件；不要手工改索引。需要恢复时用新 ID 重新发布，发布会产生新的提醒。

`list` 的文字输出与网页一样将置顶列在首位；供脚本使用的 `list --json` 保留原发布顺序，总体 `revision` 记录最近一次发布，即使那篇后来被删除。公开 HTTP 接口仍然只读，删除只由服主终端执行。

## 链接与复制

网盘等 HTTP/HTTPS 链接可以直接点击，在新标签页中访问，游戏页面继续保留。推荐用 Markdown 为链接标明用途；直接粘贴完整网址或使用尖括号网址也能点击：

```markdown
[下载素材包](https://pan.example.com/s/示例?pwd=a1b2)

https://pan.example.com/s/示例?pwd=a1b2

<https://pan.example.com/s/示例?pwd=a1b2>

提取码：a1b2
```

将示例网址替换成实际分享链接，提取码另写一行。网址参数和片段标识会保留；普通公告、紧急通知正文均可用鼠标选中文字后按 `Ctrl+C` 或右键复制，也可以复制代码和链接文字。行内/围栏代码、原始 HTML 中的网址保留文字；没有 `http://` 或 `https://` 前缀的网址不自动变成链接。

## 在公告中放图片

图片与公告一起单独管理，不放在 `public`。使用默认目录时，将图片放进项目下的 `runtime/announcements/assets`（没有这个子目录时自行创建），例如：

```text
runtime/announcements/assets/banner.png
runtime/announcements/assets/update/team.webp
```

Markdown 写法：

```markdown
![开服安排](assets/banner.png)
![队伍示意](assets/update/team.webp "队伍分组")
```

`assets/` 固定表示公告存储目录下的图片目录，不表示草稿所在目录；`./assets/` 写法也支持。草稿仍可放在任何位置，`--file` 只复制 Markdown 正文，图片须由服主另行放到上述目录。使用 `SP_ANNOUNCEMENTS_DIR` 或 `--dir` 更改公告目录后，图片相应放在该目录的 `assets/` 中。

图片通过本站 `/api/announcement-assets/` 地址只读提供，普通公告与紧急通知共用。仅支持 PNG、JPG/JPEG、GIF、WebP、AVIF 和 BMP；不支持外链、`public/assets` 图片、SVG、HTML 或本机磁盘路径。文件名与扩展名大小写在 Linux 上必须一致；文件名有空格时写成 `![说明](<assets/图片 1.png>)` 或将空格写成 `%20`。

每篇最多显示 32 张图片，超出时显示已有的截断提示；每张文件不超过 16 MiB。图片按正文宽度等比缩放，滚动到附近才加载。更换图片建议使用新文件名；更新公告内容仍用新公告编号发布。Git 和发布包不会包含公告运行目录或这些图片，迁移和备份时复制完整公告目录（包含 `assets/`）。

## 存储与部署

默认存储路径为项目下的 `runtime/announcements`，包含 `index.json` 和各篇 `.md`。该目录不会提交到 Git，也不会通过静态文件服务公开；备份公告时完整备份目录。

服务器与发布工具必须使用同一个目录。可在启动服务器及执行工具时设置 `SP_ANNOUNCEMENTS_DIR`，或为工具指定 `--dir`：

```bash
export SP_ANNOUNCEMENTS_DIR=/srv/stronghold-data/announcements
npm start

# 另一个终端，环境变量须一致
node tools/announcements.mjs publish --title "更新通知" --file /srv/notices/update.md --dir /srv/stronghold-data/announcements
```

相对目录按项目根目录解析；正文 `--file` 按执行命令的当前目录解析。公告目录需要服主读写权限，不要放在 `public` 中。多台服务器默认各自维护公告；统一发布时同步完整公告目录，账号、数据库和跨机器自动同步不在本功能范围。

公开接口只有 `GET/HEAD /api/announcements` 和 `GET/HEAD /api/announcements/<id>`。接口不提供发布能力，响应不缓存；前者只返回标题等元数据，正文按查看需求读取。非对局页面约每分钟检查一次新发布，普通检查不在对局中运行。

## 局内紧急通知

普通 `publish` 命令只发布历史公告，不触发局内弹窗。需要通知正在游玩的玩家时，再显式发送已发布公告的编号：

```bash
node tools/announcements.mjs publish --id maintenance --title "服务器维护通知" --file runtime/maintenance.md
node tools/announcements.mjs notify maintenance
```

`notify` 命令和服务器应使用同一公告目录（环境变量或 `--dir` 同上），以运行服务器的账户执行。运行中的服务器约每秒检查一次发送命令，向所有在线连接发送小型引用，玩家按需读取正文；玩家、观战者、标题页及大厅都能收到。

紧急弹窗独立于「下次不再显示」，没有免提示选项。收到的多条通知按队列依次显示，可关闭或按 Esc；正在显示的通知会留到玩家关闭，对局继续计时和战斗，弹窗会标明这一点。每个浏览器最多保留 32 条通知（包含正在查看的一条），过期的排队通知自动丢弃。

发送命令有 5 分钟有效期，保存在私有目录的 `commands/` 中；每次发送顺手清理已到期的有效命令。服务器启动时跳过已有命令，因此停机期间发送、发送后重启、断线后重连的玩家不会收到旧通知的补发。命令成功表示已提交发送请求，不代表每个玩家已阅读；发紧急通知时请确认服务器正在运行。需要再次提醒时可再次执行 `notify`，它会生成新的独立发送编号，不必重新发布正文。

发布、置顶、取消置顶和删除都不隐式执行 `notify`。删除也不是紧急通知的撤回命令：已发到浏览器或已显示的正文不会被强制关闭；尚未读取的已删正文会显示不可用，可以正常关闭。已删除的 ID 不能再 `notify`，服务端尚未发出的旧引用也不会广播该正文。HTTP 和玩家 WebSocket 请求均没有发送权限。多服务共享同一个公告目录时，每个运行中的进程独立处理新命令；不同机器各自存储时，要在对应服务器分别执行发送。

工具写入时使用短暂文件锁。命令异常被强制终止而遗留锁时，先确认没有其他发布进程，再检查并移除错误中指出的锁文件，随后重试；不要删除索引或仍有效的命令。
