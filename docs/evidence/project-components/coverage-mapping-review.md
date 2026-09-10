# 实测证据映射审查

生成时点：2026-09-10T08:10:53.393Z。只读已有证据，没有操作 UI、API 或生产。

`passed` 只代表该行明确注明的实际入口与输入。细目控件/路由通过不代表全部负向分支或上层基线通过；HTTP 15项、MCP 13项不称全部动作。未使用源码存在、共享实现、编译、单元或外部合同 fixture 代替真实外部执行。

## 24 项基线校准

| 场景 | APK | EXE | Web | HTTP API | server MCP | local MCP |
| --- | --- | --- | --- | --- | --- | --- |
| 01 项目入口姓名登录 | not_run（部分实测） | not_run（部分实测） | passed | passed | not_run（部分实测） | not_run（部分实测） |
| 02 单项目和多项目人员 | not_run（部分实测） | not_run | passed | passed | passed | not_run（部分实测） |
| 03 唯一 GM | not_run | not_run | not_run | passed | not_run | not_run |
| 04 项目人员停用 | not_run（部分实测） | passed | not_run | passed | passed | not_run |
| 05 非所属项目读取 | not_run | not_run | not_run | not_run（部分实测） | not_run（部分实测） | not_run |
| 06 写入归属 | not_run | not_run | not_run | passed | passed | not_run |
| 07 项目快速切换 | not_run（部分实测） | not_run（部分实测） | not_run | — | — | — |
| 08 多窗口和多客户端 | not_run | not_run | passed | not_run | not_run | not_run |
| 09 关闭所有组件的基础全流程 | passed | passed | passed | passed | passed | passed |
| 10 项目人员管理一致 | passed | passed | — | — | — | — |
| 11 HTTP API 独立使用 | — | — | — | passed | — | — |
| 12 服务端 MCP 独立使用 | — | — | — | — | passed | — |
| 13 HTTP/MCP 对等 | — | — | — | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 14 并发和重复提交 | not_run（部分实测） | not_run | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 15 附件三种读取 | — | — | — | passed | passed | passed |
| 16 项目组件开关 | not_run | not_run | not_run | not_run（部分实测） | not_run | not_run |
| 17 组件依赖和缺配置 | not_run | not_run | not_run | not_run（部分实测） | not_run | not_run |
| 18 运行中停用组件 | not_run（部分实测） | not_run | not_run（部分实测） | not_run | not_run | not_run |
| 19 上传和 Relay 项目归属 | not_run（部分实测） | not_run | not_run | not_run | not_run | not_run |
| 20 外部失败与人工处理 | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 21 旧数据副本迁移 | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） | not_run（部分实测） |
| 22 APK 共存与升级 | not_run（部分实测） | — | — | — | — | — |
| 23 EXE 共存与升级 | — | passed | — | — | — | — |
| 24 回退演练 | — | — | — | passed | — | — |

09按六个实际入口分别闭环；10原文的两端指APK与EXE，分别有原生人员查看、关联和停用证据，既有HTTP证据保留但不把六入口附加为此基线条件。11/12按设计独立性判据，由EXE停止窗口内的实际HTTP及服务端JSON-RPC分别登录、查询、评论和改状态判断；全部动作/负向场景继续由§17及13/14验收。15按HTTP下载、远端MCP资源、本地MCP落盘及同一PNG归属/hash判定。23有实际EXE升级恢复proof。24按设计13/24与10.3服务恢复要求，由独立HTTP回退/保留/恢复证据判定。其它客户端/HTTP/MCP功能控件独立保留，22和§17.3物理Android未豁免。

## 部分实测及剩余缺口

