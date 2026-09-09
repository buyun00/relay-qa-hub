# EXE .8 → .9 应用内升级：待执行计划

状态：`prepared_not_executed`。本轮只生成新文件，检查语法、默认 inert 分支和纯内存行为；没有发布 Windows manifest、启动 watcher、调用 UI/MCP/API/设备，也没有读取真实 profile 正文。不会覆盖 `.8` 证据或已冻结的 `.9` package-only 证据。

## 固定范围

| 项目                  | 值                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 工作树                | `C:\Users\lin0\.codex\worktrees\7c86\Relay-QA-Hub`                                                                             |
| 本次 run              | `f222d18f-4176-401f-9bdc-af6da4917991`                                                                                         |
| 新私有目录            | `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview9-live-f222d18f-4176-401f-9bdc-af6da4917991` |
| 已安装身份            | `RelayQaHubPreview`，原 profile `runtime\desktop\profile`                                                                      |
| 升级前                | `.8` / native `0.2.0.8`，原 main PID `19500`                                                                                   |
| 目标                  | `.9` / native `0.2.0.9`，release `20260909T011704801Z`                                                                         |
| 构建来源              | `bc2b347dae282212a9119e5411b17fe144ca758c`                                                                                     |
| 原安装配置 SHA256     | `aa98507fd6dbe84c360e845859af69c4f5ed1724975ecc10b7561015cf76ac83`                                                             |
| `.9` installer SHA256 | `2c50fe1bf5d0f37cdf91c0e0ea449aab6b644f44669fd26a794647d990ad4336`，108334255 bytes                                            |
| `.9` manifest SHA256  | `5e2c0d17eca2829154fb97749d6c26295e15dfdce7f388a1218f0317853f6ad9`                                                             |
| `.9` asar SHA256      | `6bc9f7508f663bd34c3896894369a7f9cafc6cc8c57542465315373a77790636`                                                             |

API-only 部署已由 root 完成：其提供的新 API 身份是 PID `22852` / UTC `2026-09-09T01:22:20.2728640Z`；Web `20284`、server MCP `15736`、原 EXE `.8` `19500`、日常 EXE `17160` 保持。以上是 root 提供的边界，本准备阶段没有重新访问进程或服务。真正升级前 helper 将读取当时的完整身份；不再以 `.8` 历史证据中的 API `10036` 作为本次硬编码前提。

沿用原有 Ed25519 公钥校验已有签名，不读私钥、不重签、不换 key。Windows Authenticode 的既有 `NotSigned` 与 Ed25519 校验分开记录。源 helper 与逐处派生修改、SHA、静态检查在 [preparation.json](preparation.json) 中；完整派生源也保留为 `.mjs.txt`。实际执行使用 `.tools` 下同 SHA 文件。

首次准备的 exact-replacement 计数断言发现 `--publish-preview8` 同时存在于分支和提示字符串，实际 2 次而预期 1 次；未输出 operational helper，也未发生任何发布/网络/profile操作。首次目录和生成器原文保留在 `exe-preview9-live-e2c95c2c-569d-42fe-afce-8bcb4ca3dd09`；[失败记录](../first-preparation-failure.json) 保留。本次使用全新 run，未覆盖它。

## Root 后续执行顺序

先完成 root 当前 Android code23 feed 发布窗口，再开始此 Windows 升级窗口。以下显式命令是后续执行步骤，本轮没有运行。三个 helper 默认调用只返回 `not_run`。

1. 原生界面读回原员工 A、未提交文字和 `exe-test-input.png`，保存新的截图/原始 UI snapshot。不要提交该草稿。以精确路径记录日常 EXE/APK、API/Web/server MCP 的当时身份；不启停它们。
2. 运行独立升级前只读采集：

   ```powershell
   node .tools/exe-preview9-independent-readback.mjs --collect before 19500
   ```

   它复用当前 EXE 会话，不读取凭据文件、不调用 `qa_login`。本地 `4420/mcp` 执行 initialize、initialized notification、tools/list、`qa_get_session`、`qa_list_projects`、`qa_get_bug_context`、advertised attachment resource，并再次核对 session。目录必须是 90 项，所用工具须标记只读。固定事实是员工 `5ef57049-0e33-4476-8a3c-b320aa26bf68` / A `fb914b3b-4169-47f8-8dec-76f3a3cc780d` / 非 GM；旧 Bug `a32d175b-137c-47bd-bbd9-b952d4860b1e`、评论 `d7a5ee19-1145-4162-a9ff-44d89fa34f7c`；绑定 PNG `bbeaafee-effa-4265-873e-881111e40ae8`，184872 bytes，SHA `e0ed7b4b96935f06855a05ce3372ada01b9585ed459d3d5c183f1c6dc8e7cb8b`。六个明确生产文件只做哈希，生产/preview readiness 只做 GET。

   **这张服务端绑定 PNG 不是未提交草稿 PNG 的字节证明。** 未提交文字/图片由真实原生截图和下面的应用文件冷保全独立取证；未建立精确文件映射时不宣称单张未提交 PNG 的 SHA。

