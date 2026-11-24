# DEV-20261124-02 · 本机提取器补齐规程素材（3D 场景、特效、开场）

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-11-24 / 2026-11-24，Asia/Shanghai |
| 状态 | 已完成（提取 + 下载补齐；24 个镜像缺口见「遗留」） |
| 类型 | 素材提取（本机，资产不进 Git） |
| 分支与开始 HEAD | `dev`，`0f571f88`（与 `origin/dev` 一致），工作区干净 |
| 客户端 | 本机 `D:\Hypergryph Launcher\games\Arknights`；打包基线 `26-10-20-11-10-38-04170990` + 热更新 `26-11-13-06-34-18-84612175`（1,586 个下载、13,300 个打包、941 个缺失） |
| 工具 | `tools/local-extract/extract.py`（`.venv-extract-win`，Python 3.12.10，UnityPy 1.25.4 / Pillow 13 / lz4 4.4.5） |
| 关联 | 收尾 [DEV-20261124-01](2026-11-24-01-upstream-dev-round84.md)；待办 I006 |

## 需求、范围与验收

用户 2026-11-24：「好的 执行一下我们的提取器，补充一下内容」。

范围：用本机客户端的本地提取器补齐 2026-11-19 合并 0.4.0 后缺失的规程素材（I006 的提取部分）。验收：
规程十个战场的 3D 场景可被服务端以 `/assets/local/scene/<stage>/scene.json` 提供；规程单位 / 敌人 / 盐坨子炮等的
官方特效进入 `data/local-fx.json`；大厅规程开场（season entry）可加载；提取后两本清单与实际文件一致，服务端能启动并
返回这些资源。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 客户端在哪、是否含规程素材 | 磁盘扫描 `Arknights_Data`；`--print-jobs`；`bundles.py` 的客户端报告 | `D:\Hypergryph Launcher\games\Arknights`，含 `map_autochesssand` / `map_syracuse_metro` / `map_icewild` / `map_ltny2` 四组规程战场依赖与热更新 26-11-13。已确认 |
| 本机缺什么 | `data/local-assets.json` 的 groups、`data/local-fx.json` 的 prefabs、`public/assets/local` | 缺 `scene/act3autochess_m01..m12`（十个战场）与 `ui/season/act3autochess`（开场）；fx 索引停在 21,490 条 / 11,655 个 prefab，没有盐坨子炮的 `trap_cnnon_*`。已确认 |
| 指南页能否提取 | 客户端 `--only guide` 输出 | 该客户端没有 `arts/guidebookpages/[pack]autochess.ab`，提取器跳过；指南页来自公开镜像（`tools/fetch-assets.mjs`），不属于提取。已确认 |
| 是否需要重提 `spine/enemy` / `spine/token` | `extract.py` 的 `ENEMY_SPINES` / `TOKEN_SPINES` 与本地目录对照 | 两份清单仍是 8 名敌人 + 40 个召唤物，本地全在；无需重提。已确认 |
| 官方主题（`--only theme`） | 帮助文本：写成 scratch，官方素材不进 Git | 可选，且需要主题包安装流程；本次不改，见「遗留」。已确认 |

## 实现或操作

| 命令 / 操作 | 结果 | 说明 |
|---|---|---|
| `python tools/local-extract/extract.py --game "D:\Hypergryph Launcher\games\Arknights" --only scene/act3autochess_m01` | 15 个文件，m01 21 chunks / 165,453 顶点 / 1 张光照图 | 先单stage试跑，确认能读客户端、清单只替换该组 |
| 同上，`--only scene/act3autochess_m02 … m06 --only scene/act3autochess_m09 … m12 --only ui/season/act3autochess --only guide` | 126 个文件；其余九个战场 + 规程开场；`guide` 因客户端缺 bundle 跳过 | 十个战场共 40 个文件 / 168.8 MB；开场 53 个文件 / 9.2 MB |
| 同上，`--only fx --fx-set used --fx-add-only --fx-jobs 8` | 739 个新 prefab、1,110 张贴图、273 个网格，3,230 个文件；`data/local-fx.json` 由 21,490 → 22,489 条（prefab 11,655 → 12,394） | 提取完成；进程退出时临时目录清理报 `PermissionError [WinError 32]`，见「验证」与「遗留」 |
| 清理 `E:\Temp\sp-client-bundles-6tnsxqfx`（27.8 GB） | 已删除 | 提取器在 Windows 上退出时没删掉的客户端临时副本 |

