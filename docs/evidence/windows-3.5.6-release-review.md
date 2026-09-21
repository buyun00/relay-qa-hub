# Windows / Web 3.5.6：Release 增量发布强制最终审核

日期：2026-09-21。功能与发布源码提交：`6569f4987fcddd507188766592ce2eca05d96355`。

## 已交付

- Release 产品（`2002`）不再提供“完成发布／自动确认正式发布”选项。页面固定显示“Release 必须最终审核”，上传、提测和正式资源准备完成后停在 `awaiting_publish`，必须由人工执行“确认发布”。
- Release 策略同时由 Web 草稿、共享快捷打包契约、API 新任务解析和桌面 MCP 参数归一化执行；旧客户端即使提交 `publish_workflow`，新的 Release 任务仍会转换为 `prepare_publish`。
- Android / iOS 的 Release 快捷打包上传均继承该策略。Debug 产品（`2001`）保持原有可选流程，不受本次变更影响。

## 验证

- 本次修改文件的 Prettier、ESLint 和差异空白检查通过。
- 全工作区类型检查通过；全工作区生产构建通过；API 启停 E2E `1 / 1` 通过。
- 单元与集成测试通过：API `169 / 169`、Desktop `72 / 72`、Web `60 / 60`、Worker `4 / 4`、Domain `64 / 64`、Storage `102 / 102`、根目录边界测试 `3 / 3`；另有真实 API / Desktop MCP / SQLite 队列链 `10 / 10` 通过。
- 新增断言覆盖 Release 无法绕过最终审核、Release 同请求以旧模式重试仍归一化、Debug 继续保留 `publish_workflow`。
- `check:contracts` 通过。仓库完整 `verify` 仍会被本次修改外的既有门禁阻止：12 个无关文件不符合当前 Prettier，且 `schemas/workflow.schema.json` 与已提交 breaking baseline 存在既有漂移；没有改写基线或顺手修改无关文件。全仓库 lint 还会扫描历史 `work/` 与打包目录并报告既有生成文件问题；本次文件的定向 lint 已通过。

## 发布证据

- Windows / Web 版本：**3.5.6**；releaseId：`20260921T123452980Z`。
- 生产 API generation：`20260921123336043`；build SHA：`6569f4987fcddd507188766592ce2eca05d96355`。
- 本机与 LAN API readiness 均为 `ready`，schema `12`，database / evidence / worker 均为 `ok`；生产 Web 返回 `200`。
- 包内 `release.json`、桌面编译文件、共享 upload-contract 和 9 个 Web 资源与该提交的构建产物逐字节一致；安装器与 portable 更新清单签名验证通过。

| 发布文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Relay-QA-Hub-Setup-x64.exe | 150506043 | `c9e40c5b2fb9c2a9fad07ea28a9ec4e66d68b66535cb930cb93737831e2c2125` |
| Relay-QA-Hub-Windows-x64.zip | 150863833 | `63855a69c8ef8f0c883321756cbc23d2e47bae250f0bcb6ce74c50c2881ff392` |

LAN 下载的安装器和 portable ZIP 字节数与 SHA-256 均和签名清单一致。发布前确认上传历史共 48 条，运行中上传 `0`、待发布 `0`、未完成快捷打包上传链 `0`；未提交游戏构建或真实增量上传。

3.5.5 回滚副本保存在 `apps/desktop/release/builds/prepublish-20260915T100458810Z-20260921T123452980Z`，包含原 package、portable ZIP、两个签名清单、稳定/版本化安装器、Web 资源和源码归档，复制后哈希复核通过。发布前已有最新本地与异盘 SQLite 恢复点；生产数据库、上传记录与历史任务未重置。

本地详细证据位于 `work/windows-3.5.6-release/`。本轮未启动、安装、升级、调试或操作 EXE；EXE 行为与桌面升级仍由用户验收，不能由上述构建、签名和在线下载验证代替。
