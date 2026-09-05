# Windows 1.3.1 沉浸式界面发布

- 发布日期：2026-09-05（Asia/Shanghai）
- Release ID：`20260905T031307609Z`
- 构建源码：`b8bdbadc33b5a08389ce3be7d68ad7e04ea19f02`
- 版本：Web / Desktop `1.3.1`

## 发布内容

主导航依次为工作台、总览、制作任务、打包下载。侧栏底部以用户管理居上、MCP 设置与当前状态居下排列；连接灯移至 QA Hub 标识旁。MCP 面板显示实际状态、端口与客户端配置，当前状态面板显示 EXE 版本并复用更新流程。Electron 移除应用菜单，隐藏标题栏，将原生窗口按钮与拖动区域融入 64px 顶部。

## 验证

- Web 单测 39/39、Desktop 单测 45/45；Web/Desktop TypeScript、相关 ESLint、格式检查和构建通过。
- 正式 ASAR 的版本和 sourceCommit 与发布源码一致，确认包含 `Menu.setApplicationMenu(null)` 和隐藏标题栏配置。
- 正式 EXE 冒烟通过：四个导航顺序、品字形卡片、可见 Windows 控件覆盖区及高度、拖动区域和可交互搜索框、Logo 连接灯。
- MCP 使用隔离的实际端口 `4321`，处于 listening；JSON 配置地址与主进程运行信息一致，两个复制入口存在。配置实际复制内容已在此前浏览器预览核对，未将该预览当作 EXE 剪贴板实测。
- 当前状态显示 `1.3.1`；检查更新实际返回 `up-to-date`，界面反馈同步。
- 既有账号登录、通知连接、18 个 MCP 工具、Bug 列表/详情/图片、总览日期筛选、制作页及创建表单只读验收通过，没有提交制作或修改 Bug。
- 隔离旧发布标识的测试客户端通过在线签名清单下载并安装本版，安装后的 release ID 为 `20260905T031307609Z`；改名安装目录、重启、用户数据目录、运行配置与回滚目录检查全部通过。
- 发布前已有的用户客户端主进程 `21424` 保持运行，没有强制退出或替换其安装目录。

## 在线产物

更新清单：`http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json`

| 产物 | 大小（字节） | 实际下载 SHA-256 |
| --- | ---: | --- |
| `Relay-QA-Hub-Setup-x64.exe` | 150383803 | `f9f266913e630cd93baeeb71b3aafc30e19a2dad079c03f6f098fd19629696d7` |
| `Relay-QA-Hub-Windows-x64.zip` | 155362474 | `638e8921c01a12b21211e9d46e2ac453ee9f850d5babc6e3c435af36a38ce1be` |

两份在线下载与本地签名清单一致，Ed25519 清单签名验证通过。安装器 Windows Authenticode 状态仍为 `NotSigned`，与清单签名是两种独立校验。

API 的 LAN `/api/v1/health/ready` 返回 `ready / schema 10`，database、evidence、worker 均为 ok。

## 回滚和证据

发布前 `1.3.0 / 20260904T113429214Z` 的安装器、便携 ZIP、清单和 Web 资源已保存到：

`D:\Relay-QA-Hub\apps\desktop\release\builds\prepublish-20260904T113429214Z-20260905T031232Z`

6 个发布文件逐一核对复制前后 SHA-256，旧稳定安装器也与旧签名清单匹配。

本次详细输出：`D:\Relay-QA-Hub\work\windows-1.3.1-release\` 下的 `publish.log`、`online-verification.json`、`portable-smoke.json`、`self-update.log`。其中自更新测试使用原有脚本构造旧 release ID，验证现有更新链路，不等同于遍历每个历史版本。
