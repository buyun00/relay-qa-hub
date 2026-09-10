# QA Hub v2.1 试用发布验收矩阵

记录日期：2026-09-10  
产品源码：`867387fe69714ae0c3aafa6182946ffd80495768`  
隔离实例：API `4639`、Web `4640`、server MCP `4641`、local MCP `4642`  
结论：**BLOCKED**。已完成的核心业务、交付物、Windows 升级及迁移回退均保留真实证据；仍有必测项失败或未执行，不能宣布 v2.1 制作完成。

状态定义：`PASS` 表示真实入口执行并回读；`FAIL` 表示真实执行暴露故障；`UNRUN` 表示缺少执行资源或可达入口。监听、静态构建、dummy 配置或 mock 不单独算业务 E2E。

| 能力/交付面 | 入口 | 状态 | 实际结果与证据 |
| --- | --- | --- | --- |
| 项目一级与唯一 GM | Web + HTTP | PASS | GM 创建隔离项目；普通姓名登录只见所属项目；GM 项目管理与普通项目会话隔离。见 [`web/core-e2e-report.md`](web/core-e2e-report.md)。 |
| 简单姓名登录 | Web + HTTP | PASS | `Luna UI User` 首次登录成功；成员停用后立即拒绝，再恢复后可登录并看到原 Bug。见 [`web/core-e2e-report.md`](web/core-e2e-report.md)。 |
| 员工项目归属与内部人员管理 | Web + HTTP + local MCP | PASS | 人员 ID、启用/停用、项目范围、撤销即时失效与恢复均从真实入口执行；Windows 升级后 local MCP 仍回读同一项目。见 Web 与 [`windows/post-upgrade-process-mcp.json`](windows/post-upgrade-process-mcp.json)。 |
| Bug 基础模块 | Web + HTTP + server MCP | PASS | 新建、列表、详情、编辑、评论、附件 init/chunk/finalize/bind/download、错误项目拒绝均通过；68 字节附件下载逐字节一致。见 [`web/attachment-e2e.json`](web/attachment-e2e.json)、[`web/comment-readback.json`](web/comment-readback.json)。 |
| Bug 原生生命周期 | APK + HTTP | PASS | 设备队列生成 `LOCAL-2`，人工修复、无代码交付、指派验收、图片绑定、验收通过并关闭；最终 state `closed`、version `6`。见 [`android/lifecycle-final-verification.md`](android/lifecycle-final-verification.md)。 |
| Android 离线提交、重连和幂等收据 | APK + HTTP + 设备 DB/WAL 事实 | PASS | operation `5a36736c-e35d-45d9-999a-ea7521f4848d` 最终 `SUCCEEDED`；client submission 只有一条 receipt，创建 `LOCAL-2`，无重复。见 [`android/offline-queue-report.md`](android/offline-queue-report.md) 与 [`android/offline-queue-db-readback.txt`](android/offline-queue-db-readback.txt)。 |
| 五个按项目可选组件的管理面 | Web + HTTP | PASS | 五项默认关闭；逐项目配置保存/刷新回读、依赖顺序与缺配置状态通过；依赖冲突显示精确提示并保留输入，不误报“记录已变化”。见 [`web/core-e2e-report.md`](web/core-e2e-report.md) 与 [`web-final-867387f/report.md`](web-final-867387f/report.md)。 |
| 打包真实外部终态 | Web/EXE/APK + HTTP/MCP + Jenkins | UNRUN / BLOCKER | 只有安全 dummy 配置、合同测试和注入 fetch；没有隔离 Jenkins Job、执行器及独立产物下载。见 [`external/README.md`](external/README.md)。 |
| 单次打包上传真实外部终态 | Web/EXE/APK + HTTP/MCP + Jenkins/上传目标 | UNRUN / BLOCKER | 没有隔离 Jenkins 与上传账号/产品/渠道/对象前缀，未形成 build 到 upload 的终态回读。见 [`external/README.md`](external/README.md)。 |
| 增量上传真实发布终态 | Web/EXE/APK + HTTP/MCP + 上传平台 | UNRUN / BLOCKER | dummy credential 仅得到 `needs_configuration`；没有真实 `published=true`/远端终态与目标文件散列。见 [`web/component-readback.json`](web/component-readback.json) 与 [`external/README.md`](external/README.md)。 |
| Relay 制作真实交付 | Web/EXE/APK + HTTP/MCP + Relay | UNRUN / BLOCKER | 仓库只有 fake Relay/合同证据；没有专用 Relay 项目、工作区、执行器、callback 和真实交付物。见 [`external/audit.json`](external/audit.json)。 |
| 第三方同步/青鱼真实订单闭环 | Web/EXE/APK + HTTP/MCP + 青鱼 | UNRUN / BLOCKER | 没有测试身份、项目、订单或获准的隔离远端数据，未执行导入/解决回读。见 [`external/README.md`](external/README.md)。 |
| Web 最终资产与错误态 | Web | PASS | 实际加载 `/assets/index-BHhxArNW.js`，SHA-256 `296935b38f898f33f49f28a262cd7cff929ac5d5aae3353819d3744659dfb907`；组件依赖错误提示、输入保留与服务端零变更通过。见 [`web-final-867387f/`](web-final-867387f/)。 |
| HTTP API | HTTP | PASS | schema `20`；项目/身份/Bug/人员/组件/附件及隔离拒绝均有真实 read-back。相关证据汇总在 Web、Android 与迁移目录。 |
| server MCP | MCP `4641` | PASS | initialize、`tools/list=96`、项目/Bug/评论/附件 materialize 与错误项目拒绝通过。见 [`web/core-e2e-report.md`](web/core-e2e-report.md)。 |
| Windows EXE 与 local MCP | EXE + MCP `4642` | PASS | build12 从真实 UI 检查、下载并“安装并重启”至 build13；旧 PID 退出、新 PID 自动启动，helper/marker handshake 完整；同一 profile、项目、Bug、未提交草稿与 PNG 指纹保留；local MCP `.13`、96 工具及只读查询通过。见 [`windows/acceptance-matrix.md`](windows/acceptance-matrix.md)。 |
| Windows 候选完整性 | installer/feed | PASS | `0.2.0-preview.13`，release `20260910T044149231Z`，installer SHA-256 `7610c92fd39d4485d78e3d8ee7618d79d5e8ed9f3d6ce096c2922c72e5388ab0`；manifest Ed25519 通过，ASAR 中版本/源码和 Web/Desktop 文件与构建产物一致。见 [`builds/windows-build13-preinstall.json`](builds/windows-build13-preinstall.json)。 |
| Windows Authenticode | installer | FACT / NOT SIGNED | `AuthenticodeStatus=NotSigned`；这与有效的 Ed25519 更新 manifest 是两项独立事实。见 [`builds/windows-build13-signatures.json`](builds/windows-build13-signatures.json)。 |
| Android APK 构建、签名、feed 与安装 | APK | PASS | code `26` / `0.2.0-preview.13`，SHA-256 `63fb67774b0fed95f923f975a1e20956a7821a629157be965950379191953acb`，v2 签名及隔离 feed HTTP/Range 通过；`adb install -r` 后版本、项目、Bug 与 daily 包均保留。见 [`builds/android-code26-artifact.json`](builds/android-code26-artifact.json) 与 [`android/code26-result.md`](android/code26-result.md)。 |
| Android 应用内自更新 | APK | UNRUN / BLOCKER | 当前 preview 详情面没有可达的应用更新入口；没有通过原生 UI 完成 code25→26 自更新。`adb install -r` 仅作为安装验证，不能替代该路径。见 [`android/code26-result.md`](android/code26-result.md)。 |
| Android MediaProjection 截图与草稿 | APK/MuMu | PARTIAL | 系统授权、一次“立即截图”、应用内图片与待提交预览均 PASS。MuMu 随后发生 `Fatal signal 7 (SIGBUS)`，稳定性为 FAIL，按规则立即停止且未重试。见 [`android/capture-after-click.png`](android/capture-after-click.png) 与 [`android/capture-final-logcat.txt`](android/capture-final-logcat.txt)。 |
| Android 物理设备 | APK | UNRUN / BLOCKER | 本轮只有 MuMu；没有物理设备上的截图稳定性、更新与队列复验。 |
| schema 迁移与回退 | HTTP + MCP + SQLite copy | PASS | 独立副本真实执行 `19 -> 20 -> 19`；MCP `94 -> 96 -> 94`；同一员工、项目、5 个 Bug、全部逻辑行和 5 个证据文件保持一致；自动 v19 备份与基线 DB 字节相同。见 [`migration/README.md`](migration/README.md) 和 [`migration/result.json`](migration/result.json)。 |
| 生产、旧 preview 与失败现场并存 | read-only observation | PASS | 生产 `4319/4174/4320`、旧 preview `4419/4274/4420`、保留现场 `4539/4541` 及 v2.1 `4639/4640/4641/4642` 均仍监听；生产 API readiness 与 Web 返回 200。见 [`coexistence-final.json`](coexistence-final.json)。 |
| 最终源码门禁 | source | PASS | `04f22a5` 上 37/37 有效阶段通过；Node/Vitest 930 项中 929 通过、1 项按既有条件跳过，Android 24 套件 192/192 通过，lint 0 error；最终 APK 与已发布 code26 字节及 SHA 一致。三次编排环境错误均发生在测试启动前，原始失败与修正记录完整保留。见 [`source-gate/final-summary.json`](source-gate/final-summary.json)。 |

## 试用发布物

- Android：隔离 feed 中的 `Relay-QA-Hub-Android-26-0.2.0-preview.13.apk`，SHA-256 `63fb67774b0fed95f923f975a1e20956a7821a629157be965950379191953acb`。
- Windows：隔离 feed 中的 `qa-hub-preview-v21-e2e-fresh-0910-windows-0.2.0-preview.13-20260910T044149231Z.exe`，SHA-256 `7610c92fd39d4485d78e3d8ee7618d79d5e8ed9f3d6ce096c2922c72e5388ab0`。
- Web/API/server MCP：隔离实例 `4640/4639/4641`；Windows build13 提供 local MCP `4642`。

## 尚需资源

要解除发布阻断，需要专用 Jenkins Job/工作区、上传测试账号与产品/渠道/对象前缀、Relay 测试项目/工作区/执行器/callback、青鱼测试身份/项目/订单，以及一台可用物理 Android 设备。所有资源须与生产隔离，并允许只修改测试数据。
