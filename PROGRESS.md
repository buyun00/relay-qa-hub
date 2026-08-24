# Relay QA Hub Progress

- Goal status: `ACTIVE`
- Release target: `0.1.0-debug`
- Current phase: `P3`
- Current pointer: `P3.0`
- Current gate: `G3-ANDROID-APP-READY`
- Critical path: `G0 -> G1 -> G2 -> G3-ANDROID-APP-READY -> G4 -> G5 -> G6 -> G8 -> G9 -> G10`
- Active work packages: `P3.0`
- Next atomic action: `发布 App-first contract delta：补齐 native workflow、attachment finalize/bind、QA item ID、capture bundle 与 Poco enrichment schemas`
- Completed gates: `1 / 11`
- Last green commit: `a873df7e9f07d37e1116ab7ff06734eb1bde0281`
- Last deployed commit: `none`
- Schema version: `none`
- Production URL: `not deployed`
- Last production verification: `none`
- Last backup verified: `none`
- Last restore drill: `none`
- Blockers: `Android Studio/SDK/JDK/adb absent blocks P3.2+ build verification; actual vendored Poco project/version still needs P3.1 source discovery`
- Updated at: `2026-08-24T18:21:25+08:00`

## Gate status

| Gate | Status | Evidence | Verified at |
|---|---|---|---|
| G0-PLAN-READY | DONE | `docs/IMPLEMENTATION_PLAN.md`; local links and plan structure verified | 2026-08-24T16:42:00+08:00 |
| G0-CONTRACT-READY | DONE | [`docs/evidence/P0.4-skeleton.md`](docs/evidence/P0.4-skeleton.md); clean install/full verify/runtime restart/Relay fingerprint | 2026-08-24T18:01:36+08:00 |
| G1-INDEPENDENT-FOUNDATION | PLANNED |  |  |
| G2-SECURITY-READY | PLANNED |  |  |
| G3-ANDROID-APP-READY | PLANNED | App-first native workflow + capture + Poco loopback/read-only + real APK/device evidence |  |
| G4-HUMAN-CLOSED-LOOP | PLANNED |  |  |
| G5-RELAY-INTEGRATED | PLANNED |  |  |
| G6-BUILD-VERIFICATION | PLANNED |  |  |
| G7-WORKBENCH-READY | PLANNED |  |  |
| G8-OPERATIONS-READY | PLANNED |  |  |
| G9-REAL-DEVICE | PLANNED |  |  |
| G10-PRODUCTION-CANARY | PLANNED |  |  |

## Work package pointer

