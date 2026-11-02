# DEV-20261008-07 · 合并上游 Windows ZIP 中文名修复

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-08 / 2026-10-08，Asia/Shanghai |
| 状态 | 已完成：本地合并与静态检查；按用户要求未运行打包或游戏测试，未推送或部署 |
| 类型 | 上游合并 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity` / `b4c6ebefe810ed6983a5a492d5e6ce6b123e74f9`；工作区干净，已与 origin 核对一致 |
| 原上游基线 | v0.2.1 / `c2a2ef778cf728ff29b953b9842b2a39b1e9cbea` |
| 目标上游 | `3eced7bdba5aae11a325bd3dbe66cdf01361d2bd`，Windows ZIP 中文名修复 #311；包版本仍为 0.2.1 |
| 作者与获取来源 | 作者 `sganggs/Stronghold-Protocol` master 已通过 ls-remote 核实，与 fork `origin/master` 同 SHA；从用户 fork fetch |
| 提交归属 | 与本文同一合并提交，通过记录路径查询；不重写历史 |
| 关联 | [前次上游同步](2026-10-08-02-upstream-v0.2.1.md)、[D008–D013](../DECISIONS.md)、[近期联防](2026-10-08-06-group-unite-rounds.md) |

## 需求、范围与验收

用户要求获取本地仓库最新远程，把 master 新增一项提交合入核心分支，并阅读 AGENTS.md。随后明确此次为打包工具修复，不直接测试打包。本次按既有会话授权 fetch、合并及本地提交，未授权再次推送或部署。

只合入已确认的上游三文件，保留当前 D010 的三/四/五人固定池、D011 分组界面、D012 组间并行六选轮选、D013 至多五轮联防与后续投票，以及其他仍生效规则。做差异、语法与记录检查，不运行打包、游戏测试、golden 或完整十四回合。远程 master、本地 master 和 `v0.2.1-20p.2` 标签不改。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 当前状态 | Git 分支、HEAD、工作区、remote | 分支正确，起点干净，origin 是用户 fork |
| 来源和数量 | fetch、作者 ls-remote、旧上游至目标 log/stat | 作者 master 与 fork master 同 SHA，只有一项新增提交；作者 v0.2.1 标签仍指向旧基线 |
| 实际影响 | 上游完整差异 | 仅 tools/package.mjs、tools/package-update.mjs、test/update-package.test.js；不改运行游戏源码、依赖或素材 |
| 本地冲突范围 | 当前 HEAD 相对旧上游的三文件差异为空 | 这三文件没有本地扩容补丁，可以按上游内容自动合并 |
| 验证取舍 | 用户本次补充 | 不运行打包/游戏测试；只核对差异、语法及文档。不能将未执行测试写成通过 |

## 实现或操作

| 文件 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `git -c credential.helper=manager fetch origin` | 获取 origin/master 从 c2a2ef7 到 3eced7b；同步远程已有 v0.1.4-20p.1 标签 | 本次仅更新本地跟踪引用与获取既有标签，没有写远程 |
| `git merge --no-commit --no-ff 3eced7bdba5aae11a325bd3dbe66cdf01361d2bd` | 自动合并三个文件，无冲突 | 保留真实来源与父提交，不改已有共享历史 |
| `tools/package.mjs` | bsdtar 回退打包显式写 UTF-8 名称，导出 zipFolder 供上游测试复用 | 避免 Windows 系统编码导致中文文件名变成问号 |
| `tools/package-update.mjs` | 读 Unicode Path extra field 的 UTF-8 名称；已有 UTF-8 header 标志仍优先 | 支持 Info-ZIP 在系统代码页 header 之外保存的中文名称 |
| `test/update-package.test.js` | 使用实际打包函数，增加不同名称编码和 stale CRC 的 fixture | 同步上游测试内容；本次不执行它们 |
| 维护入口与 UPSTREAM 清单 | 更新目标基线、记录索引；将核对清单里的旧全房扩容和两轮联防文字同步到 D010–D013 | 避免下次同步误用已被替代的规则；没有修改任何玩法决定或运行源码 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| 作者与 fork 的引用及上游差异读取 | Windows，目标完整 SHA | 来源和三个文件范围已确认 |
| `node --check tools/package.mjs`、`node --check tools/package-update.mjs`、`node --check test/update-package.test.js` | Node v24.21.0 | 三个文件均通过语法检查，仅解析，不运行打包或测试主体 |
| 合并树与目标/旧 HEAD 比较 | 三个上游文件逐项比较；排除开发文档后核对全部变化 | 与目标上游完全一致；没有其他源码变化，没有依赖或素材变化，没有未解决冲突 |
| `git diff --check`、`git diff --cached --check` | 工作区与暂存差异 | 通过 |
| 独立只读审查 | UTF-8 标志、Unicode Path 字段、路径及旧删除保护 | 除下述 Node 22.0/22.1 兼容边界外，未发现实质回归；未执行测试 |
| 四篇修改文档的相对链接、锚点和索引核对 | 维护入口、上游清单、记录索引和本文 | 55 个本地链接，0 错误；记录编号与索引一致 |

未运行任何打包、游戏测试、golden、浏览器或完整十四回合对局，遵循用户本次要求及 AGENTS.md。未创建浏览器或监听端口，无需停止测试服务。

## 结果、遗留与接手

- 实现结果：Windows ZIP 中文名修复按上游内容无冲突合入核心分支，运行游戏源码和当前扩容规则不变。
- 遗留：静态审查提示 Node 22.0/22.1 无 zlib.crc32 时，Unicode Path 名称 CRC 校验会被跳过；新增测试在该环境也跳过。本机 Node 24 支持该接口。本次不扩展修改上游兼容策略，该边界不涉及运行游戏逻辑。
- 提交 / 远程 / 素材 / 线上：与本文同一次本地合并提交；仅 fetch 和读取作者引用，未推送或部署。未改依赖/素材，无需 install 或 setup；原 I001–I003 保留。已有 v0.2.1-20p.2 仍指向 b4c6ebe，没有移动标签。
- 接手入口：三个上游文件、[当前决定](../DECISIONS.md)、[上游流程](../UPSTREAM.md)。

## 后续补充

独立后续需求另建记录并链接本文，不为写回自身哈希反复追加提交或 amend。
