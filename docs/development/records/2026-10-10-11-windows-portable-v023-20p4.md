# DEV-20261010-11 · v0.2.3-20p.4 Windows 便携包

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-10 / 2026-10-10，Asia/Shanghai |
| 状态 | 已完成：Windows x64 便携 ZIP、包内冒烟和全部压缩条目核验；本次未上传或部署 |
| 类型 | 发布打包、验证、文档 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`，`1dce9e04c8f7cb5ccd02b65dbc76ed980389ee3c`；开始工作区干净 |
| 发布标签 | `v0.2.3-20p.4`，解引用为上述 HEAD；包内应用版本沿用上游 `0.2.3` |
| 上游基线 | v0.2.3，`1db8e51023ae6abaec9370beb81a513d5c4d0b01`，本地已合并 |
| 提交归属 | 包内源码为 `1dce9e0`；本记录与索引收尾同一提交，按记录路径查询 |
| 关联 | [DEV-20261010-09](2026-10-10-09-compact-wire-bandwidth.md)、[DEV-20261010-10](2026-10-10-10-merge-compact-wire.md)、[Windows 打包流程](../../WINDOWS.md) |

## 需求、范围与验收

用户要求将当前版本打包用于发布，只需要 Windows 便携包。使用原有 `scripts/make-windows-bundle.mjs`，生成含官方 Windows x64 Node、完整本地素材、生产依赖和中文启动入口的 ZIP。仅本地构建和验证，不上传 Release 或部署；不生成其它平台、精简、源码或增量包，不移动发布标签，不修改玩法和网络代码。

输出位于仓库旁 `../releases/v0.2.3-20p.4/` 的专用新目录，未使用 `--force`。验收包含源码与标签一致、资源清单完整、生产依赖及便携 Node 可用、临时端口启动和 HTTP / WebSocket 冒烟、ZIP 完整性和 SHA-256，以及测试资源释放。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 发布基线 | 当前 Git HEAD、精确标签与工作区检查 | HEAD 对应 `v0.2.3-20p.4`，无既有未提交改动；已确认 |
| 包内 Node | 原脚本 NODE_PIN 和 `.cache/node-v22.23.3-win-x64.zip` | 固定 v22.23.3，35,574,076 B；SHA-256 为 `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`，本地归档匹配；已确认 |
| Windows 包内容 | `scripts/make-windows-bundle.mjs`、`docs/WINDOWS.md` | 复制 Git 跟踪文件但排除 test，额外复制素材 / 字体 / vendor / 本地清单；独立 npm ci --omit=dev，保留原源码和启动流程 |
| 输出路径 | 专用目录存在性、路径关系及磁盘空间检查 | 不存在的独立产物目录，位于授权 workspace 内且不覆盖仓库或旧产物；已确认 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `node scripts/make-windows-bundle.mjs --out <专用产物目录>` | 生成 Windows x64 便携目录，原脚本复制 796 个源码文件，略过 670 个 test 文件；附加 12587 个素材 / 字体 / vendor 文件、本地清单、93 个生产依赖及官方 Node | 复用标准流程，不修改源码或版本标签 |
| `verify-portable.mjs`（忽略目录中的本次检查脚本） | 在包内 Node v22.23.3 下对源码、目录、依赖、素材哈希和 HTTP / WebSocket 验证；成功后添加包根 `RELEASE.json`，标明标签、完整提交 SHA、Node 及素材版本 | 便于发布后的版本追溯，不依赖机器预装 Node |
| `package_zip.py`（忽略目录中的本次压缩脚本） | 压缩至专用 `.part`，全部 19367 项 CRC / SHA-256 和 UTF-8 文件名核验成功，原子发布 ZIP；不覆盖旧压缩包 | 确认发布文件可完整读取，中文启动文件名正确 |

### 发布产物

仓库旁 `../releases/v0.2.3-20p.4/` 保留发行 ZIP、未压缩便携目录、`SHA256SUMS.txt` 以及两份检查报告；本次检查脚本位于忽略目录 `.cache/windows-portable-v02320p4/`。发行包包含全部标准 / 本地补充素材及语音，使用原启动流程，无需目标机器预装 Node。

| 产物 | 内容 / 大小 |
|---|---|
| `Stronghold-Protocol-v0.2.3-20p.4-Windows-x64.zip` | 574985751 B，548.35 MiB；19367 个文件 |
| 解压后便携目录 | 864689679 B，824.63 MiB；包根包含 `RELEASE.json`，代码标签为 `v0.2.3-20p.4` / `1dce9e0` |
| ZIP SHA-256 | `96855aa73ffed7e2c4fd08eeb6c36b52d0082683f3b7de34c16d22a5632bc211` |
| 验证报告 | `verification.json`：源码 / 依赖 / 素材 / HTTP / 21 连接 / 重连 / 清理；`archive-verification.json`：ZIP 大小 / SHA / 条目 / UTF-8 |

## 验证

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| Git 与 Node 归档核验 | Windows 11 / PowerShell；上述完整 HEAD、版本和固定 SHA | 已确认 |
| 原 Windows 便携脚本 | 首次沙箱中 npm 无法写 `E:\GlobalCache\npm-cache`，EPERM；随后仅清理经过绝对路径核验的本次未完成目录，在沙箱外重试 | 重试退出 0，生产依赖 93 个，最终原目录 19366 文件 / 824.6 MiB；未覆盖旧包或修改 npm 配置 |
| 标签源码与复制内容 | 包内 Node v22.23.3；逐文件 SHA-256 比较 796 个已跟踪文件，工作区跟踪源码与标签比较 | 一致；额外资源 12587 文件的路径与大小一致，字体/vendor 和本地清单字节一致；生产依赖无 dev 项，无 puppeteer-core、私人运行配置、测试目录或残留安装目录 |
| 中文启动入口 | `启动游戏.bat --help`；ASCII BAT 内主动 `chcp 65001`，内部使用本包 Node 和 launch.mjs | 直接运行退出 0；Node 子进程调用最初因 cmd 参数转义错误失败，改检查脚本 windowsVerbatimArguments 后通过，无需修改发行入口 |
| 包内素材目录 | 当前完整清单及实际 12562 文件 SHA-256 | 完整，缺项 0，648096514 B；版本 `dd40447a61c10c9d655907a5ce237cec8e2a5f485a5de202a5854c3f85bad0a9`；1 条原有未使用 atlas 警告不影响完整性 |
| 包内 HTTP / 缓存 | 包内 Node 和生产依赖，临时端口、本机 127.0.0.1 | health/index/data 200，507 个 import map 条目；内容 rv、Brotli、immutable 和条件请求 304 通过 |
| 包内 WebSocket / 重连 | 20 独立玩家连接＋1 JSON 观战，到 INFO_CHECK 的短协议检查，非真人实战 | 紧凑数组 / 旧 JSON、permessage-deflate、20 席位视图、观战无私有状态；同身份降级 JSON 重连、私有状态恢复和 ping 通过 |
| 资源清理 | 检查脚本 finally | 客户端和服务器关闭，临时端口可重新绑定；未打开浏览器或占用 3000 |
| 发行 ZIP 全条目读取 | Python 3.12.10，DEFLATE level 6；压缩和完整核验共 80.11 s | 全部 19367 项 CRC 与 SHA-256 一致，无重复名、路径穿越或加密条目；中文文件名使用 UTF-8 标记；`.part` 原子改名为 ZIP |
| 整包 SHA-256 复核 | Python 创建 SHA256SUMS；PowerShell Get-FileHash 独立读取 ZIP | 与上表 SHA-256 一致 |
| 开发文档与差异检查 | `node --test test/docs-consistency.test.js test/docs-paths.test.js`；`git diff --check`；运行代码与标签差异检查 | 31 项通过，0 失败/跳过；无空白错误，运行代码与发布标签一致 |

不重复完整游戏测试或十四回合流程；发布代码已在原优化任务完成定向验证。本次验证实际发行目录和压缩包，不把启动冒烟当成真人联机压测。

## 结果、遗留与接手

- 实现结果：已生成可分发的 Windows x64 便携 ZIP，代码来自已推送的 `v0.2.3-20p.4`；包内 Node、依赖、素材、缓存 / 压缩 / 联机与压缩包完整性均通过定向核验。
- 未确定或未完成：线上性能、真实多人和旧 JSON 极低带宽边界沿用原优化记录。
- 提交 / 远程 / 素材 / 线上：本次仅本地打包和记录，记录收尾按已授权流程本地提交，不上传或部署，不移动标签；压缩包及其目录在仓库之外，不进入 Git。上一操作已将核心代码与标签推送为 `1dce9e0`，不能视为本次 ZIP 已上传。
- 接手入口：[WINDOWS](../../WINDOWS.md)、[WIRE_PROTOCOL](../../WIRE_PROTOCOL.md)、[HTTP_CACHE](../../HTTP_CACHE.md)。

## 后续补充

无。
