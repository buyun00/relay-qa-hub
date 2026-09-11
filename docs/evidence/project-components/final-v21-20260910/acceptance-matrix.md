# QA Hub v2.1 试用发布验收矩阵

记录日期：2026-09-10  
最终产品源码锚点：`fd0f0f850f907b8a77aac8ec8b6a71b308bdd711`；Windows/Web build 20 来自该提交，Android 保留产物的 `apps/android` Git tree 与该提交一致。  
来源说明：历史浏览器回读保留其原始提交 `88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b`；当前源码代理复验状态单独记录，不能由源码等价推定。  
隔离实例：API `4639`、Web `4640`、server MCP `4641`、local MCP `4642`  
结论：**代理复验仍未完成，整体为 NOT COMPLETE。** 当前仍有代理门禁失败、待测或未提供完整报告；六项用户自测也均已移交、代理未执行且保持 NOT_RUN。

状态定义：`PASS` 表示真实入口执行并回读；`FAIL` 表示真实执行暴露故障；`UNRUN` 表示尚未覆盖；`用户自测／已移交，代理未执行` 表示由用户负责且代理没有代跑。监听、静态构建、dummy 配置或 mock 不单独算业务 E2E。

| 能力/交付面 | 入口 | 状态 | 实际结果与证据 |
| --- | --- | --- | --- |
| 项目一级与唯一 GM | Web + HTTP | PASS | GM 创建隔离项目；普通姓名登录只见所属项目；GM 项目管理与普通项目会话隔离。当前隔离 Web 又由非 GM 用户从项目入口进入 `10000000-0000-4000-8000-000000000004`，API 项目目录只回读该项目。见 [`web/core-e2e-report.md`](web/core-e2e-report.md) 与 [`continuation-20260910/web-cua-readback.json`](continuation-20260910/web-cua-readback.json)。 |
| 简单姓名登录 | Web + HTTP | PASS | `Luna UI User` 首次登录成功；成员停用后立即拒绝，再恢复后可登录并看到原 Bug。当前隔离 Web 又以 `LunaV21E2E_0910_1038` 通过可见入口完成姓名登录并由 API 回读同一项目身份。见 [`web/core-e2e-report.md`](web/core-e2e-report.md) 与 [`continuation-20260910/web-cua-readback.json`](continuation-20260910/web-cua-readback.json)。 |
| 员工项目归属与内部人员管理 | Web + HTTP + local MCP | PASS | 人员 ID、启用/停用、项目范围、撤销即时失效与恢复均从真实入口执行；Windows 升级后 local MCP 仍回读同一项目。见 Web 与 [`windows/post-upgrade-process-mcp.json`](windows/post-upgrade-process-mcp.json)。 |
| Bug 基础模块 | Web + HTTP + server MCP | PASS | 新建、列表、详情、编辑、评论、附件 init/chunk/finalize/bind/download、错误项目拒绝均通过；68 字节附件下载逐字节一致。当前隔离 Web 可见入口另完成 Bug 新建、指派、编辑和评论，API 回读 `LOCAL-4` version `3` 及唯一评论。见 [`web/attachment-e2e.json`](web/attachment-e2e.json)、[`web/comment-readback.json`](web/comment-readback.json) 与 [`continuation-20260910/web-cua-readback.json`](continuation-20260910/web-cua-readback.json)。 |
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
| server MCP | MCP `4641` | PASS（目录与已执行子集） | server/local MCP 均观察到 96 项工具目录；真实执行范围仅为 initialize、目录、登录、项目列表、Bug 列表与已有附件一致性子集。该证据不声称 96 项工具全部通过业务 E2E。见 [`post-restart-mcp-check.json`](post-restart-mcp-check.json)。 |
| Windows EXE 与 local MCP | EXE + MCP `4642` | PASS（升级链路） | 隔离 Ed25519 清单更新器完成 `0.2.0-preview.19→0.2.0-preview.20`，精确重启已安装 EXE，保留 version 19 回退备份、preview 配置、项目、草稿与 local MCP；升级后只读 reload 通过。Authenticode 与桌面通知路由仍为独立失败门禁。见 [`continuation-20260911/postfix-fd0f0f8/upgrade/auto-relaunch-verification.json`](continuation-20260911/postfix-fd0f0f8/upgrade/auto-relaunch-verification.json)、[`continuation-20260911/postfix-fd0f0f8/upgrade/postupgrade-readonly.json`](continuation-20260911/postfix-fd0f0f8/upgrade/postupgrade-readonly.json)、[`continuation-20260911/postfix-fd0f0f8/upgrade/registration-readonly.json`](continuation-20260911/postfix-fd0f0f8/upgrade/registration-readonly.json) 与 [`continuation-20260911/postfix-fd0f0f8/summary.json`](continuation-20260911/postfix-fd0f0f8/summary.json)。 |
| Windows 候选完整性 | installer/feed | PASS | `0.2.0-preview.20`，release `20260911T000006100Z`，installer SHA-256 `e0e68a626657f4431447764d96f0cf95ded8b6b081c8b13f809ccacd252e7e41`；独立 receipt、publication-result 与 signed manifest 绑定同一 source/release/version/hash，发布事务完成。见 [`continuation-20260911/postfix-fd0f0f8/summary.json`](continuation-20260911/postfix-fd0f0f8/summary.json)、[`continuation-20260911/postfix-fd0f0f8/package/receipt.json`](continuation-20260911/postfix-fd0f0f8/package/receipt.json)、[`continuation-20260911/postfix-fd0f0f8/package/publication-result.json`](continuation-20260911/postfix-fd0f0f8/package/publication-result.json) 与 [`continuation-20260911/postfix-fd0f0f8/package/signed-manifest.json`](continuation-20260911/postfix-fd0f0f8/package/signed-manifest.json)。 |
| Windows Authenticode | installed EXE | FAIL（必需门禁） | build 20 升级后只读检查为 `NotSigned`，signer 与 timestamper 均为空；该结果阻断代理范围完成。见 [`continuation-20260911/postfix-fd0f0f8/upgrade/registration-readonly.json`](continuation-20260911/postfix-fd0f0f8/upgrade/registration-readonly.json) 与 [`continuation-20260911/postfix-fd0f0f8/summary.json`](continuation-20260911/postfix-fd0f0f8/summary.json)。 |
| 桌面通知项目路由 | installed EXE + Windows WPN | FAIL（environment_blocker） | run `81c44b26-5c6f-47c6-a56a-d4eb27f19d7a` 仅完成 admission 与环境预检：无业务 fixture、无业务写请求，仅一次只读 readiness；WPN 投递到 console Session 1，而应用与 observer 位于 RDP Session 2，错误为 `WINDOWS_TOAST_SESSION_MISMATCH`。`productPass=false`，不得计为 PASS。见 [`../desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/proof.json`](../desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/proof.json) 与 [`continuation-20260911/postfix-fd0f0f8/summary.json`](continuation-20260911/postfix-fd0f0f8/summary.json)。 |
| Android APK 构建、签名、feed 与安装 | APK | PASS | 最终源码构建 code `28` / `0.2.0-preview.15`，35,913,773 bytes，SHA-256 `61a885f22b9a62383d923bf36ca0f9ade9f987c22bb30c7323bd8acbd7536e7a`，v2 签名；仅隔离 feed 原子发布并由 API/Web 的 GET、HEAD、Range 逐字节回读。见 [`android/acceptance/android-code28-self-update/artifact-verification.json`](android/acceptance/android-code28-self-update/artifact-verification.json) 与 [`android/acceptance/android-code28-self-update/feed-http-verification.json`](android/acceptance/android-code28-self-update/feed-http-verification.json)。 |
| Android 应用内自更新 | APK/MuMu | PASS | 先后由应用内“检查更新”和 Android 系统安装器完成 code 26→27→28；没有用 `adb install`/`pm install` 代替。最终拉取已安装 APK 的 SHA-256 与候选完全一致，项目、姓名、关闭 Bug、截图草稿、反向端口和 daily 包均保留。见 [`android/acceptance/android-code28-self-update/luna-e2e/058-verdict.md`](android/acceptance/android-code28-self-update/luna-e2e/058-verdict.md)。 |
| Android MediaProjection 截图与草稿 | APK/MuMu | PASS | 独立复验中完成一次悬浮球截图，应用 PID 保持、草稿可见、反向端口不变且无产品 fatal marker；随后两次应用内升级仍保留该草稿。见 [`android/acceptance/android-mediaprojection-revalidation/36-revalidation-verdict.md`](android/acceptance/android-mediaprojection-revalidation/36-revalidation-verdict.md)。 |
| Android 物理设备 | APK | 用户自测／已移交，代理未执行 | 代理只执行了 MuMu；物理设备上的截图、更新、离线队列与收据复验由用户负责。见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。 |
| schema 迁移与回退 | HTTP + MCP + SQLite copy | PASS | 独立副本真实执行 `19 -> 20 -> 19`；MCP `94 -> 96 -> 94`；同一员工、项目、5 个 Bug、全部逻辑行和 5 个证据文件保持一致；自动 v19 备份与基线 DB 字节相同。见 [`migration/README.md`](migration/README.md) 和 [`migration/result.json`](migration/result.json)。 |
| 生产、旧 preview 与失败现场并存 | read-only observation | PASS | build 20 自动重启期间生产与隔离服务 owner 保持；随后通知预检只启动并优雅退出其精确子进程，最终 host 指纹保留全部既有 QA Hub 进程与受保护监听。此项不把通知可见性记为通过。见 [`continuation-20260911/postfix-fd0f0f8/upgrade/auto-relaunch-verification.json`](continuation-20260911/postfix-fd0f0f8/upgrade/auto-relaunch-verification.json)、[`../desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/proof.json`](../desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/proof.json) 与 [`continuation-20260911/postfix-fd0f0f8/summary.json`](continuation-20260911/postfix-fd0f0f8/summary.json)。 |
| 最终 API 运行时重启与持久回读 | HTTP + server/local MCP + SQLite | PASS | 只重启隔离 API：PID `16000→26088`，Web/MCP PID 未变；receipt、完整命令行、loopback 监听、ready 200、schema 20、DB integrity/FK 均通过，随后真实 HTTP 与两种 MCP 回读通过。见 [`api-runtime-restart/restart-verification.json`](api-runtime-restart/restart-verification.json)。 |
| 最终源码门禁 | source | PARTIAL | 产品源码锚定 `fd0f0f850f907b8a77aac8ec8b6a71b308bdd711`，但代理复验仍有失败、待测或未报告门禁，不能记作完成。 |

