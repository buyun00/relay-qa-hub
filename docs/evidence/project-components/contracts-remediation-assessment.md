# 严格契约漂移的修复边界评估

复核 HEAD：`3f66932e11c42f60aa660028b490a3ac0dea310d`。本次只读源码/Git，并在内存中验证假设；仅新增本 Markdown 和配套 JSON，没有修改源码、schema、checker、baseline 或任何运行服务。**没有实施或声称已完成 wire 兼容修复，严格基线门禁仍为 failed。**

完整观测、源文件物理 SHA-256、行号和声明的媒体类型见 [contracts-remediation-assessment.json](contracts-remediation-assessment.json)。此前首次漂移提交的追溯见 [contracts-baseline-audit.json](contracts-baseline-audit.json)。

## 继承范围和冻结文件

当前 HEAD 相对任务起点 `62b4495c9b28dc3aea1d5633e870be4e1fdf841f` 的 `packages/contracts` 差异为 0。当前存储工厂 `toAttempt`、`toVerification` 的函数全文也与任务起点相同。此前审查把五个属性定义的加入定位到 `abd3a861e9ab52839f4dc45e3e5db6a2dad6459e`。因此这是继承的契约与响应演进问题，不是项目组件化提交新引入的这五字段回归。

按原 canonical 算法重算冻结清单的 24 个文件，仍仅 `schemas/workflow.schema.json` 漂移。检查器会比较所有冻结路径，并拒绝新增、移除或 canonical 变化；它没有把可选字段视为自动兼容的例外。

| 项目                                              | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| 未修改的冻结 workflow canonical hash              | `da878252ce2da8b93b61cd4f9a937841b37230b87feaae589d7894ea123f6ea8` |
| 当前 workflow canonical hash                      | `38330d9691930409d4ac12c5384a51379748fb99c63df98e51c1ccbc02032b3c` |
| 当前 workflow 文件物理 hash                       | `2d98abb912c745ae34f85ddc7252bcffe480e9905a58595840507990789716f3` |
| 当前 `mobile-verification-store.ts` 文件物理 hash | `44b0c9da2f4bf11adb518b3b37d0cbcc21c1394ca69719bac34db5ea551a9c25` |
| 当前 `app.ts` 文件物理 hash                       | `f9de4db8af9a480b32bb3520c2bd4bdaa329bc2038d43db8d0a99339add07ee6` |

物理文件 hash 与 JSON canonical hash 是不同口径，不可混用。

## 只读内存假设验证

在内存中的 workflow schema 副本仅移除以下定义，磁盘文件未变：

- `repairAttempt.properties.patchUrl`、`noCodeReason`、`failureReason`：源码 `packages/contracts/schemas/workflow.schema.json:181–183`。
- `verification.properties.failureReason`、`blockedReason`：同文件 `223–224`。

该副本的 canonical hash 精确等于原冻结 hash。随后临时替换本进程的文件读取结果，使原版 `versions/1.1.0/scripts/validate-contracts.mjs` 读取这个内存副本；共替换 3 次 workflow 读取，脚本、其他文件和检查条件均未改变。脚本原有 Swagger HTTP resolver 已禁用，验证没有启动服务或访问外部资源。

原脚本实际输出通过：9 个冻结基础 schema + 1 个版本 schema、51 个 payload 场景、12 个继承 + 133 个新增 behavior 场景、35 个基础 + 19 个新增 OpenAPI operation、26 个错误码；退出码 0。替换的读取函数随后恢复，源 SHA 前后相同。

这说明恢复五个定义可以修复冻结文件本身，而且不会使现有 1.1 静态契约检查失败。它不证明运行 API 的响应已经符合恢复后的冻结 schema。

## 实际响应工厂验证

从当前 `packages/storage/src/mobile-verification-store.ts:297` 和 `:313` 提取并转译真实 `toVerification`、`toAttempt` 函数，传入合成行数据；没有手写镜像映射，没有读取业务数据库。用与契约脚本相同设置的 Ajv 分别验证当前 schema 和恢复后的原冻结 schema：

