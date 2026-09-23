# Windows / Web 3.5.9：上传任务支持明确放弃

日期：2026-09-23。发布源码提交：`91c7bd679eb0671987678fef20e2107542bc2a1c`。

## 行为变更

- 上传页对非运行中的 `failed`、`interrupted`、`awaiting_test`、`awaiting_publish` 任务显示独立的“放弃任务”入口。
- 放弃前必须在页面二次确认；成功后任务持久化为 `cancelled / DISCARDED_UPLOAD_TASK`，不能再恢复或确认发布，同产品/渠道通道立即释放。
- 正在执行的上传不能被放弃；排队任务仍使用原有“取消排队”，不会误伤其对应的失败任务。
- 新上传覆盖旧 `awaiting_publish` 的自动行为继续保留；Release 仍必须最终审核，Debug 行为未改。

## 生产现场处理

- 现场确认实际阻塞者不是待确认任务，而是 `becbd5b9-50d7-49d7-aaf2-d8ec1f6ac9e8` 的 `VERSION_CONFLICT` 恢复任务。
- 该任务已有明确后续上传，因此标记为 `cancelled / SUPERSEDED_BY_NEW_UPLOAD`；变更前 SQLite 副本保存在 `D:\Relay-QA-Hub-Backups\production\increment-upload-manual\queue-before-supersede-20260923T083748473Z.sqlite`。
- 原排队任务 `0637a1f8-074d-4126-890b-c15ecd793771` 随即进入执行，后续到达待确认后又被下一次上传按新规则覆盖，证明待确认任务不再占用通道。
- 当前最新任务 `91559805-de6f-4427-8e0d-f6f316979369` 为非运行中的 `VERSION_CONFLICT`，线上页面已提供“放弃任务”二次确认入口。

## 验证与发布

- API 测试 `170 / 170`、Web `61 / 61`、Desktop `72 / 72` 通过；全工作区 TypeScript 类型检查通过。
- 回归覆盖显式放弃失败任务、显式放弃待确认任务、放弃后禁止恢复/确认、释放同渠道队列、取消排队恢复仍保留原失败任务。
- Windows / Web 版本：**3.5.9**；releaseId：`20260923T084235673Z`。
- 生产 API generation：`20260923084155745`；build SHA：`91c7bd679eb0671987678fef20e2107542bc2a1c`；readiness 为 `ready`，database / evidence / worker 均为 `ok`。
- 线上资源 `/assets/index-BXHAOQhX.js` 包含“确认放弃任务”、成功提示及“Release 必须最终审核”策略。
- 安装器与 portable 更新清单签名验证通过；LAN 下载后的 SHA-256 与清单一致。

| 发布文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Relay-QA-Hub-Setup-x64.exe | 150508125 | `86c871c08510ae7733f7f8ecfeb41ec7858b8a2d49b2c7ff71bce9f518b4a912` |
| Relay-QA-Hub-Windows-x64.zip | 155486752 | `14260da3b82c70f956d56412d094f71a858e2620c5a1c1d95b51fe8dd60dc008` |

本轮未启动、安装、升级、调试或操作 EXE；桌面运行验收仍由用户完成。
