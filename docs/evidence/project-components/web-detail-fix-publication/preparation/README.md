# 共享 Web 详情加载修复：发布准备

状态：**prepared helper / not_run deployment / not_run Web UI**。本目录只记录新 helper 的源码审查、默认 inert 和本地临时目录测试。没有运行 `--prepare`、`--deploy` 或 `--restore-index`，没有连接 4274/4419、查询实际进程、打开浏览器、构建 Web 或操作任何服务。根代理随后发布和真实 UI 验收须各自新增原始记录，不能改写此准备时点。

## 输入与服务边界

- 输入固定为 `bc2b347dae282212a9119e5411b17fe144ca758c` 的 .9 package-only 原产物。原 run 为 `7ed02aa0-3669-4f85-932a-2cf3ed0eadaf`，目录为 `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview9-package-only-7ed02aa0-3669-4f85-932a-2cf3ed0eadaf\web-dist`。
- 8 个文件逐一使用原 `build-result.json` 的路径、长度、SHA。新 HTML SHA `22203c14cade9462e21d31b42beb2103c6c1ecabb1ebc2af00aa316968ff7367`，新 JS `assets/index-Br-CEXQI.js` SHA `813277e9792c91d27b2e153322a0a2bfcad277ec57723df712f7d84ae24ad3ae`。原 `prepared.json`、`build-result.json`、`result.json` 均硬 pin SHA 和 run/source 身份，29/29 package gate 只作为来源证据。
- 唯一允许写入的 served 目录为当前 worktree `apps/web/dist`。其 10 个旧文件必须与原 package-only before/after 完整清单完全一致，原 HTML SHA `6cda7cc65a884dcaafd1ea1f8e2a3b424032cd53f0d2d972b749b374be1408b5`。未知文件、缺失文件或任意 SHA 不符即拒绝，不能临时修改预期以继续发布。
- 已读 `scripts/project-components/preview-web.mjs:24–25,58–79`：服务固定读取 `sourceRoot/apps/web/dist`，每次请求重新 stat/read，静态返回 `no-store`；因此可以不重启服务而切换 HTML。`/api/*` 是代理，本 helper 绝不请求它；`/downloads/*` 与本发布无关，绝不写入。此服务没有 Range 实现，本方案不伪造 Range 检查。
- 后续实际执行会读取明确 instance（固定 SHA）、Web manager receipt，并通过 CIM 校对完整 PID/启动时间/可执行路径/命令行及唯一 4274 listener。命令行只在内存比较，证据仅保存摘要 SHA；输出不含 cookie、token、凭据或业务正文。命令必须精确指向本 worktree `run-preview-service.mjs`、该 instance 与 `web`。不查询或改变 EXE profile、Android、API、MCP、日常客户端或生产文件。根代理报告的当前 Web PID20284 是安排背景，不能替代执行时重新核对。

## 精确命令（根代理审阅后另行执行）

在本 worktree PowerShell 中，选择一个从未使用的新 UUID；保留终端原始输出，不重用失败 run。`RUNNER_SHA` 必须取本准备 `result.json` 中的冻结源码 SHA，不能在被修改脚本上无条件现算现批准。

```powershell
$webRunId = [Guid]::NewGuid().ToString()
$webInstance = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json'
node scripts/project-components/publish-preview-web-detail-fix.mjs --prepare $webInstance $webRunId
```

`--prepare` 只新建 `runtime/acceptance/web-detail-fix-publication-<UUID>` 和同名独立证据目录：完整复制旧 10 文件至 `old-web-dist-cold-restore`，复制原 8 文件至 `candidate-web-dist`，各自 source/copy/source 逐文件核验；保留 runner 副本、原目录清单、source before/after、Web 身份 before/after 和实际 HEAD/dirty。固定修复的四个源码 SHA、Web/shared 全源码树和服务 helper SHA 均保持一致，并用 `git diff bc2b347 -- <限定输入>` 拒绝源码漂移。此步骤不请求 HTTP、不改变 served 文件，不读取任何私密凭据文件。

审核新 `prepare.json`、私有 `plan.json` SHA、旧 10/新 8 文件、source/Web 身份后，显式传入已审 SHA：

```powershell
node scripts/project-components/publish-preview-web-detail-fix.mjs --deploy $webInstance $webRunId RUNNER_SHA PLAN_SHA
```

`--deploy` 永久 create-only 发布锁 → 精确重验批准 plan/source/旧目录 → 旧 index 实际 GET/HEAD → create-only 安装 2 个新 hash assets（相同旧资源只核验、不重写）→ 完整混合目录仍以旧 HTML 核验 → 再次检查 source/Web 身份 → 同卷唯一临时 HTML 原子 rename → 全目录核验 → 新 8 文件逐一实际 GET/HEAD。总计预期 **18 个直接静态 HTTP 请求**，仅 `127.0.0.1:4274` 固定 9 种文件路径；校对 instance/header/content-length 和每个 GET 的完整 bytes/SHA，HEAD 必须无正文。没有 API 请求、服务操作、构建、业务写入或浏览器动作。最终 served 为 12 文件：新 8 个加保留的旧 JS/map 两代，旧文件仅 HTML 被明确替换。

