# Windows 2.0.2 — 打回截图与待制作优先

- 发布日期：2026-09-06（Asia/Shanghai）
- Web / Desktop：2.0.2
- Release ID：`20260906T033735389Z`
- 产品源码 / 在线 API：`d6ce672ab2bb470e8900928e4cfdf1cae68de26c`
- 数据库仍为 schema 11，本次没有数据库迁移。

## 行为

打回原因框支持直接粘贴 PNG / JPEG / WebP 截图，也可选择文件。提交前可预览、移除，
每次最多 8 张、合计 100 MB。当前窗口中的草稿按 Bug 和修复轮次隔离；关闭详情再打开、
上传失败后重试均保留文字与图片。已上传附件在有效期内重用。

附件通过正式上传与 verification_result 预留绑定，在同一事务中写入验收结果和
verification_attachments。校验账号、项目、操作者、提交身份、目标 Bug、有效租约及
文件完整性；失败回滚，不留下半次打回。截图随持久化重做请求交给原 Relay 任务的
下一轮，并保留在 Bug 图片列表中。旧客户端回传全部图片时不会改写验收证据。
附件响应遵守既有 1.1.0 元数据约定，没有增加约定外字段。

从 QA Bug 批量制作的选择列表按待制作、处理中、待验收排序，同状态保留原顺序，
分别采用蓝、黄、绿背景和文字状态标签；搜索、负责人筛选及批量选择继续有效。

## 验证

- SQLite invariants / migrations：82 项通过；最后的元数据兼容修正又通过完整生命周期用例。
- API / production / Relay transport：26 项通过，包含下一轮截图的实际 HTTP 字节及哈希校验。
- Web：40 项；Desktop：45 项。类型、相关 ESLint、ADR、边界、diff 检查通过。
- 1.1.0 契约验证及冻结基线检查通过；回归用例校验返回附件字段都在冻结元数据约定内。
- 正式 ASAR 的版本、Release ID、源码提交一致，8 项 Web 资源逐字节匹配。
- 正式 EXE 的隔离配置登录、18 个 MCP 工具、导航和表单冒烟通过。
- 导入列表实测 60 张：25 张待制作全部在前，1 张处理中，34 张待验收；背景色区分正确。
- 实测粘贴、移除、重新粘贴、关闭再打开保留草稿、上传失败保留草稿、结果请求同身份重试。
  UI 写请求全部拦截到隔离模拟响应，真实单据只读；存储事务和 Relay HTTP 传图另外独立验证。
- 隔离旧 Release ID 客户端通过线上签名清单升级到本次实际安装包，重新启动成功，
  改名目录、用户配置、运行配置及回滚目录保留。不代表遍历所有历史客户端版本。
- 在线 API ready，database / evidence / worker 均为 ok。日常客户端 PID 9584 保持运行。

## 下载与回滚

| 实际下载产物 | 字节数 | SHA-256 |
| --- | --- | --- |
| Relay-QA-Hub-Setup-x64.exe | 150391281 | fdfeab09723f037004f5f48bf5064603fe93ce80079a5f3c8bd44049efacc2d9 |
| Relay-QA-Hub-Windows-x64.zip | 155367659 | 93e8124871e9551f88caa06efcafb843b4c36edca65525027be56b863b7eb986 |

线上 Ed25519 清单签名与下载字节校验通过；清单位于
`http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64-latest.json`。

原 2.0.1 客户端、Web、清单及产品源码已复制并逐文件核对，保留于
`apps/desktop/release/builds/prepublish-20260905T141956599Z-20260906T032539709Z`。
全部发布日志、截图、线上哈希、包内源码及升级证明位于
`D:\Relay-QA-Hub\work\windows-2.0.2-release\`。
