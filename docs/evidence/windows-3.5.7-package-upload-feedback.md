# Windows / Web 3.5.7：打包并上传不再静默无响应

日期：2026-09-23。功能与发布源码提交：`2ebc92b682528821969a9f35009c04c0a6f45287`。

## 问题与修复

- 生产只读检查确认 Jenkins 可构建、上传程序可用，但当前上传账号状态为 `configured=false`。
- 原页面因此把“构建完自动上传增量”渲染为原生禁用按钮，点击事件不会触发，用户看起来就是“没有任何反应”。
- 现在账号未配置或上传程序不可用时按钮仍可点击，并在操作区显示准确原因及“修改上传设置 / 登录账号”入口；满足前置条件后仍走原来的服务端打包上传链。
- Release 快捷打包继续固定为 `prepare_publish`，上传完成后等待最终人工审核；Debug 流程未改。

## 验证

- Web 单元测试 `61 / 61`、Desktop 测试 `72 / 72` 通过。
- 全工作区 TypeScript 类型检查通过；本次文件的 Prettier、ESLint 与差异空白检查通过；Web 生产构建通过。
- 新增回归断言：上传账号未配置时，打包上传操作不能再因账号状态被静默禁用。
- 未提交真实游戏构建或增量上传任务；未启动、安装、升级、调试或操作 EXE，桌面运行验收仍由用户完成。

## 发布证据

- Windows / Web 版本：**3.5.7**；releaseId：`20260923T043502922Z`。
- 生产 API generation：`20260923043815059`；build SHA：`2ebc92b682528821969a9f35009c04c0a6f45287`。
- 本机与 LAN API readiness 均为 `ready`，schema `12`，database / evidence / worker 均为 `ok`；生产 Web 返回 `200`。
- 线上资源 `/assets/index-RDLZvQdT.js` 包含快捷打包上传入口、账号登录提示和“Release 必须最终审核”策略文案。
- 安装器与 portable 更新清单 Ed25519 签名验证通过；LAN 下载后的 SHA-256 与清单一致。

| 发布文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Relay-QA-Hub-Setup-x64.exe | 150505869 | `f981700b9ceb1dcb1bda14532cd84e5f4149c5303c0941875e89414c30728509` |
| Relay-QA-Hub-Windows-x64.zip | 155485011 | `07f9b2c412043b5fa16effde7559049fb3dee3b957d3a98d3ee1c3322651cd2c` |

上一版本安装器 `Relay-QA-Hub-Setup-3.5.6-x64.exe` 仍保留在发布目录，可用于回滚；此前完整的 3.5.5 回滚副本仍保存在 `apps/desktop/release/builds/prepublish-20260915T100458810Z-20260921T123452980Z`。