锁位于 `runtime/acceptance/.web-detail-fix-publication.lock`，失败不删除。若 post-check 失败，HTML 可能已经切换，必须保留 `failed_retained`、锁、pending 文件和实际目录；禁止自动重放、自动回滚或根据异常字符串推断未发布。CLI 在创建记录目录前的参数/pin错误只输出精简错误，需保留 root 终端日志。锁是该受控流程的互斥，不是对任意第三方 writer 的通用原子 CAS；因此仍需单一静态目录 writer 窗口。

## 恢复路径

成功发布且根代理决定回旧资源时，可审阅成功 `deploy.json` SHA 后执行一次：

```powershell
node scripts/project-components/publish-preview-web-detail-fix.mjs --restore-index $webInstance $webRunId RUNNER_SHA PLAN_SHA DEPLOY_PROOF_SHA
```

该动作有独立永久锁，只将 index 从**明确新预像**换回完整保全的旧 HTML，所有新旧 hash assets 保留；随后旧 10 文件 GET/HEAD（加动作前 2 请求，共22）及目录/source/PID读回。它恢复旧页面入口，**不是物理目录回到仅10文件**。部署失败时不自动允许该入口，需先只读诊断、单独审阅实际现场。

完整 `old-web-dist-cold-restore` 是可冷恢复的旧10文件副本，原副本永不作为可写 served 目录。若确需物理目录恢复，由根代理另行停止**明确拥有的 Web**后，将该副本 create-only 复制到新的恢复目录并校验完整清单，保留当时整个 served 目录，再做经批准的目录切换和启动读回；此 helper 没有 stop/start、递归删除或目录 move 功能。本轮不执行此冷恢复流程，也不声称已验收。

## 发布后的独立真实浏览器验收方案（未运行）

原修复只改变 `App.tsx` 详情分支：尚无错误时展示“加载中”，只有真实请求失败才显示错误/重试。原102源码测试和 .9 package byte 对照不能证明新 Web UI 已加载。

1. 根代理先完成上述静态发布记录，保留实际 index、新 JS、map/CSS GET SHA。浏览器使用全新独立 Edge profile 和独立 CDP 端口，不连接已有浏览器或 EXE；profile、精简截图、时间线和失败原件永久保留。只结束自己创建的浏览器（`Browser.close`）。
2. 按当前真实 DOM 进入一个明确合成 fixture 项目和 Bug，使用独立员工会话；如果需创建新员工/Bug，先由根代理明确限定新 fixture，再通过正式入口创建，不能复用现有员工草稿。所有组件全关，不调用组件页面或任务接口。
3. 实际网络读回新 `index-Br-CEXQI.js` SHA，记录确实执行的页面 bundle。观察到选中 Bug 的确切详情 GET 后，仅对此 GET 暂缓继续，让真实 App 展示 loading。以 DOM/截图时间线检查没有“Bug 详情读取失败”、人为“无法连接统一后端”或重试按钮，再释放请求至真正服务端，核对同 Bug/project/version 正常加载。CDP 暂缓只控制网络时机，不伪造成功 JSON。
4. 在同一新 fixture 上对下一次确切详情 GET 施加一次 `Fetch.failRequest` 网络失败，检查实际 catch 显示错误与“重新读取”；用观察到的真实按钮点击重试，允许后续请求直达 API，确认 loading→同 Bug 正常详情。不得把模拟的错误正文或 unit stub 作为服务端返回。
5. 重开同独立 profile 读回选中详情，检查首次无错误的 pending 状态；保存所有 UI 请求的路径/方法/安全 header 白名单，递归脱敏且保留 JSON primitive 类型。别把 CDP/HTTP 镜像 ledger 相加为请求总量。

当前静态/source/temp 结果只证明 helper 边界；以上真实 UI、发布、恢复全部仍为 **not_run**，等待根代理的独立执行证据。其它五入口、物理 Android、外部组件真实链路均不由此获得通过状态。

## 本地准备门禁

`result.json` 列出最终源码、测试、日志与本文件 SHA。11 个 temp/inert 测试保留其临时目录（含拒绝 junction）在系统 temp 中，绝不放进 preview runtime，也不清理它们。

首次 `tests-first.txt` 为10通过/1失败：断言误将多行错误 JSON 的最后一行当完整 JSON，harness 修为解析完整 stderr 后11通过；不涉及产品、服务或实际发布。首次 `lint-first.txt` 为一个 regex 不必要转义，移除后 lint 通过；原件均保留。所有检查只针对这两个新增 helper 文件，不重跑或替代既有 API/Web 产品测试。