| ID | Status | Owner/agent | Depends on | Output | Verification | Evidence | Commit | Updated |
|---|---|---|---|---|---|---|---|---|
| P0.1 | DONE | root (GPT-5.6 Sol/ultra) | G0-PLAN-READY | 独立 repo/workspace | `npm ci`; Git/目录隔离与 Relay 状态指纹检查通过 | [`docs/evidence/P0.1-bootstrap.md`](docs/evidence/P0.1-bootstrap.md) | `dbb4ab6c4ba7dacf94021a33b99ecb93577ae646` | 2026-08-24T16:49:48+08:00 |
| P0.2 | DONE | root (GPT-5.6 Sol/ultra) | P0.1 | ADR 集 | `npm run check:adrs`：6/6 ADR、4/4 必需章节、10/10 原则映射通过 | [`docs/evidence/P0.2-adrs.md`](docs/evidence/P0.2-adrs.md) | `55e052113ef86002ba17389e46a510485dfff116` | 2026-08-24T16:54:25+08:00 |
| P0.3 | DONE | root (GPT-5.6 Sol/ultra) | P0.2 | OpenAPI/Event/Relay contracts | 9 schemas、12+12 场景、35 operations、19 errors、24-file breaking baseline；独立复验通过 | [`docs/evidence/P0.3-contracts.md`](docs/evidence/P0.3-contracts.md) | `525f81b3c87749e00b4118c866fb26a68c88175c` | 2026-08-24T17:33:24+08:00 |
| P0.4 | DONE | root (GPT-5.6 Sol/ultra) | P0.3 | 最小运行骨架 | clean `npm ci`; full `verify`; actual health/SIGINT/restart; Relay fingerprint | [`docs/evidence/P0.4-skeleton.md`](docs/evidence/P0.4-skeleton.md) | `a873df7e9f07d37e1116ab7ff06734eb1bde0281` | 2026-08-24T18:01:36+08:00 |
| P1.1 | PLANNED | root (GPT-5.6 Sol/ultra) | G0 | schema/migrations | migration/integrity/concurrency | App-first decision arrived before P1.1 code; safely queued after P3.0 |  | 2026-08-24T18:21:25+08:00 |
| P1.2 | PLANNED | unassigned | P1.1 | domain state machine | transition/guard/version tests |  |  | 2026-08-24 |
| P1.3 | PLANNED | unassigned | P1.1 | outbox/inbox | crash/retry/order/replay tests |  |  | 2026-08-24 |
| P1.4 | PLANNED | unassigned | P1.1 | health/log/config | dependency fault tests |  |  | 2026-08-24 |
| P2.1 | PLANNED | unassigned | G1 | user auth/invite QR | auth/session/CSRF tests |  |  | 2026-08-24 |
| P2.2 | PLANNED | unassigned | P2.1 | project RBAC | role/IDOR matrix |  |  | 2026-08-24 |
| P2.3 | PLANNED | unassigned | P1.2,P2.2 | append-only audit | atomicity/immutability tests |  |  | 2026-08-24 |
| P3.0 | IN_PROGRESS | root (GPT-5.6 Sol/ultra) | P0.3 | App-first API/evidence/Poco contract delta | schema/examples/behavior/breaking/version tests | pending |  | 2026-08-24T18:21:25+08:00 |
| P3.1 | PLANNED | unassigned | P3.0 | actual Poco capability/security spike | vendored SHA/version, framing/RPC, loopback/LAN, server read-only evidence |  |  | 2026-08-24 |
| P3.2 | PLANNED | unassigned | P3.0 | Kotlin/Compose/Room/WorkManager native foundation | toolchain preflight + clean Gradle/lint/unit/instrumented | toolchain currently absent; see blockers and `docs/ANDROID_SETUP.md` |  | 2026-08-24 |
| P3.3 | PLANNED | unassigned | P1.1,P2.2,P3.0 | backend evidence/mobile APIs | upload adversarial, IDOR, pagination/filter tests |  |  | 2026-08-24 |
| P3.4 | PLANNED | unassigned | P3.2,P3.3 | Room/WorkManager offline attachment queue | offline/retry/auth-expiry/duplicate/orphan tests |  |  | 2026-08-24 |
| P3.5 | PLANNED | unassigned | P1.2,P2.2,P3.2,P3.3 | native full-workflow home | Relay-offline human loop + 30-second intake |  |  | 2026-08-24 |
| P3.6 | PLANNED | unassigned | P3.2 | overlay/MediaProjection/Share/Picker | permission/lifecycle/gesture/FLAG_SECURE tests |  |  | 2026-08-24 |
| P3.7 | PLANNED | unassigned | P3.1,P3.2,P3.6 | Kotlin Poco read-only adapter/capture bundle | framing/timeout/size/fallback/captureId tests |  |  | 2026-08-24 |
| P3.8 | PLANNED | unassigned | P3.1 | Unity qa.snapshot/loopback compatibility layer | standard/old/Invoke, server allowlist, Mono/IL2CPP, LAN-negative tests |  |  | 2026-08-24 |
| P3.9 | PLANNED | unassigned | P3.3-P3.8 | Android/Poco real-device/performance matrix | Android 12/12L/13/14/15/16, OEM, P50/P95, APK SHA |  |  | 2026-08-24 |
| P4.1 | PLANNED | unassigned | G3 | human/external attempts | Relay-offline flow |  |  | 2026-08-24 |
| P4.2 | PLANNED | unassigned | P4.1 | builds/commit identity | wrong-SHA guard tests |  |  | 2026-08-24 |
| P4.3 | PLANNED | unassigned | P4.1,P4.2 | verification/reopen | human closed-loop E2E |  |  | 2026-08-24 |
| P5.1 | PLANNED | unassigned | G4 | QA Relay client/fake | QA-side contract suite |  |  | 2026-08-24 |
| P5.2 | PLANNED | unassigned | P5.1 | Relay M2M handoff API | auth/idempotency/attachment tests |  |  | 2026-08-24 |
| P5.3 | PLANNED | unassigned | P5.2 | Relay webhook outbox | signature/retry/order/reconcile tests |  |  | 2026-08-24 |
| P5.4 | PLANNED | unassigned | P5.2,P5.3 | state projection/continue task | real delivery/reopen tests |  |  | 2026-08-24 |
| P5.5 | PLANNED | unassigned | P5.4 | safe Relay reload | idle gates + real 4317/3000 |  |  | 2026-08-24 |
| P6.1 | PLANNED | unassigned | G5 | build adapters | job/project/SHA/mode tests |  |  | 2026-08-24 |
| P6.2 | PLANNED | unassigned | P1.3,P6.1 | Inbox/Push/reminders | crash/dedup/real-device push |  |  | 2026-08-24 |
| P7.1 | PLANNED | unassigned | G3 | duplicate candidates | fixed corpus precision/recall |  |  | 2026-08-24 |
| P7.2 | PLANNED | unassigned | G4,P7.1 | workbench/filters | pagination/filter consistency |  |  | 2026-08-24 |
| P7.3 | PLANNED | unassigned | P7.2 | metrics/export | fact-table recomputation |  |  | 2026-08-24 |
| P7.4 | DEFERRED | unassigned | G7 | post-MVP desktop management/read-only diagnostic Web | no PWA/offline/mobile-primary scope | existing P0.4 `apps/web` preserved; no further MVP investment |  | 2026-08-24T18:21:25+08:00 |
| P8.1 | PLANNED | unassigned | G6,G7 | security hardening | security suite/secret scan |  |  | 2026-08-24 |
| P8.2 | PLANNED | unassigned | P8.1 | performance/fault injection | p95/p99 + no-false-success |  |  | 2026-08-24 |
| P8.3 | PLANNED | unassigned | P1.1,P3.3 | online backup | integrity/hash/retention tests |  |  | 2026-08-24 |
| P8.4 | PLANNED | unassigned | P8.3 | isolated restore | real restore/RPO/RTO evidence |  |  | 2026-08-24 |
| P9.1 | PLANNED | unassigned | G8 | Android/Poco real-device matrix | device/OS/App/Unity/Poco/APK/request/item/performance evidence |  |  | 2026-08-24 |
| P10.1 | PLANNED | unassigned | G8 | Windows service | reboot/watchdog/firewall tests |  |  | 2026-08-24 |
| P10.2 | PLANNED | unassigned | P10.1 | blue-green/rollback | isolated port/cutover/rollback |  |  | 2026-08-24 |
| P10.3 | PLANNED | unassigned | G9,P10.2 | real HTTPS canary | full production-path E2E |  |  | 2026-08-24 |
| P10.4 | PLANNED | unassigned | P10.3 | 24-hour limited rollout | QA/dev/ops approval |  |  | 2026-08-24 |