盐坨子炮的 11 个特效 prefab 已入索引：`trap_cnnon_{idle,start,attack_start,buff,lockon,trail_1,trail_2,explode_1,explode_2,explode_hit,destroyed}`，与
[ASSETS](../../ASSETS.md) 里 `--fx-keys` 的名字一致。

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| 清单与文件一致性 | `data/local-assets.json`（93 组 / 1,971 条）与 `data/local-fx.json`（22,489 条 / 12,394 prefab） | 两本清单逐条 `existsSync`：缺文件 0 / 0 |
| 服务端提供新资源 | `PORT=8124 node server/index.js` | `/healthz` 200；`/assets/local/scene/act3autochess_m01/scene.json` 200（15,673 B）；`/assets/local/fx/prefabs/trap_cnnon_idle.json` 200（9,074 B）；`/assets/local/ui/season/act3autochess/entry/prefabs.json` 200（85,673 B） |
| 提取器测试 | `node --test test/local-extract*.test.js` | 54 项全部通过（含改名后的 `local-extract-skins`） |
| 语法 | `python -m py_compile` 六个模块 | 通过 |
| 客户端报告 | 提取日志首行 | 热更新 26-11-13 覆盖打包 26-10-20；1,586 下载 / 13,300 打包 / 941 缺失 |

边界：没有在浏览器里逐场景目视检查（浏览器套件未启用）；`--only fx` 的退出码是 1——只是退出时清理临时目录失败，
数据与清单在报错前已写完并由上面的逐条检查确认。

## 结果、遗留与接手

- 实现结果：规程十个战场 3D 场景、规程开场素材、739 个新特效 prefab（含盐坨子炮）已提取，并入两本本机清单；服务端可直
  接提供。
- 未确定或未完成：清单引用只剩 24 个镜像侧没有源文件的 BGM / 敌人音效（上游缺口，本机无法补齐）；官方主题
  （`--only theme`）可选，需主题包安装流程；`assets.test.js` 的磁盘清单仍因这 24 个失败，`ui/localArt` 仍要求本机
  清单有 `guide` 组（客户端没有 guide bundle），`assets-season-music` / `audio-pools-data` 依赖 `.cache/gamedata`，
  这些只影响本机、CI 不受影响。
- 提交 / 远程 / 素材 / 线上：素材与清单全部被 `.gitignore` 排除，本次只有文档提交；未打包、未部署。
- 接手入口：本记录；`tools/local-extract/extract.py`；`data/local-assets.json` / `data/local-fx.json`；
  [LOCAL_ASSET_EXTRACTION](../../LOCAL_ASSET_EXTRACTION.md)、[ASSETS](../../ASSETS.md)。

## 后续补充

2026-11-24（下载补齐）：提取之外，清单里还缺 2,949 个「只能下载、不能提取」的文件（2,091 个语音 mp3、558 张
干员图、300 个干员 Spine 文件），于是接着跑了 `node tools/fetch-assets.mjs --add-only --concurrency=16`
（19,103 项计划，跳过已有；136 秒，约 3,000 个文件实际下载）。结果：

- 缺失引用 2,949 → **24**：规程三名干员语音、干员图与 Spine 已齐；指南页 19 张在 `public/assets/ui/guide/`；
  `feedback7-voices`（248 名干员的 JP 全量对照）由失败转为通过。
- 剩余 24 个是镜像侧没有源文件的规程 BGM（`m_sys_act3autochess_loop`、`m_boss{1,2}_act3autochess_loop`）与
  24 个敌人 / 环境音效（`a_bat_*`、`e_atk_*`、`e_imp_*`），规划阶段就报 `not found`；属上游资源缺口，本机无法补齐。
- **没有提交重新生成的 `data/assets.json`**：本机 `.cache/gamedata` 比上游提交清单的生成基线新，`--add-only`
  跑完后清单变成 21,432 文件 / 249 名语音干员（原 21,390 / 248），字节数也变了；那是另一次数据更新（会影响卡面与
  语音树），不属于素材补齐，已 `git checkout` 还原为上游清单。
- 因此 `test/assets.test.js` 的「every manifest path exists on disk」仍因这 24 个镜像缺口失败（下载前是 2,949 个），
  `test/ui/localArt.test.js` 仍要求本机清单有 `guide` 组（本机客户端没有 guide bundle，该组无法由提取器产生）。
