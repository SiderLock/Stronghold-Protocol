# 本 fork 的便携发布包

`v0.3.1-20p.2` 起，本次候选采用下述范围；这不改变旧版已经发布的附件。正式发布仍需维护者验收候选文案、文件与校验结果。

## 平台与启动

| 包的后缀 | 目标机器 | 启动入口 |
|---|---|---|
| `Windows-x64.zip` | Windows 64 位 x86 | 双击 `启动游戏.bat` |
| `linux-x64.tar.gz` | Linux x86-64，需兼容包内官方 Node 二进制 | `bash 启动游戏.sh` |
| `darwin-arm64.tar.gz` | macOS Apple Silicon | `bash 启动游戏.sh` |
| `darwin-x64.tar.gz` | macOS Intel | `bash 启动游戏.sh` |

每个包都自带对应平台的 Node.js 22.23.3、Node 许可证和生产依赖，无需另装 Node 或运行 npm install。解压整个目录后启动，不要只复制启动脚本。浏览器打开本机服务；启动脚本不自动下载或提取游戏素材。端口、局域网与防火墙设置沿用 [部署说明](DEPLOY.md)。

“开箱即用”指自带运行环境与上游基础素材，**不是附带本分支演示中的完整皮肤、特效及场景库**。缺少可选素材时保留默认模型或简化画面；本机提取并生成相应索引后，再重启本机服务读取。连接其他人的服务器通常只需要浏览器。

## 素材来源与排除规则

基础美术、音频和字体仅直接取自作者上游 `v0.3.1` 的原始完整包：

- 来源：[Stronghold-Protocol-v0.3.1.zip](https://github.com/sganggs/Stronghold-Protocol/releases/tag/v0.3.1)。
- 完整归档 SHA-256：`d2f48f7fd2698f330b86c897d93ada2d7066825593cce4de8add46dfa68c3db1`。
- 只允许其中的 `public/assets/` 和 `public/fonts/` 普通文件，排除所有 `public/assets/local/`；逐文件记录来源与 SHA-256，不从维护者本机同名素材目录取替代文件。
- 不附带本分支自行提取或新增的素材，也不附带 `data/local*.json`、个人皮肤、特效 / 场景输出、私人记录、公告、运行配置、原始报告、缓存或其他服务文件。
- 只生成四个平台运行包和校验说明，**不生成或发布独立素材包**。

上游收录不等于获得使用或再次分发许可。游戏素材仍可能涉及侵权风险；自行提取也必须遵守权利人的授权与适用条款，不能把非商业用途或署名当成免责。请阅读 [NOTICE](../NOTICE.md) 和[本地提取参考](LOCAL_ASSET_EXTRACTION.md)。游戏素材不适用本项目代码的 GPL，Node、依赖库及 Spine Runtime 另有各自许可。

## 提取文档与包内文件

包根包含 `README-开箱即用.md`、更新说明和许可证；游戏在 `app/`，运行时在 `node/`。主要文档：

- `app/docs/LOCAL_ASSET_EXTRACTION.md`：Python 环境、皮肤图片 / 模型 / 特效提取与核验。
- `app/docs/REFERENCES.md`：参考开发者、功能思路、冻结版本与采用范围。
- `app/docs/RELEASE_PACKAGES.md`：本页。
- `app/docs/releases/v0.3.1-20p.2.md`：更新内容及版权边界。
- `RELEASE.json`：候选版本、源码提交、目标平台和上游归档来源。
- `PACKAGE-MANIFEST.json`：包内实际文件的大小与 SHA-256。

提取工具在 `app/tools/local-extract/`；输出留在使用者本机。素材包、截图或模型文件不能代替提取说明对外分发。

## 准备与核验

维护者使用 `tools/release-candidate.py` 准备候选，复用既有玩家文件白名单与文档处理；不使用会整树复制本机素材的旧便携脚本默认流程。工具要求明确的源码提交、经校验的上游归档和固定哈希的四平台官方 Node 归档，输出到专用新目录，不覆盖现有目录，不自动推送、打 tag、创建 Release 或上传附件。

核验包括来源归档哈希、来源路径与文件哈希、全部提取输出的排除、依赖及许可证、归档 CRC / 哈希、脚本权限和本机可运行目标的启动检查。macOS 的实机启动不能由 Windows 或 Linux 的结构检查替代；实际结果单独写入候选核验清单。
