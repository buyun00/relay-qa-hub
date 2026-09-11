# 四组兼容性检测并发与页面触发验收（2026-09-11）

Windows/Web 3.5.2 已发布，releaseId 为 `20260911T035645652Z`，客户端源码为 `471bb23973ef3ae29542cb2cfb255da117f5629a`。API 随后补上 Windows 文件占用重试，生产源码为 `e8da9d0f8b397df11b5cd54bef4723b4c5332993`；客户端资源无需变更。

## 最终行为

- 一个 Jenkins 检测任务占一个 executor，内部同时运行 Android Debug、Android Release、iOS Debug、iOS Release 四个检测进程。先获取一次 main，再准备四个独立 Git 引用与结果目录；各组补拉基线时不争用 Git 锁。
- 普通页面刷新不提交检测。按钮显示“开始检测”或“重新检测”。从其他分页进入并连续停留 2 秒后自动检测一次；提前离开取消，手动点击取消尚未执行的自动检测。运行中的批次保持同一身份，不因切页或刷新重复创建。
- 检测任务改名为 `【OZDQP】【兼容性检测】`，原 67 条记录和下一构建编号完整保留。Jenkins 首页实际顺序中它为第 8 项，`00-【OZDQP】【快捷打包】` 仍为第 1 项。
- Windows 状态文件短暂被读取者占用时，重试替换同一份临时快照，最多等候 1.55 秒；不重发 Jenkins POST。永久错误保留原结果并返回失败，清理本次拥有的临时文件。

## 实际验证

真实打包机检测 #63：成功，准备加检测合计 5,885 毫秒。四个检测进程启动仅相差约 12.1 毫秒，四路共同运行约 1.17 秒，且四组目标源码 SHA 一致。业务规则继续读取原快捷打包任务内的当前 Python 模块。

发布后的真实 EXE 使用真实 API 验证：手动操作创建 #71，从点击事件到提交约 65 毫秒；切页自动操作创建 #72，延迟约 2,021 毫秒。两批均为四项 complete、同一 queueId 和 buildNumber，报告地址分别绑定四个目标目录。另行读取这两个构建的实际进程时间，确认四路执行时间重叠。普通刷新、短暂切入后离开均未创建新批次。

EXE 八个打包菜单及产品、渠道、测试人映射检查通过，未点击正式构建或上传操作。隐藏窗口元素截图稳定性等待不可用；保留此前 EXE 八菜单截图、实际 DOM 验证和浏览器页面截图，不以截图代替接口与构建证据。

自动回归：23 个 API/Jenkins/保存测试、57 个 Web 测试、11 个桌面打包相关测试通过，三端 TypeScript 检查通过。保存测试包含真实 PowerShell 文件共享锁：占用约 650 毫秒后释放，旧文件在成功替换前一直保留。浏览器导航测试使用真实 React 页面、受控 HTTP 响应，单独覆盖 StrictMode 初次挂载、数据刷新、短暂切页、延迟、手动取消延迟和进行中批次去重；它不是瑞雪或 Jenkins 真实业务验收。

## 发布与保留

在线签名清单、安装程序和便携 ZIP 下载校验通过；安装程序 SHA-256 为 `07bbb37205c0855b3a274f897de746bf9481b957052ea821f375038a3fccbe72`，ZIP 为 `99d49ecb3c753bc80410088a2b988b083a9b9c86bfb60b841e7ec9195e27be19`。EXE 中 Web 资源与服务端发布资源一致。API ready，数据库、证据和 worker 检查正常。

切换前等待用户新发起的 2.5.3 上传完成；确认 `published=true`、`remoteStatus=100` 后才重启检测 API。17 个上传任务身份保持一致，原来的三个取消任务仍取消且没有 uploadJobId。日常 EXE 的四个 PID 保持不变。验收使用独立 EXE 用户目录，结束后仅关闭该验收客户端。正式打包 job 配置及全局两个 executor 未改动。

回退保留在 `apps/desktop/release/builds/prepublish-20260911T033325460Z-20260911T035636580Z`。Jenkins 改名前配置、完整历史、队列 SQLite 一致性备份和前后验证保留在 `work/parallel-build-checks/`。发布签名、下载哈希和客户端源码证明保留在 `work/windows-3.5.2-release/`。

关键证据文件：`parallel-verification.json`、`rename-verification.json`、`jenkins-order.json`、`exe-live-verification.json`、`exe-jenkins-timing.json`、`production-final.json`。可复跑的页面触发回归脚本是 `scripts/test-build-compatibility-browser.mjs`。
