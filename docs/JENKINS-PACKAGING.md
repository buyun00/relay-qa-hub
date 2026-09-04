# OZDQP 打包与下载

Web 和 Windows 1.2.4 共用“打包与下载”分页。打包区仅有三个按钮，无账号、版本号、服务器或高级参数设置。

固定任务：`http://10.100.5.129:8080/job/01-【OZDQP】【Android】/`。
API 进程使用用户指定的内网固定账户自动认证；前端、二维码和下载服务器均不接收 Jenkins 凭据。

| 按钮 | networkScope | internalUseSdk | buildMode |
| --- | --- | --- | --- |
| 打不带 SDK 的内网包 | 内网_自动判断 | 不接入SDK | Auto_自动判断 |
| 打带 SDK 的内网包 | 内网_自动判断 | 接入SDK | Auto_自动判断 |
| 打外网包 | 外网_保留原参数 | 不接入SDK | App_资源和包体 |

外网行中的 `internalUseSdk` 是页面保持不变的内网参数；外网 SDK 来自现有 `BuildParam` 默认值。`buildMode` 的外网切换与 Jenkins 页面 ParameterUX 的联动一致。其他参数不随请求发送，由 Jenkins 使用当前默认值，包括空版本号及 JSON Editor 的 `BuildParam.startval`。2026-09-04 实际页面外网默认为法兰克福正式服、生成 APK 与 ZIP。

内网保持自动判断，可能只生成资源，因此成功构建不一定产生新 APK。下载列表单独读取实际文件，按文件更新时间排序，三类快捷入口通过 `_intra_nosdk.apk`、`_intra_sdk.apk`、`_extra_sdk.apk` 区分，不能把最近一次成功构建当作新 APK。

下载来源：

- APK：`http://10.100.5.129:8000/apk/?json=true`。
- IPA：`http://10.100.5.129:8000/ipa/?json=true`，提供对应目录和最新 IPA 链接。
- 增量 ZIP：`http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip`，通过 HEAD 读取大小和更新时间。
- 二维码在客户端生成，指向同一个真实下载文件。手机需要能访问内网。
- Windows 通过默认浏览器下载，限制为该固定服务器的 APK、IPA 与指定 ZIP，不经过有响应大小限制的桌面 API 代理。

API：登录后 GET `/api/v1/packaging`，POST `/api/v1/packaging/builds`（仅 `{preset}`，必须携带 `Idempotency-Key`）。沿用 QA Hub 会话与 CSRF 校验。只在收到 Jenkins 201 和合法队列编号后显示已提交。401/403 刷新 crumb 与会话后重试一次；超时或不明确响应不重发打包请求。相同请求键在 API 进程内保留 24 小时，包括结果不明确的请求；服务重启后该内存记录不保留，因此客户端不会自动重试结果不明确的提交。

页面每 10 秒更新，隐藏后停止轮询。Jenkins 故障不影响已有文件下载；提交状态局限于打包区，切换工作台不被锁定。

验证：API 模拟 Jenkins 检查三个参数组合、crumb 失效恢复、重复请求与不明确结果；Web 检查三按钮、无设置项、下载链接和二维码；桌面检查外部下载 URL 白名单。浏览器预览中的打包 POST 被本地测试服务接收；未启动真实 Jenkins 构建。真实 Jenkins 与文件目录只做读取验证。

JSON Editor 默认参数行为参考该插件 [JsonEditorParameterDefinition 源码](https://github.com/jenkinsci/json-editor-parameter-plugin/blob/71962f37a416/src/main/java/io/jenkins/plugins/json_editor_parameter/JsonEditorParameterDefinition.java)。
