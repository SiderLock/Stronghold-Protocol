# DEV-20261009-04 · 核对并补齐 v0.2.2 召唤物素材

## 基本信息

| 字段 | 内容 |
|---|---|
| 开始 / 最后更新 | 2026-10-09 / 2026-10-09，Asia/Shanghai |
| 状态 | 本地补齐及补丁验证已完成；服务器待用户部署 |
| 类型 | 调查 / 素材补齐 |
| 分支与开始 HEAD | `feat/IncreasePlayerCapacity`；`63d667b93954fcfbbd1a6ff6b5e53eeffe86d31c`；工作区干净 |
| 上游基线 | 已合并 v0.2.2 `62eb113419123d9a3a63606107bbf85230c5dd2f`；本次读取用户已解压的作者 v0.2.2 整合包，不重新联网核实来源 |
| 提交归属 | 未提交；本次素材及补丁放在 Git 忽略目录 |
| 关联 | I003；[v0.2.2 合并记录](2026-10-09-03-upstream-v0.2.2.md) |

## 需求、范围与验收

用户怀疑缺少素材，提供 `E:\GAME\A\gameDevelop\原作者0.2.2包\Stronghold-Protocol` 要求对比。只读核对后确认缺少 39 套召唤物模型；用户要求完整列出缺项，并补充本地及供其部署至服务器。

本次只补缺少的 117 个模型文件及同版 `data/local-assets.json`，准备小型服务器补丁和独立校验工具。保留现有标准下载素材；不覆盖作者与本机不同的雪孩子图集；不开发浏览器预缓存功能，不执行服务器写入、Git 提交或远程操作。

验收：117 个文件均与作者包 SHA-256 一致；本地所有提取素材清单引用存在且非空；真实客户端 URL 解析得到全部 39 套模型；服务器补丁完整包含模型、配套清单及校验说明。

## 调查与决定

| 问题 | 证据或来源 | 结论及确定程度 |
|---|---|---|
| 标准下载素材缺失 | 两边 `data/assets.json` 字节一致；各 10650 个唯一素材/字体引用均存在且非空 | 已确认：没有缺项，清单哈希均为 `bfdfd5e7efd9` |
| 特殊召唤物缺失 | 作者包清单 1598 项，本地 1481 项；全目录对比 | 已确认：缺 39 个模型目录，每目录 3 个文件，共 117 个，3648898 字节（3.48 MiB） |
| 共用文件内容 | 对两边 `public/assets`、`public/fonts` 全部文件计算 SHA-256 | 已确认：12142 个相同；作者独有 117 个；本地独有 4 个未引用音效；2 个共用文件不同 |
| 雪孩子差异 | `enemy_10138_xdsnow` 的 atlas/PNG；骨骼一致 | 已确认：本地 316×316，作者 216×216，均有 18 个区域，无越界；不同版本的实际渲染效果未验证，不认定为缺失或已修复问题 |
| 配套清单必要性 | `public/js/assets.js` 的 `localSpineEntry()` 要求清单列齐 skel、atlas、textures | 已确认：只复制模型目录而不同步清单，客户端仍不能使用 |

## 实现或操作

| 文件 / 函数 / 操作 | 变化或结果 | 为什么这样做 |
|---|---|---|
| `public/assets/local/spine/token/` | 从作者包复制以下 39 个目录、117 个文件；全部此前不存在，原有素材不覆盖 | 补齐 I003 的真实模型 |
| `data/local-assets.json` | 原样采用作者同版清单，1481 → 1598 项；先确认原有所有组内容与作者一致；原清单备份至补丁目录 `local-assets.before.json` | 模型与清单一起生效，不手工编辑生成数据 |
| `.cache/asset-patches/v0.2.2-token-models/v0.2.2-token-models.zip` | 1706274 字节（1.627 MiB）；117 个模型 + 1 个配套清单 + 3 个校验/说明文件 | 让用户小量上传并独立校验服务器 |
| 补丁 `asset-patch-v0.2.2/manifest.json` | 118 个运行文件的完整路径、大小、SHA-256，以及 39 个模型组 | 可核对 ZIP、安装文件与作者来源，避免按同名文件误去重 |
| 补丁 `asset-patch-v0.2.2/verify.mjs` | 检查版本/标准素材清单基线、118 个安装文件 SHA-256、39 组登记及全部 1598 个提取素材存在且非空 | 同一工具可在 Windows/Linux 的 Node 环境读取本地或服务器安装 |

补丁 SHA-256：`64713af48bf2842ed5e7143554b4f5483c1518ee254114b38a1cdd7e22711228`。

