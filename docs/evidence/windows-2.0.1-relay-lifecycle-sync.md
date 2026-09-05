# Windows 2.0.1 Relay lifecycle synchronization

- 发布日期：2026-09-05（Asia/Shanghai）
- Web / Desktop：2.0.1
- Release ID：`20260905T141956599Z`
- QA Hub 产品 / 在线 API：`55b5ac9669e03f2ff74d1e8bd5534a1c8367d497`
- Relay 服务端：`e9908c1`
- 决策：[ADR-0010](../adr/ADR-0010-relay-delivery-and-verification-sync.md)

## 交付行为

Relay 已验证推送的交付回执推进当前 RepairAttempt 和 QA Bug 到待验收。人工打回
可输入多行理由，保存失败验收历史后，由持久化队列创建新轮次，沿用原 Relay
任务、分支与对话。人工通过先关闭 QA Bug，再异步关闭对应 Relay 任务；不会自动
合并代码或代替其他系统的验收。网络暂时失败可重试，旧轮次回执不能覆盖新轮次。

## 验证结果

- SQLite invariants 与 migrations：82/82；API、production batches 和 Relay HTTP transport：26/26。
- Web：39/39；Desktop：45/45；Relay M2M / outbox / workbench：9/9。
- 类型检查、相关 ESLint 和 Git diff 检查通过；Relay ESLint 无错误，保留 3 项既有未使用声明警告。
- 回归覆盖：无效交付拒绝、重复回执、非开发人员的合法人工打回、独立新轮次、
  原任务/分支/对话复用、旧回执隔离、丢失创建响应后队列排空、重启后幂等、
  多次重试后的网络恢复、人工通过与 Relay 关闭、过期轮次拒绝关闭。
- 在一致性生产副本上应用 schema 11：只补同步 2 个活动交付，重复处理为 0，
  integrity_check / foreign_key_check 通过。
- 生产 API 重启后为 ready / schema 11，database、evidence、worker 均为 ok。
  Relay 重启后 ready，Hyper-V 和 Codex 检查正常，重启时没有活动制作任务或 Worker。

## 生产单据

| Bug | 当前修复 | 修复状态 | Bug 状态 / 版本 | Relay 任务 |
| --- | --- | --- | --- | --- |
| LOCAL-257 | 第 2 轮，91d320c9-f96f-4439-8300-9ce4e9bd1cf8 | delivered / v3 | ready_for_verification / v8 | #207，task-d0332c0f-1fd4-47c0-95a2-b23a42bafdc0 |
| LOCAL-289 | 第 1 轮，60ffc903-b5f8-4819-b82e-977d0da927fe | delivered / v3 | ready_for_verification / v5 | #206，task-7a6bb967-1095-43bd-ab97-7724b4c432bc |

交付提交分别为 `1094061e2eb01c1aefe44cd23d5336bfdabd5f9a` 和
`9fd89a22e88735426d80e9090aa88e4e4fe39974`，取自既有认证回执，没有新增制作或伪造人工结果。

## 正式包与升级

- 实际 ASAR 的版本、release ID、源码提交相符；包内 8 个 Web 构建资源逐字节匹配。
- 隔离正式 EXE 登录、18 个 MCP 工具、工作台、总览、制作任务页、新建/编辑表单通过。
- 从制作任务 #207 / #206 打开关联 Bug，均显示待验收；多行打回理由上限 5000 字符，
  “打回并让 Relay 继续制作”和“直接关闭”入口可用。该生产界面验证只读取，未提交验收。
- 隔离旧 release ID 客户端通过线上签名清单下载安装并重启到本版；用户 profile、
  运行配置、改名安装目录与回滚目录均保留。该测试不代表遍历全部历史版本。
- 日常客户端主进程 PID 9584 保持运行，未强制安装或关闭。

| 实际下载产物 | 字节数 | SHA-256 |
| --- | --- | --- |
| Relay-QA-Hub-Setup-x64.exe | 150386715 | 29ebcc2ad21eec7317fffb5b106e03facb6c1dfcdc5f16f5e5da94d31c08b80b |
| Relay-QA-Hub-Windows-x64.zip | 155364561 | 79e0a5e0c2ef82935fcf252827bd56c9d0206057c9a781d2fef6f738dba1a354 |

线上清单：`http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json`。
Ed25519 清单签名、实际下载大小与哈希均通过。NSIS 保留既有 LegalCopyright 警告，
不将清单签名混称为 EXE 的 Authenticode 签名。

## 恢复与证据

- 异盘数据库和 641 项附件恢复点：2026-09-05T14:08:01.551Z，拒绝恢复点数 0。
- 原 2.0.0 安装器、ZIP、清单、Web/桌面构建和产品源码归档已复制并逐文件核对：
  `apps/desktop/release/builds/prepublish-20260905T120703541Z-20260905T141802345Z`。
- Relay 数据库发布前的一致性副本保留在 Relay `scratch/releases/qa-lifecycle-2.0.1/`。
- Schema 11 使用正式前向迁移；恢复旧数据库会影响之后的新写入，需要先制定数据
  对账方案，不能把安装包回滚视为数据库降级。此次发布没有清理历史或恢复证据。
- 详细日志、线上哈希、生产前后记录、截图与升级证明在
  `D:\Relay-QA-Hub\work\windows-2.0.1-release\`。
