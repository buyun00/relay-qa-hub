# Web 坏媒体拒绝后的显式换稿恢复

单轮真实验收通过，`2026-09-09T00:38:00.490Z–00:38:05.893Z`，runner 退出 0。独立只读复算 **81/81** 检查相符，没有业务重跑。仅使用独立预览 4274/4419、新项目与新员工、自有 headless Edge profile；未修改产品、矩阵或启停 API/Web。

原始证据：[proof.json](5f3c9726-5374-4c7d-9ba4-57573901968e/proof.json)，SHA `26b0310da268968626efa3cbde1be10461c05a77563b1d071b74008ffa1509fb`。独立复核及全部文件 SHA：[audit.json](audit.json)。准备时点的 `not_run` 记录保留在 [preparation](../web-rejected-media-recovery-preparation.json)，计划与 runner 未在执行后改写。

## 实际行为

1. 12 字节截断 PNG 走真实上传 init/chunk/finalize；finalize 返回 **400 / UPLOAD_CONTENT_INVALID**。此时 Bug POST 为 0、旧 journal `commitAttempts=0` 且没有 Bug requestBody，项目 Bug 列表仍为空。
2. 页面保留原稿及明确恢复按钮。用户操作路径实际编辑正文、移除当前稿中的坏图、选择有效 PNG，再点击「保留失败记录并提交修改稿」。点击前旧意图和坏 Blob 保持，Bug POST 仍为 0。
3. 该显式动作新建 submission ID，只发一次 Bug POST，收到真实 201。最终正好 **1 Bug / 1 occurrence / 1 附件 / 0 评论**，Bug v1，项目与员工一致。有效 PNG 为 68 字节，下载 SHA `5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15`。
4. 旧 journal 除新增 `supersededBy` 外完整相同；原拒绝回执、冻结 payload、上传 checkpoint 和坏 Blob 保留。其 runtime 原文件与精确 session 的隔离 chunk 仍是原 12 字节，SHA `218ad85a233eff829618a6865ab681222b734c62d35a32b3eabd5c37d8945f86`。
5. 自有 Edge 正常关闭后重开同一 profile，两条 journal、Bug/PNG、员工作用域保持，没有自动重复提交；两次浏览器均正常关闭。五组件始终关闭，组件路由请求为 0。

项目 `5fbf115a-4f3f-4b44-bfb0-907da639b65b`，员工 `27818fb8-6f44-42a0-8dd8-cce791bc9262`，Bug `08f36597-a582-4bd2-96e4-2361bbb77315`。原拒绝 submission 为 `23b8fcf5-20d7-46d3-a902-b3a1c2f38fba`，新 submission 为 `16c72a31-d04b-4baa-a93e-9af51c1e0624`。测试数据、坏上传、profile 和文件全部保留，没有清理。

两次加载的真实 Web bundle 都匹配已发布 `7904e2c` 的固定 SHA；四份 Web 当前源码 SHA 相符。已知 API 请求为 68（浏览器请求记录 65 + 只读 readiness/GM 登录/建项目各 1），响应和只读镜像不能再计一次；这不是全部网络请求数量。

## 可见证据与边界

已人工查看以下三张原始 PNG，五张截图均与 proof 的字节 SHA 相符：

- [真实拒绝后按钮](5f3c9726-5374-4c7d-9ba4-57573901968e/02-real-400-recovery-button.png)
- [换稿后、明确点击前](5f3c9726-5374-4c7d-9ba4-57573901968e/03-corrected-draft-before-explicit-action.png)
- [正常重开后的唯一 Bug 与附件](5f3c9726-5374-4c7d-9ba4-57573901968e/05-final-retained-state.png)

只读公开 JSON 扫描覆盖 3,577 个字符串，敏感字段/Bearer/JWT/PEM 模式发现 0；本次复核没有重新打开私有凭据做精确值扫描。GM 登录仅用于新项目准备，其 bearer 登录格式不构成 Android 验收。

本证据仅覆盖 **尚未发送首个 Bug POST 时，明确上传拒绝后的人工换稿与正常浏览器重开**。未知提交史后收到 400/403、超时/5xx、评论拒绝、EXE/APK、并发/强制崩溃和外部组件均未由此测试；不提升完整基线14。