## 试用发布物

- Android：隔离 feed 中的 `Relay-QA-Hub-Android-28-0.2.0-preview.15.apk`，SHA-256 `61a885f22b9a62383d923bf36ca0f9ade9f987c22bb30c7323bd8acbd7536e7a`。
- Windows：隔离 feed 中的 `qa-hub-preview-v21-e2e-fresh-0910-windows-0.2.0-preview.20-20260911T000006100Z.exe`，SHA-256 `e0e68a626657f4431447764d96f0cf95ded8b6b081c8b13f809ccacd252e7e41`。
- Web/API/server MCP：隔离实例 `4640/4639/4641`；Windows 0.2.0-preview.20 提供 local MCP `4642`。

## 尚未完成

代理侧的细粒度覆盖矩阵已按最终源码重新生成：1,030 项、47 个退休项、637 项带源码复验标记，详见 [`../coverage-matrix.md`](../coverage-matrix.md)。这些行继续保留且未被改成 PASS；该单一计数包含自动展开节点和历史源码漂移，不等于 637 个独立用户功能失败，也不替代上表的真实功能验收结论。

用户侧六项均为 `用户自测／已移交，代理未执行`：物理 Android 真机、真实打包、单次打包上传、真实增量上传发布、Relay AI 制作交付、第三方同步/青鱼真实订单闭环。操作与回填要求见 [`user-self-test-handoff.md`](user-self-test-handoff.md)。
