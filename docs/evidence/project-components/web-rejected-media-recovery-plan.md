# Web 坏媒体明确拒绝后的显式换稿验收计划

状态：`prepared / not_run`。本文件描述待 root 审查的单一真实浏览器场景；静态检查不能代替验收结果。仅新增 runner 与本计划/准备记录，不修改产品、矩阵、运行中的服务或既有证据。

## 范围与隔离

- 仅现有预览 Web `127.0.0.1:4274`、API `127.0.0.1:4419`；配置参数必须精确指向独立预览的 `instance.json`，源码路径和实例标识须匹配。
- 为每轮创建新 UUID 项目、新唯一员工姓名；仅 GM 创建新项目，员工通过真实 Web 姓名登录。五个组件须全部关闭。
- 使用固定 Edge 可执行文件、自有 headless profile、独立调试端口 `9366`；端口占用即停止，不连接已有浏览器。比较新启动 PID、创建时点、路径和 CDP 所属 PID。正常 `Browser.close` 后可重开同一自有 profile；不使用强制终止或清理。
- 每轮 runtime 和公开证据目录均为新 UUID，文件以 create-only 写入；保留 runner 原字节、全部失败、两份媒体、profile、截图和请求/检查记录。已有浏览器、EXE、生产目录和其他项目均不在操作范围。
- GM 凭据只在正式 `--run` 内从既定私有配置读取，不作为命令参数、响应正文或日志输出。准备阶段没有读取该文件。
- 参考已通过的 [未知回执浏览器验收说明](web-submission-recovery-live/README.md) 和同名 runner。此次不丢弃或伪造任何响应。

## 固定输入和真实步骤

1. 检查四份 Web 源码 SHA、当前页面加载 JS 的 URL/大小/SHA 与已发布 `7904e2c` 产物一致，确认 API ready/schema14、新项目列表为空、五组件关闭。
2. 使用真实 PNG 签名但仅有前 12 字节的截断文件 `rejected-truncated.png`，MIME 为 `image/png`。这是特意构造的结构损坏 PNG，不宣称有效图片。填写原文并点击一次「创建 Bug」。
3. 不拦改服务端响应：观察真实 `POST uploads/:id/finalize` 返回 `400 / UPLOAD_CONTENT_INVALID`。同时核对页面发出的 `POST /api/v1/bugs` 数为 0、持久 journal 的 `commitAttempts=0` 且没有 `requestBody`，API 新项目 Bug 列表仍为空。
4. 验证原拒绝 journal 的完整冻结输入、上传 checkpoint、拒绝回执和坏 File/Blob SHA 保留。只读取本轮实际得到的 session 对应 `dataRoot/quarantine/uploads/<session>/1/0.bin`，其 SHA 必须等于原 12 字节文件；不查询生产、不扫描其他 session、不打开 SQLite。
5. 在页面编辑当前稿，移除当前稿中的坏图，换入真实有效 68 字节 PNG `replacement-valid.png`。这些操作不删除旧 journal 的 File/Blob 或服务器隔离文件。点击前断言旧条目完全相同、只有一条旧意图、Bug POST 仍为 0。
6. 点击可见的「保留失败记录并提交修改稿」。仅这次明确操作允许创建新的 submission ID。请求守卫只放行该新意图、正确项目、改稿正文和新附件的上传/绑定，以及唯一一次 Bug POST；观察真实 201。
7. 读回正好一个 Bug、一个 occurrence、一个绑定附件、零评论；Bug 为 v1、reporter 和 project 匹配本轮员工/项目，下载 PNG 的 68 字节与 SHA 一致。旧条目只允许新增 `supersededBy`，其余冻结数据、坏媒体和拒绝回执须原样保留；新条目与旧条目作用域完全相同，提交次数为 1。
8. 正常关闭自有浏览器并重开同一 profile，检查两条 journal、原坏图字节、正确 Bug/附件和五组件关闭状态保留；没有自动发出第二个 Bug POST。

坏媒体 SHA 及有效 PNG SHA 会同时保存在准备 JSON 和每轮原始 proof 中。页面每次加载的 bundle 都重新校验；源码或页面产物变化时停止，不复用旧通过结论。

## 证据与失败口径

正式 runner 为 [web-rejected-media-recovery-live.mjs](../../../scripts/project-components/web-rejected-media-recovery-live.mjs)。默认不带 `--run` 只打印 not_run 用法并退出；必须先由 root 审查计划。

每轮输出 `web-rejected-media-recovery-live/<runId>/proof.json`、`runner.mjs`、真实 400 摘要和 5 张阶段 PNG；runtime 保留同版 runner/proof、完整 profile、原媒体和截图。检查记录中包含 API 只读读回与浏览器网络观察，两者可能描述同一请求，不能把 ledger 条数当作 HTTP 请求总数。

任何条件不符均保存失败；不自动更改预期、补建另一条意图、重做业务或删除残留。浏览器无法正常关闭时保留进程身份并报错，不改为强停。整个准备阶段仅做语法、格式与 lint 检查，不启动浏览器、不调用 API。

此场景只覆盖 **首次 Bug POST 尚未发生时，明确坏媒体拒绝后的人工换稿**。不覆盖未知提交史之后的 400/403、超时/5xx、评论拒绝、跨窗口并发、EXE/APK、外部组件、完整基线14或进程故障恢复；不会将本次结果传播到这些入口。
