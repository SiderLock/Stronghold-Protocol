# DEV-20261019-01 · 忽略本分支自有的美术素材目录与美术工程文件

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-19 / 2026-10-19，Asia/Shanghai |
| 状态 | 已完成：`.gitignore` 增补与定向检查通过；未推送、未发布、未部署 |
| 类型 | 文档（仓库配置） |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`68904720`；开始工作区 `.gitignore` 无改动，另有 36 项未跟踪的脚本与临时文件 |
| 上游基线 | v0.3.1 `d905c146`（本次不改动上游文件，基线未变化） |
| 提交归属 | 与本文同一提交，按记录路径查询 |
| 关联 | [.dockerignore](../../../.dockerignore)、`tools/package.mjs` 的 `REFUSE`、[test/gitignore.test.js](../../../test/gitignore.test.js)、[素材说明](../../ASSETS.md)、[前次记录 DEV-20261018-02](2026-10-18-02-asset-import-fixes.md) |

## 需求、范围与验收

用户要求（2026-10-19 原话）：「丰富下 gitignore，不要把我们的一些美术素材往上传，上游分支有的那些没关系。」

即：本分支自己产生或收集的美术素材（截图、对比图、宣传片、绘图工程文件）不要进 Git；上游分支本来就有、已经在仓库里的那些素材保持原样，不要因为新规则被误伤。

验收条件：

1. 本分支自有的美术素材目录与美术工程文件被 `git status` / `git add` 忽略；
2. 上游已跟踪的素材（`public/icons/`、`docs/img/`、`test/fixtures/`、`plugins/_template/cosmetic/media/`）行为不变：已跟踪文件继续能改能提交，上游合并带来的新文件照常进入工作区与索引；
3. 既有检查（`test/gitignore.test.js`、`test/scene-assets.test.js`、文档检查）继续通过。

