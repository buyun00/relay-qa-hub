# OZDQP 独立上传工具 0.2.0

Windows x64 独立命令行 EXE；页面以后做。覆盖创建版本、下载 ZIP、查重/COS 上传、绑定、等待解压、提测、测试状态操作、复制及发布至状态 100。

## 这版怎么登录

首次双击 **登录.cmd**，输入网站登录邮箱和密码。子账号用户双击 **子账号登录.cmd**。也可以在 PowerShell 执行：

```powershell
.\ozdqp-uploader.exe login
# 网页使用“子账号登录”时：
.\ozdqp-uploader.exe login --kind subaccount
```

按用户的内网使用要求，账号、密码、访问令牌、刷新令牌以普通 JSON 直接保存到：

`%LOCALAPPDATA%\OZDQP-Uploader\auth\fq2ivi.ipwana.com-443.json`

不使用 DPAPI 或凭据管理器。控制台密码输入不回显。后续运行自动加载保存的登录状态；令牌过期先尝试续期，续期失败再用保存的账号密码登录一次。密码错误或出现额外网页登录要求时停止，重新 login 即可更新。logout 只清除本工具的本地配置，不操作网页里的登录状态。

```powershell
.\ozdqp-uploader.exe auth-check
.\ozdqp-uploader.exe logout
```

程序按网站当前前端合同处理密码：UTF-8 MD5 转大写，调用 `/api/v1/gwapi/login/unified`；子账号调用 `/api/v1/gwapi/login/extension`。这是网站要求的提交格式，与本地直接保存密码是两件事。刷新接口为 `/api/v1/gwapi/user/token/refresh_token`。每次登录后先读文件服务验证访问能力，不创建版本。

高级宿主仍可通过 `OZDQP_AUTHORIZATION` 提供完整请求头值；提供时优先于本地账号配置，程序不替该外部令牌自动续期。正常使用不需要手动复制 Authorization。

## ZIP 地址固定

程序固定从以下地址下载，不需要填写 filePath 或下载地址：

`http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip?download=true`

先独立验证下载可双击 **仅下载.cmd**，或：

```powershell
.\ozdqp-uploader.exe download --work .\download-check
```

文件保存到指定目录的 `input/_pkg_cfg_2001_1002.zip`。新任务下载一次；恢复已有任务使用原下载文件，重算 SHA-256 核对内容，不会因为服务器更新了 ZIP 就给旧任务换包。下载中断只保留 `.partial`；恢复时从头重下，避免跨构建拼接。完成文件丢失且已经有上传断点时停止，不自动下载新文件替换。

重复对同一目录执行 download 会复用已完成文件。要取服务器最新包，请使用新的目录。下载过程使用独立 HTTP 客户端，不携带平台 Authorization 或 Cookie。校验长度、ZIP 中央目录、条目路径和整个文件散列，不完整解压或逐条校验 CRC。

## 开始任务

复制 sample-job.json 为 job.json，填写本次产品、渠道、概述和说明，每个新任务使用不同 workDirectory。version=null 时查询平台下一个版本。示例 2002/1002 是录制中的真实产品/渠道，不从 ZIP 文件名推导产品。

```powershell
.\ozdqp-uploader.exe run --config .\job.json
.\ozdqp-uploader.exe resume --config .\job.json
.\ozdqp-uploader.exe status --work .\jobs\first-upload
```

默认 publish_workflow 覆盖完整流程。testerId 填平台真实测试人 ID，testResultReference 填本次实际测试结论的引用；工具只操作“测试通过”状态，不执行游戏测试。未填写会上传并提测后停留，补齐后 resume。开始测试状态操作后不能替换这两项。

0.2.0 的输入改为固定地址下载，**不能直接接续 0.1.0 的本地文件任务目录**。已有旧任务仍使用旧 EXE 恢复；本版为新任务使用新目录。不要重放历史版本 828/829。

任务目录保存 state.json、events.jsonl、result.json。账号密码保存在独立登录配置，不写入任务日志或回执。Ctrl+C 保留断点；同步 COS 分片可能等待当前请求完成或超时后才退出。远端写操作结果不明时先查证，不能证明已完成则停止重发；创建响应丢失时不自动认领同名版本。

## 验证与当前边界

- 23 项本地测试通过：完整流程、恢复、去重、固定下载、部分下载拒绝、网页内容拒绝、登录请求格式、子账号令牌解析、令牌刷新、明文配置保存、自动重新登录和有限重试。
- 已从固定内网地址真实下载 749,972,031 字节 ZIP；1605 条目，MD5 与录制一致。
- 尚未使用真实账号验证登录成功、跨域令牌权限和续期；真实 COS 上传及发布仍未联调。本地测试没有向平台发送登录尝试，也没有创建或发布版本。
- 测试解压终态仍需平台确认；当前兼容录制中的双日志为空且目标目录匹配。COS STS 字段、ListParts/HEAD 权限和实际云端断点仍待联调。

EXE 自包含运行时，无需用户另装 .NET/Node。完整证据见 validation，后续架构见 design；其中 serve --stdio 双向协议尚未实现，实际接口以本 README 为准。

## 本地自检与源码

```powershell
.\ozdqp-uploader.exe self-test
.\ozdqp-uploader.exe preflight --file .\download-check\input\_pkg_cfg_2001_1002.zip
```

self-test 只使用本地 loopback/模拟传输及临时文件。源码在 source，使用 .NET 10 SDK：

```powershell
cd source
dotnet publish -c Release -r win-x64 --self-contained true -o .\dist
```

第三方依赖为腾讯 COS SDK 5.4.51，许可在 licenses。0.2.0 没有添加加密存储依赖。退出码：0 成功，3 需登录，4 冲突，6 其他失败/待补测试结论，7 取消或超时；具体看 JSON 错误 code。
