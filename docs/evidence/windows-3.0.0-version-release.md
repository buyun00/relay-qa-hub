# Windows / Web 3.0.0 版本发布

- 发布日期：2026-09-08（Asia/Shanghai）
- Release ID：`20260907T172648913Z`
- 构建源码：`38bb204f2bc825905c5560f7923df03300e05037`
- Web / Desktop：`3.0.0`

根据用户要求将 Web、Windows 客户端、锁文件对应 workspace 版本和版本断言统一调整为 3.0.0。

## 验证

- Web 41/41、Desktop 59/59 通过，发布构建的 Web/Desktop TypeScript 检查、工作区边界及 Git diff 检查通过。
- 正式 EXE 冒烟通过，界面显示 `3.0.0`，更新状态为 `up-to-date`；标题栏、搜索、详情关闭、总览/制作页、登录及 18 个 MCP 工具正常。
- 安装器、主 EXE、原生更新器的 Windows ProductVersion / FileVersion 均为 `3.0.0`。
- 包内 release ID、源码提交和版本与正式清单一致；8 项 Web 资源以及主进程、preload、更新器编译产物与发布构建逐字节匹配。
- 隔离升级先缓存真实签名的 2.0.11 安装包，再切换到 3.0.0 渠道清单；一次安装直接达到本次 release ID，成功重启，profile、运行配置和一个回滚目录保留。隔离源客户端采用模拟旧 release ID `20000101T000000000Z`，携带修复后的更新器。
- API ready/schema 12，database/evidence/worker 均为 ok；恢复点验证包含 788 项附件且无拒绝项。
- 日常客户端主进程 16728 及其子进程保持运行，启动项保持一致，9333、4321 测试端口已释放。

## 在线产物与回滚

更新清单：`http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json`

| 产物 | 字节数 | 实际下载 SHA-256 |
| --- | ---: | --- |
| 安装器 | 150395497 | `ad8a771e385bc4b9dde242bedf190e932d23464bb699a012d8ee7be66919ecce` |
| 便携 ZIP | 155371034 | `611e96d791b397f2fd9cefef16dc5d700b62d37a0c8fc7a525ddcdc587ab05d4` |

线上与本地清单一致，Ed25519 签名、下载大小及哈希验证通过；安装器 Authenticode 仍为 NotSigned。

2.0.11 的完整便携客户端、安装器、清单、Web 资源和已提交源码保留在 `D:\Relay-QA-Hub\apps\desktop\release\builds\prepublish-20260907T172217550Z-20260907T172623631Z`，6 项发布文件复制前后 SHA-256 一致。

详细验证日志：`D:\Relay-QA-Hub\work\windows-3.0.0-release\`。
