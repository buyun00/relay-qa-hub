# GPT-5.6 Sol Ultra Goal 接续交接

用户在原规划/协调对话 01a080dc-20d4-7ba2-980f-98e1d2fa5c06 中明确要求：新建 GPT-5.6 Sol、Ultra、Goal 对话承接当前制作主任务，不要在原对话直接切换模型，不再使用 GPT-6 Ultra。新的主任务和新建子 Agent 均使用 gpt-5.6-sol / ultra；无需设置 token 预算。用户已授权多个子 Agent 并行制作和真实测试。

## 原任务和停止状态

- 原制作任务：项目制组件化独立制作与全功能端到端验收。
- 原 threadId：01a081c7-26e9-7cc2-ad9a-2a6520180a54，host local。
- 交接通过应用正式归档操作停止原主任务；随后逐一读取状态，原主任务为 notLoaded / interrupted。
- 原子任务 01a081c8-4277-7230-a039-68d31fc6eefc 为 notLoaded / completed；另外两个 01a081c8-68e9-7a71-91f5-b8e80ab6da84、01a081c8-0f2e-7b32-b786-080562886930 均为 notLoaded / interrupted。三者停止状态均已读取确认。
- 原任务曾收到一条排队的停止交接消息；它没有生成本文件。本文件由规划/协调任务根据正式状态、代码和证据写成。
- 没有把未完成产品 Goal 标为 complete 或虚假 blocked。新任务开始时调用 get_goal；若没有目标则 create_goal，若已有对应 active Goal 则接续，不重复创建。旧归档任务保留历史，不重新启动或继续旧 GPT-6 子 Agent。

## 必须接续现有工作树

- 工作树：C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub。
- 分支：codex/project-components-v2-1。
- 本次协调读取的 HEAD：5208a8a（feat(api): persist authorized workflow snapshot pages），开始接续时重新核对完整 SHA 和 git status。
- 起点：62b4495c9b28dc3aea1d5633e870be4e1fdf841f。
- **不要从 main 重新开发，不要创建空白分支替代此工作树，不要 reset、clean、stash、还原、覆盖或删除现有改动。暂存区也有尚未提交的真实验收证据。**
- 设计依据：docs/design/project-components-transformation-2026-09-08.md，v2.1，原来源 SHA-256 8DABD8C8542F33659579BB0692A5831EF902ABF710941655779513548C21AF42；同目录已有 Word。

## 原始目标和不可放宽的要求

完成 v2.1 全部改造：仅项目一级，员工可属于多个项目，按项目姓名登录，单一 GM，项目内部人员管理保持简单。基础只有完整 Bug 管理；打包、单次打包上传、增量上传、Relay 制作和第三方同步按项目作为可选组件。HTTP API 与 MCP 共用业务能力且各自独立可用。APK、EXE、Web 同步兼容。

新版必须和 D:\Relay-QA-Hub 旧生产并行，不合并 main、不推送生产分支、不替换或重启生产、不关闭日常 EXE、不覆盖或卸载日常 APK。所有数据库/WAL、附件、队列/outbox、凭据、日志、PID/服务、端口、客户端身份、更新源和发布目标隔离。预览的发布及升级已获授权，生产替换没有获授权。复制历史数据只能通过一致备份，在独立副本迁移；导入外部任务保持暂停，禁止重放生产任务。

完成后必须实际安装与操作、真实 HTTP/MCP 请求和最终结果读回，覆盖所有功能。mock、编译、监听存在、排队成功、证据审计或截图本身不能代替全链路通过。物理 Android 与外部测试资源缺口要如实记录，未执行不算通过。不得自行将必测功能改为不适用。已有测试只有新变化/失败/具体复验需要时才重跑，优先补齐剩余功能及其真实链路。

## 当前运行和最新证据入口

