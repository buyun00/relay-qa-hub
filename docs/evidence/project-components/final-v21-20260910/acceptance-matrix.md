# QA Hub v2.1 试用发布验收矩阵

记录日期：2026-09-10  
最终 API/Android 源码：`88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b`；保留的 Windows/Web 试用物仍来自 `867387fe69714ae0c3aafa6182946ffd80495768`  
隔离实例：API `4639`、Web `4640`、server MCP `4641`、local MCP `4642`  
结论：**NOT COMPLETE**。最终候选的 API、Android 模拟器、既有 Windows/Web 试用物、迁移回退及隔离共存都有真实证据；细粒度矩阵仍有大量 `not_run`/`needsRevalidation`，另有六项已明确移交用户自测，因此不能宣布 v2.1 制作完成。

状态定义：`PASS` 表示真实入口执行并回读；`FAIL` 表示真实执行暴露故障；`UNRUN` 表示尚未覆盖；`用户自测／已移交，代理未执行` 表示由用户负责且代理没有代跑。监听、静态构建、dummy 配置或 mock 不单独算业务 E2E。

| 能力/交付面 | 入口 | 状态 | 实际结果与证据 |
| --- | --- | --- | --- |
| 项目一级与唯一 GM | Web + HTTP | PASS | GM 创建隔离项目；普通姓名登录只见所属项目；GM 项目管理与普通项目会话隔离。见 [`web/core-e2e-report.md`](web/core-e2e-report.md)。 |
| 简单姓名登录 | Web + HTTP | PASS | `Luna UI User` 首次登录成功；成员停用后立即拒绝，再恢复后可登录并看到原 Bug。见 [`web/core-e2e-report.md`](web/core-e2e-report.md)。 |
| 员工项目归属与内部人员管理 | Web + HTTP + local MCP | PASS | 人员 ID、启用/停用、项目范围、撤销即时失效与恢复均从真实入口执行；Windows 升级后 local MCP 仍回读同一项目。见 Web 与 [`windows/post-upgrade-process-mcp.json`](windows/post-upgrade-process-mcp.json)。 |
| Bug 基础模块 | Web + HTTP + server MCP | PASS | 新建、列表、详情、编辑、评论、附件 init/chunk/finalize/bind/download、错误项目拒绝均通过；68 字节附件下载逐字节一致。见 [`web/attachment-e2e.json`](web/attachment-e2e.json)、[`web/comment-readback.json`](web/comment-readback.json)。 |
| Bug 原生生命周期 | APK + HTTP | PASS | 设备队列生成 `LOCAL-2`，人工修复、无代码交付、指派验收、图片绑定、验收通过并关闭；最终 state `closed`、version `6`。见 [`android/lifecycle-final-verification.md`](android/lifecycle-final-verification.md)。 |
| Android 离线提交、重连和幂等收据 | APK + HTTP + 设备 DB/WAL 事实 | PASS | operation `5a36736c-e35d-45d9-999a-ea7521f4848d` 最终 `SUCCEEDED`；client submission 只有一条 receipt，创建 `LOCAL-2`，无重复。见 [`android/offline-queue-report.md`](android/offline-queue-report.md) 与 [`android/offline-queue-db-readback.txt`](android/offline-queue-db-readback.txt)。 |
| 五个按项目可选组件的管理面 | Web + HTTP | PASS | 五项默认关闭；逐项目配置保存/刷新回读、依赖顺序与缺配置状态通过；依赖冲突显示精确提示并保留输入，不误报“记录已变化”。见 [`web/core-e2e-report.md`](web/core-e2e-report.md) 与 [`web-final-867387f/report.md`](web-final-867387f/report.md)。 |
| 打包真实外部终态 | Web/EXE/APK + HTTP/MCP + Jenkins | 用户自测／已移交，代理未执行 | 用户负责真实 Jenkins 构建号、终态和独立产物回读；代理只保留合同与安全 dummy 证据。见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。 |
| 单次打包上传真实外部终态 | Web/EXE/APK + HTTP/MCP + Jenkins/上传目标 | 用户自测／已移交，代理未执行 | 用户负责同链路 build→upload 的真实远端终态、任务 ID 与文件散列。见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。 |
| 增量上传真实发布终态 | Web/EXE/APK + HTTP/MCP + 上传平台 | 用户自测／已移交，代理未执行 | 用户负责真实 `published=true`、`remoteStatus=100`、目标路径与远端文件回读。见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。 |
| Relay 制作真实交付 | Web/EXE/APK + HTTP/MCP + Relay | 用户自测／已移交，代理未执行 | 用户负责专用 Relay 项目、工作区、执行器、callback 与 `commitSha=remoteSha` 交付回读。见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。 |
| 第三方同步/青鱼真实订单闭环 | Web/EXE/APK + HTTP/MCP + 青鱼 | 用户自测／已移交，代理未执行 | 用户负责获准测试账号、项目和订单的导入及解决终态回读。见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。 |
| Web 最终资产与错误态 | Web | PASS | 实际加载 `/assets/index-BHhxArNW.js`，SHA-256 `296935b38f898f33f49f28a262cd7cff929ac5d5aae3353819d3744659dfb907`；组件依赖错误提示、输入保留与服务端零变更通过。见 [`web-final-867387f/`](web-final-867387f/)。 |
| HTTP API | HTTP | PASS | 最终构建重启后仍为 schema `20`；真实链路完成上传丢回执恢复、附件元数据 `unbound→reserved→claimed`、通知读取 CAS/精确重放、跨项目/未认证/错误版本拒绝，并从 SQLite 回读唯一 committed 回执、唯一审计事件及匹配 HMAC-SHA-256。见 [`live-http-e2e.json`](live-http-e2e.json)、[`live-http-db-receipt.json`](live-http-db-receipt.json)。 |
| server MCP | MCP `4641` | PASS | 重启后的 initialize、`tools/list=96`、`qa_list_projects`、`qa_list_bugs` 均真实通过；既有项目/Bug/评论/附件 materialize 与错误项目拒绝证据继续保留。见 [`post-restart-mcp-check.json`](post-restart-mcp-check.json) 与 [`web/core-e2e-report.md`](web/core-e2e-report.md)。 |
| Windows EXE 与 local MCP | EXE + MCP `4642` | PASS | build12 从真实 UI 检查、下载并“安装并重启”至 build13；旧 PID 退出、新 PID 自动启动，helper/marker handshake 完整；同一 profile、项目、Bug、未提交草稿与 PNG 指纹保留；最终 API 重启后 local MCP `.13` 仍返回 96 工具并完成项目/Bug 实读。见 [`windows/acceptance-matrix.md`](windows/acceptance-matrix.md) 与 [`post-restart-mcp-check.json`](post-restart-mcp-check.json)。 |
| Windows 候选完整性 | installer/feed | PASS | `0.2.0-preview.13`，release `20260910T044149231Z`，installer SHA-256 `7610c92fd39d4485d78e3d8ee7618d79d5e8ed9f3d6ce096c2922c72e5388ab0`；manifest Ed25519 通过，ASAR 中版本/源码和 Web/Desktop 文件与构建产物一致。见 [`builds/windows-build13-preinstall.json`](builds/windows-build13-preinstall.json)。 |
| Windows Authenticode | installer | FACT / NOT SIGNED | `AuthenticodeStatus=NotSigned`；这与有效的 Ed25519 更新 manifest 是两项独立事实。见 [`builds/windows-build13-signatures.json`](builds/windows-build13-signatures.json)。 |
| Android APK 构建、签名、feed 与安装 | APK | PASS | 最终源码构建 code `28` / `0.2.0-preview.15`，35,913,773 bytes，SHA-256 `61a885f22b9a62383d923bf36ca0f9ade9f987c22bb30c7323bd8acbd7536e7a`，v2 签名；仅隔离 feed 原子发布并由 API/Web 的 GET、HEAD、Range 逐字节回读。见 [`android/acceptance/android-code28-self-update/artifact-verification.json`](android/acceptance/android-code28-self-update/artifact-verification.json) 与 [`android/acceptance/android-code28-self-update/feed-http-verification.json`](android/acceptance/android-code28-self-update/feed-http-verification.json)。 |
| Android 应用内自更新 | APK/MuMu | PASS | 先后由应用内“检查更新”和 Android 系统安装器完成 code 26→27→28；没有用 `adb install`/`pm install` 代替。最终拉取已安装 APK 的 SHA-256 与候选完全一致，项目、姓名、关闭 Bug、截图草稿、反向端口和 daily 包均保留。见 [`android/acceptance/android-code28-self-update/luna-e2e/058-verdict.md`](android/acceptance/android-code28-self-update/luna-e2e/058-verdict.md)。 |
| Android MediaProjection 截图与草稿 | APK/MuMu | PASS | 独立复验中完成一次悬浮球截图，应用 PID 保持、草稿可见、反向端口不变且无产品 fatal marker；随后两次应用内升级仍保留该草稿。见 [`android/acceptance/android-mediaprojection-revalidation/36-revalidation-verdict.md`](android/acceptance/android-mediaprojection-revalidation/36-revalidation-verdict.md)。 |
| Android 物理设备 | APK | 用户自测／已移交，代理未执行 | 代理只执行了 MuMu；物理设备上的截图、更新、离线队列与收据复验由用户负责。见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。 |
| schema 迁移与回退 | HTTP + MCP + SQLite copy | PASS | 独立副本真实执行 `19 -> 20 -> 19`；MCP `94 -> 96 -> 94`；同一员工、项目、5 个 Bug、全部逻辑行和 5 个证据文件保持一致；自动 v19 备份与基线 DB 字节相同。见 [`migration/README.md`](migration/README.md) 和 [`migration/result.json`](migration/result.json)。 |
| 生产、旧 preview 与失败现场并存 | read-only observation | PASS | 最终重启后再次只读核对：生产 `4319/4174/4320`、旧 preview `4419/4274/4420`、保留现场 `4539/4541` 及 v2.1 `4639/4640/4641/4642` 共 12 个监听均在；所有 API ready、所有 Web HTTP 200，v2.1 四端口保持 loopback。见 [`coexistence-post-restart.json`](coexistence-post-restart.json)。 |
| 最终 API 运行时重启与持久回读 | HTTP + server/local MCP + SQLite | PASS | 只重启隔离 API：PID `16000→26088`，Web/MCP PID 未变；receipt、完整命令行、loopback 监听、ready 200、schema 20、DB integrity/FK 均通过，随后真实 HTTP 与两种 MCP 回读通过。见 [`api-runtime-restart/restart-verification.json`](api-runtime-restart/restart-verification.json)。 |
| 最终源码门禁 | source | PASS | `88a6d0f` 上 TypeScript 构建与 5 项冻结/增量合同检查通过；storage 166 PASS/1 SKIP，API JS 274/274、TS 47/47；Android clean unit+lint+assemble 59 tasks 与更新 UI 定向 32 tasks 均通过。并行首次失败日志原样保留，隔离完整复跑通过。见 [`source-verification-88a6d0f/summary.json`](source-verification-88a6d0f/summary.json)。 |

## 试用发布物

- Android：隔离 feed 中的 `Relay-QA-Hub-Android-28-0.2.0-preview.15.apk`，SHA-256 `61a885f22b9a62383d923bf36ca0f9ade9f987c22bb30c7323bd8acbd7536e7a`。
- Windows：隔离 feed 中的 `qa-hub-preview-v21-e2e-fresh-0910-windows-0.2.0-preview.13-20260910T044149231Z.exe`，SHA-256 `7610c92fd39d4485d78e3d8ee7618d79d5e8ed9f3d6ce096c2922c72e5388ab0`。
- Web/API/server MCP：隔离实例 `4640/4639/4641`；Windows build13 提供 local MCP `4642`。

## 尚未完成

代理侧的细粒度覆盖矩阵已按最终源码重新生成：1,030 项、47 个退休项、637 项需要复验；各入口仍有大量 `not_run`，详见 [`../coverage-matrix.md`](../coverage-matrix.md)。这些行保持权威，因此整体不能标 complete。

用户侧六项均为 `用户自测／已移交，代理未执行`：物理 Android 真机、真实打包、单次打包上传、真实增量上传发布、Relay AI 制作交付、第三方同步和轻语闭环。操作与回填要求见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。
