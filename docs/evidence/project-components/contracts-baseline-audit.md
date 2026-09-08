# 冻结合同门禁只读审查

记录时点：2026-09-08T18:25:33.746Z。结论：**existing_failure；check:contract-breaking 仍为 failed**。没有修改合同、schema、baseline，没有运行 --write-baseline。

## 可复核结论

- 当前 HEAD：62b4495c9b28dc3aea1d5633e870be4e1fdf841f，也是本项目任务起点。
- packages/contracts 的工作树状态、HEAD 差异和暂存差异均为空；没有新增未跟踪合同文件。
- 工作树 workflow 与 HEAD 的 canonical JSON 相同，冻结清单也与 HEAD 相同。
- 对 HEAD 冻结清单的 24 个文件按原检查器算法逐个重算，仅 schemas/workflow.schema.json 不匹配。因此不需要本任务工作树改动，起点 HEAD 自身就会出现这个严格合同漂移。

| 项目 | 值 |
| --- | --- |
| 冻结合同版本 | 1.0.0 |
| frozenAt | 2026-08-24T09:31:43.013Z |
| 冻结 workflow SHA-256 | da878252ce2da8b93b61cd4f9a937841b37230b87feaae589d7894ea123f6ea8 |
| 当前/HEAD workflow SHA-256 | 38330d9691930409d4ac12c5384a51379748fb99c63df98e51c1ccbc02032b3c |
| 初始匹配提交 | 525f81b3c87749e00b4118c866fb26a68c88175c |
| 引入差异提交 | abd3a861e9ab52839f4dc45e3e5db6a2dad6459e，2026-08-27T17:36:51+08:00，feat: preserve current QA Hub product mainline |

Canonical 算法递归按 JSON 对象键排序，保持数组顺序，再以 JSON.stringify 输出计算 SHA-256；非 JSON 统一 CRLF 为 LF，与 check-breaking.mjs 一致。不是格式或换行误差。

## 具体语义差异

| 对象 | 新增属性 | 类型/限制 | 必填变化 |
| --- | --- | --- | --- |
| repairAttempt | patchUrl | string 或 null；format uri | 无 |
| repairAttempt | noCodeReason | string 或 null；maxLength 5000 | 无 |
| repairAttempt | failureReason | string 或 null；maxLength 5000 | 无 |
| verification | failureReason | string 或 null；maxLength 5000 | 无 |
| verification | blockedReason | string 或 null；maxLength 5000 | 无 |

移除这五个属性定义后，HEAD schema 与冻结版本的 canonical JSON 完全相同；没有其他字段、required、命令或状态定义差异。首次变更提交父版本匹配冻结 hash，该提交后的 hash 与当前相同；完整 Git patch 保存在 JSON。

这些是可选响应字段的增加，但两个旧对象均为 additionalProperties:false。符合旧字段集的对象仍被新 schema 接受；包含新增字段的响应会被旧严格验证器拒绝。这里只确定差异和门禁来源，不批准兼容性变更、不决定版本策略，也不将其记为通过。

## 现有门禁运行

[root 合同运行日志](runs/contracts-final-retry.txt) 中 check:contracts 通过：9 schemas、12/12 payload、12/12 behavior、12 transitions、35 OpenAPI operations、19 error codes。紧接着 check:contract-breaking 只报告 workflow canonical contract changed。

root test:contract 使用 && 串联，因此该次日志中的 check:contracts:app-first、check:contract-additive、check:contract-breaking:app-first 未到达；此处不为它们推定结果。本次只读 Git/hash 审查没有重新执行整套合同门禁。

机器证据：[contracts-baseline-audit.json](contracts-baseline-audit.json)。其中保留 HEAD、历史提交、所有漂移、五项字段定义、Git patch、工作树干净结果与 canonical hash。