3. 升级前采集必须成功。随后执行已审核的唯一 `.9` 发行物发布：

   ```powershell
   node .tools/publish-exe9-reviewed.mjs --publish-preview9
   ```

   该 helper 重新核对 staged installer/manifest/release/hash/公钥、原安装配置、正式 `.8` manifest 的固定 SHA，保存前一 manifest、原安装配置和先前 updater result。旧 `.7`、`.8` 安装器留在原位置并核哈希。新 `.9` installer 用 exclusive copy；manifest 以同目录唯一临时文件写入再 atomic rename，仅覆盖该 preview 的 Windows latest。随后 HTTP 读回 `4274` 上的 exact manifest 与 installer，核对字节/hash；不会触发安装。所有部分成功产物保留，不删除目的文件强行重试。此步骤不改 Android feed，也不改 served Web。

4. 在原生“安装并重启”动作前，单独启动只读 watcher；保存它的独立 exec session：

   ```powershell
   node .tools/exe9-cold-state-watch.mjs --watch
   ```

   watcher 起始必须观察到 exact preview PID19500、4420 属于它。只等待实际 updater 导致的正常退出，最长 180 秒；不发 quit/kill/install。只有所有 exact-path preview 进程退出且 4420 无 listener 后才读取并复制 profile 应用文件。排除顶层 `updates`，因为 updater 正在写入该目录；它们由旧/新 updater result 与安装器留存另行证明。其他目录不排除，拒绝链接，exclusive copy 到新 `private-cold-application-state`，比较源→副本→源全文件清单、bytes/SHA，并再次确认没有 preview 进程或 listener。若重启过快或窗口不够，保留失败/部分副本，不能为了补证强停客户端。该结果只证明成功观察到的退出窗口，不把“曾短暂没有 listener”扩大成复制期间绝无瞬时重启的连续证明。

5. Root 使用原生窗口实际点击“检查更新 → 安装并重启”。不得直接执行安装器并称作应用内升级。期间固定已审核 manifest。记录旧 main PID 退出、新 exact-path PID/启动时间、updater `last-update-result.json`（可能 UTF-16LE）、其 release/version/timestamp 和旧 `.8` rollback 目录。仅关闭窗口到托盘不算退出。安装配置、原 public key 和 profile 路径必须保持。
6. 新 PID 已确认后，用同一 SHA 的 helper 运行独立升级后采集：

   ```powershell
   # 用实际新主进程 PID 替换占位符；必须不是 19500。
   node .tools/exe-preview9-independent-readback.mjs --collect after ACTUAL_NEW_MAIN_PID
   ```

   它要求 `.9` / MCP `.9`，完整比较 before 的原 session/project/Bug/comments/PNG、90 工具目录、生产哈希。API/Web/server MCP/日常进程与非4420 listeners 使用本次 before 的 PID/创建时间/路径比较；除升级主进程外不允许身份变化。本次 collection 内还做前后稳定检查。所有 raw body 和 PNG 保留私有，公开 proof 递归脱敏并保留 primitive JSON string，输出 create-only。

7. Root 另做实际原生回读：原员工 A、原未提交文字和 PNG 可见；打开旧 Bug，首次选择时应显示加载而非无错误依据的失败，响应后正常显示详情。保存初始与完成两种状态；若有真实网络错误保留它，不能将 source 单测替代此实际 UI 结论。核 installed asar/config、8 个 Web entry（新 bundle `index-Br-CEXQI.js`，SHA `813277e9792c91d27b2e153322a0a2bfcad277ec57723df712f7d84ae24ad3ae`）、版本与 staged 包一致。

## 结果边界

新 before/after raw 目录固定在本次 runtime 内 `independent-before` / `independent-after`；未来公共读取证明在 `exe-preview9-independent/<run>/before|after`。脚本拒绝已有输出，失败后保留而不覆盖。首次准备残留的 `.tools/exe9-live-current.json` 指向失败 run，仅作为保留记录；本次三个 helper 均读取 `.tools/exe9-live-f222d18f-4176-401f-9bdc-af6da4917991.json` 或固定本次路径，不使用旧指针。

本计划未证明 `.9` 已发布、安装、自升级、冷保全、MCP 重启、草稿保留或原生加载修复。既有 `.8` 和 `.9` package-only 证据继续保留原字节。应用恢复、90 项工具目录只读抽样、单张 bound PNG 和未提交草稿分别陈述；不扩大到全部工具执行、外部组件或全部基线通过。不要修改 matrix/根文档来先行标记这些尚未运行的步骤。
