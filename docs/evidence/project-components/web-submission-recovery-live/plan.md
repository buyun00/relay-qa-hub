# Web 提交回执恢复：隔离真实验收计划

状态：`not_run`。本文件记录准备方案；尚未启动浏览器、创建项目/员工/Bug、发送上传/评论请求或注入响应丢失。静态检查不计作真实验收。

脚本：`scripts/project-components/web-submission-recovery-live.mjs`。主任务审查冻结版本并明确进入执行窗口后，才运行：

```powershell
node scripts/project-components/web-submission-recovery-live.mjs --run C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json
```

没有 `--run` 时只打印 `not_run` 并退出。脚本只接受上面的精确配置和 runtime，实例必须为 `qa-hub-preview-7c86`，API/Web 必须为 `127.0.0.1:4419/4274`，源码根必须为当前隔离工作树。沿用实例路径验证，拒绝生产根和链接逃逸。

## 已发布实现与准备检查

Web 提交恢复源提交：`7904e2c2d7285003884a5788a83300fbf521dbf1`。发布证据为 `../runs/web-pending-submission-publication.json`；本准备阶段只读该文件，没有重新发布。

每次打开独立浏览器时，都必须通过浏览器真实 Network 响应体核对以下脚本，验证通过才进行后续 UI 动作：

- URL：`http://127.0.0.1:4274/assets/index-Ce9wROrH.js`
- 长度：`477454` bytes
- SHA-256：`c6e0392ff28cbb86a27aec2dc1fe1cd4b47bb3eb9e22025c95e58a7187ab367d`

实际运行时另记录四个相关 Web 源文件及验收脚本的 SHA-256。若发布包变化，脚本应失败并等待重新审查，不能自动接受其他包。

准备阶段已执行 `node --check`、单文件 ESLint、Prettier 和无参数的 inert 入口。没有执行 `--run`。合成 1×1 PNG 的 IHDR/IDAT/IEND CRC 与解压数据已在本地静态检查；没有通过伪上传替代真实文件上传。

## 浏览器与数据边界

- 使用既有 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，Node 24 原生 WebSocket/CDP，无依赖安装。
- 调试端口固定 `127.0.0.1:9364`，启动前必须为空闲；不连接已有监听器。核对新进程 PID、可执行文件路径、启动时间，以及 CDP 报告的 Browser PID 与实际 spawn PID 一致。
- profile、TEMP、APPDATA、LOCALAPPDATA、缓存、崩溃目录、PNG 和截图全部位于全新 `runtimeRoot/web-submission-recovery-<UUID>`。不读取已有浏览器 profile、EXE profile 或客户端草稿。
- 仅对持有且已核实的 CDP 连接调用 `Browser.close`，等待相应进程消失并检查 9364 释放。没有 kill/taskkill、清数据、卸载或自动清理回退。若启动失败而无法取得正常关闭连接，保留失败与 PID，交由主任务处置，不擅自扩大进程操作范围。
- 浏览器关闭背景网络/同步/更新、禁止域名解析；受控页面的 Fetch 拦截只放行本机 4419/4274 及页面内部 about/data/blob。组件执行路由明确拒绝，即使是 GET 也不放行。这个边界描述的是该受控浏览器页面与启动参数，不宣称通用 OS 网络沙箱。
- 不连接 4420、4421、生产端口、现有 EXE/APK，也不启停任何 API/Web/MCP 服务。没有组件任务调用、第三方登录、外部构建或真实上传服务调用。

## 计划中的真实动作