## Active work

- `P3.0` — owner: `root (GPT-5.6 Sol/ultra)`; started: `2026-08-24T18:21:25+08:00`; next atomic action: `在不改写 1.0.0 历史基线的前提下发布 App-first additive contract version`。

## Completed evidence

- 规划阶段完成三条并行只读审计：QA 领域/状态机、移动 PWA/运维、Relay 集成契约。
- 新建独立目录 `D:\Relay-QA-Hub`；规划阶段未修改现有 Relay 工作树。
- P0.1 建立独立 Git/npm workspaces；Relay 前后状态指纹完全一致；证据与本地提交见 `docs/evidence/P0.1-bootstrap.md` / `dbb4ab6`。
- P0.2 冻结 6 份 ADR 并完成十条不可破坏原则映射；证据与提交见 `docs/evidence/P0.2-adrs.md` / `55e0521`。
- P0.3 冻结 OpenAPI/Event/Relay/Build/Upload contracts；两轮独立反例审查后无阻断/高优先级；证据与提交见 `docs/evidence/P0.3-contracts.md` / `525f81b`。
- P0.4 建立六 workspace 独立运行骨架；clean install、22 项自动测试、冻结 contracts、生产 Web build、实际 API SIGINT/restart 与 Relay 指纹全部通过；证据与提交见 `docs/evidence/P0.4-skeleton.md` / `a873df7`。
- G0 后产品架构按用户决策改为 App-first：P0/后端成果原样保留；`apps/web` 降级到 P7.4 post-MVP；P3 重排为 Android 主客户端和 Poco QA Bridge，当前唯一 pointer 是 P3.0。
- App-first 重排于 `2026-08-24T18:31:47+08:00` 完成安全点验证：计划/进度 `44/44` ID 一一对应、7 份 ADR 与完整 `npm run verify` 全绿，独立只读签核为 Blocker/High/Medium=`0/0/0`。Android toolchain preflight 按预期非零并明确列出缺失 Studio/SDK/JDK/tools；HypervisorPlatform=`1`，未宣称 APK 构建或测试通过。

## Blockers

1. **Android toolchain absent**：`C:\Program Files\Android\Android Studio`、`%LOCALAPPDATA%\Android\Sdk` 不存在，`adb/java` 不在 PATH。影响 P3.2+ 的 Gradle/APK/设备验证；解除条件是按 `docs/ANDROID_SETUP.md` 安装 Android Studio、SDK Platform 36/Build-Tools/Platform-Tools/Command-line Tools/Emulator，并使用 bundled JDK。preflight 绿前不得声称 APK build/test。P3.0、P3.1、P1/P2/backend 可继续。
2. **Actual Poco capability not yet identified**：需要定位权威被测 Unity 工程及 vendored Poco 文件/version/SHA，才能证明 Invoke 扩展、Loopback 和 server read-only 面。影响 P3.1/P3.7/P3.8/G3；解除条件是完成只读源码/真机 probe。标准 contract/backend/Android fake work不受阻。
3. HypervisorPlatform 已启用；模拟器必须走 WHPX，禁止关闭 Hyper-V 或影响 Relay workers。Android 12 MuMu 不能替代 Android 12 真机 Gate；adb 可用后记录实际 `ro.build.version.sdk`。

## Progress update rules

1. 状态只允许 `PLANNED | IN_PROGRESS | BLOCKED | VERIFYING | DONE | DEFERRED`。
2. 每个 ID 只能有一个 owner；可以有多个互不重叠 ID 并行。
3. 写代码前更新 Active pointer；验证完成后才标记 `DONE`。
4. `DONE` 必须有命令/手工步骤、结果、证据路径、Commit 和时间。
5. “代码完成但未验证”必须保持 `VERIFYING`。
6. 根代理独占本文件、contracts、迁移和共享根配置。
7. `last green commit` 与 `last deployed commit` 必须分开。
8. Blocker 必须说明证据、影响、解除条件和仍可并行的工作包。
9. 生产完成不能只引用源码或临时端口，必须记录真实 URL、设备、部署 SHA、备份、恢复和回滚点。
