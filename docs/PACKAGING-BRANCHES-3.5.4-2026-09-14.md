# 打包分支适配与 3.5.4 发布记录

日期：2026-09-14。实现提交：`d6b0c1060e1f719b6fef7ba5883f846299445130`。

## 交付行为

- 四组 Android / iOS、Debug / Release 控件各显示源码分支。分支选项读取 Jenkins 当前 Active Choices 结果；Debug 当前构建端只允许 `main`，Release 默认 `auto`（最新日期的 `release/YYYY-MM-DD`），可手动选择构建端允许的 `release/*` 分支。
- 只构建、构建并上传、MCP `qa_start_build` / `qa_build_and_upload` 均携带 `sourceBranch`。新增只读 MCP `qa_get_build_branches`。幂等重试不能更换原任务分支。
- 自动上传在新构建上核对归档的 `source-request.json` 与 `build-result.json`：请求 ID、分支、完整提交 SHA、平台和配置必须一致。旧构建清单仍可读取；原瑞雪渠道映射和构建版本号传递规则保留。
- 检测跟随四组当前分支；切换分支后旧结论失效。保留手动检测、切换分页停留 2 秒自动检测的行为，普通数据刷新不额外触发检测。

## 打包机同步修改

发现旧检测代码依赖快捷任务内嵌的脚本，当前构建已改用独立 `source-routing` 工具，旧提取方式失效；旧检测任务还固定检测 `main`。

已更新无数字前缀的 `【OZDQP】【兼容性检测】`，使用 `scripts/jenkins-compatibility-branches.groovy`（`QA_HUB_CHECK_ONLY_V3`）及 `scripts/jenkins-branch-checks.py`。调用打包机现有的分支解析与兼容性工具，固定每组提交 SHA，使用独立 Git 目录并行检测四组。检测不分配版本号或创建游戏构建、增量上传任务。

安装前备份检查任务配置与历史；安装后核对脚本、sandbox 设置及历史保持完整，快捷打包任务配置未改。旧 V2 文件保留作为历史参考。

## 验证结果

- API 相关测试 74 / 74；构建产物、上传链和桌面 MCP 合同测试 31 / 31；Web 测试 60 / 60（14 文件）。API、Web、Desktop 类型检查与编译通过，ESLint 和 `git diff --check` 通过。
- 网页测试使用实际分支目录及 Jenkins 检测。验证默认选择、手动选择、检测传参、刷新不重复检测、切换分支移除旧结果，以及 800 px 布局无横向溢出。
- 网页两种构建操作的请求由验证中间件捕获，确认分支正确后返回 409，未转发为真实游戏构建或上传。这部分是页面请求验证，不是完整打包上传验收。
- 实际检测任务 #97、#98、#99 完成。#97 的四组开始时间差约 1.3 ms，各组执行耗时约 0.17–0.72 秒（不含 Jenkins 排队和启动时间）。
- 发布后的 API 实际检测批次：`ff2225b1-a113-4a24-88f1-4a16a99d45ed`，Jenkins #99，队列 1066。

| 组别 | 请求分支 | 实际分支 / 提交 | 检测结果 |
| --- | --- | --- | --- |
| Android Debug | main | main / 816693fa0e | 可增量 |
| Android Release | auto | release/2026-09-11 / 567fe86f1c | 可增量 |
| iOS Debug | main | main / 816693fa0e | 可增量 |
| iOS Release | release/2026-09-11 | release/2026-09-11 / 567fe86f1c | UNKNOWN：BASE_NOT_ANCESTOR |

iOS Release 的旧安装包基线 `iOS/Release/2.5.6/52`（`71740d86fa36f8b61a468bbd9a8fdc10d6555c1c`）不是所选 Release 提交的祖先。页面显示“参考安装包与当前分支不兼容，请打完整包”。这是实际基线不兼容，不能作为可增量通过；检测任务因此为 UNSTABLE，而四组报告均成功取得。

完整目标 SHA：main 为 `816693fa0e64a8b16726204031100c187c4148a1`，Release 为 `567fe86f1c020d88cbe90fef888a0c20886bbfff`。分支、SHA 和兼容性结论均为本次检测时点结果。

生产上传记录 ID 集合、构建上传链 ID 与状态在更新前后相同，未恢复已取消任务。快捷游戏构建入口下一编号仍为 32，本轮没有创建游戏构建或上传任务。

## 发布证据

- 版本：3.5.4；releaseId：`20260914T070220494Z`。
- API 源码提交：`d6b0c1060e1f719b6fef7ba5883f846299445130`；generation：`20260914070304784`；LAN / 本机 readiness 为 ready。
- 干净发布源码：`work/windows-3.5.4-release/source`；归档内 Web 资源、桌面编译文件和 upload-contract 与本次构建逐字节一致。
- 更新清单签名验证通过，LAN 下载的安装包和便携 ZIP 字节数 / SHA-256 与清单一致。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Relay-QA-Hub-Setup-x64.exe | 150491377 | 206a0e87ca720f428c7698141adc6e8bd82391edd2267481cb47701ce996d8f6 |
| Relay-QA-Hub-Windows-x64.zip | 155470190 | ca6dbae12305653eef4829e23fe67b23d64de22a8344df6951082c8bf3fd0974 |

下载：[Windows 安装包](http://10.100.5.157:4174/downloads/Relay-QA-Hub-Setup-x64.exe)。线上 Web 静态资源也与发布构建逐字节一致。

回滚副本：`apps/desktop/release/builds/prepublish-20260911T123828690Z-20260914T065706523Z`，保留上一版 3.5.3 发布产物、清单、Web 资源与来源记录。API 更新前已备份上传 SQLite 数据库。

本地详细证据位于 `work/build-branches/` 和 `work/windows-3.5.4-release/`，包括测试日志、检测报告、网页验证截图、发布清单验证和历史保存比较。原始 Jenkins 配置、认证会话及生产数据库备份不提交到 Git。

## 验收边界

遵守 `docs/design/lan-project-onboarding-v2.2-2026-09-11.md` 的最新 EXE 边界：本轮只制作、编译、打包与验证下载产物，未启动、安装、升级或调试 EXE，也未执行 EXE MCP。EXE 实际行为及完整游戏打包上传链标记为用户自测 / 本轮未执行。
