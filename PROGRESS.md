# Relay QA Hub Progress

- Goal status: `ACTIVE`
- Release target: `0.1.0-debug`
- Current phase: `P0`
- Current pointer: `P0.1`
- Current gate: `G0-CONTRACT-READY`
- Critical path: `G0 -> G1 -> G2 -> G3 -> G4 -> G5 -> G6 -> G8 -> G9 -> G10`
- Active work packages: `P0.1`
- Next atomic action: `记录 Relay 工作树基线并初始化独立 Git/npm workspace`
- Completed gates: `0 / 11`
- Last green commit: `none`
- Last deployed commit: `none`
- Schema version: `none`
- Production URL: `not deployed`
- Last production verification: `none`
- Last backup verified: `none`
- Last restore drill: `none`
- Blockers: `none`
- Updated at: `2026-08-24T16:43:57+08:00`

## Gate status

| Gate | Status | Evidence | Verified at |
|---|---|---|---|
| G0-PLAN-READY | DONE | `docs/IMPLEMENTATION_PLAN.md`; local links and plan structure verified | 2026-08-24T16:42:00+08:00 |
| G0-CONTRACT-READY | PLANNED |  |  |
| G1-INDEPENDENT-FOUNDATION | PLANNED |  |  |
| G2-SECURITY-READY | PLANNED |  |  |
| G3-MOBILE-INTAKE | PLANNED |  |  |
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
| P0.1 | IN_PROGRESS | root (GPT-5.6 Sol/ultra) | G0-PLAN-READY | 独立 repo/workspace | Git/目录隔离检查 |  |  | 2026-08-24T16:43:57+08:00 |
| P0.2 | PLANNED | unassigned | P0.1 | ADR 集 | ADR 完整性检查 |  |  | 2026-08-24 |
| P0.3 | PLANNED | unassigned | P0.2 | OpenAPI/Event/Relay contracts | schema lint + 场景走查 |  |  | 2026-08-24 |
| P0.4 | PLANNED | unassigned | P0.3 | 最小运行骨架 | lint/typecheck/test/build/health |  |  | 2026-08-24 |
| P1.1 | PLANNED | unassigned | G0 | schema/migrations | migration/integrity/concurrency |  |  | 2026-08-24 |
| P1.2 | PLANNED | unassigned | P1.1 | domain state machine | transition/guard/version tests |  |  | 2026-08-24 |
| P1.3 | PLANNED | unassigned | P1.1 | outbox/inbox | crash/retry/order/replay tests |  |  | 2026-08-24 |
| P1.4 | PLANNED | unassigned | P1.1 | health/log/config | dependency fault tests |  |  | 2026-08-24 |
| P2.1 | PLANNED | unassigned | G1 | user auth/invite QR | auth/session/CSRF tests |  |  | 2026-08-24 |
| P2.2 | PLANNED | unassigned | P2.1 | project RBAC | role/IDOR matrix |  |  | 2026-08-24 |
| P2.3 | PLANNED | unassigned | P1.2,P2.2 | append-only audit | atomicity/immutability tests |  |  | 2026-08-24 |
| P3.1 | PLANNED | unassigned | G1 | PWA shell/mobile layout | install/offline/update tests |  |  | 2026-08-24 |
| P3.2 | PLANNED | unassigned | P1.1,P2.2 | secure resumable upload | adversarial/network tests |  |  | 2026-08-24 |
| P3.3 | PLANNED | unassigned | P3.2 | offline drafts/idempotent submit | offline/retry/multitab tests |  |  | 2026-08-24 |
| P3.4 | PLANNED | unassigned | P1.2,P3.1,P3.3 | report/triage UI | real Android 30-second flow |  |  | 2026-08-24 |
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
| P8.1 | PLANNED | unassigned | G6,G7 | security hardening | security suite/secret scan |  |  | 2026-08-24 |
| P8.2 | PLANNED | unassigned | P8.1 | performance/fault injection | p95/p99 + no-false-success |  |  | 2026-08-24 |
| P8.3 | PLANNED | unassigned | P1.1,P3.2 | online backup | integrity/hash/retention tests |  |  | 2026-08-24 |
| P8.4 | PLANNED | unassigned | P8.3 | isolated restore | real restore/RPO/RTO evidence |  |  | 2026-08-24 |
| P9.1 | PLANNED | unassigned | G8 | real-device matrix | device/OS/browser evidence |  |  | 2026-08-24 |
| P10.1 | PLANNED | unassigned | G8 | Windows service | reboot/watchdog/firewall tests |  |  | 2026-08-24 |
| P10.2 | PLANNED | unassigned | P10.1 | blue-green/rollback | isolated port/cutover/rollback |  |  | 2026-08-24 |
| P10.3 | PLANNED | unassigned | G9,P10.2 | real HTTPS canary | full production-path E2E |  |  | 2026-08-24 |
| P10.4 | PLANNED | unassigned | P10.3 | 24-hour limited rollout | QA/dev/ops approval |  |  | 2026-08-24 |

## Active work

- `P0.1` — owner: `root (GPT-5.6 Sol/ultra)`; started: `2026-08-24T16:43:57+08:00`; next atomic action: `记录 Relay 工作树基线并初始化独立 Git/npm workspace`。

## Completed evidence

- 规划阶段完成三条并行只读审计：QA 领域/状态机、移动 PWA/运维、Relay 集成契约。
- 新建独立目录 `D:\Relay-QA-Hub`；规划阶段未修改现有 Relay 工作树。

## Blockers

无。生产域名、正式认证提供方、真实设备清单和最终数据盘容量可在对应 Gate 前确认，不阻塞 P0-P4 本地实施。

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
