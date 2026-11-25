# DEV-20261124-03 · 合入 master 与 v0.4.0-20p.3 便携包

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-11-24 / 2026-11-24，Asia/Shanghai |
| 状态 | 已完成（候选包已生成并核验，尚未发布） |
| 类型 | 发布准备（PR 合并 + 候选包构建） |
| 分支与源码 | `dev` → `master` 的 PR #6 已合并为 `b581e882`；候选包源码提交 `9563b450`（干净 HEAD，与 `master` 树一致） |
| 工具 | `tools/release-candidate.py`（Python 3.12.10）、`tools/release-plan.mjs`、四个官方 Node 归档 |
| 关联 | [DEV-20261124-01](2026-11-24-01-upstream-dev-round84.md)、[DEV-20261124-02](2026-11-24-02-regulation-local-extract.md)；发行说明 [v0.4.0-20p.1](../../releases/v0.4.0-20p.3.md) |

## 需求、范围与验收

用户 2026-11-24：「将我们的 dev pr 到我们的 main 里面，然后使用 tech-chinese skill 对 readme 进行优化。然后打一下便携包和完整包，注意按照之前的要求，合入完整包的素材只包含上游有的素材，不把我们本机提取的素材放进去。」用户在同一轮确认按 [RELEASE_PACKAGES](../../RELEASE_PACKAGES.md) 的正式候选流程走（四平台）。

验收：

1. `dev` 合入 `master`，CI 通过；
2. `README` 按 `zh-tech-writing` 整理，链接与锚点不变；
3. 四平台候选包生成，`README-开箱即用.md`、`RELEASE.json`、`更新说明.md`、`ReleaseNotes.md`、`ServerAnnouncement.md`、`SHA256SUMS.txt` 齐全；
4. 包内素材全部来自上游 v0.4.0 归档，本机提取的素材（场景、特效、时装、`data/local-skins.json`）不出现。

## 决定与依据

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 用哪条打包线 | `docs/RELEASE_PACKAGES.md`「维护者使用 `tools/release-candidate.py`」；用户本轮选择该选项 | 用候选工具生成四个平台包；已确认 |
| 上游素材来源 | GitHub Release `sganggs/Stronghold-Protocol` `v0.4.0`：`Stronghold-Protocol-v0.4.0.zip`，1,145,084,137 B，SHA-256 `aded7ef9…a0b45`（与 API `digest` 一致） | 只从该归档取 `public/assets/`、`public/fonts/` 与三个索引；已确认 |
| Node 版本 | 现有候选工具固定 Node 22.23.3 与四个平台归档哈希 | 沿用固定值，下载后逐一校验通过；已确认 |
| `README` 的标题层级与锚点 | `docs-paths` 与目录链接依赖锚点；本轮是措辞整理 | 只改句子、标点与分段，不动标题；已确认 |
| 为什么重建候选 | 首次构建（`a6569ea7`）后 `static-local-art` 测试发现两处被断言的原文被改写，修复提交在 `9563b450` | 用最终源码重建一次，产物与源码提交对齐；已确认 |

## 实现或操作

| 操作 | 结果 | 说明 |
|---|---|---|
| `dev` → `master` PR #6 | 合并为 `b581e882`，CI（push 与 pull_request 两次）全绿 | PR 正文列出内容、来源、验证、golden 位移与 `[ASSUMED]` |
| `README` 整理 | 17 处替换：拆长句、破折号改冒号、日期与等级范围用「至」、更新包拆三步、两段拆段 | 链接、版本号、锚点不动；`static-local-art` 与 `docs-paths` 复跑通过 |
| 更新 `tools/release-plan.mjs` / `tools/release-candidate.py` | `RELEASE=v0.4.0-20p.1`、上游归档与哈希指向 0.4.0、公告保留 0.4.0 / 0.3.3 两段、包内说明同步版本 | 与 [v0.4.0-20p.3 发行说明](../../releases/v0.4.0-20p.3.md) 一起提交 |
| 下载并校验输入 | 四个 Node 归档哈希与固定值一致；上游归档 1,092 MiB、哈希一致 | 输入在 `.cache/release-candidate-20261124/downloads/` |
| 首次候选构建 `D:\release-candidate-20261124-01` | 四包生成、`verify_archive` 通过 | 源码 `a6569ea7`，后因 README 修复废弃 |
| 最终候选构建 `D:\release-candidate-20261124-02` | 四包生成、`verify_archive` 通过；1,304 个允许的源码文件、38,745 个上游素材文件、`MANIFEST.json` 7,429 条 | 源码 `9563b450` |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| 归档自校验 | `verify_archive`（逐文件 CRC、文件集合与 inventory 比对） | 四个包全部通过；Windows 46,185 文件、Linux 46,185、两个 macOS 各 46,186 |
| 包内素材来源 | `upstream-art-provenance.json`（上游 38,745 条逐文件 sha256） | 所有 `public/assets/**`、`public/fonts/**` 与三个索引与上游归档逐字节一致；构建时日志「checkout art never copied」 |
| 本机素材排除 | 包内 `app/data`、`app/public/assets/local` | 无 `data/local-skins.json`；无 `public/assets/local/skins`；fx 索引 5,458 个 prefab，无 `trap_cnnon_*`（本机提取的 11 个没进包）；场景采用上游版本（m01 16,020 B，本机提取版为 15,673 B） |
| 包结构 | `RELEASE.json` | `release=v0.4.0-20p.1`、`appVersion=0.4.0`、`source=9563b450…`、Node 22.23.3 与四个归档哈希、`art.policy=verified-upstream-only` |
| Windows 实机启动 | 解压后用包内 `node\node.exe` 启动 `app/scripts/launch.mjs --no-setup --no-browser` | `/healthz` 200；`/assets/local/fx/index.json` 200（8,356,548 B） |
| 校验文件 | `SHA256SUMS.txt` | 四个包的各 SHA-256 与 `archive-verification.json` 一致 |

