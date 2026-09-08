# QA Hub 项目上传执行器 0.5.0

Windows x64 自包含 EXE，当前工作树源码位于 `apps/desktop/uploader`，以独立 .NET SDK 10.0.400 / Runtime 10.0.11 构建。此产物尚未向生产发布。

SHA-256：`0d5e930bd6421550ac18d816a4f08ca444c3a8f078df26e2c051e960649fc907`。

每项任务必须配置 `projectId`、`componentVersion`、`apiBase`、`loginBase`、`downloadUrl`、`sourceRoot`、`targetPrefix`、`testDirectoryPrefix`、`releaseDirectoryPrefix`，并明确产品、渠道和测试人。没有生产地址、固定产品或渠道默认值。来源只允许配置目录内的直接 ZIP 子项，拒绝跨来源、路径逃逸和重定向。

服务端通过独立实例下的 `OZDQP_AUTH_FILE` 和 `OZDQP_LOCK_ROOT` 指定凭据与锁文件，进程环境中的 `QA_HUB_PROJECT_ID` / `QA_HUB_COMPONENT_VERSION` 必须与任务配置一致。配置摘要绑定项目和版本；未绑定项目的旧任务不可直接恢复。凭据文件与 API / 登录服务来源不符会在网络请求前拒绝。

```powershell
.\ozdqp-uploader.exe run --config .\job.json
.\ozdqp-uploader.exe resume --config .\job.json
.\ozdqp-uploader.exe confirm-publish --config .\job.json
```

`prepare_publish` 在最终确认前停止；只有显式 `confirm-publish` 才推进最终发布。`publish_workflow` 包含最终发布核对，状态 99 不算成功。`recordedTestWorkflow` 只沿用明确选择的状态登记流程，不代表完成游戏测试。

`expectedSource` 绑定构建产物大小和 Last-Modified，下载时使用条件请求并再次核对来源。完整下载留在原任务目录，恢复不更换来源。分片默认并发 4（支持 1–8）；成功分片持久保存，失败或取消等待在途请求结束，恢复只补传缺失片。

本机自检 40/40 通过，包括真实腾讯 SDK 对本机回环服务的字节、并发和恢复验证，以及项目/来源/凭据约束。这些合同测试没有调用真实外部平台；真实 Jenkins、COS 与业务发布链路尚未验证。原始交接说明保留在 `README.upstream-0.2.0.md`，其中旧默认地址和无参数命令不适用于 0.5.0。
