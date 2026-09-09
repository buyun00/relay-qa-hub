# Bug 详情首次加载误报修复

共享 Web 源码已修复并冻结，完整 Web **102/102** 测试、typecheck、lint、format 通过。没有构建或发布 Web dist，没有修改桌面/API/Android源码、矩阵或历史验收结果。机器记录及源码／日志 SHA 见 [web-detail-loading-fix.json](web-detail-loading-fix.json)。已安装 preview.8 仍保留原包，不把本次源码测试记作新版原生验收。

## 原因与两行改动

root 在 preview.8 打开原 Bug 时，第一份原生快照出现“Bug 详情读取失败／无法连接统一后端”，稍后未点重试便正常展示详情。两组私有 JSON／PNG 的路径和 SHA 已绑定到本证据，未修改原件。

`App.tsx:1038` 的 `resetDetail()` 同步设置 `detail=null`、`detailLoading=false`、`detailError=null`；`openDetail()` 随后选中 Bug，`useEffect` 到 `1228` 行才开始请求。恢复已有 `initialDraft.selectedId` 也产生同一首帧。旧 JSX 在 `detail=null` 且 `detailLoading=false` 时直接显示错误，即使没有任何请求错误；“无法连接统一后端”正是 `detailError=null` 时人为填入的兜底文字。

本次在 `2404` 行将“加载中”条件改为 `detailLoading || detailError === null`，在 `2409` 行只显示确实捕获的 `detailError`。原有请求、权限、并发请求代次和重试回调保持不变。真正失败仍显示原错误和“重新读取”；没有错误的初始状态显示加载提示。

## 可重复的源码验证

新增 [App.detail-loading.test.tsx](../../../apps/web/src/App.detail-loading.test.tsx) 直接使用真实 App，未模拟 hooks 或手写状态机：

1. `renderToStaticMarkup` 恢复选中记录，验证 effect 尚未开始时已显示加载、没有错误或重试。该测试在旧源确定失败，日志 `runs/web-detail-loading-before-fix-r2.txt` 原样保留。
2. React renderer 挂载 App，调用实际列表按钮回调，延迟 `getBug` promise；Profiler 检查每次提交的界面均没有详情错误，响应完成后显示正常详情。
3. 异步 promise 真实 reject 后，App 的 catch 显示原 Error 文本；通过实际“重新读取”按钮再次调用同 Bug 的加载函数，等待期间显示加载，成功后正常显示详情。

API 传输、无关的持久提交恢复及图标在测试中替换为固定 fixture；任何意外 fetch 都拒绝且被断言为0。测试不接入预览4419或生产4319。为此仅新增匹配当前 React 的 `react-test-renderer@19.2.8` 和 `@types/react-test-renderer@19.1.0` 开发依赖，锁文件新增三个测试包；无运行依赖更新。

最终日志为 `runs/web-detail-loading-final-tests.txt`、`-final-typecheck.txt`、`-final-lint.txt` 与 `-format.txt`。首次未提供强制显式 API 目标的启动错误，以及新测试非空断言触发的 lint 错误均保留；后者改为明确的挂载失败检查后，最终完整门禁重新通过。

## 发布与证据边界

现有 `apps/web/dist/index.html` 和 `index-Ce9wROrH.js` 仍分别为 `6cda7cc6…`、`c6e0392f…`，与原发布证据一致。此前99项源码测试、真实 Web101／81检查和 preview.8 原生证据均保持历史含义，不能用它们证明本次新源已经安装或发布。原快照与确定的首帧回归共同支持本次原因判断；本任务没有采集原失败瞬间的网络追踪，也没有重新执行修复后的真实 EXE UI。
