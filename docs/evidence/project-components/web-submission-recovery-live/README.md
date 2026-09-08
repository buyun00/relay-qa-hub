# Web 真实提交回执丢失与重启恢复

第二轮完成 **101/101** 断言：真实 Web UI 创建含 PNG 的 Bug、评论分别在服务端返回 201 后丢失回执；修改草稿、正常关闭并重启同一个独立 Edge profile 后，通过原请求确认成功。原 Bug、occurrence、附件和评论均只有一份，后改的两份草稿及两个确认回执仍持久保留。

第一轮失败也完整保留。它已完成 Bug 恢复，随后因验收脚本误判被遮挡/折叠的 DOM 控件而超时，未发送评论 POST。两轮之间没有修改 App 源码，只修正脚本的控件可见性与点击命中检查。

这只为设计基线 14 的 **Web 部分能力** 增加真实证据，不能将整个基线或其他五个入口改为通过。原 [plan.md](plan.md) 保持 `not_run`，作为执行前准备历史；本 README 和 [audit.json](audit.json) 记录执行后的事实。独立审计没有启动浏览器、调用业务 API、操作服务或修改原始记录。

## 两轮原始记录

| 项目                      | 首轮                                                               | 第二轮                                                               |
| ------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Run ID                    | `4f6387f6-244b-4115-916b-6fffe3db1efd`                             | `bf3a4621-6c48-459e-b776-5c9011d7d327`                               |
| 结果                      | `failed`，超时前 38 项断言均通过                                   | `passed`，101/101                                                    |
| UTC 时窗                  | 2026-09-08 23:34:34.184–23:34:58.870                               | 2026-09-08 23:36:51.104–23:36:58.777                                 |
| 原始 proof                | [首轮 proof.json](4f6387f6-244b-4115-916b-6fffe3db1efd/proof.json) | [第二轮 proof.json](bf3a4621-6c48-459e-b776-5c9011d7d327/proof.json) |
| proof SHA-256             | `e895f1114d9b86ac2272783e101a360617c1e28fc16537104a116a880446eef7` | `3bd91b313315c54c457307facaaff52d900848dfc6da4fc8c096c8e70d1c4c84`   |
| runner SHA-256            | `dec415ebabbb59f272644945722dfad97d183c05297521a0cc2907747854fa1d` | `c68945dc9c2fcaaa1d338c3707266a205f5a4943f521485490a5738be1b4ded8`   |
| 自有浏览器启动 / 正常关闭 | 2 / 2                                                              | 4 / 4                                                                |
| 同 profile 重启           | 1                                                                  | 3                                                                    |
| 实际 201 丢回执           | Bug 一次                                                           | Bug、评论各一次                                                      |

首轮旧脚本保存在 [runner.mjs](4f6387f6-244b-4115-916b-6fffe3db1efd/runner.mjs)。第二轮脚本为仓库 `scripts/project-components/web-submission-recovery-live.mjs`，审计按上表 SHA 固定。两轮项目、员工、Bug、附件、日志、profile 和截图均保留，没有清理或软删除。

## 首轮失败的具体原因

失败信息为 `Timed out: post comment once`。首轮的 Bug POST 和确认 POST 都实际返回 201，请求正文/幂等键相同，第二次回执 `replayed: true`，原记录和附件字节读回均通过。

截图 `03-confirmed-create-new-draft-retained.png` 显示 Bug 详情已在前景打开，保留的新建表单处于后方。原始 DOM 记录仍列出后方表单的“取消”和折叠 `details` 内的评论输入框；旧脚本只根据 `getClientRects()` 判断可见，误将这些控件作为可操作目标，随后找不到有效“记录”按钮。原始请求 ledger 中评论 POST 为 **0**，因此这不是评论业务提交失败。

第二轮只作三处 harness 修正：使用 `checkVisibility` 并排除关闭的 `details` 子控件；点击前用 `elementFromPoint` 验证命中目标；直接操作前景 Bug 详情，不点击其后方新建表单的取消按钮。**保留的 create modal 仍位于详情后方**，不是被测试脚本关闭或清稿。两轮四个 Web 源文件 SHA 完全一致，且与发布证据一致。

## 第二轮真实结果与独立复核

实际运行使用新项目 `ea83c107-7687-4b38-8d80-096f0868001a`、新员工 `968df48a-2b12-45fa-8bc5-4346ef9a57b9`。先通过真实姓名登录 UI，确认五组件全部关闭，再执行新建表单和评论表单。

