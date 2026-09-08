# Web/EXE 创建与评论持久提交：源码回归

2026-09-08 23:17 UTC 对已冻结的 6 个 Web 文件重跑本地门禁，并逐字节核对原冻结 SHA。Web **16 个测试文件、99/99 项通过**（原 61 项、新 38 项）；App/Node 两项 `tsc --noEmit`、相关 ESLint、Prettier check 均退出 0。运行输出、命令及观测时点见 [日志](runs/web-pending-submission-source.txt)，6 文件 SHA 和日志 SHA 见 [结构化证明](web-pending-submission-source.json)。

创建与评论在请求前保存业务 ID、完整核心 JSON；附件保存原 File、SHA、clientAttachmentId 和各上传阶段回执。未知结果重放原意图。确认回执先落盘，未被界面确认的成功记录仍可单独确认；后改或留空的草稿不覆盖，明确下一次提交才生成新意图。另一窗口推进上传后，重复分片返回相等的当前版本也可继续。

明确拒绝先保留证据，再由用户显式“保留失败记录并提交修改稿”。附件阶段只在核心提交次数为 0 且收到实际 400 `UPLOAD_CONTENT_INVALID`/`INVALID_REQUEST` 时可进入该路径。核心只允许首次、不并发的 400 `INVALID_REQUEST`；每次 POST 前持久记录次数，已有未知结果、并发请求、权限、幂等或归属异常均不据此释放槽。服务端解析与事务位置经过独立源码复核，不能泛化到任意 4xx。

本证明仅为源码和本地单元回归：fetch 为本地替身；IndexedDB 使用受控 commit/abort 边界，提交日志使用串行存储适配器。未启动真实业务服务，未 build Web/dist 或 EXE，未进行浏览器/安装版进程重启、真实 HTTP 故障注入或升级验收。这些结果不能据此勾选整项客户端或跨端验收通过。
