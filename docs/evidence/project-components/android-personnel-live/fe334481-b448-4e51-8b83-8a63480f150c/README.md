# Android 原生人员与项目隔离验收

2026-09-09 02:49:34–03:04:01 UTC，在独立 MuMu `127.0.0.1:16384`、preview code23 上完成。实际结果及 33 个有据断言见 [result.json](result.json)。本轮仅新建 A/B 项目和一个员工；五组件在每次读取时均关闭。没有使用物理设备，没有修改覆盖矩阵。

| 实际路径 | 证据 |
| --- | --- |
| 原生填写新姓名进入 A，项目目录只有 A；通过原生项目入口进入 B 后同一员工目录有 A/B | [单项目](raw/08-single-project-menu.png)、[双项目](raw/11-multi-project-menu.png)、[同一 ID 的 HTTP 读回](raw/read-1788922562957.json) |
| GM API 停用新员工的 A 会员：A v1→revoked/v2，B active/v1 不变 | [停用读回](raw/disable-1788922601542.json)、[辅助请求流水](raw/http.jsonl) |
| 原生 A 旧会话刷新被拒绝；B 仍可进入，刷新后的目录仅 B | [A 拒绝](raw/15-native-a-revoked-read.png)、[B 工作台](raw/17-b-usable-a-disabled.png)、[仅 B 目录](raw/18-only-b-menu.png) |
| 原生自动记名登录和重新手填同名登录 A 均拒绝，没有重新激活会员；B 仍可登录 | [显式拒绝](raw/22-disabled-a-explicit-name-rejected.png)、[拒绝后会员仍 v2](raw/read-1788922686909.json)、[B 仍可用](raw/24-b-workbench-after-refusal.png) |
| GM API 恢复 A 至 active/v3；原生重新进入 A，同一 ID 且目录恢复 A/B | [恢复读回](raw/restore-1788922710553.json)、[A 原生工作台](raw/25-a-restored-native.png)、[目录](raw/26-restored-both-projects.png) |
| 正常切换身份回原员工 AndroidCaptureQA、原 A，文字和待提交 PNG 自动恢复 | [恢复原稿](raw/34-original-login-restored.png)、[对应原生树](raw/34-original-login-restored.xml)、[前后文件哈希](raw/after-readonly.json) |

停用和恢复明确由 **GM 官方 HTTP** 辅助执行。原生人员页禁止自停用：按钮父节点为 disabled，第一次点击没有效果，前后截图完全同 SHA、会员仍为 v1；没有把它计作原生停用成功。新员工 ID 为 `54436391-12c3-42f3-8124-d3d650d4bb76`；A 为 `b41667b3-7fd7-415f-8851-8b59aba192d8`，B 为 `81cdaf01-e6ee-47b3-b9d1-7bbed6bd1c07`，测试数据完整保留。

辅助流水含 55 个实际 HTTP 请求，均 200：42 GET、11 POST（9 次 GM 登录、2 次新项目创建）、2 PUT。它不包含原生应用自行发出的网络请求，不能把界面拒绝推算成已抓取的 403 响应。原生输入共 34 次，保存 35 组 PNG/XML；图和树是顺序采集，不是同步帧。

原稿保全先于身份切换。原 identity XML、draft prefs、150,880 字节 PNG、743 字节 sidecar 四文件在稳定读取、私有副本及结束读取时 SHA 完全一致；PNG SHA 为 `9b87034279be40b603fd48ff5bb739640493e7854dfd78d845612ff83202fcfc`。原文字 `UNSENT_CODE20_TO_CODE21_CAPTURE_DRAFT_KEEP` 在开始和恢复后原生 UI 可见。原 preview PID23733、daily PID5051、两包版本及安装时间、preview 配置和 daily 四份偏好哈希均不变。正常身份切换会更改会话保险库，不声称该文件不变。

本轮没有复制运行中的 Room 主库/WAL，也不声称整份 profile 或队列一致快照。既有 code23 一致保全只按 [历史证据](../../android-code23-recovery-live/65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/result.json) 的原范围引用。原稿私有文件仍在独立 runtime；公开材料仅包含其哈希、界面证据及已脱敏流水。

诊断原样保留：首次 UI dump 139 未保留 stdout/stderr，但其唯一 XML 随后成功读取；首次静态复制脚本因模块语法错误在任何语句执行前退出。后续 34 次 dump 有 33 次139、1次135，但均明确写出唯一 XML，并留存 stdout、有效树及 PNG；输入命令本身均成功。A 撤权后旧人员行和旧菜单短时仍可见，刷新报拒绝，B 登录后目录才更新；不声称缓存被擦除。

102 份原始公开副本共 5,050,199 字节，逐字节 SHA 与 runtime 原件相同，清单在 result 的 `artifacts`。另附两个最终辅助脚本和只读汇总脚本的文本；辅助 API 早期读目录由 `/members` 改为 `/users` 以取得版本，实际历史以请求流水为准。递归凭据字段、JWT、Bearer 与私钥模式检查为 0 命中；原密码和 token 在请求日志生成时已于内存脱敏。

没有安装、升级、清数据、强停、删稿、提交 Bug、日常客户端输入或生产操作。没有新增原生关联/解除、非零历史任务引用保全、物理设备或整项基线通过结论。