| 真实工厂输出     | 当前漂移 schema | 原冻结 schema 的拒绝原因                                            |
| ---------------- | --------------- | ------------------------------------------------------------------- |
| `toAttempt`      | 接受            | `additionalProperties`：`patchUrl`、`noCodeReason`、`failureReason` |
| `toVerification` | 接受            | `additionalProperties`：`failureReason`、`blockedReason`            |

两个对象的原冻结定义分别在 workflow `:162`、`:195` 使用 `additionalProperties:false`。字段是可选属性或值为 `null` 都不能绕过这个约束。只从 schema 删除五个定义，会暴露既存响应工厂与冻结定义的不一致；不能据此宣称真实响应兼容问题已经修好。

## 当前路由与表示层承诺

契约层的承诺可以定位：基础 OpenAPI 的 server prefix 是 `/api/v1`，以下 operation 明确声明 `application/json`，1.1 OpenAPI 保留它并增加 vendor media。配套 JSON 列出了 8 个受影响 operation 的准确 `$ref`，包括 repair-attempt 的 create/start/deliver/fail/supersede 和下表三项：

| 当前 API 路径                                        | 冻结 1.0 `application/json`           | 声明的 1.1 vendor response                                                                                 |
| ---------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/bugs/{bugId}/verifications`            | workflow `verification`               | 同一基础 `verification` 定义                                                                               |
| `POST /api/v1/verifications/{verificationId}/start`  | workflow `verification`               | 同一基础 `verification` 定义                                                                               |
| `POST /api/v1/verifications/{verificationId}/result` | workflow `verificationResultResponse` | app-first `recordVerificationResultResponse`；其中 `verification`/`repairAttempt` 仍引用基础 workflow 定义 |

来源为基础 `src/api-manifest.json:30–32`、两个版本的 OpenAPI、1.1 `src/api-manifest.json:376–385` 和 `:481–486`，以及 1.1 `schemas/app-first.schema.json:858`。1.1 README `:11–21` 明确保留原 JSON 表示并增加 vendor media，`api-manifest.json:147` 也明确要求 vendor 与 inherited JSON 的业务不变量一致。

实现侧不能据此推定已经支持该协商：当前 `apps/api/src/app.ts:2283`、`:2338`、`:2371` 调用存储服务，随后在 `:2289`、`:2344`、`:2399` 直接设置 `MOBILE_API_CONTENT_TYPE` 并发送结果；该常量在 `apps/api/src/mobile-bugs.ts:1–2` 固定为 `application/vnd.relay-qa-hub.v1.1+json; charset=utf-8`。这三个 handler 内未发现依据 `Accept` 选择严格 legacy 投影的分支。**已实现的冻结 1.0 响应投影入口在本次审查范围内未确定，不能把契约声明当作运行实现证据。** 本次没有发出实际 HTTP 请求，也不扩展为整个 API 的协商审计。

## 修复提案边界

有界的冻结档案修复可以仅移除这五个漂移的响应属性定义，恢复冻结文件，使原 hash 门禁按原规则通过；禁止重写原 baseline、改变 canonical 算法或添加豁免。但这项修复单独不能解决真实 DTO 的兼容性。

完整修复还需明确丰富字段的表示层边界：内部数据库、审计与业务事实保留；承诺冻结响应的表示层需要严格投影；五个字段若继续作为公共响应提供，需要一个明确约定并测试的丰富表示层。当前 1.1 的 schema/checker 自身也在独立严格 baseline 内，不能通过静默修改它们转移漂移。

本报告没有选择、批准或虚构新的 endpoint、媒体类型或版本，也没有认定现有某个扩展 endpoint 可直接承接这些字段。该边界仍待设计决定；决定后应使用真实 API 响应验证原冻结 schema，并确认客户端不会丢失修复证据或验收原因。在此之前，保留未完成的兼容性结论。