1. 直接 GET 4419 ready，要求 `ready` 和 schema `14`。GM 密码仅从明确实例的私密配置读入内存；登录并创建全新 UUID 项目，使用本脚本生成的名称和短码。此处只有 fixture 准备，无已有项目更新。
2. 启动全新 headless Edge profile，进入 4274 明确 `projectId` 入口。观察 DOM 后，在姓名输入框填写全新员工名并点击实际“登录”。此后使用浏览器自身 cookie 会话，读取五组件配置并断言全部关闭。
3. 通过实际“新建 Bug”表单填写合成描述，给观察到的文件输入框添加真实 PNG。通过实际“创建 Bug”按钮触发正常 init/chunk/finalize/bind/commit。所有 mutation 都校验具体方法、路径、新项目、已观察到的上传 session/attachment 和稳定 submission/idempotency 身份；不直接调用创建 Bug API 来代替 UI。
4. CDP Fetch 在该首个 Bug POST 的服务端 **实际 201 响应阶段** 暂停，读取真实 JSON 回执并先持久保存脱敏原响应；再仅一次 `Fetch.failRequest/Failed`。不返回伪造响应、不替换 HTTP 成功内容。故障对应“服务端已提交、浏览器未收到成功回执”。
5. 等到真实“确认上次提交”按钮可用，用户式输入修改后的新稿。先读取该 profile 项目草稿及 pending journal，确认新稿、PNG、原未知提交已持久保存，再正常关闭浏览器。
6. 用同一个独立 profile 重新启动，观察新稿确实恢复；点击“确认上次提交”。确认 journal 持有原回执，UI acknowledge 指向原 submission，修改后的新稿仍在。直接只读 API 对照原 Bug ID/版本/内容/actor、一个 occurrence、事件、一个附件与实际字节 SHA，恢复前后完全相同。取消创建弹窗只隐藏表单，保留新稿。
7. 在该新 Bug 实际“状态轨迹与处理记录”表单输入合成评论，点击“记录”。同样在该首个 POST 的实际 201 回执已保存后丢响应一次。修改评论稿，检查持久化后正常关闭并重启同 profile；点击“确认上次记录”。要求原 comment ID/正文/actor 不变、总评论数为一，后改评论稿保留。
8. 最后再正常重启一次，读回两个确认回执和两份未提交的新稿；实际附件 bytes/SHA、Bug/评论/事件/版本仍与提交后快照相同。正常关闭仅本脚本的浏览器；所有 fixture、profile、截图和失败记录永久保留，不软删除或清理。

UI 选择仅使用执行时观察到的 DOM 节点与唯一文本/placeholder；找不到或出现多个候选时停止，不使用盲坐标。页面内只读 API fetch 使用同源 cookie 和明确项目头，不导出会话 token/cookie。读取 IndexedDB 仅使用本新 profile 的项目草稿 store、只读事务，不修改或伪造 journal。

## 证据与失败规则

每次 `--run` 生成独立证据子目录 `<UUID>/`。输出 `proof.json`、`bug-observed-201.json`、`comment-observed-201.json`（后两者只在真实成功回执被观察到时产生）。真实 PNG、截图和完整 profile 保留于私有 runtime；公共 proof 只记录其路径、长度和 SHA。

`proof.json` 包含阶段时刻、已核实 PID/启动/正常关闭、浏览器加载包哈希、观察到的 DOM 摘要、请求方法/路径/合成正文与头白名单、真实提交响应、只读 API 对照、持久草稿投影及断言。`check()` 在失败抛出前也保存 expected/actual/passed，stdout 仅打印状态、run ID、输出路径及断言数量。请求 ledger 包含 UI 请求与只读对照镜像，不能把数组长度直接写成服务端总 HTTP 请求数；GM fixture 登录单独记录脱敏概要。

敏感字段递归移除，已知内存 secret 和 Bearer 字符串替换；JSON 字符串仅在解析结果为对象/数组时递归处理，`"2.0"` 等 primitive 字符串保持原文。所有 Cookie、Authorization、CSRF/password/token 头均不进入白名单；不记录 CDP 的原始请求 headers 或私密配置。截图/文本只允许本次新员工、新项目和合成业务数据。

任何失败保留已产生的新项目、员工、Bug、上传、评论、审计、profile 与原始 proof；先判定 harness 或产品问题，再由主任务决定后续动作。不能改 expected、跳过检查或覆盖旧目录来制造通过。

## 当前不能声称通过的内容

当前真实 UI、真实响应故障、浏览器重启、真实上传和恢复全部 `not_run`。静态检查不能代替实际结果。本计划只验证一个独立浏览器 profile 内的共享 Web 实现及两次核心写入的回执恢复；不会自动证明现有 EXE 已升级、跨窗口同时提交、断电/强停、跨身份项目切换、附件各中间阶段丢包、所有错误类型、物理 Android 或外部组件链路。后改稿在这次流程中故意保持未提交，因此也不声称它已生成第二条业务记录。
