# 剩余本地验收优先项（只读审查）

本记录沿当前矩阵、实施说明、设计§16/17和所指证据收口，没有调用网络、客户端、设备、服务或活数据库。环境以根任务提供的4419/4274/4421、EXE .9/4420、MuMu code23及五组件关闭为执行前提，本轮没有重新确认运行状态。矩阵仍为991项、28退休项；191个源码hash属于原生成时快照。整项通过仍为 **09、10、11、12、15、23、24（7/24）**，本记录不改状态。逐文件原字节SHA见 [review.json](./review.json)。

已经有新的 [Web详情59项实测](../web-detail-loading-live/ab51a7d8-3d97-40e0-86af-bf2fe77af389/proof.json)：同项目 loading、真实响应、网络失败与重试已走通。下面只建议其尚未覆盖的跨项目迟到分支；旧矩阵尚未映入该新proof不代表应再跑一次相同用例。

## 五项优先工作

### 1. A迟到响应释放时，B页面与草稿不变（07/08）

先用独立 Web profile 在新 A/B 项目人为扣留 A 的真实详情/人员响应，切 B、编辑 B 文字/图片/人员选择，再释放 A；核 B 屏幕、请求作用域与草稿不变，回 A 仍有 A 原稿。之后分别安排 EXE/APK，不能从共享实现传递通过。

复用：`scripts/project-components/web-detail-loading-live.mjs`、`scripts/project-components/web-dual-window.fixture.mjs`。扩展现有 exact-scope 延迟计划和项目切换选择器；先核当前组件取消/快照守卫，发现问题才修产品。现有 runner 不是 A/B 场景即用命令。

已有边界：ab51 的59项是同项目 loading→真实响应、网络失败与重试；旧双标签证据是并行草稿/撤权恢复。两者都不替代 A 迟到响应覆盖 B 的场景。 保全要求：仅新 A/B、专属浏览器 profile；保留错误帧、真实响应时间及文件原字节 SHA；不改应用计时器，不向既有原生草稿注入故障。

### 2. 已安装EXE/APK的新增未知回执分支（14）

EXE .9 在新项目实际创建/评论成功回执丢失后，经正常重新打开或审定的故障窗口重试原意图；APK code23 补带图片提交的上传/创建断点、明确附件拒绝后显式换稿，以及错误成功回执拒绝。逐分支执行，不合成一次全通过。

复用：`scripts/project-components/web-submission-recovery-live.mjs`、`scripts/project-components/web-rejected-media-recovery-live.mjs`、`scripts/project-components/android-recovery-proxy.mjs`、`docs/evidence/project-components/exe-preview8-recovery-plan.md`、`docs/evidence/project-components/android-code23-recovery-plan.md`。EXE 需要只绑定精确预览客户端的新 fault driver/native 观察适配；APK proxy 需要精确阶段/图片/协议分支扩展。旧 .8 计划须按实际 .9 安装和新 artifact hash 重订，不能直接复用旧进程/包 pin。

已有边界：Web101未知回执与81坏媒体已实际通过；APK23只证明 legacy text 的4次真实201丢失及同原意图恢复；EXE .9升级与草稿保全不等于 native 未知提交测试。 保全要求：新项目/actor 与原 EXE 员工、未提交 PNG、原 closed Bug 分离；保留冷备份范围、签名/包名、代理原配置与失败。APK 禁止 pm clear、卸载和清数据 instrumentation；已保存图片与未保存笔画分开说明。

### 3. 本地4420与HTTP的实际负向、幂等对等（06/13/14）

针对本地4420，用两个全新项目的等价操作与直接HTTP作配对：错项目写入、旧版本、同键并发/重放、异体409和软删除拒绝；比较实际版本、操作人、事件与回执，不只比较 HTTP200。

复用：`scripts/project-components/project-isolation-live.mjs`、`scripts/project-components/workflow-concurrency-live.mjs`、`scripts/project-components/workflow-verdict-concurrency-live.mjs`、`scripts/project-components/mcp-core.smoke.mjs`。已有 isolation/concurrency runner 固定4419/4421，需新增受审定4420 driver/返回解析和身份保存恢复；不能仅改一个 URL 视为准备完成。产品暂不假定需要改动。

已有边界：HTTP与独立server MCP的既有1997请求隔离、98请求六动作重放及验收竞争不覆盖本地4420。HTTP事件/附件也不能填05组件日志缺口。 保全要求：local MCP login 会影响已安装 EXE 持久身份，须由 root 排定独占身份窗口并核原身份/文字/PNG保全；这一步不与 root 的 server MCP 人员用例混用。所有 fixture 留存。