- Bug：`f64b024c-71b5-4f50-b767-957b0b9e2eab`；submission：`e3a683e0-7813-44c5-91d0-cc80496408ef`。两次 POST 的解析后 JSON 正文及白名单 headers 完全相同，幂等键均为 `submission:e3a683e0-7813-44c5-91d0-cc80496408ef:commit`。实际回执依次为 `replayed: false/true`，其余字段完全一致。
- Comment：`4f0fbf5c-3d4f-41c6-8ebd-489209c50757`；submission：`549b6189-ec76-408a-b299-2edf6049c3da`。两次 POST 的正文和白名单 headers 完全相同，实际回执完全一致。评论合同没有 `replayed` 字段，不虚构此字段作为凭据。
- 最终原 Bug 仍为 version `1`，occurrenceCount `1`；一条 `occurrence.appended` 与一条 `comment.created` 事件，actor 均为本次新员工；评论总数 `1`。创建恢复前后、评论恢复前后、最终重启的业务快照一致。
- 附件：`7b01c8c7-5963-4522-a79d-e9db82677472`。真实 68-byte PNG 的 SHA-256 为 `5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15`。审计重新读取保留文件，并逐次解码实际 HTTP 下载的 base64 字节，确认完全一致。
- 原 Bug 和评论的未知提交都先在项目限定 IndexedDB 中持久保存；编辑后的文字和 PNG 保留，再正常关闭浏览器。重启后点击“确认上次提交”/“确认上次记录”，最终再次重启仍读到两个原 receipt acknowledgement，以及两份未提交的新稿。审计复查两个 journal 的 project/actor/responseId 和表单 acknowledgment ID，未将新稿当作已提交业务。

每次首次提交都由 CDP Fetch 在服务端 **实际 201 响应阶段** 暂停，先保存真实回执，再 `Fetch.failRequest/Failed`。保留的 [Bug 201](bf3a4621-6c48-459e-b776-5c9011d7d327/bug-observed-201.json) 和 [Comment 201](bf3a4621-6c48-459e-b776-5c9011d7d327/comment-observed-201.json) 与原始 fault/response 记录一致，回执原字节 SHA 也能从紧凑序列化 JSON 复算。脚本没有用 mock 成功响应替代服务端提交。

四次浏览器加载均为实际发布的 `assets/index-Ce9wROrH.js`，477454 bytes，SHA-256 `c6e0392ff28cbb86a27aec2dc1fe1cd4b47bb3eb9e22025c95e58a7187ab367d`，对应 Web 源提交 `7904e2c2d7285003884a5788a83300fbf521dbf1`。另有的源码单元回归证据（包括 99 项回归报告）不能替代本次真实 UI 证据；审计通过依据是原始运行记录、回执、字节与截图。

## 请求计数、进程和保存边界

| ledger 类别            | 首轮 | 第二轮 | 解释                            |
| ---------------------- | ---- | ------ | ------------------------------- |
| `readiness`            | 1    | 1      | 脚本直接健康读取                |
| `setup_gm_login`       | 1    | 1      | 独立 fixture 准备登录，脱敏概要 |
| `setup_project`        | 1    | 1      | 仅创建本轮新项目                |
| `page_request`         | 87   | 114    | CDP 观察到的页面 API 请求记录   |
| `read_only_api`        | 13   | 31     | 其中只读对照请求的结果镜像      |
| `page_upload_response` | 2    | 2      | 已有上传请求的响应镜像          |
| `page_commit_response` | 2    | 4      | 已有核心 POST 的响应镜像        |

ledger 总记录数分别为 107、154。**不能将这些记录数相加宣称为总 HTTP 请求数**：读回和响应镜像不是新请求，静态资源/CDP 调试请求也不在该 API 计数范围内。

第二轮自有 Browser PID 依次为 `1096`、`17920`、`14624`、`21748`。各次可执行路径、启动时间、CDP Browser PID 均匹配；各次都有对应 `Browser.close` 后进程消失的记录。只使用新 profile 和调试端口 9364，没有连接已有浏览器或 EXE。审计没有重新启动这些进程；其结论绑定运行时保留的进程记录。

私有目录为：

- `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\web-submission-recovery-4f6387f6-244b-4115-916b-6fffe3db1efd`
- `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\web-submission-recovery-bf3a4621-6c48-459e-b776-5c9011d7d327`

审计重新计算全部 **3 + 6** 张截图的大小与 SHA，并人工查看首轮截图 03、第二轮截图 05/06；均与 raw 一致。两轮 ledger 均无组件执行路由。五组件配置 GET 只是开关核验，不能当作外部组件验收。

公共 JSON 进行了嵌套对象/数组 JSON 文本递归检查，协议 primitive 字符串原样保留；私密配置的确切 secret 值、非脱敏敏感字段和 JWT 形态命中均为 0。比较时凭据只在内存，未输出数值，也没有从保留 profile 提取 cookie/token。该检查范围详见 audit，不宣称检测所有未知形式的秘密。

## 覆盖范围

设计基线 14 原文是“旧版本被拒绝，同一幂等请求不重复执行”。本次覆盖 Web 创建 Bug 与评论在 **提交成功但回执丢失** 后的原键确认、单次业务效果和改稿保留，状态为 **partial**。

本次没有测试旧版本拒绝、多个窗口并发、跨项目迟到响应、所有状态/编辑/删除动作、上传中间阶段丢包、进程强停/断电。没有操作或验收 APK、EXE、独立 HTTP 入口、服务端 MCP、本地 MCP、物理设备或外部组件任务；其他五个入口不能继承这里的通过结果。两份后改稿故意保持未提交，不声称已生成第二条 Bug/评论。
