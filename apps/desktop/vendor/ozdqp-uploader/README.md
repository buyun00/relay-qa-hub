# OZDQP 独立上传工具 0.3.1

QA Hub 3.1.2 使用的 Windows x64 自包含 EXE，基于 2026-09-08 交接包 0.2.0 源码修改。原始交接目录未修改，原始说明保留在 README.upstream-0.2.0.md。

默认 `uploadConcurrency=4`，四个 5 MB 分片并行上传；CLI 支持 1–8。每片成功即保存断点，STS 续期和状态写入分别串行保护。失败/取消会等待在途请求结束，恢复只补传缺失分片。并发数不改变任务身份、uploadId 或分片布局。30 项本地自检通过，包括真实腾讯 SDK 的本机并发传输测试；实际 COS 网络速度仍需下一次上传验证。

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

源码：`apps/desktop/uploader`，使用 .NET 10 SDK；完整集成说明见仓库 `docs/INCREMENT-UPLOAD.md`。30 项本地自检通过，真实业务平台上传发布仍需用指定新版本验收。
