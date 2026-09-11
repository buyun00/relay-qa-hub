# OZDQP 独立上传工具 0.5.1

QA Hub 3.4.0 服务端使用的 Windows x64 自包含 EXE，基于 2026-09-08 交接包 0.2.0 源码修改。原始交接目录未修改，原始说明保留在 README.upstream-0.2.0.md。

SHA-256：`0d5e930bd6421550ac18d816a4f08ca444c3a8f078df26e2c051e960649fc907`。

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

`prepare_publish` 在最终确认前停止；只有显式 `confirm-publish` 才推进最终发布。`publish_workflow` 包含最终发布核对，状态 99 不算成功。`recordedTestWorkflow` 只沿用明确选择的状态登记流程，不代表完成游戏测试。

`expectedSource` 绑定构建产物大小和 Last-Modified，下载时使用条件请求并再次核对来源。完整下载留在原任务目录，恢复不更换来源。分片默认并发 4（支持 1–8）；成功分片持久保存，失败或取消等待在途请求结束，恢复只补传缺失片。

0.2.0 的旧任务仍可恢复，保持原模式和实际测试结论要求。新增选项加入任务身份摘要，旧任务的摘要算法保持不变。ZIP 固定地址、登录缓存格式、文件校验、任务/渠道锁、COS 分片和失败核对行为保持原有协议。

源码：`apps/desktop/uploader`，使用 .NET 10 SDK；完整集成说明见仓库 `docs/SERVER-INCREMENT-UPLOAD.md`。52 项本地自检通过，包含凭证刷新回归、SDK 本机传输、断点与身份校验；这些检查不是新版本在实际 COS 上的验收证明。
