# Windows 2.0.0 Relay 修复轮次发布

- 发布日期：2026-09-05（Asia/Shanghai）
- Web / Desktop 版本：`2.0.0`
- Release ID：`20260905T120703541Z`
- 产品源码与已运行 API：`1868537e7edb79d76386b85e532b96b5dd7c3928`

## 问题与修复

LOCAL-257 在第 1 次人工修复验收失败后回到 ready。Relay 创建入口将修复轮次固定写为 1，违反数据库要求的历史最大轮次加一规则，报出 `RepairAttempt must begin as one neutral planned version-one fact with its exact typed audit Event`。

Relay 创建入口现于既有写事务中，按 account/project/bug 范围计算下一轮次。新修复自身仍为 planned、version 1，并携带原有精确审计事件；数据库约束、人工修复和历史验收记录保持原样。

## 验证

- 回归测试先在原代码上复现同一数据库错误，修复后通过。覆盖首次 Relay 轮次 1、人工验收失败后的 Relay 轮次 2、旧修复事实完整保留、Bug 活动指针和新审计事件。
- SQLite invariants 67/67、production batches 5/5、Desktop 45/45、Web 39/39 通过；相关 TypeScript、ESLint、Prettier、diff 检查及构建通过。
- 发布前验证了异盘数据库与附件恢复点：`2026-09-05T12:02:16.880Z`，641 项附件，拒绝的恢复点数 0。
- 正式 ASAR 内版本、release ID 和源码提交匹配；包内 5 个 Web 构建文件逐字节匹配。
- 隔离正式 EXE 登录、四个主导航、Bug 详情/编辑表单、总览、制作任务页、18 个 MCP 工具和登录态复用验收通过。最初选择的旧安装包验收账号已停用，因此保持其停用状态，改用经规范 ID 核实的现有账号进行只读界面验收。
- 隔离旧 release ID 客户端通过线上签名清单完成下载、安装和重启到本版本；改名安装目录、用户 profile、运行配置和回滚目录验证通过。此测试未遍历全部历史版本。
- 日常 EXE 主进程 9584 在最终检查时仍存活，未强制更新其安装目录。

## LOCAL-257 恢复

通过正式登录和 production batch retry API，以原批次的规范 actor ID 核对身份后重试失败项，沿用原幂等步骤。同批已成功的 LOCAL-289 保留原修复和 handoff。

- 第 2 次修复：`91d320c9-f96f-4439-8300-9ce4e9bd1cf8`
- Relay 任务：`task-d0332c0f-1fd4-47c0-95a2-b23a42bafdc0`
- 另一个失败批次再次核对后返回 existing，复用同一 Relay 任务。
- 20:13:51 最终读取：Bug in_progress/v7，Relay receipt running，无 failure_summary；旧人工修复仍为 verification_failed/v4。制作开始不代表 Bug 修复或验收完成。

## 线上产物与回滚

更新清单：`http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json`

| 产物 | 字节数 | 实际下载 SHA-256 |
| --- | ---: | --- |
| `Relay-QA-Hub-Setup-x64.exe` | 150385154 | `1845558751ae80ac71a0801fc40475ef023dfe6db390d91739e3f801880823f9` |
| `Relay-QA-Hub-Windows-x64.zip` | 155363623 | `1f0fd31304ca0dea0f5d208795590152f065036d30c2399d30516231c0060891` |

线上与本地更新清单一致，Ed25519 清单签名及实际下载的大小、哈希核验通过。API ready/schema 10，database/evidence/worker 均为 ok。

旧版 1.3.3 的安装器、ZIP、清单、Web 与后端构建已复制并逐文件核对 SHA-256，保存在：

`D:\Relay-QA-Hub\apps\desktop\release\builds\prepublish-20260905T114303437Z-20260905T120552619Z`

详细证据：`D:\Relay-QA-Hub\work\windows-2.0.0-release\` 下的 rollback.json、publish-build.log、online-verification.json、package-source.json、portable-smoke.json、self-update.log、retry-257.json 和 final-runtime.json。
