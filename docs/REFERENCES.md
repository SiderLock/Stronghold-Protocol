# 来源与致谢

感谢 [sganggs](https://github.com/sganggs/Stronghold-Protocol) 与上游贡献者提供游戏实现、规则考证和维护基础；感谢 [LongQianChen（龙千尘）](https://github.com/LongQianChen/Stronghold-Protocol) 提供 20 人容量、固定分组、并行轮选、紧凑协议和预缓存等多人分支基础。本 fork 在这些工作之上持续适配。

以下按本 fork 的实际采用范围列出参考，核对日期为 2026-10-23。PR 链接用于溯源，不表示该 PR 已被上游合并，也不表示整套实现均已移植。

| 作者与原始来源 | 本 fork 的采用范围与边界 |
|---|---|
| [Flotiarenor · PR #685](https://github.com/sganggs/Stronghold-Protocol/pull/685)、[PR #686](https://github.com/sganggs/Stronghold-Protocol/pull/686) | 随上游 0.3.1 保留的外观插件、多套皮肤、按席位选择和按 owner 渲染基础；不是本 fork 原创。原 PR 的 closed / merged 状态与上游后续整合提交分别看待。 |
| [sganggs · 图片时装提交 77b91081](https://github.com/sganggs/Stronghold-Protocol/commit/77b91081) | 移植上游 0.3.2 的 B6：图片时装可穿，商店、详情和结算按席位取图，无模型时保留默认战斗模型。多人行为由本分支适配。 |
| [alien-zzy · PR #652](https://github.com/sganggs/Stronghold-Protocol/pull/652) | 参考换装与动态小人预览方向；核对 head `54806d9c68cdf69974f17c57e50e04c7238f060a`。本 fork 复用现有插件协议、资源缓存与组件生命周期，没有引入该 PR 的服务器下载 / 安装通道。该 PR 提及的更早换装参考 [AoyamaT1 · PR #85](https://github.com/sganggs/Stronghold-Protocol/pull/85) 也一并致谢；这是参考链说明，不宣称本 fork 直接移植了 #85。 |
| [FengYuPrime · 皮肤与官方 VFX 移植手册](https://github.com/FengYuPrime/Stronghold-Protocol/blob/master/docs/FORK-SKIN-VFX.md) | 参考召唤物换装的数据链路、`CharacterSkinHooker` 替换映射、资源覆盖层与键名归一化的排查思路。本分支沿用现有素材提取器、展示字段和 VFX 系统适配，不宣称已移植该 fork 的全部特效绑定或玩法修改。来源仓库保留 GPL-3.0 LICENSE。 |
| [xcdoge · PR #734](https://github.com/sganggs/Stronghold-Protocol/pull/734) | 参考皮肤记录携带独立语音槽的设计（关联 issue #733）；核对 head `a3400da2db953c612cfdacf58f4155596eb4a5d6`。本分支通过既有语音解析与回退行为接入，不将 PR 尚未合并的状态写成上游已采用。 |
| [hesperine · PR #823](https://github.com/sganggs/Stronghold-Protocol/pull/823) | 采用描述扫描中复用私有正则的初始化优化，冻结 head `d80afc979eff314b3c8d9317c45282f6b03b6e47`；不改变官方上限和数字解析结果。性能测量与局限见 [MOBILE_PERFORMANCE.md](https://github.com/SiderLock/Stronghold-Protocol/blob/master/docs/development/MOBILE_PERFORMANCE.md)。 |
| [zasx77771 · PR #739](https://github.com/sganggs/Stronghold-Protocol/pull/739) | 参考 Windows 路径分隔符兼容修复；核对 head `383983b7d6faebb7ebfad2e642a3e5add5d44a5f`。 |
| [zasx77771 · PR #857](https://github.com/sganggs/Stronghold-Protocol/pull/857) | 融合队友申请、房主发起重刷投票的实现，冻结所采用版本 `c865393fe049c7a06cd7ade6248f7812cf52c1de`；保留本分支全部固定组库存、20 席位、插件对局与紧急冻结保护。规则见 [D041](https://github.com/SiderLock/Stronghold-Protocol/blob/master/docs/development/DECISIONS.md#d041)。 |
| [YuriRestia · PR #70](https://github.com/sganggs/Stronghold-Protocol/pull/70) | 保留既有英文翻译署名；具体采用范围及未采用的未声明许可文本见 [NOTICE.md](../NOTICE.md)。 |
| [isHarryh（Harry Huang）· Ark-Unpacker](https://github.com/isHarryh/Ark-Unpacker)、[K0lb3 · UnityPy](https://github.com/K0lb3/UnityPy) | 本地资源解析基础。`aklz4.py` 保留原 BSD-3-Clause 声明；UnityPy 遵循其 MIT 许可。组件许可证见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。 |

本分支的背压状态合并、连接质量提示、场景预处理、缓存生命周期、粒子预算与骨骼变换优化还包含自行实现和测试。未实际采用的其他 Worker 池或增量协议方案不列为已集成成果；技术取舍见公开性能说明与 [WIRE_PROTOCOL.md](WIRE_PROTOCOL.md)。

## 源码公开与素材边界

- 本项目自己编写的代码和文档依 [LICENSE](../LICENSE) 与 [NOTICE.md](../NOTICE.md) 发布，保留上游及第三方的署名、许可例外与免责声明。
- 游戏图片、模型、动画、音频、文本和数据的权利属于各自权利人。公开镜像、上游已包含、致谢或非商业用途均不能替代授权，也不能把这些内容转为 GPL 素材。
- 本次逐级整合不新增游戏素材、提取输出、素材压缩包、运行配置、公告、私人过程记录或原始测量报告；不创建含这些文件的 Release。既有 master 中继承的历史资源不作改写，也不据此宣称已经完成全仓库版权清理。
- 需要素材的维护者按 [本地提取参考](LOCAL_ASSET_EXTRACTION.md) 核对本机合法来源与适用条款；仅提交工具源码及必要说明，输出留在忽略目录。服务部署与素材使用仍需单独核实相应权利和条款。
- [Spine Runtimes License](https://esotericsoftware.com/spine-runtimes-license) 另有使用与分发条件，项目的 GPL 链接例外不能代替 Spine 自身许可。涉及不明许可的内容先不新增分发；权利人通知渠道见 NOTICE。