- 01 项目入口姓名登录 / APK：已测 实际项目A姓名登录、进入B、回A，code20恢复同一身份与A列表。仍缺 尚未逐一核对该基线完整首登/原历史姓名/有效成员目录组合；物理Android设备未测。
- 01 项目入口姓名登录 / EXE：已测 .6原生退出清除磁盘身份且本地MCP拒绝，local MCP登录成功响应时身份已落盘；原生重登同人同项目恢复原文字+1图。。仍缺 完整首次成员登记/已有姓名稳定ID/多项目入口组合未全部覆盖；该序列未强停进程。。
- 01 项目入口姓名登录 / server MCP：已测 实际项目姓名登录与项目目录、后续操作人读回；服务端4421实际35次JSON-RPC/59检查：新姓名首登与重复/跨项目ID稳定，单项目直接选A、目录只含有效所属项目；A停用后重新姓名登录及旧token读A均403，B登录/读回和会员字段不变，恢复A同原ID。。仍缺 完整首次成员登记/已有姓名稳定ID/多项目组合未逐项覆盖；旧导入姓名/别名完整组合、原生客户端和本地EXE MCP独立验收；此运行不代表当前变更后的API源码已部署。。
- 01 项目入口姓名登录 / local MCP：已测 实际项目姓名登录与项目目录、后续操作人读回。仍缺 完整首次成员登记/已有姓名稳定ID/多项目组合未逐项覆盖。
- 02 单项目和多项目人员 / APK：已测 实际项目A姓名登录、进入B、回A，code20恢复同一身份与A列表。仍缺 尚未逐一核对该基线完整首登/原历史姓名/有效成员目录组合；物理Android设备未测。
- 02 单项目和多项目人员 / local MCP：已测 实际列出当前员工所属项目。仍缺 单项目/多项目/撤销关系的完整目录组合未在该MCP入口覆盖。
- 04 项目人员停用 / APK：已测 A 内原生停用/恢复及HTTP同名登录403/200已核对。仍缺 未在这次原生人员操作中验证同一人的 B 项目继续可用；物理设备未测。
- 05 非所属项目读取 / HTTP API：已测 HTTP4419及服务JSON-RPC4421各自双向C/D测试：非成员403、双成员显式错记录项目404；每次拒绝后Bug/列表/评论/事件/附件字节/统计/分类相同，合法读取及写入对照成功。；实际PNG下载和MCP资源字节一致；仅当前HTTP/server MCP入口。仍缺 组件任务日志未执行，Bug事件/附件不替代日志；其它客户端、本地MCP和§17完整异常组合独立验收。
- 05 非所属项目读取 / server MCP：已测 HTTP4419及服务JSON-RPC4421各自双向C/D测试：非成员403、双成员显式错记录项目404；每次拒绝后Bug/列表/评论/事件/附件字节/统计/分类相同，合法读取及写入对照成功。；实际PNG下载和MCP资源字节一致；仅当前HTTP/server MCP入口。仍缺 组件任务日志未执行，Bug事件/附件不替代日志；其它客户端、本地MCP和§17完整异常组合独立验收。
- 07 项目快速切换 / APK：已测 A/B文字与图片草稿实际分离；20→21升级恢复原项目/身份/文字/未提交PNG且三个本地hash一致；code21→22覆盖升级及原生闭环后，旧草稿/PNG/sidecar三个hash和原文继续保留。仍缺 未刻意制造迟到网络响应；未覆盖全部编辑/组件/文件草稿与人员选择；物理设备和完整迟到响应/草稿类别仍未完成。
- 07 项目快速切换 / EXE：已测 .4升级及异常退出后的项目/姓名/文字/图片草稿恢复 .6原生退出重登后同一项目/员工原文字+1图草稿恢复；本序列不含强停。 .7原生更新后同员工/项目/文字+PNG草稿恢复。；受控停止.7后实际恢复同员工/项目/原文字+1PNG，原Bug closed/v14与评论/附件hash不变。。仍缺 EXE内A/B快速切换和刻意延迟响应未完成。
- 13 HTTP/MCP 对等 / HTTP API：已测 真实临时HTTP/SQLite与MCP资源、分页501评论/101附件、协议/项目权限及部分API对等用例通过；真实预览六已注册POST的vendor/JSON冻结响应、两格式同请求重放与丰富历史读取；仅HTTP，没有独立MCP对照；EXE停止窗口内独立HTTP及服务JSON-RPC各自完成编辑、评论重放、人工完成重放、退回/再完成/关闭/删除，以及错项目403和旧版本412负例；逐请求进程边界保留。。仍缺 全部业务工具/动作的等价输入、版本/操作人/幂等/错误组合未完成；不是跨所有客户端的全量证明；完整HTTP/MCP对等输入矩阵仍未逐项执行。
- 13 HTTP/MCP 对等 / server MCP：已测 真实临时HTTP/SQLite与MCP资源、分页501评论/101附件、协议/项目权限及部分API对等用例通过 实际预览.6对应MCP入口默认删除、同请求重放、context拒绝和原记录/actor/version审计保留通过。 实际预览.7本地4420和服务4421目录相同90工具，协议2025-06-18，不支持的协议头400；未逐一执行所有工具；EXE停止窗口内独立HTTP及服务JSON-RPC各自完成编辑、评论重放、人工完成重放、退回/再完成/关闭/删除，以及错项目403和旧版本412负例；逐请求进程边界保留。。仍缺 全部业务工具/动作的等价输入、版本/操作人/幂等/错误组合未完成；不是跨所有客户端的全量证明。
- 13 HTTP/MCP 对等 / local MCP：已测 实际预览.6对应MCP入口默认删除、同请求重放、context拒绝和原记录/actor/version审计保留通过。 实际预览.7本地4420和服务4421目录相同90工具，协议2025-06-18，不支持的协议头400；未逐一执行所有工具。仍缺 全部业务动作的等价输入、版本/人员/幂等错误组合及并发场景仍未完成。。
- 14 并发和重复提交 / APK：已测 MuMu code22文本CREATE_BUG连续4次回执丢失耗尽后，install-r升code23；首次收养旧意图不发请求，原生再次提交用原operation/key/body取得同一Bug/occurrence/event，Room仅1回执；原稿与后改稿、日常14/PID5051保留。。仍缺 仅模拟器旧文本CREATE_BUG；图片未知回执/坏回执/评论/其它写动作及物理Android未测。冷归档使用预览force-stop，不等于正常退出；3个可选更新未认证拒绝和原harness失败保留。。
- 14 并发和重复提交 / Web：已测 bf3a4621：实际Edge页面101/101；Bug及评论各在服务201后丢弃一次回执，修改草稿后正常关闭/重启同profile，再通过原结果确认按钮以原key/冻结payload重放；仅1个Bug/occurrence/评论及1份68B PNG同SHA，后改两份草稿保留并再次重启读回。；7904e2c共享Web的实际Edge81/81：坏PNG finalize返回真实400/UPLOAD_CONTENT_INVALID，Bug POST仍为0；显式保留失败记录并提交修改稿后真PNG只创建1个Bug，旧journal/坏Blob/隔离chunk保留，正常重启后再次读回。。仍缺 该Web实测未覆盖其它写动作、同时多窗口、附件上传中断、撤权/跨项目故障、进程强杀或所有幂等竞争组合；APK/EXE/HTTP/server MCP/local MCP结果不由此迁移。首轮38检查后harness失败保留。；仅新建Bug附件阶段的确定拒绝恢复；评论拒绝、未知提交后再拒绝、多窗口/强杀及其它客户端未测。该历史source SHA不重新验证当前改动。。
- 14 并发和重复提交 / HTTP API：已测 真实同验收请求切换JSON/vendor重放，保留相同事件和Bug版本；EXE停止窗口内独立HTTP及服务JSON-RPC各自完成编辑、评论重放、人工完成重放、退回/再完成/关闭/删除，以及错项目403和旧版本412负例；逐请求进程边界保留。；真实两客户端12并发组、98请求/105检查通过；六人工流程动作同键并发及后续重放返回同一已提交资源，事件/操作者和重放后Bug不变，旧版本不同编辑键一胜一VERSION_CONFLICT。；创建同键不同payload实际HTTP409/IDEMPOTENCY_PAYLOAD_MISMATCH；创建、编辑、评论、验收通过和软删除同键无重复效果。首次19项产品失败原样留存并由同场景新proof对照修复。；f8e2c6da：66真实请求/56检查，两组同manual_complete意图和verify_pass/verify_fail、close/reject相反结论竞争；验收结果各仅一个版本和事件效果。胜方跨HTTP/server MCP重放同回执，败方旧版本及胜方变更payload均拒绝，原记录保留。。仍缺 全部动作/错误/并发组合的幂等验证仍不完整；APK/EXE/Web真实超时恢复及local MCP未由本轮测试；更多状态动作、全部附件阶段、组件外部任务及§17完整异常组合尚未测试；f8e2c6da中两次均由HTTP通过方胜出，不据此声称退回成功效果、客户端恢复或所有动作组合通过。
- 14 并发和重复提交 / server MCP：已测 实际预览.6对应MCP入口默认删除、同请求重放、context拒绝和原记录/actor/version审计保留通过。；EXE停止窗口内独立HTTP及服务JSON-RPC各自完成编辑、评论重放、人工完成重放、退回/再完成/关闭/删除，以及错项目403和旧版本412负例；逐请求进程边界保留。；真实两客户端12并发组、98请求/105检查通过；六人工流程动作同键并发及后续重放返回同一已提交资源，事件/操作者和重放后Bug不变，旧版本不同编辑键一胜一VERSION_CONFLICT。；创建同键不同payload实际HTTP409/IDEMPOTENCY_PAYLOAD_MISMATCH；创建、编辑、评论、验收通过和软删除同键无重复效果。首次19项产品失败原样留存并由同场景新proof对照修复。；f8e2c6da：66真实请求/56检查，两组同manual_complete意图和verify_pass/verify_fail、close/reject相反结论竞争；验收结果各仅一个版本和事件效果。胜方跨HTTP/server MCP重放同回执，败方旧版本及胜方变更payload均拒绝，原记录保留。。仍缺 全部业务动作的等价输入、版本/人员/幂等错误组合及并发场景仍未完成。；APK/EXE/Web真实超时恢复及local MCP未由本轮测试；更多状态动作、全部附件阶段、组件外部任务及§17完整异常组合尚未测试；f8e2c6da中两次均由HTTP通过方胜出，不据此声称退回成功效果、客户端恢复或所有动作组合通过。
- 14 并发和重复提交 / local MCP：已测 实际预览.6对应MCP入口默认删除、同请求重放、context拒绝和原记录/actor/version审计保留通过。。仍缺 全部业务动作的等价输入、版本/人员/幂等错误组合及并发场景仍未完成。。
- 15 附件三种读取 / APK：已测 真实MediaProjection PNG在APK提交绑定；同一图片三个读取入口hash一致。仍缺 APK物理设备和更多文件/游戏截图场景未测；MCP调用属于各自MCP入口，未记作APK调用。
- 16 项目组件开关 / HTTP API：已测 A配置开关不影响B；依赖级联关闭；普通员工禁止组件配置。仍缺 旧HTTP/MCP和后台创建任务的全组合禁止仍只部分fixture覆盖，没有真实外部任务验证。
- 17 组件依赖和缺配置 / HTTP API：已测 缺配置为needs_configuration；single依赖检查和级联关闭；基础人工闭环可用。仍缺 所有客户端可见配置引导及实际独立外部资源尚未全面验证。
- 18 运行中停用组件 / APK：已测 code21原生本地批次/交接/禁用远端三个tab可达；全关时本地空列表读回，远端无执行按钮。仍缺 有数据的暂停恢复/批次重试/merge原生点击未测；真实独立Relay任务及回调/外部执行未测。
- 18 运行中停用组件 / Web：已测 真实临时SQLite/API交接关闭暂停、启用不重放、hold拒绝、明确恢复、重复拒绝及单审计；外部请求0。仍缺 浏览器有数据的暂停条目确认/恢复未测；真实外部执行/运行中停用全组合未测。
- 19 上传和 Relay 项目归属 / APK：已测 code21原生本地批次/交接/禁用远端三个tab可达；全关时本地空列表读回，远端无执行按钮。仍缺 有数据的暂停恢复/批次重试/merge原生点击未测；真实独立Relay任务及回调/外部执行未测。
- 20 外部失败与人工处理 / APK：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / EXE：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / Web：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / HTTP API：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / server MCP：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 20 外部失败与人工处理 / local MCP：已测 本地合同fixture已验证实现的部分失败处理，作为背景证据；不算本入口外部失败实测。仍缺 真实独立Jenkins/上传/Relay/轻语失败时的完整客户端人工处理未执行。
- 21 旧数据副本迁移 / APK：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称；只读盘点53文件/3上传job/2chain/9Relay batch（17 items）及queue/WAL位置；没有复制、打开活SQLite或迁移。。仍缺 旧外部状态的位置和本地部分状态已盘点；活queue/WAL未打开，队列数量/状态未知；缺跨文件一致恢复集、明确项目/组件版本映射和实际迁移读回。Qingyu仅metadata，其密文/密钥恢复未验收。。
- 21 旧数据副本迁移 / EXE：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称；只读盘点53文件/3上传job/2chain/9Relay batch（17 items）及queue/WAL位置；没有复制、打开活SQLite或迁移。。仍缺 旧外部状态的位置和本地部分状态已盘点；活queue/WAL未打开，队列数量/状态未知；缺跨文件一致恢复集、明确项目/组件版本映射和实际迁移读回。Qingyu仅metadata，其密文/密钥恢复未验收。。
- 21 旧数据副本迁移 / Web：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称；只读盘点53文件/3上传job/2chain/9Relay batch（17 items）及queue/WAL位置；没有复制、打开活SQLite或迁移。。仍缺 旧外部状态的位置和本地部分状态已盘点；活queue/WAL未打开，队列数量/状态未知；缺跨文件一致恢复集、明确项目/组件版本映射和实际迁移读回。Qingyu仅metadata，其密文/密钥恢复未验收。。
- 21 旧数据副本迁移 / HTTP API：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；新的held schema14 API真实26项：旧姓名稳定ID、100 Bug/2评论/1附件3487861字节hash，匿名401/跨项目404/hold409；五组件off、出站0、原身份和核心表保留，正常exit0；只读盘点53文件/3上传job/2chain/9Relay batch（17 items）及queue/WAL位置；没有复制、打开活SQLite或迁移。。仍缺 旧外部状态的位置和本地部分状态已盘点；活queue/WAL未打开，队列数量/状态未知；缺跨文件一致恢复集、明确项目/组件版本映射和实际迁移读回。Qingyu仅metadata，其密文/密钥恢复未验收。。
- 21 旧数据副本迁移 / server MCP：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称；只读盘点53文件/3上传job/2chain/9Relay batch（17 items）及queue/WAL位置；没有复制、打开活SQLite或迁移。。仍缺 旧外部状态的位置和本地部分状态已盘点；活queue/WAL未打开，队列数量/状态未知；缺跨文件一致恢复集、明确项目/组件版本映射和实际迁移读回。Qingyu仅metadata，其密文/密钥恢复未验收。。
- 21 旧数据副本迁移 / local MCP：已测 主SQLite固定归档schema12→14；原ID/878附件/58业务表指纹保留，2021条主outbox均sent且数量/指纹不变；上述为恢复集证据；本客户端/工具入口的服务读回未由该证据宣称；只读盘点53文件/3上传job/2chain/9Relay batch（17 items）及queue/WAL位置；没有复制、打开活SQLite或迁移。。仍缺 旧外部状态的位置和本地部分状态已盘点；活queue/WAL未打开，队列数量/状态未知；缺跨文件一致恢复集、明确项目/组件版本映射和实际迁移读回。Qingyu仅metadata，其密文/密钥恢复未验收。。
- 22 APK 共存与升级 / APK：已测 MuMu预览15→21实际共存/ADB升级；20→21的文字/未提交PNG/sidecar三hash逐一相同；日常code14/PID5051/安装时点/dataDir保留；code21→22/preview.8实际ADB install-r成功，87unit/lint0errors；日常14/PID5051/安装时间/dataDir/四配置hash不变，预览草稿/PNG/sidecar保留；MuMu code22→23/preview.9的ADB install-r实际通过，首次启动前12份私有文件保全；旧operation/原正文及PNG锚点、后改稿、日常14/PID5051与配置保留。。仍缺 物理Android设备必测仍缺；应用内更新源/自安装链路未测；物理Android及应用内更新完整链路仍未验收；物理Android及应用内检查/下载/自安装完整链仍未实测；下载feed发布不能补成客户端自更新。。