### 4. 组件关闭后的旧入口拒绝与安全历史分支（16/17/19/05）

在新项目五组件保持关闭时，逐个合法形状调用仍可到达的旧构建/上传/Relay/Qingyu创建入口，确认组件拒绝、无新任务/outbox/文件提交、Bug页仍可用；只读历史和非成员拒绝按确切路由独立留证。

复用：`scripts/project-components/management.smoke.mjs`、`scripts/project-components/project-isolation-live.mjs`。新增禁止配置启用的精确路由白名单与组件前后快照；现有 management 主要测配置/依赖，isolation 明确排除了组件路由，不能原样重跑。非空日志/暂停条目需另建执行 hold 的临时持久 fixture 和新端口，限制全部外部调用；不得往真实已有队列插造数据。

已有边界：管理HTTP已验证A/B配置隔离、依赖和needs_configuration；native三历史tab主要为空；web-outbox证明是临时SQLite/API，无真实有数据浏览器点击。 保全要求：新项目一直 all-off；没有合格安全门禁就不放行组件写请求。源测试可 fail-if-called，实际预览的拒绝证据需对应任务/事件/文件快照，不能把一次409当全部后台零出站证明。

### 5. Phase D：持久冻结workflow GET，先做本地合同

实现 frozen workflow GET：occurrences、repairAttempts、verifications、builds、relayReceipts 五集合安全DTO，持久冻结快照和各集合独立cursor；分页期间新写入/旧事实更新不得混入，当前撤权/删除仍拒绝。

复用：`docs/evidence/project-components/contracts-remediation-gap-review/README.md`、`scripts/project-components/frozen-workflow-live.mjs`。独立 projection/cursor/store/API adapter/tests 与后续 schema16 新迁移文件；Phase A 的 schema15 和公共迁移/worker/route 注册由 root 协调接线。先发精确文件分工，获确认后实施；不改冻结合同。

已有边界：丰富 human-workflow 与已注册六个冻结 mutation 读回都不等于未注册 frozen workflow GET；Phase A 正在推进，不能预记已完成。 保全要求：所有写入只在独立 tempDB 合同 fixture。非空Build/Relay可用明确标注的持久本地合同数据；不声称真实外部执行来源。冻结400枚举与cursor行为的内部缺口原样保留报告。

## 已有人推进与其它本地工作

根任务正在准备 **server MCP的01/02/04人员完整分支**：全新A/B与员工、姓名稳定ID、单/多项目、A停用/B继续、恢复。本清单不重复实现，也不提前记通过；APK/EXE/local MCP的独立目录与登录观察不能从该用例传递。Phase A/schema15由project_backend实施，D等待根确认新文件分工与统一注册，二者可以隔离并行。

APK应用内自更新也可在本地继续，但需新更高versionCode的专用签名包和feed。已有code23下载发布/ADB升级不等于应用内更新；同版本feed不是一次升级验收。无需因缺外部组件凭据而搁置这项准备。

## 真正需要补齐的资源与恢复材料

- **完整组件18/19/20与§17**：专用Jenkins job/workspace/参数/产物URL及认证引用；独立上传API/login/source、默认字段、三个测试目录前缀；Relay测试实例ID/projectKey/回调认证；轻语测试项目、可用记录与认证。全部是独立测试目标。关闭入口的拒绝、本地hold历史与契约fixture不能代替真实调度、产物、回调、运行中停用和失败后人工闭环。
- **21外部旧状态**：[只读盘点](../baseline21-external-state-inventory.md)已找到53文件中的3jobs、2chains、9batches及活queue/WAL；不是“位置未找到”。尚缺活队列数量与跨文件一致恢复集、项目/组件版本导入映射、轻语密钥/会话恢复材料。主SQLite和附件的既有迁移不能代替这些独立状态，也不能直接复制活主文件漏WAL。
- **22/§17.3物理Android**：真实设备及截屏、文件、安装更新权限仍必需。MuMu保全、已发布APK和ADB覆盖升级不能豁免。

设计[§16/17](../../../design/project-components-transformation-2026-09-08.md)要求每端与每项功能分开记实测。上述所有后续执行都应保留新fixture、原失败和范围；不得触生产、清理日常数据、把旧版本proof说成当前源码已复验，或把没有执行的分支写成通过。