素材源为用户提供的解压目录；未执行包内程序或启动游戏服务器。源码预缓存功能没有开发。服务器既有本地素材是否齐全尚未核实；校验工具会报告这 117 个新增文件之外的缺项。如果服务器有额外自定义提取素材，应先合并清单再部署，而非直接覆盖。

### 完整 39 个目录

以下目录全部位于 `public/assets/local/spine/token/`，各包含 `.atlas`、`.png`、`.skel` 三个文件；其余 36 个非 eagle 目录的文件主名与目录相同。三个 `token_10057_svash2_eagle1/2/3` 目录内部文件主名都为 `token_10057_svash2_eagle`，必须保留各自目录，不改名、不跨目录去重。全部 117 个文件完整路径及 SHA-256 在补丁校验清单中。

```text
token_10002_kalts_mon3tr
token_10003_cgbird_bird
token_10005_mgllan_drone1
token_10005_mgllan_drone2
token_10005_mgllan_drone3
token_10007_phatom_twin
token_10008_cqbw_box
token_10009_weedy_cannon
token_10020_ling_soul1
token_10020_ling_soul2
token_10020_ling_soul3
token_10024_ebnhlz_rcube
token_10025_doroth_recttp
token_10026_bgsnow_subbow
token_10027_ironmn_pile1
token_10027_ironmn_pile2
token_10027_ironmn_pile3
token_10029_slent2_protrb
token_10032_jesca2_jckshd
token_10034_ray_sndbst
token_10035_wisdel_wward
token_10041_cathy_catsld
token_10043_necras_skeltn
token_10050_monstr_prosts
token_10051_radian_tower1
token_10052_radian_tower2
token_10053_radian_tower3
token_10054_phatm2_encdool
token_10057_svash2_eagle1
token_10057_svash2_eagle2
token_10057_svash2_eagle3
token_10059_nasti_nstdef
token_10060_nasti_nstchr
token_10061_nasti_nstbld
token_10064_wang_stone1
token_10066_closur_ourbase
token_10068_kalts2_mtship
token_10069_mcnist_mcgraf
token_10070_aphris_pc
```

## 验证

只读调查已执行：两边目录枚举、SHA-256、JSON 结构比较、清单引用存在/非空检查、`localSpineEntry()` 解析、atlas 区域边界及 PNG IHDR 检查。

| 命令或场景 | 环境 / 数据 / 版本 | 实际结果 |
|---|---|---|
| 任务临时构建辅助 `.cache/asset-patches/build-token-patch.mjs <作者根目录> <本地根目录> <输出目录>` | Node；双方 v0.2.2；复制前版本/基线/旧组一致性和 39/117/3648898 数量断言 | 复制后本地和补丁暂存区共 118 个安装文件 SHA-256 全部匹配；原清单已备份 |
| `node .cache/asset-patches/v0.2.2-token-models/stage/asset-patch-v0.2.2/verify.mjs .` | 当前本地仓库 | 39 套模型、117 个素材文件与配套清单哈希通过；1598 个引用存在且非空；118 项安装文件通过 |
| 使用真实 `localSpineEntry()` 解析全部 `tokens[*].spineLocal` | 当前客户端 helper 与新清单 | 期望 39，成功 39；旧清单此前成功 0 |
| Python `zipfile` 构建及直接读取归档 | Deflate level 6；不解压运行程序 | ZIP 有 121 个唯一条目；118 个安装文件逐项 SHA-256/长度匹配；`testzip()` 无 CRC 错误 |

未运行完整测试、golden、浏览器或十四回合对局，原因是没有源码或玩法改动。客户端解析通过不等于每套模型的实际战场动画均进行过视觉检查。服务器检查尚未执行，不能宣称已经上线。

## 结果、遗留与接手

- 本地补齐：已完成；I003 的本地模型缺项全部补齐。
- 服务器补丁：已生成、检查，用户上传 ZIP 并在项目根目录合并解压，最后复制配套清单；服务器运行 `node asset-patch-v0.2.2/verify.mjs`。
- 服务器上线：未执行、未验证，由用户手动部署。
- Git：无提交、推送、拉取；素材、清单和补丁均处于忽略目录。任务记录、入口和索引作为未提交文档更新；推送 Git 不会同步这些素材。
- 接手入口：本记录、I003、`public/assets/local/spine/token/`、`data/local-assets.json`。

## 后续补充

待用户提供服务器校验结果后补充部署状态。原有任务 I001/I002 与本次素材补齐无关，状态不变。
