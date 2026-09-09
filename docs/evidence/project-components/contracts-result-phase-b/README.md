# Verification blocked result, schema16

旧 JSON 与 v1.1 vendor 结果请求现在均接受 blocked，且仅允许对应 blockedReason。实际写入保持已交付 RepairAttempt 的整行与 Bug.activeRepairAttemptId；只结束本次 Verification、清除 activeVerificationId，Bug 留在 ready_for_verification 并递增版本。后续可以新建 Verification，旧 blocked 终态不能再次提交新结果。

原始完整结果快照、Event、通知 outbox 和幂等回执仍在同一事务。重复请求返回原始快照；后续标题变化、新一轮验证通过关单也不改写旧回执。冻结 workflow 响应 DTO 按既有合同不暴露 failureReason/blockedReason，完整原因保存在 typed SQL 和不可变完整快照中；没有放宽冻结合同。普通人工多员工权限及 Relay 的既有通过/失败路径保持原策略，blocked 不派发 Relay 验收或重工。

API 全部 266 项（233 MJS +33 TS）、Storage118、类型检查、lint、格式及五步冻结合同检查通过。新增六组实际随机 loopback HTTP 共114请求，覆盖 blocked→重复→修改Bug→新Verification→通过→重放旧blocked、整行Attempt不变、对应原因/人员/CAS拒绝、中文控制字符长度边界、最终receipt故障503时整事务回滚。既有Phase A14组215HTTP亦通过。它们使用实际Fastify、worker和SQLite临时fixture，不代替完整main或安装客户端验收。

Schema15的源码/SQL/checksum保持原样，新增schema16只替换exact-effect触发器的结果状态白名单，所有DTO形状、字段类型、typed effect、附件、Event、reserved receipt约束保留。使用独立完整main A实验的一致备份（2035712B，SHA5d0e8d9c768f0756ec6360da03ea5921f61de4118c6498547065d30998a69cea）独占复制后升级：70张原业务表、7份原始result DTO严格一致，4份当前授权的原receipt通过storage回放；另外3份按当前撤权/删除/普通人工权限范围排除，不虚称全部HTTP回放。旧15自动备份和在线16恢复文件均重新打开校验完整性，11项通过，原档字节未改。保留目录：C:\Users\lin0\AppData\Local\Temp\qa-result-schema16-odaHs6。

首次失败完整保留：fixture复制带入7个未用import；首次HTTP2/6通过，4项是测试误期待冻结DTO原因字段和500状态；首次迁移副本已升级后，测试用错membership关系名称而中止。改正测试断言后均使用新fixture/新副本重新验证，不覆盖旧日志或原库。initial-test-author.mjs.txt是最初测试生成器，不冒充首个格式化测试文件的精确副本；最终源码以result.json的pins为准。

常驻4419仍是schema14，未重启或部署。另一个子组使用新独立运行目录继续完整schema16 main验收，结果另记。现有90个MCP工具尚无blocked提交动作；附件9..20/capture、fail/supersede和workflow GET仍分阶段未完成，不将本证据计为六入口全部通过。
