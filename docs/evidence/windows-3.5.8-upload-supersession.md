# Windows / Web 3.5.8：等待确认任务可被后续上传覆盖

日期：2026-09-23。发布源码提交：`25365183803a24273f5ac89e0d8dec497646408c`。

## 行为变更

- 同产品、同渠道的旧任务若停在 `awaiting_publish`，新上传视为明确覆盖意图：旧任务持久化为 `cancelled / SUPERSEDED_BY_NEW_UPLOAD`，新任务直接启动，不再等待旧任务确认发布。
- 被覆盖的旧任务不能再执行恢复或确认发布，避免新版本开始后误发布旧版本。
- 正在上传、远端结果不明、失败待恢复等任务仍占用通道；已提交的确认发布操作也不会被并发新任务抢先覆盖。
- Release 仍固定走最终审核，Debug 行为未改。

## 当前生产处理

- 原等待确认任务 `872b66a3-0187-4ce9-99ac-2007b2e9bfce`（Release 2.5.27，产品 2002 / 渠道 1002）已按用户要求标记为 `cancelled / DISCARDED_AWAITING_PUBLISH`，未执行正式发布。
- 修改前的上传队列数据库已通过 SQLite `VACUUM INTO` 保存到 `D:\Relay-QA-Hub-Backups\production\increment-upload-manual\queue-before-discard-20260923T065611822Z.sqlite`。
- 随后提交的 2.5.33 任务 `97c29984-bb72-4be9-a3f5-00fb80af60f0` 已完成，当前生产无运行中上传、无等待确认任务。

## 验证与发布

- API 测试 `169 / 169`、Web `61 / 61`、Desktop `72 / 72` 通过；全工作区 TypeScript 类型检查通过。
- 覆盖回归包括：等待确认自动让路、旧任务不能再确认、手工发布先被核对、失败任务继续占通道、取消排队恢复不改变原失败任务。
- Windows / Web 版本：**3.5.8**；releaseId：`20260923T070119018Z`。
- 生产 API generation：`20260923070300030`；build SHA：`25365183803a24273f5ac89e0d8dec497646408c`；readiness 为 `ready`，database / evidence / worker 均为 `ok`。
- 线上 Web 资源：`/assets/index-DEDSck7S.js`；包含覆盖状态文案及“Release 必须最终审核”策略。
- 安装器与 portable 更新清单签名验证通过；LAN 下载后的 SHA-256 与清单一致。

| 发布文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Relay-QA-Hub-Setup-x64.exe | 150506924 | `c3305ac165cd2b98e9dc0ebf9735e4d648842a768893fe60e9556ece84c19c17` |
| Relay-QA-Hub-Windows-x64.zip | 155485549 | `890300e6c2fea3baf56004925388e429fb5b90bcdc5c1f3e99554f75cf35774a` |

本轮未启动、安装、升级、调试或操作 EXE；桌面运行验收仍由用户完成。
