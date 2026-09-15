# Windows / Web 3.5.5：IPA Wi-Fi 安装与 Release Ad Hoc 转换

日期：2026-09-15。功能提交：`a80b91b0a85778409f403b325db678821db081de`。

## 已交付

打包下载页的每个 IPA 增加快速安装入口，默认选择 iPhone 15，可切换并记住 iPhone 14 或其他已配对手机。后端通过 Mac 打包机执行，页面关闭不影响已提交安装。

Debug 使用原 IPA。Release 商店 IPA 在临时目录生成 Ad Hoc 副本后安装，保持 bundle ID、应用版本和构建号，不覆盖原商店包。副本使用包含所选测试机的有效 Ad Hoc 描述文件和对应签名私钥，并保留原能力和 keychain groups。签名或描述文件不匹配时明确失败。

同设备安装去重、任务持久化、未知提交只查询原任务、安装回执及实际应用版本核对均已实现。详见 [功能与接口说明](../IOS-QUICK-INSTALL.md)。

## 实际验证与限制

- API 相关回归 **60 / 60**，含 8 项新增安装验证；上传产物 / 桌面 MCP 合同 **31 / 31**；Python 安装与重签名 **8 / 8**；Web **60 / 60**（14 文件）。API、Web、Desktop 编译 / 类型检查、相关 ESLint、差异空白检查通过。
- 实际 Xcode 26.3 / devicectl 读取两台已配对设备：iPhone 15（iOS 26.2）、iPhone 14（iOS 18.4.1），两者开发者模式开启，当前均离线。
- 实际 Debug 2.5.5 / 53 的描述文件与签名对两台设备均通过。
- 实际 Release **2.5.11 / 58** 已转换成 Ad Hoc 副本，重新封装后再次解压核对两台设备的描述文件及嵌套签名，均通过。bundle ID `com.hetpl2.baloot.ios`、版本 2.5.11、构建号 58 保持一致；原 IPA 字节哈希不变。
- 原 Release IPA SHA-256：`935742586e4ae5bbfed65984ca9ee95257cd9c1624c5b63425e9486a3af9230d`。
- 本次验证生成的 Ad Hoc IPA SHA-256：`111c131d4a43340c01bab54bce2c341814211319da0699d7ae491f386d29eaa9`。使用 `Baloot AdHoc` 描述文件；验证临时副本在检查结束后清理，正式安装时副本归档到对应 Jenkins 安装任务。
- 网页使用真实 IPA 清单、真实 Mac 设备列表，验证默认 iPhone 15、改选及记忆 iPhone 14、离线按钮与提示、固定文件 / 版本 / 构建号、排队防重复、未确认结果不会显示成功，以及 800 px 无横向溢出。模拟在线状态仅用于捕获安装请求，未转发到手机。
- 独立安装任务初次查询 #1 成功；发布后的生产 API 查询完成于安装任务 **#4**。Ad Hoc 归档功能更新时发现 Jenkins XML 更新请求未明确 UTF-8 导致中文参数乱码，已用更新前配置恢复正确参数并显式 UTF-8 提交；脚本文本、参数、sandbox 与历史均读回验证。失败扫描没有产生安装动作，失败记录保留。
- API 更新前后上传记录 ID、构建上传链 ID 与状态一致，没有恢复历史任务。本轮未提交游戏构建或手机安装；快捷打包下一编号保持 40。

手机实际 Wi-Fi 安装尚未验证，因为两台手机离线。EXE 遵守用户自测边界，未启动、安装、升级或操作；完整真机安装及 EXE 行为不得标记为通过。

## 发布证据

- 版本 **3.5.5**，releaseId **`20260915T100458810Z`**。
- API 源码 SHA **`a80b91b0a85778409f403b325db678821db081de`**，generation **`20260915100437368`**，本机 / LAN readiness 均为 ready。
- 干净 main 源码独立构建。归档 Web 文件、Desktop 编译文件、共享 `ios-install.js` / `.d.ts` 与源构建一致；更新清单签名通过；LAN 实际下载 SHA-256 / 大小均与清单匹配。

| 发布文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Relay-QA-Hub-Setup-x64.exe | 150500290 | b811ec1f629ddf9817904c898d5dd4237f1dcf654044545592450b8f29fdc79a |
| Relay-QA-Hub-Windows-x64.zip | 155480211 | c5c3d8832e315cb1d27e1b945ec7abee264c57ffc7c3db63cea454b022ffe7bc |

线上 Web 静态文件逐字节比对通过。[安装包下载](http://10.100.5.157:4174/downloads/Relay-QA-Hub-Setup-x64.exe)。

3.5.4 回滚副本：`apps/desktop/release/builds/prepublish-20260914T070220494Z-20260915T095605790Z`，包括原发布包、清单、Web 与源代码归档。上传队列 SQLite 在 API 更新前完成一致性备份，原客户端目录与运行实例未操作。

本地详细证据：`work/ipa-install/`（测试、设备扫描、签名检查、Ad Hoc 转换、网页与上线验证）和 `work/windows-3.5.5-release/`（构建、回滚、归档与下载验证）。原 Jenkins 配置、签名材料路径、生产数据库备份仅保留本地，不提交 Git。