- 预览实例配置：C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json。
- 常驻预览 API 4419、Web/下载 4274、服务端 MCP 4421、原预览 EXE 本地 MCP 4420；上一核对常驻 API 为 schema14，EXE preview.9、Android 模拟器 code23。schema15/16/17 及新 MCP 工具在独立副本验证，不能仅凭代码提交说已装入常驻预览。
- 原生产 API 4319、Web 4174 只用于按既有方式只读核对。不要泄露实例凭据正文。
- 正式矩阵 docs/evidence/project-components/coverage-matrix.json 与 .md；协调最后核对 991 条目，整项基线通过 09、10、11、12、15、23、24，仍为 7/24。矩阵与最新源码、证据并不同步，接续时需核对而非推断完成率。
- IMPLEMENTATION.md 和 preview-operations.md 汇总操作；各专题 README 与原始 result/proof 优先于过时汇总。
- contracts-result-phase-a-live：完整服务 127 次请求 / 247 检查，原结果回执；contracts-result-phase-b-live：115 次请求 / 246 检查，blocked 和原回执，关停 SQL/备份 86 检查。
- result-workflow-phase-d-live：原主任务报告 665 检查、后置 186 审计、四个服务进程正常退出；该目录和脚本已暂存但尚未提交，必须先读实际 README/result 核对。
- mcp-workflow-projection：新增只读工作流 MCP 和显式 projectId 参数修复，原主任务报告 14 项工具回归与 31 次真实请求；源码和证据尚未提交。
- server-mcp-membership-live、android-personnel-live、web-project-switch-draft-live、独立本地 MCP 相关目录：分别保留人员/项目资格、原生身份/草稿、项目切换草稿与本地副本验收。最新提交 e825030 是独立 EXE 本地 MCP 人员验证；原主任务报告 99 检查通过，原客户端保留。

## 未提交工作和接续重点

停止时读取到这些工作状态，不代表均实现或验证完成：

1. 主任务：apps/api/src/automation-routes.ts、automation.ts 及 automation-protocol / automation-verification-result 测试有未暂存修改；automation-workflow-projection.test.ts 和 mcp-workflow-projection 证据未跟踪。接续只读工作流工具及显式 projectId 修复，核对与 91/92 工具运行目录的实际关系，不猜测当前工具数量。
2. 原子任务 01a081c8-68e9-7a71-91f5-b8e80ab6da84：repair-attempt-terminal.ts、对应迁移/store、repair-attempt-terminal.test.ts 和 repair-attempt-terminal-candidate 目录未跟踪。最新消息称 legacy 两步后继与 vendor 事务替换候选已编写，三种修复模式只进入 planned，定向回归/冻结及正式应用接线仍需完成。不要误当已装配路由。
3. 原子任务 01a081c8-0f2e-7b32-b786-080562886930：mobile-attachment-store.ts、mobile-capture-store.ts、mobile-verification-store.ts、workflow-idempotency.ts 已修改；verification-result-evidence-migration/store、其 fixture/test 及 verification-result-phase-e 目录未跟踪。20 附件/capture 绑定与事务回滚、旧回执的候选正在制作，状态不完整。需要安排新的 Sol 子 Agent 检查接续。
4. 暂存区已有 IMPLEMENTATION.md、result-workflow-phase-d-live 多份证据与 scripts/project-components/result-workflow-phase-d-e2e.mjs。保留暂存范围及未暂存源码的区别，提交前逐项复核，不把未测候选混入已验收包。

外部 build/upload/Relay/Qingyu 独立执行资源仍未确认、完整链路未通过。物理 Android、应用内升级、旧上传队列与外部任务一致迁移/恢复仍有缺口。不要把此时描述成只剩监控或全部新功能已完成。

## 接续执行方式

先核对工作树、原代理停止状态、残留工具进程/端口与当前源码，保存交接时的状态快照。原代理已停止不等于所有后台测试进程一定退出；仅可根据明确路径/PID/启动身份核对本次独立测试进程，不按通用进程名杀进程。保留常驻预览和日常客户端。

新建 Sol 子 Agent 接管互不重叠的未完范围；不要 follow-up 原 GPT-6 代理。按用户要求并行，使用独立项目/人员/Bug、浏览器上下文、设备和证据目录，统一协调共享文件、版本迁移、构建部署与矩阵更新。当前最多按可用槽位分配，不让多个代理写同一文件或同时操作同一 GUI/设备。

随后补齐候选实现和正式接线、对应真实测试，推进外部组件和终端剩余验收，再发布到独立预览并验证实际升级。以需求与实际行为为验收口径，不重复只做映射/审计而延迟功能补齐；证据充分即可继续下一未完项。定期清楚报告新增实现、实际通过、剩余缺口及主预览是否包含新代码。
