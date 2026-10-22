# 运行性能与兼容排查（2026-10-22）

本次基线 `feat/skin-enhance@30f88891`。优化集中于场景准备、资源生命周期和素材兼容，不改变模拟或玩法。详细过程为本地记录 DEV-20261022-08。

## 已实施

| 位置 | 确认的问题 | 改进 |
|---|---|---|
| `public/js/render/board3d/load.js`、`sceneWorker*.js` | 初次场景网格合并占用页面线程 | 一个共用 module Worker，直接转移二进制缓冲区并回传；与贴图加载并行。Worker 缺失、启动拒绝、消息错误、超时或转移后崩溃，均可回退；已转移的缓冲区只补取一次 |
| `sceneGeometry.js`、`scene.js` | 区域重建重复合并相同的材质 / 光照页网格 | 按可见网格集合缓存，最多保留两个合并结果；保持隐藏区域、水面、材质和光照页规则 |
| `scene.js`、`load.js` | 访问过的场景持续保留 CPU / GPU 资源；不同素材仓库共用 stageId 缓存 | GPU 仅保留当前场景；视图及每个素材仓库最多缓存两个场景包，仓库间隔离；返回旧场景时重新创建 GPU 对象 |
| `load.js` | 本机存在 IDM，实际请求被接管后返回 HTTP 成功但二进制内容为空 | 仅对空响应补发一次完整 Range 请求，核对长度与 206 的 Content-Range；正常下载仍使用原有压缩和缓存。不修改下载器设置 |
| `public/js/render/vfx/library.js` | 有 ImageBitmap API，但其解码或选项被拒绝时，整张特效贴图不可用 | 复用已下载 Blob，经 HTMLImageElement 解码；维持现有翻转路径；成功 / 失败均释放临时 URL |
| `public/js/ui/compat.js`、战斗 / 预演 Worker 入口 | 页面补丁不覆盖 Worker 全局；旧环境的克隆补丁无法处理 DataView 和共享缓冲区 | Worker 自行加载能力补丁；克隆保留缓冲区关系、视图偏移和循环引用 |
| `test/render/board3d.browser.test.js` | 测试固定 Metal 后端，在 Windows 上没有有效的 3D 图层 | 复用现有 `gpuArgs()`，Windows 使用 D3D11，macOS 使用 Metal |

ImageBitmap 选项和 Worker API 的参考为 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/createImageBitmap)。按能力检测和失败回退处理，不能由现代桌面浏览器推定所有 WebView 均支持。

## 实测与边界

Edge 157.0.4341.10，1280×720，页面 CPU 节流 4 倍；真实本地 `act2autochess_m01`，6,544,564 字节、19 个网格块。每条路径采样 8 次，取中位数：

| 指标 | 结果 |
|---|---|
| 原路径同步准备占用主线程 | 20.9 ms |
| 直接转移缓冲区的 Worker 派发占用主线程 | 0.8 ms |
| Worker 请求至返回，中位数 / 首次冷启动 | 6.4 / 62.5 ms |
| 相同可见区域缓存命中 | 接近计时器分辨率，低于 0.2 ms |
| 连续访问 4 张 act2 地图 | 场景 GPU 资源集合始终为 1，CPU 包最多 2；总纹理数 22 → 27 → 24 → 24，无累积增长 |

这些是场景几何准备的数据，不是整体 FPS 提升；不含贴图下载与首次 GPU 上传。CDP 的页面 CPU 节流不等于整机和 Worker 同时变慢 4 倍，不能作为真实低端手机成绩。Worker 冷启动也需要等待，只是页面可以继续响应。

回归核对网格属性及索引逐项相同；本机 11 张已提取场景 × 4 套区域还与原材质桶合并结果逐项比较。覆盖转移后失败补取、模块 Worker 不可用 / 超时、空响应 / 不完整 Range 拒绝、真实贴图解码回退。图片格式和皮肤画面未改动。

性能原始证据：`.cache/perf-20261022-scene/report.json`；短战斗采样：`.cache/perf-20261022-before/`。后者仅预热 4 秒，含素材到达和编译开销，不能当作稳定战斗帧率。

最终验证：848 项定向 Node 测试通过（另 3 项可选提取环境测试跳过），5 项 Edge 测试通过（场景准备 / 图片回退、投影对齐、区域切换、WebGL 丢失回退、AI 预演与 Node 结果一致）。相关 ESLint 无错误，场景文件有一个已有未使用参数警告。全局检查仍报告既存的 `shared/plugins/visual.js:329–330` 类型错误和 `server/sim/nodeData.js:11–13` 导入边界错误；本次未修改这两个文件。

## 多线程与后续优先级

| 工作 | 当前状态 / 建议 |
|---|---|
| 场景网格准备 | 本次已放入 Worker；不为每张地图或每个玩家新开线程 |
| AI 布局预演 | 已有浏览器 Worker 与服务端进程池；先按实际任务耗时和核心数配置，不重复建池 |
| 素材 ZIP、解压、摘要校验 | 已有素材缓存 Worker，保留逐项受限内存，避免并发解压多个大项挤满内存 |
| 普通战斗模拟 | 插件对局已有 Worker 适配；普通对局统计依赖本地模拟对象。后续迁移需连同统计、共享血量、失败恢复、消息复制和结果一致性一起验证 |
| Spine 骨骼姿态与绘制批次 | 短采样中开销较大，是下一轮稳态采样的重点。现有 impostor 已降刷新率；进一步处理需验证挂点、皮肤、攻击出手与视觉延迟 |
| 特效粒子 / 整个渲染器 | 不宜直接搬线程：目前依赖同一 WebGL 场景、单位挂点和 Pixi。需单独设计 OffscreenCanvas / 缓冲区协议、能力检测和回退，再衡量通信成本 |
| 解码图片总内存 | 本次释放旧场景 GPU，但通用 `assets.image()` 仍缓存解码图片，不能声称全部浏览器内存已受限。后续应测量长局素材切换，并设计消费者引用计数后再释放 |

尚未验证真实 iOS / Android / Firefox、20 真人长时间战斗、生产服务器 CPU 与出口；本次不推送或部署。渲染修改不运行 golden 更新；全局类型 / 导入边界检查的既存失败详见任务记录。

## 复验

```powershell
node --test test/render/runtime-performance.test.js test/render/board3d-scene.test.js
$env:RENDER_E2E='1'
$env:CHROME_PATH='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node --test test/render/scene-preparation.browser.test.js
node --test --test-name-pattern='both layers|camera transitions|fallbacks:' test/render/board3d.browser.test.js
```

浏览器文件逐个运行；需要本地可选素材。浏览器测试在无头 Edge 中执行，不等同真人联机验收。
