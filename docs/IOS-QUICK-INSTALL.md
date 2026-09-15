# IPA 快速安装到测试机

入口：打包与下载 → iOS Debug / iOS Release → 选择测试机 → 对应 IPA 的“快速安装”。默认选择唯一的 iPhone 15，手动选择会在当前用户的页面中保留；不会在 iPhone 15 离线时擅自切换到其他手机。同型号多台设备需明确选择。

## 连接与签名

安装通过 Mac 打包机的 Xcode `devicectl` 执行。手机先在该 Mac 上通过 USB 完成信任、配对与无线连接设置，并开启开发者模式；之后手机和 Mac 在同一局域网、手机解锁，即可拔线安装。无需把 IPA 先下载到 Windows，也不依赖 EXE 进程执行安装。

Debug 使用原有开发签名安装。Release 商店签名不能直接安装到测试机，快速安装会自动在临时副本上重新签名为 Ad Hoc，再安装到所选手机；不重新编译游戏，也不更改原商店 IPA。Mac 需有匹配应用和测试机的有效 Ad Hoc 描述文件及对应私钥。本机已有 `Baloot AdHoc`，包含 iPhone 15 与 iPhone 14。现有签名校验结果（2026-09-15）：

| 构建 | iPhone 15 / iPhone 14 |
| --- | --- |
| iOS Debug 2.5.5 / 53 | 描述文件包含两台设备，签名检查通过 |
| iOS Release 2.5.11 / 58 | 原包为商店签名，安装时转换 Ad Hoc 副本 |

上述只证明签名和包完整性，不是手机实际安装成功证明。当前两台测试机在 Mac 上都显示离线。

## 后端与打包机

新增独立 Jenkins 任务 `【OZDQP】【测试机安装】`，无数字前缀，与游戏打包、增量上传分别排队。任务保持 sandbox，禁止任务并发，使用 `scripts/jenkins-ios-install.groovy` 和 `scripts/jenkins-ios-install.py`。只执行设备清单查询、Release Ad Hoc 副本制作或安装已选 IPA；不构建游戏、不卸载旧应用、不启动应用。

后端读取所选配置、版本和构建号的 `build-info.json`，验证平台、渠道、版本、产物名称与目录。安装请求固定设备 ID、IPA URL、字节数及 SHA-256，拒绝客户端自带 URL 或路径。Mac 获取 IPA 后再次比对完整大小与哈希，并校验签名、描述文件有效期与所选设备。只解压到该次任务的临时目录，完成后清理临时 IPA / App。

Release 转换使用相同 application identifier 的 Ad Hoc 描述文件，校验证书私钥可用、描述文件未过期且包含选定设备。保留应用原有 capability entitlements 和 keychain groups，只调整分发相关字段；新描述文件缺少应用所需能力时停止。先签名内嵌 framework / dylib，再签名主应用，生成 DER entitlements；验证嵌套签名、描述文件及 Info.plist 完全不变后，封装 `adhoc.ipa`。当前 Unity 包结构支持 framework / dylib；带独立 app extension / 嵌套应用的未来 IPA 会明确提示需要独立签名配置，不能误签。

原始 IPA 与 Ad Hoc IPA 分别记录 SHA-256。Ad Hoc 副本归档到该安装任务的 `adhoc.ipa`，保留版本和 bundle ID；发布目录原商店 IPA 不被覆盖。界面安装记录标注 Ad Hoc 测试副本。

安装命令使用明确设备 ID。成功必须同时收到该设备对应 bundle ID 的安装回执，并再次读取已安装应用核对 bundle ID、应用版本与构建号。超时、无回执、回执身份不符或版本无法确认均不会显示成功。安装程序不删除手机上的应用数据；应用自身的数据迁移行为不在此工具控制范围内。

`integrations/ios-install/jobs.json` 保存请求意图、队列号、任务号和结果。API 启动后继续查询原 Jenkins 任务，已提交或提交结果未知的请求不会自动重新提交。同设备进行中的任务阻止重复安装；同一幂等键不能更换包或测试机。连接清单与最近安装记录在团队中共享，页面关闭后已提交任务继续执行。

## API

- `GET /api/v1/packaging/ios-installs`：已配对设备、最后扫描状态、最近安装记录。GET 本身不触发扫描或安装。
- `POST /api/v1/packaging/ios-installs`：需登录和 UUID `Idempotency-Key`。
- 刷新测试机：`{"action":"devices"}`。多个正在进行的扫描请求合并到同一任务。
- 安装：`{"action":"install","selection":{"configuration":"Debug","version":"2.5.5","buildNumber":53,"filename":"清单中的IPA文件名.ipa","deviceId":"设备列表返回的UUID"}}`。

页面首次进入 iOS 下载区时刷新过期连接状态，也可手动点击“刷新测试机”。离线或未开启开发者模式时按钮禁用并显示具体说明。最新任务显示排队、正在校验及安装、成功、失败或结果未确认。

## 本轮验证边界

后端、安装脚本与网页验证包括：默认与手动设备选择、固定版本和哈希、设备签名限制、离线不执行安装、重复提交、API 重启追踪、回执与应用版本核对、800 px 布局。

实际 Mac 设备查询与实际 IPA 签名检查已执行。网页安装按钮请求通过验证中间件捕获，没有转发为手机安装；模拟在线状态仅用于验证请求与界面。本轮未对离线手机执行实际安装，也未启动、安装或操作 QA Hub EXE。手机实际 Wi-Fi 安装与 EXE 行为由用户自测。

参考：[Apple 注册设备分发](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices)、[Xcode 命令行工具](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)。安装与应用列表 JSON 字段同时参考 [Flutter 对 devicectl 的原始回执测试](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/test/general.shard/ios/core_devices_test.dart)；当前 Mac 的命令帮助和设备查询已实测。
