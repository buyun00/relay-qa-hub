# schema19 终态与验证证据接线

本证据固定 schema18 `repair_attempt_terminal_receipts` 与 schema19
`verification_result_evidence` 的正式注册、worker 消息、API 主应用接线和真实 server MCP
调用。测试只使用随机 loopback 端口、临时 SQLite 和临时媒体目录；没有访问或修改主预览、旧生产、日用
EXE、日用 APK 或任何外部执行器。

迁移检查从真实 schema17 库升级到19，只应用18和19，并创建可读、非空的 schema17
备份。15、16、17 的名称和校验和逐行保持；原 Bug 保持。测试还故意制造 v18 后段对象冲突，确认事务回滚到
schema17、没有新增迁移历史或半张终态表。成功升级后的重开是无操作，完整性检查通过。冻结校验和见
[migration-checksums.json](migration-checksums.json)。

主应用通过 BrowserAuth、ProjectManagementService 和 ProjectRequestContext 注册终态路径；三者缺一会在启动时拒绝该组合。
项目 ID 来自当前请求上下文，GM 身份只来自认证 principal。SQLite 适配器在调用 worker 前移除命令中的
`isGm`，避免请求载荷把权限事实带进存储层。

真实终态集成执行35次 HTTP 请求，覆盖员工 fail、旧版两步 supersede/parented successor/replay、GM 的
vendor 原子 supersede、external successor、不同 Accept 下的原始响应媒体重放，以及持久化 snapshot、活动
Attempt 指针和零临时授权残留。验证证据集成执行20次真实 MCP/HTTP 调用：上传两份实际 PNG，建立含 system
与 Poco artifact 的 capture bundle，把 attachment IDs 与 captureBundleId 一次性绑定到 passed Verification
result，再重放并直接读取 SQLite 核对不可变链接和快照。

规范工作目录的最终门禁为：Storage **134 passed / 1 个既有可选归档 skip / 0 failed**，API MJS
**248/248**，API TS **47/47**，合计 **429 passed / 0 failed**。Storage/API build、Desktop
typecheck、定向 ESLint 和 Prettier 均 exit 0。原始输出、退出记录、源文件与证据 SHA256 全部列在
[result.json](result.json)。

失败过程没有改写成通过：首次 Verification 集成暴露了测试对数据库返回顺序的错误假设，改为集合比较后连续三次及
全量通过；首次 API TS 从仓库根目录运行导致六个 uploader fixture `UPLOADER_MISSING`，在测试包规定的
`apps/api` 工作目录重跑为47/47；首次 Desktop typecheck 指向不存在的包内 TypeScript，改用仓库已安装的
TypeScript 后通过。证据 logger 的首次目录命令也记录为“测试未执行”，没有误算为成功。

这些结果仍不是主预览升级、EXE/Web/APK UI 或外部 Jenkins、上传、Relay、轻羽执行证明；相应必测项继续保持
`not_run`，不得据此宣告 v2.1 完成。