独立 Jenkins、上传平台/对象存储、Relay 目的实例和轻语测试租户/凭据仍缺；所有 `external_full_chain` 保持 not_run。离线迁移的数据库/附件指纹证明没有替代各入口执行。异常停止预览 EXE 证明进程独立和草稿恢复，不能自动记为完整版本回退。
已安装EXE的90工具共享目录与源码保留的18工具fallback目录分别统计；同名工具调用只通过共享目录对应行，fallback行保留未测，避免重复计数。

## 首次提交前证据补充

新增预览.6真实双入口删除：服务端4421和已安装EXE的本地4420各创建独立Bug并调用默认删除；相同请求重放均replayed:true、删除时点相同，context返回NOT_FOUND，原Bug及删除actor/version审计保留。[双MCP删除实测](runs/mcp-delete-live-preview6.json)。仅映射对应qa_delete_bug入口，不把一个删除用例推定为全部HTTP/MCP动作对等或全量幂等通过。

新增.6实际身份边界：原生退出后磁盘身份清除，本地MCP返回QA_HUB_LOGIN_REQUIRED；local MCP登录成功返回时身份已经落盘；原生重新登录同员工/项目后原文字+1张PNG草稿恢复。[退出读回](runs/exe-preview6-logout-readback.json)、[同步持久登录](runs/exe-preview6-login-durable-readback.json)、[原生重登草稿](runs/exe-preview6-relogin-draft.json)。登录后立即强停的组合命令被自动审批拒绝、未执行且未重试；这组证据明确processRestartNotTested，不能据此声称该强停场景通过。

此前提交前只读生产快照为2026-09-08T19:30:39Z：六个文件hash、三个原PID/启动时点均与19:02:22Z一致，4319 ready/schema12，4174的Windows 3.3.5公开manifest原字节hash一致；日常APK code14/PID5051/安装时点保留，预览APK code21仍在。未读取配置正文或凭据，未启停任何应用，未重新验签。日期比较曾因PowerShell隐式转换丢失小数精度误报，已按原始UTC字符串100ns精度更正并保留说明。[提交前生产快照](runs/production-pre-commit.json)。

此前.7升级后生产只读核对为2026-09-08T19:55:31.6095789Z：六文件hash、三个原PID及精确启动时点不变，4319 ready/schema12，4174 Windows3.3.5 manifest原字节SHA不变。日常EXE可读路径相同；两个Node的路径仍为null，不能视为新增可执行路径验证。本轮未重新查询Android，APK状态仍引用19:30快照；未读配置正文/凭据或修改生产。[.7后生产快照](runs/production-after-preview7.json)。

