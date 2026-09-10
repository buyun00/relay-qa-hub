# OZDQP 独立上传工具 0.5.1

QA Hub 3.4.0 服务端使用的 Windows x64 自包含 EXE，基于 2026-09-08 交接包 0.2.0 源码修改。原始交接目录未修改，原始说明保留在 README.upstream-0.2.0.md。

一键打包任务可传入 `expectedSource`（大小和 Last-Modified）。下载时发送 If-Unmodified-Since，核对响应并在完成后再次 HEAD 检查，确认本次 ZIP 没被替换才开始平台写操作。完整下载仍属于原任务，恢复不会改取最新包；没有该字段的旧任务保持原身份摘要。

QA Hub 新任务明确设置 `uploadConcurrency=8`，八个 5 MiB 分片并行上传；CLI 支持 1–8，省略参数时保留旧默认 4。每片成功即保存断点，STS 续期和状态写入分别串行保护。失败/取消会等待在途请求结束，恢复只补传缺失分片。并发数不改变任务身份、uploadId 或分片布局。

本程序只部署到服务端，不再随 Windows 客户端分发。服务器按用户设置 OZDQP_AUTH_FILE，所有用户共用 OZDQP_LOCK_ROOT。SHA-256：`6734b552caf70743af644fbac4e59f4e0209d196723481ef4a19b68f2001c649`。

0.5.1 让分片合并、恢复查询和上传分片均在发请求前取得有效凭证，修复长时间上传结束后合并复用过期签名器的问题。并发失败只触发一次有效刷新。合并响应不确定时报告 `REMOTE_RESULT_UNKNOWN` 并保留原分片，恢复先核对远端。诊断仅记录凭证时间，不记录密钥或签名 URL。

页面新建任务仅提供两种执行方式：

- `publish_workflow`：完成上传、提测、测试状态登记和资源准备，确认正式发布并核验状态 100。
- `prepare_publish`：完成相同前序步骤，到状态 60 停下，等待最终确认；普通 `resume` 仍会等待。

```powershell
.\ozdqp-uploader.exe run --config .\job.json
.\ozdqp-uploader.exe resume --config .\job.json
.\ozdqp-uploader.exe confirm-publish --config .\job.json
```

只有等待最终确认的任务才能使用 `confirm-publish`。操作会保存明确确认时间，再检查远端版本身份、状态和正式目录；重复/不明确的写操作沿用原来的断点核对规则。

QA Hub 按最近完整操作 JSON 默认填入产品 2002、渠道 1002、测试人 11562。`useVersionText: true` 让概述和说明只使用实际版本号，自动生成版本号也适用。`recordedTestWorkflow: true` 表示用户选择沿用录制中的测试状态流程，日志记录来源，不生成虚构测试报告，也不执行游戏测试。

0.2.0 的旧任务仍可恢复，保持原模式和实际测试结论要求。新增选项加入任务身份摘要，旧任务的摘要算法保持不变。ZIP 固定地址、登录缓存格式、文件校验、任务/渠道锁、COS 分片和失败核对行为保持原有协议。

源码：`apps/desktop/uploader`，使用 .NET 10 SDK；完整集成说明见仓库 `docs/SERVER-INCREMENT-UPLOAD.md`。52 项本地自检通过，包含凭证刷新回归、SDK 本机传输、断点与身份校验；这些检查不是新版本在实际 COS 上的验收证明。
