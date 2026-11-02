# 页面代码、数据与 HTTP 缓存

本说明对应测试分支的 [DEV-20261010-09](development/records/2026-10-10-09-compact-wire-bandwidth.md) 与决定 [D022](development/DECISIONS.md#d022)。WebSocket 的可逆位置协议、压缩和当前 8 Hz 合并另见 [WIRE_PROTOCOL](WIRE_PROTOCOL.md)。v0.2.6 的素材哈希地址与页面固定版本结合见 [合并记录](development/records/2026-10-14-02-upstream-v0.2.6.md)，素材包沿用 schema-1 与完整 SHA-256 内容存储。

## 内容版本地址

`server/http/runtimeCache.js` 在本进程首次需要时扫描公开的 JS / CSS / 游戏 JSON。对每个文件实际内容计算完整 SHA-256，并生成：

```text
/js/net.js?rv=<64 位小写 SHA-256>
/data/chess.json?rv=<该 JSON 内容的 SHA-256>
```

首页仍是 `no-cache`。服务器在返回首页时扩充已有 import map，把所有原模块 URL 映射到各自的内容版本 URL，并同步改写 HTML 中的本地入口、样式及预加载地址。JS 源码、相对路径、模块依赖及模拟代码不改写。`../../shared/...`、模拟器的 `/data.js` 替身和 `/sim/simdata.js` 最终仍解析到唯一的正确模块实例。

每个文件独立寻址：服务器重启、改其他模块或更新数据，不会让未变化的文件一起失效。数据 / 经典脚本不经过原生模块解析，`public/js/runtime.js` 从同一目录解析其地址；UI 数据、模拟器数据、素材清单和 Pixi 经典脚本均采用相应地址。可信版本使用原生 HTTP 缓存的 `default` 模式，旧服务器 / 无目录页面继续使用原地址和原有验证方式。

| 资源 | 规则 |
|---|---|
| `/js/`、`/shared/`、`/sim/` 的公开 JS，`/vendor/` JS，`/css/` CSS，`/data/` JSON，虚拟 `/data.js` | 目录内正确 `rv`：`public, max-age=31536000, immutable` |
| HTML | `no-cache`，生成后的完整内容 ETag；不使用原 index.html 的 Last-Modified 判断新目录 |
| 未带受验证 `rv` 的代码 / 游戏数据 | 保持可验证；任意 `?v=123` 不再使代码 / 数据变成一年 immutable；传统 vendor 地址仍沿用一天缓存 |
| Service Worker 与素材导入 Worker 入口 | 不加入新版本目录，沿用原验证方式；文档 import map 不适用于 Worker |
| 素材、字体、音频、内容包、公告和 API | 保留各自既有策略；不把这些响应误存进代码缓存 |
| `/sim/nodeData.js`、隐藏文件和其他服务器源码 | 继续不可公开访问，也不进入目录 |

版本目录每个进程只有一个快照。**更新服务器文件后须重启进程**，现有 build guard 也在重启后更新；不支持在同一进程中混合部署新旧文件。新增公开模块 / JSON 在相应目录中会自动进入下一进程的目录，不用手写哈希。build guard 新增 vendor 覆盖，让依赖更新也能通知旧页面在安全时机刷新。

v0.2.6 会把 `assets.json` / `local-assets.json` 中的素材地址改为 `/assets/~<16 位内容哈希>/…`。运行时目录等首轮素材索引就绪后，使用**实际返回的改写正文**计算这两个文件的 `rv`，并固定正文到当前进程的快照。之后素材索引重扫只更新无 `rv` 的清单；已固定页面仍取得原快照，不能把新清单写进旧 `rv` 地址。素材的这些精确地址同时进入本地预缓存目录别名，见 [ASSET_CACHE](ASSET_CACHE.md#本地目录约定与维护入口)。

服务器检查 `rv` 的格式、唯一性和目录匹配，首次提供内容时再次验证其 SHA-256，随后只复用那份已验证的字节；发现文件元信息变化或哈希不匹配时拒绝旧地址（409、no-store），不会把新内容缓存到旧版本名下。旧部署不存在的文件仍可返回 404。浏览器中已缓存的旧版本保持其原有内容，不会被覆盖；旧页面依赖完整图，更新通知与重连沿用现有行为。

## Brotli 与压缩缓存

`server/http/files.js` 支持标准 Brotli / gzip 协商：同权重优先 Brotli，显式排除和权重生效，不支持时仍可原文传输。Brotli quality 5，gzip level 6；文本小于 512 B 通常不压缩。图片 / 压缩音频不重复压缩，音频 Range 功能保留。

- 每个编码表示有独立 ETag，`Vary: Accept-Encoding`，HEAD 与 GET 的表示长度一致；304 不发正文。Range 使用原文与现有 206 / 416 / If-Range 规则。
- HTTP 压缩最多同时执行两项，重复请求共享同一计算；gzip / Brotli 结果按字节做 LRU，静态文件缓存上限 96 MiB。普通磁盘文件超过 8 MiB 时压缩为流；内容版本需要先校验字节，验证缓冲 LRU 上限 32 MiB、单文件上限 16 MiB。
- 完整素材目录的线上出口仅在用户明确操作时开放：`/api/asset-cache/catalog` 受素材限速器和紧急保护约束；初始化、检查和准入仍只发送 `/api/asset-cache/status` 小摘要。目录和文件补齐共用服主可调预算，详见 [ASSET_CACHE](ASSET_CACHE.md) 与本次记录。

应急开关（启动前的环境变量）：`SP_HTTP_RUNTIME_CACHE=0` 关闭首页版本目录，`SP_HTTP_BROTLI=0` 回退为 gzip / 原文。两者独立；修改后重启并刷新页面。Windows PowerShell 示例：

```powershell
$env:SP_HTTP_RUNTIME_CACHE = '0'
$env:SP_HTTP_BROTLI = '0'
npm start
```

正常开启时不需要设置这些变量。回退不要删除玩家的素材 Cache Storage；那与原生代码 / 数据 HTTP 缓存是两个不同机制。

## 验证与边界

`test/runtime-http.test.js` 验证版本目录、相对模块依赖地址、私有文件边界、数据独立更新、拒绝过期地址、编码权重、HEAD / 304 / Range、并发首次下载和大文件压缩流。`test/compact-wire.browser.test.js` 用真实 Edge 加载全页面和本地模拟器，检查两条路径读取同一个模拟数据实例，随后验证 20 席位开局、休整和身份恢复。

2026-10-10 的 Edge 155 检查：449 个代码 / 数据资源首次传输约 2.86 MB；同一浏览器上下文再次载入时这 449 个资源均命中原生缓存，正文传输 0 B。该数字**不包含首页、API、WebSocket 和素材流量**，不代表第一次进入无需下载。浏览器的强制刷新、清缓存、存储回收或换设备也可能再次下载。

2026-10-14 合并 v0.2.6 后，Edge 155 短流程检查了 457 个代码 / 数据资源：首次正文 3,038,484 B，热刷新全部命中缓存、正文 0 B；20 席位进入 R1 准备，混合位置数组 / JSON 与原身份 JSON 回退重连通过。它仍是单浏览器加测试客户端的短检查，未运行完整对局或线上压测，详见 [本次记录](development/records/2026-10-14-02-upstream-v0.2.6.md)。

本次通过减少正文和缓存复用降低峰值；**没有增加全局 HTTP 字节限速或公网链路 QoS**。冷启动 / 同时首次访问仍可竞争实际公网带宽；现有在线素材填充限速不是全站总限速。阿里云出口降到约 1 Mbps 的场景仍需部署后测量，不能用本机缓存结果保证线上完全不卡。

原生映射边界参考 [MDN import map 文档](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap)：只用于文档模块解析，入口 script src 与 Worker 需要各自处理。当前实现已分别覆盖这些边界。