该阶段API完整回归为MJS151+TS33=184/184，旧175轮次保留；后续238最终回归见末节。生命周期9项覆盖真实监听、SQLite与inflight清理，修复的是绑定前调度/异常清理，旧runtime已有onReady/onClose；不得据此通过外部完整链路。[184原始日志](runs/api-final-lifecycle-source.txt)、[生命周期证据](component-runtime-lifecycle.md)。

本次仅将源码qa_delete_bug行 mcp_tool-65cae97a9470db 的server_mcp/local_mcp记通过；required_mcp_parity同名需求行仍not_run，不重复算全部对等。基线01/07的EXE与13/14的两MCP只补部分实测，该次补充后的wholepass为09/15/23；随后基线24服务证据及判据校正见专节。

该历史阶段mapper源保持冻结。当时新增结果及SHA使用既有JSON results/manual保留机制，审计元数据位于evidenceMapping.postFreezeSupplement，各行manual.postFreezeEvidence亦保留必要proof hash。只运行既有generate-coverage-matrix.mjs重生JSON/Markdown，不重写mapper代码。未来重跑旧mapper会刷新其自动审查段，需保留本补充段；人工行结果由既有matching-ID机制保留。

## 实施提交后的发布与迁移补充

**Windows 0.2.0-preview.7 已完成独立发布和实际6→7原生升级验收。** releaseId为20260908T194425490Z，108378668字节，SHA-256 fbf0656285474e2b4d521178cb9107dd26d3426dd463b9198fc21b239e02152a。公开回执sourceCommit为3b1371cbbaee4ab31f5861fe3cd72d6ff93c4789、sourceDirty:false；文档更新只读核对receipt及主代理实际原生升级proof；未额外操作安装或验签。回执位置：C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\packages\20260908T194425490Z\receipt.json。此包已含首装guard及提交内源码，升级passed依据下述实际proof。

.6→.7已通过原生“检查更新→安装并重启”实际完成，proof观测时点2026-09-08T19:54:02.443Z；当前已安装nativeVersion0.2.0.7、主PID11368。原员工/项目A、文字+1张PNG草稿和配置SHA保持，原Bug13 closed/v14、评论及184872字节原附件materialize/hash读回通过；旧更新结果及7份backup目录保留。新helper的成功result时间19:52:36Z位于真实原生点击区间，UTC已在本次成功更新中核对。[.7升级proof](runs/exe-after-preview7-upgrade.json)、[原生恢复](runs/exe-preview7-restored-draft.txt)。19:54:30Z本地4420与服务4421实际目录均为相同90工具、协议2025-06-18，不支持的协议头均400；此项只证明目录/协议，不能称90个业务工具全部通过。[双入口协议](runs/exe-preview7-live-protocol.json)。

新增保持冻结状态的迁移副本的真实API服务读回26项通过：固定schema12归档在新的service-readback-8b94d602中恢复并迁移至14，127.0.0.1:51708仅启动该副本API；稳定旧姓名ID登录后读出100 Bug、真实2评论及1附件（3487861字节、SHA-256 73470971577ea3ceb30edf4e8cb713d449a3b6e66c566cac5e897e136566e2ce），匿名401、跨项目404、外部读取hold409均实测。五组件关闭、出站和执行器子进程尝试均0；hold字节和核心业务/outbox指纹保持，原身份记录全部保留。新增的仅是官方独立GM和会话记录；不能称整个数据库字节无变化。进程8532正常exit0且监听关闭，旧migrated/rollback未启动且hash不变。[26项读回](migration-service-readback.md)、[脱敏JSON](migration-service-readback.json)。

该服务使用19:24:26Z冻结的独立编译样本，其已有onReady/onClose并由paused gate阻止调度；它不代替后续监听生命周期9项测试。此结果证明held schema14 API恢复读取，**未证明schema12程序启动、迁移后新增数据的完整回退、生产切换、客户端迁移或独立组件队列/workspace恢复**。归档2021条outbox原本全sent，也不单独证明pending任务冻结。前两次错误测试路由导致的harness失败已保留，不计成功。

该次迁移补充保留985条，仅补21的HTTP progress，不传递其它客户端/MCP通过；当时21/24仍not_run。后续24服务演练及判据校正另记，21外部任务清单与物理Android缺口仍保留。公开receipt摘要与hash记录于evidenceMapping.releaseAndMigrationSupplement，原始receipt仍位于独立runtime。该段发布证据形成时mapper源码保持冻结；本轮仅追加proof保留与基线判据校正。
## 基线判据及窄分支校正

设计13原文：“相同输入得到相同状态、版本、操作人和错误结果”。设计15原文：“HTTP 下载、远端 MCP 资源、本地 MCP 落盘均归属正确且可用”。15现在只按这三读取入口汇总，APK/EXE/Web其它功能控件保持各自状态，未增加not_applicable状态或豁免17.3物理设备要求。

重新核对同一项目fb914b3b-4169-47f8-8dec-76f3a3cc780d、Bug b817a6cc-f096-415d-bdb8-faa9b6005c36、附件31c9b4be-d0f6-4c9a-864e-032cc9130562：184872字节PNG，三种读取SHA-256同为e0ed7b4b96935f06855a05ce3372ada01b9585ed459d3d5c183f1c6dc8e7cb8b；HTTP跨项目404。三份主要入口proof是[HTTP](../../../apps/android/app/build/evidence/project-components/preview-code17-capture-isolation-readback.json)、[远端MCP](runs/server-mcp-real-resource-20260909.json)、[本地落盘](runs/desktop-mcp-resource-preview4.json)，绑定ID来自原[采集读回](../../../apps/android/app/build/evidence/project-components/preview-code17-capture-bug-readback.json)。

21仅移除无关的schema12程序启动/新增数据回退条件；26项held服务读回同时写入HTTP actual/evidence和manual。主库与878附件恢复集已经可用，historical-copy改为partially_verified；仍缺legacy上传独立queue.sqlite/owner/workspace/job、Relay批次/state和轻语状态的未完成任务完整清单及迁移核对。故21整项仍not_run，不能从58表指纹或2021sent主outbox推出这些目录已迁移。

.7真实close和更新按钮仅EXE入口passed；window-action(close)、check-update成功、install-update成功和second-instance无深链恢复记录为manual.branchResults中的passed，复合handler整行仍not_run。tray.click/double-click及托盘菜单没有此证据，仍not_run。

可重放纠正由manual.reviewedEvidence保存结果、progress和实际proof SHA；mapper在重放前逐一核对hash，变化即拒绝并要求重审。它不是新的业务通过来源，也不会取消needsRevalidation。
## 本轮重放验证与合同边界

前轮生成器→mapper→生成器重放后985细目不变，当时wholepass为09、15、23；401个既有needsRevalidation以及sourceHash/人工复验字段的规范化SHA保持相同。实际运行mapper的内存文件系统替身用错误proof SHA验证拒绝且零写入；另一个用例证明后来的failed结果、负向note、partial note、item/manual复验标记和sourceHash均保留。原始磁盘证据未改。[实际重放验证](runs/coverage-criteria-replay.json)。

严格合同的历史失败已在提交09f7150fc1c671d867bbdbc257cab0e61c78d20f修复：五步test:contract全部通过，原1.0/1.1 baseline与checker未重写。六条已注册POST使用冻结响应投影，丰富事实仍可从原三条GET读取。完整API238/238（205mjs+33ts）、Storage109/109、相关Web19/19通过；其中52条响应fixture覆盖八种Accept，不能当作运行实例E2E。[实现与边界](contracts-remediation-implementation.md)、[严格五步](runs/contracts-remediation-strict.txt)、[最终API](runs/contracts-remediation-api-final.txt)。旧1.0 result请求、blocked写入和未注册fail/supersede POST及/bugs/:bugId/workflow GET仍缺，不能据静态门禁宣称完整运行合同。
## 基线24服务回退判据校正

