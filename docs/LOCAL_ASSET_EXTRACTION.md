# 本地素材提取参考

本页只提供现有工具的使用方法，不附带游戏文件、素材下载包或提取结果。操作前确认对本机客户端及拟进行的处理具有相应权利，并遵守其适用条款；安装客户端不等于获得再次分发素材的许可。权利归属见 [NOTICE.md](../NOTICE.md)，参考作者见 [REFERENCES.md](REFERENCES.md)。

## 环境与输入

在项目根目录运行。使用 Python 3.12 或更新版本及 `tools/local-extract/requirements.txt` 中的 UnityPy、lz4、Pillow；Node.js 版本遵循 `package.json`。下面是 PowerShell 示例，把 `$gameAssets` 改为自己的客户端 AB 目录；热更新资源不全时先通过官方客户端正常更新，工具不绕过账号、付费或资源访问限制。

```powershell
py -3.12 -m venv .venv-extract
.\.venv-extract\Scripts\python.exe -m pip install -r tools/local-extract/requirements.txt
$gameAssets = 'D:\自己的客户端\Arknights_Data\StreamingAssets\AB\Windows'
```

皮肤工具首次运行需要皮肤数据表缓存，缓存缺失时会联网读取数据表；`--dry-run` 不是完全离线模式。`skins.py` 的 `--extra` 可以指定本机热更新 bundle 根目录，否则按现有客户端目录规则寻找。不同版本的资源结构和完整度可能不同，缺少资源时保留缺项，不伪造模型。

## 皮肤图片与模型

先小范围扫描，再提取相同范围；以下角色 ID 只是可替换的示例。

```powershell
.\.venv-extract\Scripts\python.exe tools/local-extract/skins.py --game "$gameAssets" --only char_003_kalts --limit 1 --dry-run --json
.\.venv-extract\Scripts\python.exe tools/local-extract/skins.py --game "$gameAssets" --only char_003_kalts --limit 1 --json
node tools/local-extract/skin-meta.mjs --sidecar data/local-skins.json --json
```

图片与 Front / Back 模型写入 `public/assets/local/skins/`，元数据写入 `data/local-skins.json`。提取器按客户端 prefab 的模型引用选取朝向，不把同名骨骼当作朝向证据。修复已安装模型可使用 `--models-only`，保留已有图片与其他元数据；只修头像可使用 `--avatars-only`。工具有写盘动作，建议先备份本机 sidecar 与对应输出。

## 官方特效与时装替换

先提取当前棋池使用的基础特效，再生成时装替换映射与缺失键列表，补提取替换键。命令沿用本仓库接口，不套用其他 fork 的工具参数。

```powershell
.\.venv-extract\Scripts\python.exe tools/local-extract/extract.py --game "$gameAssets" --only fx --fx-set used
New-Item -ItemType Directory -Force .cache | Out-Null
.\.venv-extract\Scripts\python.exe tools/local-extract/skinfx.py --game "$gameAssets" --keys-out .cache/skinfx-keys.txt --json
.\.venv-extract\Scripts\python.exe tools/local-extract/extract.py --game "$gameAssets" --only fx --fx-keys '@.cache/skinfx-keys.txt'
.\.venv-extract\Scripts\python.exe tools/local-extract/skinfx.py --game "$gameAssets" --json
```

特效文件及 `skinFx` 映射在 `public/assets/local/fx/`，配套本地索引为 `data/local-fx.json`。`skinfx.py` 的 `--only` 会限制本次扫描并替换整个 `skinFx` 段，维护完整安装时不要误用小范围结果覆盖全量映射。`--dry-run` 跳过索引合并，但指定 `--keys-out` 仍会写键列表。映射存在不代表目标 prefab、贴图和网格已存在；查看摘要中的 `bad`、`notInIndex` 与实际文件。部分假弹道字段仅报告，不能据此宣称所有换装特效都支持。

## 本机核验与发布前检查

启动本地服务后在编队页逐个核验头像、立绘、预览动画、棋盘朝向和特效回退；有变更时重启本机服务并刷新页面。不要为了重读本地索引终止线上对局，也不要在已有完整安装上随意重跑全量 setup 或 prune。

```powershell
node --test test/local-extract-skins.test.js test/local-skin-meta.test.js test/render/vfx-skinfx.test.js test/sim/skins-token.test.js
git check-ignore public/assets/local/skins/example.png data/local-skins.json data/local-fx.json .cache/skinfx-keys.txt
git diff --cached --name-status
```

`public/assets/`、`data/local*.json`、`.cache/` 及原始报告保持忽略；禁止用 `git add -f` 加入这些输出。`.gitignore` 不清除旧提交，推送前同时审查目标分支新增的历史对象、最终文件和敏感配置。不要上传提取包、截图、模型、音频或含这些内容的 Release 来代替这份参考文档。上游同步的既有素材仍须遵守其原权利边界。
