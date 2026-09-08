# Web 组件入口与表单核查

记录时点：2026-09-08T17:37:56.479Z。这是源码核查；五组件外部执行均为 not_run。

| 组件 | 页面 | 配置字段 | 仍需真实验证 |
|---|---|---|---|
| build | PackagingPage、BuildTasksPanel | baseUrl、job、downloadOrigin、zipPath、artifactUrlTemplate、credentialRef、presets | Real Jenkins fixture final artifact/hash/download and disable/re-enable acceptance not_run. |
| build_upload.single | BuildUploadControls、ComponentHistoryPage | buildPreset | Real build→exact new ZIP→upload→platform final result acceptance not_run. |
| upload.incremental | UploadIncrementPage、ComponentHistoryPage | sourceUrl、apiBase、loginBase、credentialRef、targetPrefix、testDirectoryPrefix、releaseDirectoryPrefix、defaults | Isolated platform credentials/product/channel/relative prefixes and final result validation unavailable; execution not_run. |
| relay.production | ProductionPage、ComponentHistoryPage | baseUrl、relayInstanceId、externalProjectId (Relay project key)、credentialRef | Actual isolated Relay task/executor/callback/outbox acceptance not_run. Disabled history currently displays state/time/version; richer historical result/detail display remains limited. |
| qingyu.sync | App (import dialog and Bug resolve action)、ComponentHistoryPage | baseUrl、externalProjectId (external project ID)、credentialRef | Independent external account/project/order and resolve-failure/nonblocking local closure acceptance not_run. Disabled history currently displays state/time/version; richer historical result/detail display remains limited. |

本次补充：组件历史始终可见，停用状态也能查看导入历史；历史请求独立完成，单项失败不会隐藏其他记录；暂停的 Relay 批次可明确恢复；下载快捷卡片使用实际产物预设。

完整路由明细见 JSON 与 coverage-matrix。API 保留旧路径别名，Web 请求仍带明确项目头。GM 页面已具备项目创建/改名/停用、组件配置和人员增删，GM 浏览管理实际创建、配置、成员和项目停用恢复已通过，小写短码登录及全关历史也已实测，见 web-browser/gm-results.json。真实 Jenkins/上传/Relay/第三方目标尚未提供完整外部闭环证据。停用后的 Relay/第三方历史详情目前仅显示概要，完整结果呈现仍有限。
