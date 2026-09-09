# code22 → code23：原请求确认的独立审计

本次只读审计通过：停止后的代理文件 **55/55** 检查、独立官方 API **19/19** 检查、root 原生操作／冷归档摘要关联 **11/11** 检查，以及最终总证据交叉复核 **88/88** 检查。没有改动 Android 或代理源码，没有设备操作、服务变更或业务 POST。官方读回仅使用1次 GM 登录及6次 scoped GET；凭据和登录原始回执均未落盘或输出。

## 代理与官方 API 的独立结果

[代理审计 proof](proof.json) 固定运行源码 SHA `a164c85357260430d8ad8d8566ca7d9f98249669823dbbe8ecf3ea621430d7af`，读取原请求、状态、事件、确认标记和五份实际 API 创建回执。九个输入文件在读取前后的 SHA 一致。结果为同一 key/body 的 **4次真实201丢回执 + 第5次转发合法回执**，bootstrap3，代理不自行重试；第3次原生重启没有增加创建 POST，正常停止记录存在。

三条拒绝全部精确匹配 GET `/api/v1/android-updates/preview/latest.json` 的 `AUTH_FINGERPRINT_REFUSED`，目标 SHA 为 `3ad87b1ad8b878338b28824a3aa4ef321b346681ad3ac6b2ff72b7e8036f2740`。源码 `ApkDistributionClient.kt:79` 构造该地址，83–87仅添加 Accept/Cache-Control；`FoundationViewModel.kt:553` 初始化触发检查。它们是未转发的可选预览更新检查。审计没有忽略其他拒绝或放宽代理规则。

[独立官方 API proof](../../android-code23-create-readback/f0d296c0-da06-4423-83bc-a5a6d0d5e59c/proof.json) 直接访问预览 API4419，未经过故障代理。项目中仅有下列 Bug，状态 `reported`、version1、occurrenceCount1；只有1条 `occurrence.appended` 事件，附件0，五组件仍全部关闭，无后续分页。

| 字段         | 官方值                                 |
| ------------ | -------------------------------------- |
| Project      | `b9a42a41-c15d-4393-8568-61d22a30ba98` |
| Native actor | `9229e801-0ad6-4616-85b4-d40d66b50822` |
| Bug          | `1c838790-d125-4109-9b3c-5f4588f39146` |
| Occurrence   | `83c3ad73-e355-4876-ac35-aea1a8b13515` |
| Event        | `f9a6e3c9-9257-4be7-9624-aca435c8ba79` |

正文精确为 `LEGACY_CODE22_UNCERTAIN_65ee5dc8`。修改稿 `UNSUBMITTED_CODE22_TO_23_EDIT_65ee5dc8` 未出现在六项服务端读回中。五份代理 API 回执与官方事件的 canonical IDs 相同，最终回执标记 replayed。六份官方 GET 原始响应留在本次私有 `independent-create-readback-f0d296c0-da06-4423-83bc-a5a6d0d5e59c` 子目录；公开 proof 记录原始 SHA 和递归脱敏后的响应，保留 primitive 字符串原文。

## 与 root 原生证据的绑定

[root-bindings.json](root-bindings.json) 记录 root 提供的三份私有 JSON 和重启后 XML/PNG 的文件 SHA，没有复制原始私有内容。比较结果显示：

- `legacy-adoption-readback.json` 的完整 project/actor scope、submissionId 和原 payload SHA 与代理一致；首次恢复仅关联旧记录，forwardedCreates仍为4。
- `code23-confirm-gesture.json` 记录显式原生 Submit，时间先于代理第5次真实响应且相距不足30秒。
- `confirmed-room-readback.json` 记录冷归档只读检查 integrity为ok、外键违规0；同一个 operation 成为 `SUCCEEDED`，新项目仅1行、1份 replayed receipt，canonical IDs 与独立 API/代理一致。原2行队列及原回执保持，pending preference移除、修改稿保留。
- 重启后 XML 包含修改稿文本。原生截图和 root 冷归档摘要的 SHA 已绑定；本审计没有重新打开数据库、运行设备或重复执行 root 的安装／冷归档流程。

安装前后12文件、旧草稿保全、实际升级与点击、原A身份恢复、日用 PID／配置和 reverse 映射恢复，由 [root 总证据](../../android-code23-recovery-live/65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/result.json) 独立记录。总证据 SHA 为 `5fe38d5fc111354e57763525b31c5705a04461627a3436e1bcb8580be586bc56`。[最终交叉复核](aggregate-review-final.json) 已核对47个引用文件的 SHA，包括11份私有摘要、公开截图及 XML、六份保留的 harness、独立 API／代理 proof、十份 Android 源码、实际 APK和冷归档。总证据嵌入的升级、关联、确认、冷归档和最终设备摘要与对应私有 JSON 一致。

复核确认旧 code22 原行的 key/body SHA 与代理一致；首次关联仍只有4次 POST；明确原生确认后，同一 operation 只有1份成功 replayed receipt；重启后仍为5次 POST。日用 code14/PID5051、日用设置与 API 配置 SHA、reverse 映射均与开始摘要一致。已独立目视两张公开 PNG，并核对 XML：新测试项目的修改稿在重启后仍可见，原A／AndroidCaptureQA 的旧文字和截图预览恢复。归档只计算哈希，没有重新解包、打开 SQLite、安装应用或查询设备；数据库和进程结论仍明确绑定 root 的原始执行记录。BuildConfig 与签名结论关联准备证据及签名日志，本审计没有重新构建或验签。

首份 [交叉复核失败记录](aggregate-review.json) 保留了 **85/86**：审计错误地要求官方 GET 的预期值包含 `clientSubmissionId`，但 GET 没有这个字段。最终复核仅将 API 比较限制为它实际提供的 Bug／occurrence／event ID，并另用实际创建回执及原请求核对 submission ID；全部输入文件字节保持一致。这是审计断言修正，没有改产品、root proof或业务数据。较早的 `root-bindings.json` 保留当时尚未读取总证据的历史标记。

以上结合了真实模拟器请求、独立服务读回和 root 原生证据。代理标记本身不能证明用户手势，回执本身也不能证明全库计数；这两个缺口分别由 root 原生记录和本次官方 scoped 列表补充。真实物理设备、图片上传故障、协议篡改、编辑／评论／组件／生命周期的重试语义不在本次检查范围，不能据此将整项客户端基线14记为全部完成。