## 结果、遗留与接手

- 产物：`D:\release-candidate-20261124-02\`
  - `Stronghold-Protocol-v0.4.0-20p.1-Windows-x64.zip`（1,187,082,532 B，`522fe093…`）
  - `…-linux-x64.tar.gz`（1,173,326,480 B，`00e0a228…`）
  - `…-darwin-arm64.tar.gz`（1,166,417,124 B，`9f25cde9…`）
  - `…-darwin-x64.tar.gz`（1,167,635,875 B，`920788cb…`）
  - 同时有 `ReleaseNotes.md`、`ServerAnnouncement.md`、`SHA256SUMS.txt`、`upstream-art-provenance.json` 与各包 `PACKAGE-MANIFEST.json`。
- 未确定或未完成：macOS 两个包只做了归档、架构与权限核验，未实机启动；Linux 同样只有结构核验（文档明确要求不能由 Windows 检查替代）；
  `tools/package-smoke.mjs` 面向 `npm run package` 的布局，不认候选包根下的 `app/`，本轮改用「解压 + 包内 Node 启动 + HTTP 探活」的冒烟。
- 提交 / 远程 / 素材 / 线上：PR 已合并、`dev` 已推送；候选包在仓库外，**没有**上传 Release、打 tag 或部署；游戏素材不进 Git。
- 接手入口：本记录；`docs/releases/v0.4.0-20p.3.md`；`docs/RELEASE_PACKAGES.md`；`tools/release-candidate.py`。

## 后续补充

2026-11-25（换发行标签并发布）：核对公开状态发现 `v0.4.0-20p.1` 的 tag 指向 `f7d7f6a8`、`v0.4.0-20p.2`
指向 `a7172dc4`，两者都是第 84 轮之前的历史提交，且都没有附件。本记录 11-24 的构建名带 `.1`，
若把第 84 轮的包挂到 `.1`，GitHub 的源码下载和便携包会对应不同提交。因此：

- `RELEASE` 改为 `v0.4.0-20p.3`（`tools/release-plan.mjs`、`tools/release-candidate.py`），发行说明改名
  [v0.4.0-20p.3](../../releases/v0.4.0-20p.3.md)，`docs/RELEASE_PACKAGES.md` 同步；
- 候选包按新的源码提交重建并发布为 `v0.4.0-20p.3`，四个平台包与 `SHA256SUMS.txt` 一起上传，源码下载与包内
  `RELEASE.json` 的 `source` 指向同一提交；
- 11-24 的 `.1` 构建产物（`D:\release-candidate-20261124-02`）只作历史留存，不再上传。

2026-11-25（发布结果）：PR #7 合并为 `482eb3a7`，CI 全绿；用该提交重建候选（`D:\release-candidate-20261125-01`），
发布 [v0.4.0-20p.3](https://github.com/SiderLock/Stronghold-Protocol/releases/tag/v0.4.0-20p.3)。五个附件：

| 附件 | 字节 | SHA-256 |
|---|---|---|
| `Stronghold-Protocol-v0.4.0-20p.3-Windows-x64.zip` | 1,187,083,360 | `3e8afa7e…` |
| `…-linux-x64.tar.gz` | 1,173,322,385 | `e3371e02…` |
| `…-darwin-arm64.tar.gz` | 1,166,416,204 | `5453599f…` |
| `…-darwin-x64.tar.gz` | 1,167,635,101 | `c410272d…` |
| `SHA256SUMS.txt` | 467 | 与本地一致 |

核对结果：tag `v0.4.0-20p.3` → `482eb3a7`（`target_commitish=master`），包内 `RELEASE.json.source` 同为
`482eb3a7…`；`codeload` 的源码 zip 返回 200；GitHub 的 `releases/latest` 指向本版；发布体由
`ReleaseNotes.md` 生成，链接指向该提交。macOS / Linux 仍只有结构核验，Windows 包在发布前实机启动过
（`/healthz` 与特效索引 200）。