设计13/24原文：“能按文档恢复服务并保留回退前新增数据和任务证据”。10.3同时要求旧服务不能读取已迁移的新库，新版停止或回退时保留新增操作和产物。因此24以服务/HTTP为必要入口；此前要求APK、EXE、Web、HTTP、两MCP各自降级是过度约束。已有EXE客户端回退/重装证据独立保留，APK/Web/MCP及所有功能控件不由服务演练自动通过。

[47项服务回退](baseline24-service-rollback.md)及[脱敏JSON](baseline24-service-rollback.json)记录59条真实HTTP状态/大小/hash：modern3b1371c/schema14新增两Bug、评论、68字节PNG及两人工RepairAttempt/两Verification，其中一项仍in_progress；正常停止后910文件753461759字节整根保留，old62b4495/schema12实际读取独立旧归档，再以M14原session恢复所有新增ID/版本/操作者/状态/hash。三进程均正常exit0，端口关闭，retained全文件hash仍一致。写入外层是HTTP /api/v1/mcp/call，另有标准domain GET；本证据没有建立独立JSON-RPC或客户端UI会话。

该证明的protectedBefore/After仅为固定archive/migrated/rollback副本，不是新一轮生产六文件快照；生产状态继续按各自带时点proof引用。它不证明旧外部queue.sqlite/workspace、Relay批次/state、轻语目录的完整迁移，也不承诺schema14新业务降级到12。18/19外部任务、21旧文件系统任务清单、22和17.3物理设备缺口保留。该轮整项通过09、15、23、24，全部任务仍未完成。
## 最终API、Android与生产读回

严格合同的历史失败已在提交09f7150fc1c671d867bbdbc257cab0e61c78d20f修复：五步test:contract全部通过，原1.0/1.1 baseline与checker未重写。六条已注册POST使用冻结响应投影，丰富事实仍可从原三条GET读取。完整API238/238（205mjs+33ts）、Storage109/109、相关Web19/19通过；其中52条响应fixture覆盖八种Accept，不能当作运行实例E2E。[实现与边界](contracts-remediation-implementation.md)、[严格五步](runs/contracts-remediation-strict.txt)、[最终API](runs/contracts-remediation-api-final.txt)。旧1.0 result请求、blocked写入和未注册fail/supersede POST及/bugs/:bugId/workflow GET仍缺，不能据静态门禁宣称完整运行合同。

最终dist已在独立API PID18644加载，启动时点2026-09-08T20:39:13.7225210Z，4419 ready/schema14。root实际31个HTTP调用通过：六条冻结POST的vendor/JSON输出、同幂等请求切换媒体重放、丰富历史读取及跨项目404；另核对14个媒体头与原EXE Bug closed/v14、评论及184872字节附件hash。[31次实际请求](runs/frozen-workflow-live-2026-09-08T20-40-57-088Z.json)、[媒体/旧业务读回](runs/frozen-workflow-live-readback.json)。请求均使用1.1；没有以此补齐旧1.0请求、未注册路由或全部HTTP/MCP对等。

Android最新实际安装为com.relayqahub.android.preview.debug，code22 / 0.2.0-preview.8，MuMu中21→22覆盖升级与原生开始→无需代码提交→验收通过关闭完成。Bug386cdd2f-44c9-4a79-992a-891d595766fd closed/v6；49条对应HTTP均2xx，deliver1次、complete0次，87单测通过，lint0errors/29warnings。原有草稿/PNG/sidecar三hash、日常code14/PID5051/安装时间及四配置hash保留。Bug由API准备，后续状态写入来自原生按钮。修复文件BugLifecycleClient.kt由本目标3b1371c新增，62b起点不存在，不能描述为旧基线故障。[code22原生记录](android-code22-no-code.md)、[机器证据](android-code22-no-code.json)。真实物理设备、真实代码分支交付及外部组件仍not_run。

前轮生产只读核对为2026-09-08T20:49:45.0734634Z：相对19:55快照，六文件hash、三个原PID精确启动时点及可见日常EXE路径保持，4319 ready/schema12，4174 Windows3.3.5 manifest原字节hash不变。两个Node的可执行路径仍null，没有新增路径证明；未重新验签/下载生产安装包。Android引用code22证据20:46:37.419Z的daily14/PID5051/配置保留，root未重复ADB查询。[前轮生产只读证据](runs/production-after-api-fix-code22.json)。

14条HTTP路由仅映射该实际调用子集。Android开始按钮记实测通过，submitFix的no_code分支记录passed但真实代码分支未测，复合按钮整行仍not_run。基线09保留原APK原生创建证据并追加本轮状态链，22仅追加模拟器升级progress；09、15、23、24为整项通过，18/19/21/22及17.3缺口继续保留。

