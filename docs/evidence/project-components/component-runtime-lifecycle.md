# 组件 runtime 的 API 生命周期验证

2026-09-09，独立源码验证，未启动、重启或关闭现有预览/生产服务。

最初“runtime 从未启动”的判断不成立：旧 `registerProjectComponentRoutes` 在末尾注册了 Fastify `onReady -> runtime.start()` 和 `onClose -> runtime.close()`。实际缺陷是 `onReady` 发生在端口绑定成功之前；此外，`main.ts` 的 runtime 原来是 `try` 内局部常量，应用构造同步失败时，外层清理无法取得这个已构造资源。

已保留旧行为的真实复现：在独立 SQLite 中创建明确测试配置的 queued build，再使用实际占用的 loopback 端口启动 API。`listen` 返回 `EADDRINUSE`，但 runtime 已通过注入 transport 发起 1 次 `/job/fixture/api/json` GET。transport 只记录并拒绝请求，真实外部网络调用为 0。复现脚本、原编译 runtime SHA 和结果保留在 [结构化证据](runs/component-runtime-lifecycle.json) 指定的工作树外 fixture 目录。

修复把 runtime 生命周期归属移到 `createApiServer`：只有 `app.listen()` 成功并且没有并发关停时才调用 `start()`。失败和关停共享幂等关闭 Promise，避免重复关闭 SQLite。Fastify 先停止接收并排空 HTTP handler，随后 `onClose` 停止 runtime 的定时循环、等待正在执行的 tick 并关闭其资源，最后主入口关闭 worker；如果 Fastify 关闭过程失败，仍尝试清理剩余资源并报告错误。主入口在 `try` 外保留 runtime 引用，使应用构造同步失败也可清理。

`ProjectComponentsRuntime` 内部调度和 hold 逻辑未改，只移除了原路由注册函数末尾两条生命周期 hook。直接使用路由注册的 API/Web 测试现在显式关闭 runtime。Android、desktop 和 Web 产品源未改。

新增 `apps/api/test/component-runtime-lifecycle.test.mjs` 使用真实 Fastify listener、真实 `ProjectComponentsRuntime`/SQLite worker 和被拦截的外部 transport，9/9 通过：

- 仅 `app.ready()` 不执行队列；并发正常启动只启动 runtime 一次；停止等待真实的延迟 transport，再关闭 worker。
- 实际端口占用导致绑定失败时，runtime 启动次数为 0、关闭次数为 1，queued 状态保持不变，外部 transport 调用为 0。
- 启动尚未完成时并发停止，不启动 runtime，不重复关闭。
- 慢 HTTP handler 在关停中仍可读取 runtime 数据库；新请求被拒绝，handler 完成后才关闭 runtime/worker。
- 实际 paused import hold 阻止已启用组件的既存 queued 任务；正常启动但全部组件默认关闭时也无外部请求。
- 应用构造同步失败、runtime 启动失败以及关闭失败的路径，均验证资源关闭和 worker 顺序。

最终门禁：完整 API `npm run test --workspace @relay-qa-hub/api` 包含 TypeScript 编译，151 个 `.mjs` + 33 个 `.ts`，共 **184/184**；日志保存在 [api-final-lifecycle-source.txt](runs/api-final-lifecycle-source.txt)，没有覆盖此前 175 项日志。另一次定向 API/组件/Relay 回归为 39/39。Web 全部 **61/61**、两个 TypeScript 配置和 ESLint 均通过，测试服务地址明确设为 `http://127.0.0.1:1`，没有连接预览 API。Prettier 和 `git diff --check` 通过；没有重建未变更的 Web bundle。

测试过程保留了准备阶段的限制：第一份复现 fixture 缺少必填 `zipPath`，补齐后使用独立子目录复现；第一版慢 HTTP 测试的客户端探测等待被终止，改为有界并发探测后通过；Web 首次运行因缺少必填测试地址而未启动测试，明确配置后通过。这些记录没有被当作成功验收。

本证据证明应用生命周期和隔离 transport/SQLite 的行为；不代表 Jenkins、Relay、uploader、轻语等真实外部资源已完成端到端执行验收。
