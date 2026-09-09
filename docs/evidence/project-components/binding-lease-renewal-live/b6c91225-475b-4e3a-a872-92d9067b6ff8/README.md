# 过期附件绑定原位续租实机证据

本证据在独立实例 `qa-hub-preview-final-sol-0909` 上完成。执行时 API 为 `127.0.0.1:4539`，服务端 MCP 为 `127.0.0.1:4541`，两者均返回 ready、schema 19。实例配置 SHA-256 为 `1e36dd0cebe27457e04505ca86c87e92335415dc2a970f2338004f778f759503`，源码提交为 `029188ba25df1c3e940437f1e78fa05ba011aed8`。运行器在请求前核对固定配置路径、配置哈希、所有实例目录的真实路径、监听 PID 与命令行以及端口；生产和共享预览均未被调用。

[create-proof.json](create-proof.json) 记录了真实上传、分块、完成和第一代绑定。第一代绑定 `e15f00f9-763b-4dd4-a759-164d00be8183` 在 `2026-09-09T09:04:29.338Z` 到期，状态为 `reserved`、附件版本为 4。系统时钟没有修改，程序等待真实时间越过到期点后，于 `2026-09-09T09:10:42.549Z` 发出第二代续租。

[renew-proof.json](renew-proof.json) 记录了同一 binding、attachment、project、submission、clientAttachment、intent 和 target 的第二代续租。首次请求返回 `leaseGeneration=2`、`version=5`、`status=reserved`、`replayed=false`，新到期点为 `2026-09-09T09:25:42.555Z`；同一幂等键和正文随即重放，返回相同身份、版本和到期点且 `replayed=true`。两次响应的字节数和 SHA-256 均保存在请求账本中，绑定在证据完成时仍未 claim。

文件指纹：

- `create-proof.json`: `820281a216439a0c9b10aa4fb1dba279b6eac5deaa2a13488a1cbaaa3180903e`
- `renew-proof.json`: `6a48ef0168ffb23b1a24e7273f531ac003ceb110ab5fd96afd4c00feb6bf5164`
- `runner.mjs.txt`: `d24027e4e1ef7e9b9ed93ddb0cbd2790f166bdc76d3fcaaefa4f7b2720b77d54`，创建阶段原始运行器
- `runner-renew-executed.mjs.txt`: `7f48fbf4487054aef9a1ee1e9ae3f76f1d5b908fa6911cd15cbd02b094258140`，第二代续租实际执行字节；该哈希与 `renew-proof.json` 完全一致
- `runner-current-after-review.mjs.txt`: `811892b8697cfa6c555fc3016c4f904b232accfbc0bdff10f073ffa5843d786b`，执行后仅格式化长断言的当前审阅版本
- `evidence-review.json`: `c324a5836790ef8ab204a15b04f12da8297518c1d65910d65928f6536cb80fc6`，35 项离线一致性、边界和敏感值检查

公开证据没有保存登录令牌、Authorization 值、Cookie、密码、私钥或实例私密配置。运行器源快照包含变量名和模板表达式，但没有实际凭据值。此项只证明独立预览 HTTP/API 与服务端 MCP 下的真实过期续租和精确重放，不代表 Web、Android、Windows EXE、本地 MCP、外部构建或第三方同步已经验收。
