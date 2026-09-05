# Windows 1.3.2 顶部布局发布

- 发布日期：2026-09-05（Asia/Shanghai）
- Release ID：`20260905T073349220Z`
- 构建源码：`c5ff9802447e33c6247736a823df585b2f23b462`
- 版本：Web / Desktop `1.3.2`

## 发布内容

顶部与侧栏品牌区增加到 112px，QA Hub 标识和项目 Logo 居中对齐。项目 Logo 增加浅色底座，项目名与当前页名称分层展示；搜索与刷新图标统一样式。连接灯贴在 QA Hub 标识右下角。原生窗口按钮保留在顶部 32px 区域，内容在其下方排列，拖动区域与搜索操作继续分开。

## 验证

- Web 39/39、Desktop 45/45 单测通过；Web/Desktop TypeScript、相关 ESLint、格式检查和构建通过。
- 发布前已在浏览器预览检查常规尺寸与 960×640 窗口，工作台、总览顶部没有横向溢出；两个 Logo 垂直中心对齐，侧栏管理卡片可见。
- 正式 ASAR 的版本、release ID、sourceCommit 均匹配本次发布；包内确认包含 112px 顶部样式、隐藏标题栏、32px 原生窗口控件配置和菜单移除代码。
- 正式 EXE 冒烟通过：四个导航顺序、品字形卡片、可见的 Windows 控件覆盖区及 32px 高度、拖动样式、可交互搜索框和 Logo 连接灯。
- MCP 使用独立端口 4321，处于 listening；配置地址与实际运行信息一致，两个复制入口存在。当前状态显示 1.3.2，检查更新返回 up-to-date 且界面有反馈。本轮没有另行执行 EXE 剪贴板内容验证。
- 既有账号登录、通知连接、18 个 MCP 工具、Bug 列表/详情/图片、总览日期筛选、制作页与创建表单只读验收通过，没有提交制作或修改 Bug。
- 独立测试客户端从在线签名清单下载更新，成功安装并重启至本次 release ID；改名安装目录、用户数据目录、运行配置和回滚目录检查全部通过。测试使用脚本构造的旧 release ID，不代表遍历所有历史版本。
- 测试进程和配置均隔离，未强制退出日常客户端。发布期间本机客户端进程发生变化；最终只读检查确认日常安装目录的 release.json 已为 1.3.2 / 本次 release ID，不将原进程视为始终存活。

## 在线产物

更新清单：`http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json`

| 产物 | 大小（字节） | 实际下载 SHA-256 |
| --- | ---: | --- |
| `Relay-QA-Hub-Setup-x64.exe` | 150385305 | `cb02a827c6f49ad375a86fea432d0a2c8b606186c6ce1f66df609b6877a06c0c` |
| `Relay-QA-Hub-Windows-x64.zip` | 155363503 | `cfb72d884d1def8454f7f027066d76c568b2190903de6399ae065e8c0153ca7f` |

在线清单与本地清单一致，Ed25519 签名及两份实际下载的大小、哈希验证通过。安装器 Authenticode 为 NotSigned，与更新清单签名分开记录。LAN API `/api/v1/health/ready` 返回 ready / schema 10，database、evidence、worker 均为 ok。

## 回滚与证据

发布前 1.3.1 / `20260905T031307609Z` 的安装器、便携 ZIP、清单与 Web 资源保留在：

`D:\Relay-QA-Hub\apps\desktop\release\builds\prepublish-20260905T031307609Z-20260905T073300Z`

6 个发布文件逐一核对复制前后 SHA-256，旧安装器与便携 ZIP 也分别匹配旧清单；归档目录包含 inventory.json。

详细证据位于 `D:\Relay-QA-Hub\work\windows-1.3.2-release\`：`publish-build.log`、`online-verification.json`、`package-source.json`、`portable-smoke.log`、`self-update.log`。
