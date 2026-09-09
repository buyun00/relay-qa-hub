# EXE preview.8：独立只读升级前后对照

升级前 [before-r2/proof.json](before-r2/proof.json) 通过 **51/51** 检查，升级后 [after/proof.json](after/proof.json) 通过 **59/59** 检查，两次各 **11次真实只读请求**。前次为 preview.7／主 PID23924，root 完成原生升级后，后次为 preview.8／主 PID19500。两次使用完全相同的冻结采集脚本。

本次访问的是本机 **4420 local MCP**，复用 EXE 的现有会话。请求依次为生产4319与预览4419 readiness、MCP initialize、initialized notification、tools/list、qa_get_session、qa_list_projects、qa_get_bug_context、resources/templates/list、广告模板的 resources/read，以及结束时 qa_get_session。没有 qa_login、凭据文件读取、业务写入、客户端操作或服务启停。读取 auth/me 返回的 CSRF 字段只保留在私有原始证据中，公开对象和嵌套 JSON 字符串均脱敏。

实际 local MCP 分别返回 `0.2.0-preview.7`／`0.2.0-preview.8`，均为相同90工具，4420分别属于上述实际主 PID。原员工 `5ef57049-0e33-4476-8a3c-b320aa26bf68`／项目A `fb914b3b-4169-47f8-8dec-76f3a3cc780d` 在两次采集及各次读取前后相同。原 Bug `a32d175b-137c-47bd-bbd9-b952d4860b1e` 的完整 DTO 与既有 `.7` 记录一致（closed／version14／occurrenceCount1），原评论仍1条，前后完整评论 DTO 一致。广告资源模板读回原绑定 PNG `bbeaafee-effa-4265-873e-881111e40ae8`，两次均184872 bytes，SHA256 `e0ed7b4b96935f06855a05ce3372ada01b9585ed459d3d5c183f1c6dc8e7cb8b`。这是已绑定图片，不能代替原生未提交草稿 PNG 的验收。

同次采集只计算 `production-after-verdict.json` 指定六个生产文件的 SHA，均与原基线相同；没有输出文件正文。生产3个 PID／启动时间和预览 API、Web、server MCP 的 PID／启动时间一致。两个生产 Node 的 executable 路径仍不可见，不推断其路径匹配。生产4319返回 schema12 ready、预览4419返回 schema14 ready。读前后生产文件哈希、preview主 PID／启动时间保持。

原始响应、资源 bytes、主机快照和执行源码保留在该次 runtime 的 `independent-before-r2` 与 `independent-after`。公开 [执行源码副本](readback-source.mjs.txt) SHA256 为 `6daece2f4c0d4c7561029b1e55b562610a493cd7a9e31438fe09b21603b65808`；源码默认 inert，只有显式 `--collect before-r2 23924` 或 `--collect after <root确认的新PID>` 才执行固定只读请求。实际后次使用 `--collect after 19500`，比对升级后的身份、Bug、评论、图片、工具目录及生产文件，写全新目录，未覆盖前次。

[首份失败记录](before/proof.json) 原样保留：6个生产文件 SHA 校验通过后，Get-Process 的部分服务 StartTime 为 null，主机快照 harness 调用 ToUniversalTime 失败，**尚未执行任何 MCP/API 请求**。后续改为按精确 PID 读取 Win32_Process.CreationDate，写入全新 before-r2；未修改服务、凭据、身份或基线。

三份公开 proof、执行源码副本和本说明的已知私有 secret 字面值、JWT和私钥标记扫描命中均为0。此次只读采集没有直接观察原生升级手势、正常退出、未提交草稿、安装器行为或提交回执恢复；这些不能由目录／健康／资源读取成功替代，仍由 root 的独立原生执行证据承担。
