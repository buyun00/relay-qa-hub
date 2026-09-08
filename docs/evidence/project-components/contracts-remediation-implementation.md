# 六条现有路由的冻结响应修复

本轮在开发工作树实施有界修复，起点提交为 `ef296a49f1e22da43f3a264541ef8384d617d6d5`。未操作生产、预览运行实例、设备安装或发布。修复前的只读评估及失败结论保留在 [contracts-remediation-assessment.md](contracts-remediation-assessment.md) 和其原始 JSON；本次观测、源 hash 和日志 hash 见 [contracts-remediation-implementation.json](contracts-remediation-implementation.json)。

## 实际改变

`workflow.schema.json` 只移除五个漂移的响应属性定义，恢复原冻结 canonical hash `da878252ce2da8b93b61cd4f9a937841b37230b87feaae589d7894ea123f6ea8`。原 1.0/1.1 baseline、checker、OpenAPI 和请求 schema 均未修改。数据库、审计和存储写入工厂仍保存全部事实。

新增 `apps/api/src/frozen-workflow-response.ts` 在真实注册的六条 POST 响应边界按 DTO 字段白名单投影：

| 路由（前缀 `/api/v1`）                  | 响应处理                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/bugs/:bugId/repair-attempts`          | 冻结 RepairAttempt，包括原 Relay 创建分支                                                                                    |
| `/repair-attempts/:attemptId/start`     | 冻结 RepairAttempt                                                                                                           |
| `/repair-attempts/:attemptId/deliver`   | 冻结 RepairAttempt                                                                                                           |
| `/bugs/:bugId/verifications`            | 冻结 Verification                                                                                                            |
| `/verifications/:verificationId/start`  | 冻结 Verification                                                                                                            |
| `/verifications/:verificationId/result` | 1.1 外层保留，嵌套 Verification/RepairAttempt 均投影；显式选择 legacy JSON 时返回 `{verification,bug}`，Bug 采用旧字段白名单 |

仅实现这两种已声明响应媒体的选择：无 Accept、通配符和显式 vendor 保持当前 vendor 行为；明确 JSON 偏好按质量值及同权重顺序选择 legacy。不是完整 HTTP 内容协商实现，不声称未知媒体或零权重具有额外 RFC 拒绝行为。请求解析和幂等作用域保持原样，响应投影在存储结果返回后执行，不原地删字段。Poco 等其它对象的 `failureReason` 不受影响。

三端产品源码不在本修复中改变。当前 Web/desktop/Android 均请求 vendor，界面未读取这五个响应属性；相关同名参数是请求写入，另一些属于 Poco。Web 创建/开始仍读取 id/status/version，验收结果后从详情读取最新状态。

## 丰富事实的官方读取边界

已存在的 GET `/bugs/:bugId/human-workflow`、`/repair-attempts/:attemptId` 和 `/verifications/:verificationId` 在原 1.0 与 1.1 OpenAPI 均无对应 GET 定义，属于已注册的未冻结读模型，仍返回丰富字段。没有新增端点或媒体版本。

原 human-workflow 仅包含当前活动修复；原 attempt 读取只允许部分人工状态，不能覆盖历史 Relay 验收失败。本次给已有 GET attempt 接入独立 `getRepairAttemptDetail` 查询，读取已持久化的 human/relay/external 各状态及真实 parent/target/patch/no-code/failure 字段。查询核对 account/project、活动用户/项目/成员（含既有显式 GM 上下文）、Bug 归属及删除标记。人工写入继续调用原 `getManualAttempt` 和原 active+human 约束，没有放宽操作权限。

## 验证

| 检查                                  | 结果                                               |
| ------------------------------------- | -------------------------------------------------- |
| 完整 API 测试                         | 205 个 mjs + 33 个 ts，238/238                     |
| 完整 storage 测试                     | 109/109                                            |
| Web App/api 界面相关回归              | 19/19                                              |
| 两版严格合同检查链                    | 原五步全通过：1.0 的 24 文件、1.1 的 13 文件均匹配 |
| API/storage TypeScript                | 通过                                               |
| 修改范围 ESLint、Prettier、diff-check | 通过                                               |

API 总数包含 52 个真实 `createApiApp/inject` 响应测试：六条 POST × 八种 Accept，三条丰富 GET，逐个非空额外字段反向验证原 schema。绑定两版真实 OpenAPI `$ref` 使用 Ajv；deepFreeze 的存储 DTO 保证投影不修改内部数据。这是路由/协议 fixture，不是运行实例的端到端网络证据。

另两项真实 SQLite/会话 fixture 覆盖：姓名登录、人工创建/开始/no-code 交付、创建/开始/失败验收、丰富原因读回、vendor→legacy→vendor 幂等重放（同事件、同 Bug 版本）；以及三种 mode × failed/verification_failed/superseded/cancelled 的 12 条历史详情、历史 blocked Verification 原因、错误项目、非成员、成员禁用、已删除 Bug 与操作拒绝。历史状态采用合成快照初始化，只在 fixture 事务中暂移表触发器后导入，再逐字恢复并核对全部触发器和外键，随后才经过正常 API；这不是缺失状态变更接口的执行证据。

首次完整 API 测试发现旧 Qingyu fixture 返回 `repairAttempt:null`，与真实存储及冻结结果 schema 不符；仅补该 fixture 的真实对象，原“本地先提交、外部失败不影响关闭”断言全部保留，定向 29 项及最终完整测试通过。旧路由参数 fixture 同样补齐嵌套结果形状。首次 Web 启动缺明确 API 地址被正常拒绝，重跑显式绑定未用端口 `127.0.0.1:1` 后 19 项通过；未连接现有 API。最初 SQLite 测试误在 no-code 已自动到 ready_for_verification 后再调 complete，保留其 409 失败日志并改用合法状态流程。所有失败日志与最终日志分别保留。

## 仍未覆盖

严格静态门禁通过不代表完整 1.0/1.1 服务实现。继承的 `/result` 请求解析仍要求 1.1 submission 字段，仅支持 passed/failed；旧 1.0 请求及 blocked 写入未在本轮实现。冻结声明中的 fail/supersede 两条 POST 和 1.1 `/bugs/:bugId/workflow` GET 仍未注册，未虚构成功。未来若实现 frozen workflow 的数组投影，也需遵守原 DTO。运行预览 API 的实际网络回归、后续部署及客户端升级由根任务另行验证；本轮没有执行。