授权范围：只改 `.gitignore` 与本文及记录索引；不动素材、不动上游跟踪内容、不推送、不部署。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 当前有没有「我们自己的、又没被忽略的」美术文件会被上传 | `git status --untracked-files=all`（36 项，全是脚本与临时文件）、`git diff --name-status upstream/master...HEAD` 按素材扩展名过滤（0 项）、工作区内按素材扩展名扫描 | 已确认：没有。官方素材都在已忽略的 `public/assets/`、`public/fonts/`、`.cache/`、`/runtime/` 里，本分支也没有新增任何素材文件 |
| 那缺口在哪 | `.dockerignore`（上游原样）已列出 `handoff`、`pv`、`3，9，11回合情况`、`review`；`tools/package.mjs` 的 `REFUSE` 同样拒收，注释写明是「owner-only notes, the promo project」；`test/package.test.js` 的夹具 .gitignore 也写着 `pv/` | 已确认：这四个目录是项目自己定义的维护者私有素材（截图、对比图、宣传片），发布工具和 Docker 都拒收，唯独 `.gitignore` 没写 —— `git add -A` 会把它们推上 GitHub |
| 忽略规则会不会连上游的素材一起挡掉 | 临时仓库实验：`.gitignore` 写入 `docs/img/` 后，合并一条新增 `docs/img/up2.png` 的分支 | 已确认：合并后 `up2.png` 照常落在工作区且已被跟踪；忽略规则不作用于索引内的路径，也不阻止合并写文件 |
| 新规则会不会命中已跟踪文件 | `git ls-files -z \| git check-ignore -z --stdin --no-index` | 已确认：0 个已跟踪文件被命中 |
| 要不要连 `docs/img/` 的新文件一起忽略 | `docs/PLUGIN-GUIDE.md`：「本仓库不放截图（截图里有官方游戏的美术，按规矩不能进 git）」；但上游会持续往 `docs/img/` 加图，用户也明确「上游分支有的那些没关系」 | 推断：本次不动 `docs/img/`。忽略新文件会让上游后续截图静默消失、也让本分支偶尔想补一张自有图时摸不着头脑；列为待用户确认项 |
| 要不要忽略 `*.svg` / `*.png` 之类所有图片 | `public/icons/app.svg` 是已跟踪的项目自有图标，上游还在持续扩这套图标 | 已确认不做：按扩展名一刀切会把项目自己要提交的原创图标一起挡掉，只忽略「工程文件与母版」格式 |
| 四个目录写不写前导斜杠 | `tools/package.mjs` 的判定是「命中自身或其下任意层级」；`test/package.test.js` 夹具用的是不带斜杠的 `pv/` | 已确认不带斜杠：与发布工具的语义一致，目录在仓库里的位置变化也不影响 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `.gitignore` 新增 `our own art material` 一节 | 新增四个目录规则：`pv/`、`review/`、`handoff/`、`3，9，11回合情况/` | 与 `.dockerignore`、`tools/package.mjs` 的拒收口径对齐；这四处装的是截图、对比图与宣传片，含官方美术 |
| 同上，新增绘图 / 图像母版格式 | `*.psd` `*.psb` `*.ai` `*.xcf` `*.kra` `*.afdesign` `*.afphoto` `*.procreate` `*.clip` `*.sai` `*.sai2` `*.aseprite` `*.ase`；`*.tif` `*.tiff` `*.tga` `*.bmp` `*.exr` | 这些是绘制工程与母版，永远不进发布包；客户端实际使用的 png / webp / jpg / svg / ico 一个都没进名单 |
| 同上，新增 3D 格式 | `*.blend` `*.blend1` `*.fbx` `*.obj` `*.ztl` `*.c4d` `*.max` `*.ma` `*.mb` | 本机提取与二创用的模型源文件，和官方 `.skel` / `.atlas`（在已忽略的 `public/assets/` 内）无关 |
| 同上，新增视频与剪辑工程 | `*.mp4` `*.webm` `*.mov` `*.mkv` `*.flv` `*.wmv` `*.aep` `*.prproj` `*.veg` | 宣传片与录制素材不随源码发布；仓库至今没有任何跟踪的视频文件 |
| 同上，新增音频母版 | `*.flac` `*.aif` `*.aiff` `*.wav` `*.aup` | 客户端只发 `.ogg` / `.mp3`（两者都已跟踪，未加入名单） |
| 同上，新增注释说明 | 写明「已跟踪的素材不受影响」与合并行为 | 用户明确要求上游已有素材不受影响，避免后来维护者以为规则会连上游素材一起挡 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| `git check-ignore -q --no-index`（应命中） | 仓库根目录，Node 22 / Git（WSL） | 9/9 命中：`pv/clip.mp4`、`review/1.png`、`handoff/wip-r46/fix-hits/before/a.png`、`3，9，11回合情况/r3.png`、`art/logo.psd`、`docs/a.kra`、`x.aseprite`、`cover.wav`、`promo.mov` |
| `git check-ignore -q --no-index`（不应命中） | 同上 | 通过：`public/icons/app.svg`、`public/icons/app-512.png`、`docs/img/combat.jpg`、`test/fixtures/forge/skin-pack/voice/select.mp3`、`plugins/_template/cosmetic/media/sample.png`、`plugins/_template/cosmetic/media/sample.ogg`、`public/i18n/zh-CN.json`、`package.json`、`data/assets.json` 全部未被忽略 |
| `git ls-files -z \| git check-ignore -z --stdin --no-index` | 全部已跟踪文件 | 通过：输出为空，没有已跟踪文件被新规则命中 |
| `git status --porcelain --untracked-files=all` | 改动前后对比 | 通过：仍然只有脚本、临时文件与 `tmp-import-test/`，没有美术文件被吞掉或新出现 |
| `node --test test/gitignore.test.js test/scene-assets.test.js` | 本地 Node | 通过：7/7（`gitignore` 2 项、`scene-assets` 5 项），无失败 |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | 本地 Node，含本文与索引 | 通过：32/32，无失败 |
| `node --test test/gitignore.test.js test/scene-assets.test.js test/docs-consistency.test.js test/docs-paths.test.js` | 本地 Node，一次合并运行 | 通过：39/39，0 失败、0 跳过（`duration_ms` 约 36.7 s） |
| 发行与开箱脚本是否受影响 | `scripts/make-windows-bundle.mjs`、`scripts/make-unix-bundle.mjs`、`tools/package.mjs` 的文件清单来源 | 已确认：三者都用 `git ls-files`（只收已跟踪文件），不读 `.gitignore`；本次改动不可能改变任何发行包内容 |

跳过的检查及原因：没有跑完整 `npm test` / golden / 浏览器套件 —— 本次只改 `.gitignore` 与文档，不触及运行代码、数据与素材；golden 与浏览器行为不可能因此变化。

## 结果、遗留与接手

- 实现结果：`.gitignore` 增加一节「本分支自有美术素材」规则（四个维护者私有目录 + 绘图 / 3D / 视频 / 音频工程格式），并注明上游已跟踪素材不受影响。
- 未确定或未完成：
  1. 「我们的美术素材」的具体目录尚未经用户确认。本次按项目自身口径（`.dockerignore` / `tools/package.mjs`）落地；如果实际素材放在别处（例如仓库根目录直接丢 png / jpg，或 `SP_ANNOUNCEMENTS_DIR` 指到仓库内某个目录），还需要按同样方式补一行。
  2. `docs/img/` 是否也要忽略新文件，待用户决定（见「调查与决定」）。
  3. 仓库根目录的临时文件（`tmp-*`、`tmp-import-test.zip`）与 `scripts/remote-*.sh`、`scripts/sshpass.py` 仍未被忽略；它们不属于美术素材，本次未动。注意 `scripts/sshpass.py` 这类运维脚本可能带服务器口令，是否入库请用户明确。
- 提交 / 远程 / 素材 / 线上：本地提交，未推送、未发布、未部署；素材文件未改动。
- 接手入口：`.gitignore` 的 `our own art material` 一节；对照 `.dockerignore` 与 `tools/package.mjs` 的 `REFUSE` 名单；`test/gitignore.test.js` 在改动后必跑。