code22同一已验收APK已发布为不可变预览下载：[下载Android code22 / preview.8](http://127.0.0.1:4274/downloads/qa-hub-preview-7c86-android-0.2.0-preview.8-code22.apk)。完整HTTP下载35,471,405字节、SHA-256 733088b8f876c41ce767627c6de8dfe12e00803c0b61ff13c6facd3b8982d777，实例响应头/类型匹配，Windows manifest未变。Android源内容与提交1be772469671d75cbb5e31240bf345dcc7c4a267一致，APK构建发生在提交之前；本次发布没有重新构建或安装。回执不是签名更新manifest，不能记为应用内自升级或物理设备通过。[下载发布证据](runs/android-code22-download-publication.json)。
## 前轮源码及映射冻结

前轮冻结盘点锚点为81e70d43638f3cb2f3dbd3994acd46f413e5364e，其中API兼容源码提交09f7150、Android源码提交1be7724；188个源码文件hash逐一匹配，985条细目、21条退役历史保留。连续生成器→mapper→生成器重放的语义hash一致；错误proof hash在任何写入前拒绝（0写入），人工负向结果和item/manual复验、sourceHash标记均保留，既有needsRevalidation零丢失。审计结果见coverage-matrix.json的evidenceMapping.finalReplayVerification。

[运行HTTP回归说明](frozen-workflow-live.md)保留六注册路由的31请求和14媒体头边界。此次新增API/Android/下载证据没有补齐旧请求、blocked写入、未注册状态路由、外部队列迁移或物理设备验收。
## EXE 停止期间的 HTTP / 服务端 MCP 独立性

设计基线11原文为“关闭 EXE 后，外部程序仍可登录、查询、评论和改状态”；12为“服务端 MCP 不依赖 EXE，并覆盖同样主要 Bug 动作”。此前生成器把“全部动作/完整负向场景”加入这两个基线，超出原文；这些要求继续由§17全功能矩阵及13/14对等、并发项目验收。该轮按独立性纠正11/12，当时整项通过为09、11、12、15、23、24。

2026-09-08T21:13:39.2199432Z，主代理对已核对精确路径/启动时点的预览EXE主进程11368执行 controlled_fault_stop；没有登录后立即强停的组合，也没有操作日常EXE。独立性脚本在21:14:14.415Z–21:17:11.392Z一次运行通过：33次直接HTTP请求、36次服务端4421请求（业务为真实JSON-RPC）、140次逐请求前后及首尾边界，预览目录/同名进程和4420监听始终不存在。两个独立员工和Bug各完成登录、查询、编辑、评论重放、人工完成、验收失败退回、再次完成和通过关闭v12，随后软删除并读回拒绝/列表消失；各17条事件actor、验收人及旧版本/错项目负例均核对。[可读全过程](exe-independent-services.md)、[69请求和140边界](runs/exe-closed-api-mcp.json)、[精确停止](runs/exe-independence-controlled-stop.json)。

停止期间，109个预览profile文件共772540633字节冷保留，全部hash相同。21:18:26.3376550Z恢复同一已安装.7，主PID23924、4420恢复；原员工/项目/文字+1PNG/配置SHA，以及原Bug closed/v14、1评论和184872字节原附件hash读回不变；API18644、服务MCP15736、Web20284继续运行。[冷保留](runs/exe-independence-profile-retained.json)、[原生恢复和业务读回](runs/exe-independence-restored.json)、[恢复界面](runs/exe-independence-restored-draft.txt)。该实测不证明正常托盘退出、Windows托盘图标点击或任意崩溃组合。

最新生产只读快照为2026-09-08T21:22:09.4439761Z：六文件hash、三个原PID精确启动时点和可见日常EXE路径保持；4319 ready/schema12，4174 Windows3.3.5 manifest原字节SHA不变。两个Node路径仍null；本次没有重新ADB查询，Android仍引用20:46:37.419Z的code22证据。[独立性恢复后生产快照](runs/production-after-independence.json)。

21的旧外部状态现已找到并只读盘点：53文件，3上传job/2chain/9Relay batch共17items，以及活queue/WAL位置。活SQLite未打开，队列行数/状态未知；未建立跨文件一致导出或迁移，项目/组件版本绑定及Qingyu密文/密钥恢复仍缺，因此21保持not_run。[盘点及限制](baseline21-external-state-inventory.md)、[脱敏元数据](baseline21-external-state-inventory.json)。本轮只把实际17条HTTP路由和12个服务MCP源码工具行追加对应证据，没有转移到本地MCP、APK/Web控件或全部状态组合。

## 独立性证据与脱敏保真最终检查点

前轮源码盘点锚点为538c78f03e74aef8d02d13ad3e166ab3ece4a06f（脱敏修正提交）；业务API源码仍09f7150，Android源码仍1be7724。8份新的corrected派生由已核对原始SHA的私有原件生成，旧公开proof保留；它们修复104个JSON-RPC版本和240个事件schemaVersion的证据文本，业务结果、失败历史、检查数量未变，绝不计作新增业务运行。mapper只读取公开文件，核对index及old/corrected两侧SHA后解析派生内容，在当前结果保留old引用并追加corrected引用。[更正说明](redaction-corrections/README.md)、[公开哈希索引](redaction-corrections/index.json)。两份实际脱敏helper共有18/18纯函数测试通过；原1.0请求/blocked及未注册路由的业务能力缺口不因本证据修正改变。

前轮仅11/12及所对应实际入口新增通过；当时整项基线为09、11、12、15、23、24。985项/188源码文件/21退役历史、401复验标记继续保留；完整HTTP/MCP对等与并发、§17全功能、18/19外部执行、21一致迁移和22物理Android仍未完成。预览EXE当前已恢复PID23924；最新生产观测为21:22:09.4439761Z，均以本轮独立性proof为准，前轮时点保留为历史。

前轮最终重放已完成（2026-09-08T21:38:02.173Z）：985项、188源码hash逐一相符、21退役历史和401复验标记保留。两次generate→map→generate的语义SHA-256同为cc470e52d6f9537a9790a75a5e9fe1a6d96957e62174dfc38b58a6d695639f48；实际mapper的内存FS故障测试证实manual/source-change标记及reviewed失败结果保留，独立性proof或corrected proof错hash均在任何写入前拒绝（0写入）。该轮只有8个入口状态由not_run变passed：11/12两基线、HTTP的DELETE/manual-complete/events三路、server MCP的list_bugs/update_bug/list_events三工具；派生脱敏本身没有新增业务通过。审计字段见coverage-matrix.json的evidenceMapping.finalReplayVerification，前轮检查点保留在finalReplayVerificationHistory。
## EXE人员管理补充与基线10判据

以dc9889263cbe2b7d499ec0efbff33b512a490ef9为本轮证据锚点。设计444“两端均按现有方式完成项目人员查看、关联与停用”承接443的APK、EXE；10现在仅用这两个必要入口汇总。已有MuMu code19原生人员查看/关联/解除/停用/恢复和稳定ID读回，加上此次已安装EXE .7的独立实际操作，满足10整项；其它入口人员功能及§17.3物理Android继续独立验收，既有HTTP结果保留。

本次4个EXE业务动作、24辅助HTTP、6组截图/树、7项断言通过：A内关联/解除有2条唯一身份事件；停用/恢复有2条原actor成员事件，A主资格v1→2→3，B两人active/v1且无link；A同名登录及旧session403，B仍200。原Bug完整DTO、员工及文字+PNG草稿保持。5条UI/REPL诊断保留，未重做业务变更；新员工任务数0，不证明非零引用保全。[原生验收](exe-native-personnel/README.md)、[结果](exe-native-personnel/result.json)。

新增通过限于4.EXE、10.EXE与确认关联/取消关联/停用/恢复四按钮；搜索、主用户选择及整页只记录部分实测。当前wholepass为09、10、11、12、15、23、24，4整体仍not_run。生产最新仍21:22:09.4439761Z快照；本轮没有再次探测生产，也没有启停服务。

本轮重放以dc98892为锚点，985项/188源码hash/21退役项/401复验标记保持；相对该提交仅6个EXE入口状态新增通过，10的必要入口改为APK/EXE并保留旧HTTP证据。稳定重放语义SHA为c23f07f22c0195b2dc59eab39c7cb4f84d32c79ea770cd0a884147ea33902b9f。proof统一按原始字节求SHA；首次JPG文本hash不匹配被拒绝后修正，旧JSON及14份人员proof的字节hash均核对不变。

## C/D HTTP与服务端MCP项目隔离

[两轮完整证据](project-isolation-live/README.md)：首次363请求/45已完成断言因harness变量初始化顺序失败，项目/人员/4Bug/额外预留原样保留；修正后新fixture第二轮1997请求/262断言通过，100授权拒绝各有原项目快照不变。05仅部分实测，组件任务日志仍未执行；事件/附件不替代日志。06的修改、评论、上传绑定、状态最低类别在HTTP/serverMCP两个实际入口criterion passed，绑定额外测试是bug_create预留及持久重放，不声称已claim到既有Bug或全部意图通过。其它客户端不迁移状态，06整行仍未完成。映射仅13条明确HTTP路由和14个服务端工具，不向本地MCP/fallback/所有状态组合传播。

[首次并发实际失败](workflow-concurrency-live/e94223b3-82c5-469d-b7ca-eea306ba0aab.json)为98请求/86检查、19失败：六动作同键回执重放及创建payload不匹配错误边界。部署修复8f7330a后，[相同12并发组新proof](workflow-concurrency-live/badce916-8b25-463b-9ee2-ddad3727350f.json)98请求/105检查全过，原86检查逐label均重新通过，增加18个成功后才能执行的资源比较和1个HTTP409断言；首次失败及fixture原样留存。映射精确六条人工流程HTTP路由、POST Bugs错误码和server qa_bug_action六动作，保留needsRevalidation；其它状态与local MCP不传播。14仅HTTP/server MCP partial，客户端timeout恢复、更多动作/附件阶段与外部任务去重仍未测试。

## 可重放与审计

以下历史 `reviewedEvidence` 指向的 Git-ignored Android build proof 当前缺失；对应行已标记 `needsRevalidation`，本次没有重放或提升这些结果。其它 tracked/public proof 缺失仍会在写入前拒绝：

- baseline-bf491c9fd4acc9：../../../apps/android/app/build/evidence/project-components/preview-code17-capture-bug-readback.json、../../../apps/android/app/build/evidence/project-components/preview-code17-capture-isolation-readback.json

- 人工流程幂等修复API MJS206/206：已有成功输出，见[workflow-concurrency-live/api-regression.txt](workflow-concurrency-live/api-regression.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 人工流程幂等修复API TS33/33（合计239/239）：已有成功输出，见[workflow-concurrency-live/api-regression.txt](workflow-concurrency-live/api-regression.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 人工流程幂等修复Storage117/117：已有成功输出，见[workflow-concurrency-live/storage-regression.txt](workflow-concurrency-live/storage-regression.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 响应修复最终API MJS205/205：已有成功输出，见[runs/contracts-remediation-api-final.txt](runs/contracts-remediation-api-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 响应修复最终API TS33/33（合计238/238）：已有成功输出，见[runs/contracts-remediation-api-final.txt](runs/contracts-remediation-api-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 响应修复Storage109/109：已有成功输出，见[runs/contracts-remediation-storage.txt](runs/contracts-remediation-storage.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 响应修复相关Web19/19：已有成功输出，见[runs/contracts-remediation-web-configured.txt](runs/contracts-remediation-web-configured.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 严格合同五步恢复通过（原baseline/checker保留）：已有成功输出，见[runs/contracts-remediation-strict.txt](runs/contracts-remediation-strict.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- Desktop 104/104：已有成功输出，见[runs/desktop-final-pagination-protocol.txt](runs/desktop-final-pagination-protocol.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- Storage 109/109：已有成功输出，见[runs/storage-final.txt](runs/storage-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 冻结源码最终Storage109/109：已有成功输出，见[runs/storage-final-complete-source.txt](runs/storage-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 冻结源码最终API MJS142/142：已有成功输出，见[runs/api-final-complete-source.txt](runs/api-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 冻结源码最终API TS33/33（两组共175/175）：已有成功输出，见[runs/api-final-complete-source.txt](runs/api-final-complete-source.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 真实临时HTTP/SQLite与MCP分页/协议15/15，501评论/101附件：已有成功输出，见[runs/api-pagination-final.txt](runs/api-pagination-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- root unit 4/4：已有成功输出，见[runs/root-unit-final-retry.txt](runs/root-unit-final-retry.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- skeleton 1/1：已有成功输出，见[runs/skeleton-e2e-final-retry.txt](runs/skeleton-e2e-final-retry.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 精确Relay授权及组件scope16/16，含第101项目/成员：已有成功输出，见[runs/api-production-scope-final.txt](runs/api-production-scope-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- MCP删除合同及已删除Bug附件读取保护17/17：已有成功输出，见[runs/api-delete-guard-final.txt](runs/api-delete-guard-final.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 独立app-first合同检查通过：已有成功输出，见[runs/contracts-app-first.txt](runs/contracts-app-first.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 独立additive检查通过：已有成功输出，见[runs/contracts-additive.txt](runs/contracts-additive.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 独立app-first breaking检查通过：已有成功输出，见[runs/contracts-breaking-app-first.txt](runs/contracts-breaking-app-first.txt)。local verification; does not mark unexecuted native UI/external baseline passed。
- 冻结共享Web源码99/99、双noEmit/lint/format；严格持久提交与明确拒绝恢复的本地回归：已有成功输出，见[web-pending-submission-source.json](web-pending-submission-source.json)。fetch替身、受控IndexedDB事件与串行存储适配器；不证明真实浏览器/EXE重启或基线14客户端恢复。
- 7904e2c Web独立构建发布、3个实际HTTP下载SHA匹配、旧dist及全部旧assets保留：已有成功输出，见[runs/web-pending-submission-publication.json](runs/web-pending-submission-publication.json)。该发布记录仅证明构建和静态下载，无服务重启/安装版EXE更新；后续浏览器故障注入单独映射，不由发布提升客户端通过项。
- Android 115/115、lint 0 error；严格核对提交fb2eca7的10份冻结源码SHA：已有成功输出，见[android-offline-create-recovery.json](android-offline-create-recovery.json)。当前源码SHA已漂移，needs revalidation；该记录只保留为历史验证，不映射为当前通过。这是历史验证记录。BugDraftPreferences测试原始SHA与提交canonical SHA分别保留，仅1个CRLF→LF、未重跑测试。OkHttp回环/受控DAO及偏好存储夹具，不是已安装APK、Compose/物理设备故障注入；不提升任何客户端结果。。
- 原始NSIS .onInit隔离native guard6/6：已有成功输出，见[runs/native-installer-guards.json](runs/native-installer-guards.json)。仅首建Programs、marker、junction与越界目录守卫；未执行真实用户完整首装或卸载。
- .6 native helper以故意无效空配置实际返回failed并验证UTC序列化：已有成功输出，见[runs/native-updater-utc.json](runs/native-updater-utc.json)。预期失败仅验证UTC；没有调用installer，不计更新成功。
- Web61/61+typecheck/lint/build；outbox真实临时API/SQLite、外部请求0：已有成功输出，见[runs/web-outbox-verification.json](runs/web-outbox-verification.json)。React静态渲染及隔离API实测；浏览器暂停条目点击未测。
- code23同包preview feed发布13个真实HTTP：GET/HEAD/206 range及完整APK SHA核对；旧code22与发布时Windows.8保留：已有成功输出，见[android-code23-feed-publication/29a9b98b-2fa8-4625-a465-5d75a91b70e8/publish.json](android-code23-feed-publication/29a9b98b-2fa8-4625-a465-5d75a91b70e8/publish.json)。仅发布/下载与API身份记录；stable未选channel的401保留。不是APK原生自更新，后来的Windows.9更新不是本次失败。。
- bc2b347对应.9包中共享Web部署：18 GET/HEAD全部200、8候选SHA、12 served文件及Web进程身份保持：已有成功输出，见[web-detail-fix-publication/e2d5cb4b-9068-4f14-9f90-d292ee4af864/deploy.json](web-detail-fix-publication/e2d5cb4b-9068-4f14-9f90-d292ee4af864/deploy.json)。仅静态下载和发布时进程证据；无新服务启停，不代表真实Web loading页面验收，不将.9原生EXE UI传递到Web。。
- Br-CEXQI真实Edge59项：真实200暂留显示加载，注入Failed显示错误，实际Retry取得新200恢复同一详情：已有成功输出，见[web-detail-loading-live/ab51a7d8-3d97-40e0-86af-bf2fe77af389/proof.json](web-detail-loading-live/ab51a7d8-3d97-40e0-86af-bf2fe77af389/proof.json)。仅同项目文本Bug；四张实际截图、Bug与事件未变。背景components hold实际0，不证明超时/常态轮询或跨项目迟到响应。。
- 服务端MCP人员真实59项，02/04的server MCP入口完成；01保留旧历史姓名组合未测：已有成功输出，见[server-mcp-membership-live/e21431f0-e927-4a3f-8275-167accb1eaef/proof.json](server-mcp-membership-live/e21431f0-e927-4a3f-8275-167accb1eaef/proof.json)。仅新A/B/新员工；35 RPC另加1 health GET，五组件off、无Bug写入，不传递到其它入口或整个基线。。
- Phase A源码：legacy passed/failed和不可变原回执，API260/Storage118及临时真实HTTP215通过，schema15加法恢复验证：已有成功输出，见[contracts-result-phase-a/result.json](contracts-result-phase-a/result.json)。该证据未部署常驻4419、未做完整main/MCP/客户端运行；blocked、附件9..20/capture、fail/supersede及workflow GET仍独立未完成。。
- 真实Web A/B切换164项：A genuine200在实际切B时由同network request取消；两项目独立文字/人员/PNG经reload及往返保留：已有成功输出，见[web-project-switch-draft-live/9320822e-6d6d-4f78-a6cb-eb59cb0a7013/proof.json](web-project-switch-draft-live/9320822e-6d6d-4f78-a6cb-eb59cb0a7013/proof.json)。实际settlement=canceled，未绕过Abort或伪造旧回调送达；18直接+47浏览器请求与28响应记录分开，无Bug/上传/评论写入。。
- MuMu code23原生33项：单A/A-B/B-only目录、A撤权后同名拒绝/B可用、恢复同ID；原账号文字PNG及四稳定文件完整恢复：已有成功输出，见[android-personnel-live/fe334481-b448-4e51-8b83-8a63480f150c/result.json](android-personnel-live/fe334481-b448-4e51-8b83-8a63480f150c/result.json)。停用/恢复由GM官方HTTP辅助；原生自停用被disabled，无物理设备、原生网络403抓包或整项人员基线通过结论。。
- 独立完整main/schema15+worker+server MCP：247项，111直接HTTP+16JSONRPC；legacy/vendor原receipt、权限与普通人工链真实通过：已有成功输出，见[contracts-result-phase-a-live/e9662073-77cf-44b5-a04d-3649e1651e20/be5c18d7-8150-4684-b7c4-a9044c11b796/result.json](contracts-result-phase-a-live/e9662073-77cf-44b5-a04d-3649e1651e20/be5c18d7-8150-4684-b7c4-a9044c11b796/result.json)。4459/4461专用临时实验服务正常退出、一致备份保留；不代表常驻4419已更新或客户端/外部组件已验收。。
- PhaseB blocked源码API266/Storage118、六组114临时HTTP与15→16独立档案迁移11项通过，原70表/7份receipt保持：已有成功输出，见[contracts-result-phase-b/result.json](contracts-result-phase-b/result.json)。五份产品源码与四份测试按pin固定；本证据不含完整schema16 main运行。常驻4419仍14、MCP仍无blocked提交工具。。

## 近期指定版本的部分实测

以下补充原始版本证据；仅新e21431f0完整覆盖的02/04服务端MCP入口标通过，不清除旧失败或源码复验标记。EXE旧升级基线保留原结果；共享Web静态发布与另行实际loading验收分开。

- web-7904e2c-rejected-media-81：[原始证据](web-rejected-media-recovery-live/5f3c9726-5374-4c7d-9ba4-57573901968e/proof.json)。7904e2c共享Web的实际Edge81/81：坏PNG finalize返回真实400/UPLOAD_CONTENT_INVALID，Bug POST仍为0；显式保留失败记录并提交修改稿后真PNG只创建1个Bug，旧journal/坏Blob/隔离chunk保留，正常重启后再次读回。 仅新建Bug附件阶段的确定拒绝恢复；评论拒绝、未知提交后再拒绝、多窗口/强杀及其它客户端未测。该历史source SHA不重新验证当前改动。
- apk-code23-legacy-text-recovery：[原始证据](android-code23-recovery-live/65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/result.json)。MuMu code22文本CREATE_BUG连续4次回执丢失耗尽后，install-r升code23；首次收养旧意图不发请求，原生再次提交用原operation/key/body取得同一Bug/occurrence/event，Room仅1回执；原稿与后改稿、日常14/PID5051保留。 仅模拟器旧文本CREATE_BUG；图片未知回执/坏回执/评论/其它写动作及物理Android未测。冷归档使用预览force-stop，不等于正常退出；3个可选更新未认证拒绝和原harness失败保留。
- android-code23-feed-http13：[原始证据](android-code23-feed-publication/29a9b98b-2fa8-4625-a465-5d75a91b70e8/publish.json)。已选择preview的匿名manifest/APK GET、HEAD及range均按原始13条ledger实测，原code22下载仍可用。 仅固定preview下载输入；客户端更新UI、所有错误组合及物理设备未测。
- exe-native-upgrade-7-to-8：[原始证据](exe-preview8-live/1786509a-9de7-4d1a-ba8c-9fb282c9c453/result.json)。EXE实际原生7→8检查/下载/安装并重启成功；同员工/项目、原正文与1图可见、旧Bug/评论及绑定PNG读回保留。冷副本67文件，仅应用状态，排除updates。 .8首开详情虚假失败仍保留为该版本未关闭缺陷；本轮不测提交未知回执/坏媒体恢复。
- exe-native-upgrade-8-to-9：[原始证据](exe-preview9-live/f222d18f-4176-401f-9bdc-af6da4917991/result.json)。EXE实际原生8→9检查/下载/安装并重启成功；同员工/项目、原正文与1图可见、旧Bug/评论及绑定PNG读回保留。冷副本67文件，仅应用状态，排除updates。 .9仅取样loading→loaded且未点retry；不证明连续所有帧或真实网络故障恢复。未提交单图SHA未由可见性推断，.8失败历史不改。
- server-mcp-membership-e21431f0-59：[原始证据](server-mcp-membership-live/e21431f0-e927-4a3f-8275-167accb1eaef/proof.json)。服务端4421实际35次JSON-RPC/59检查：新姓名首登与重复/跨项目ID稳定，单项目直接选A、目录只含有效所属项目；A停用后重新姓名登录及旧token读A均403，B登录/读回和会员字段不变，恢复A同原ID。 旧导入姓名/别名完整组合、原生客户端和本地EXE MCP独立验收；此运行不代表当前变更后的API源码已部署。
- 清单缺项：GET /api/v1/android-updates/preview/:fileName（apps/api/src/android-updates.ts）；仅保存原始观察，等待后续生成器盘点，不虚建当前条目或计通过。
- 清单缺项：HEAD /api/v1/android-updates/preview/:fileName（apps/api/src/android-updates.ts）；仅保存原始观察，等待后续生成器盘点，不虚建当前条目或计通过。

严格旧合同冻结失败保留为历史，后续六条响应边界修复已有独立五步门禁成功日志与实际HTTP读回。Phase A旧1.0 passed/failed与原回执已完成独立完整main/schema15实测；PhaseB blocked在源码/临时HTTP/schema16档案恢复完成。常驻4419仍schema14，MCP blocked提交工具、fail/supersede POST和workflow GET仍待各自接线实测，静态合同通过不代表全部运行能力。EXE各版本升级/回退/原生操作按对应proof记录，不能传递为所有控件通过。NSIS6项仅guard，不证明干净用户完整首装。完整迁移和服务回退仍按各自缺口与实际证据判定，不能从客户端恢复或表指纹推定完成。

依次执行 `node scripts/project-components/generate-coverage-matrix.mjs`、`node scripts/project-components/map-coverage-evidence.mjs`、`node scripts/project-components/generate-coverage-matrix.mjs`。生成器保留 matching ID 的人工结果和 `manual.surfaceProgress`；源码变更仍保留 `needsRevalidation`，不会自动清除未复核标记。此映射器只对明确识别的证据行赋值；其它人工结果保留。

所有proof的SHA-256均按原始文件字节计算，见coverage-matrix.json的evidenceMapping.proofHashes。仅JSON解析或日志/正文文本断言使用UTF-8解码；JPG等二进制hash检查不解码。旧/修正公开proof与原生tree/截图均保留各自hash；缺少optional proof时不新增通过。所有凭据均不参与读取和输出。

当前细目计数：1030。设计明确的必要入口均满足而整行 passed 的基线：09 关闭所有组件的基础全流程、10 项目人员管理一致、11 HTTP API 独立使用、12 服务端 MCP 独立使用、15 附件三种读取、23 EXE 共存与升级、24 回退演练。其余基线不能称整体完成。
