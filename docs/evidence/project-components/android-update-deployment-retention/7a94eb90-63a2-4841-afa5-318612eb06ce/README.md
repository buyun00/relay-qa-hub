# Android 更新路由：仅预览 API 的实际部署

API修复 `0a00ae2` 已部署到独立4419。原PID10036通过归属校验的manager停止，随后CIM确认旧PID不存在、4419无监听，再启动新PID22852（`2026-09-09T01:22:20.2728640Z`）。新服务ready/schema14，database/evidence/worker三项均ok。[部署结果和实际源码/编译字节](deployment-result.json)、[实际停止](api-stop.json)、[实际启动](api-start.json)。这里只操作显式 `-Services api`；Stop是精确进程操作，不称HTTP优雅关闭。

部署前 `01:16:48.147Z–01:16:55.339Z` 的 [before](before.json) 5/5通过；部署后 `01:22:49.902Z–01:22:54.639Z` 的 [after](after.json) 8/8通过。只读事务中发现的全部70张表指纹及schema保持，7条组件配置均off；4份evidence共228319字节、22个quarantine文件共642338字节、配置、Android两包PID/版本及草稿/偏好哈希、Web/serverMCP/localMCP与两个EXE进程身份保持。六个生产文件哈希和原生产进程启动时点也保持，未知的生产Node可执行路径仍按null记录。

维护进程只读打开预览数据库，经SQLite online backup生成3743744字节一致副本，SHA `e0ccd08befa911c9b8e4fc0ece0b4a0f42e09a80bf910466d503735ae9dae803`；随后建立引用附件archive并校验4个ready/clean引用附件及完整标记。未完成上传另作create-only副本，没有复制live WAL/SHM。全部38个私有保留文件共79402480字节，部署后哈希一致。[独立副本复核](before-artifact-review.json) 21/21，在immutable归档上重新计算70表及完整性/FK、附件和22个quarantine；未重新读取活库，未产生新sidecar。原副本、旧下载、配置和失败历史均保留。

实际匿名请求在旧服务上，preview/stable latest均为401。新服务上preview latest变为 **404 / ANDROID_UPDATE_NOT_FOUND**，说明已进入正确公开分发路由；此检查点尚未发布feed。另一channel的匿名请求在真实项目鉴权组合下仍是401，不能借用裸路由fixture将其写成404。[前](routes-before.json)、[后](routes-after.json)，各2次GET，无业务写入。

此前已加载的API源码 `8f7330a559fc9611e93f2ef62df0e63639f07afc` 另存完整Git ZIP，49209293字节，SHA `a7be190235ac96dbf13ecc4aa6b2ffb82f8cb0b9ce15ac36b6d039ebb582cf2a`。这是可重建源码输入，不是保留的旧dist，也不是已运行回退包。[范围记录](source-rollback-preparation.json)。本轮没有迁移旧生产、发布Android feed、安装APK、更新EXE或提升完整基线21。
