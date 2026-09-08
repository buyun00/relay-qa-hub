# 提交前保密审查

审查时间：2026-09-09 03:04（UTC+08）。本报告仅记录路径、类别、数量和处置，不包含凭据值。工作树仍有其他代理更新，本结论绑定此时快照，不代表后续新增文件已自动通过。

已修复 8 份 MCP 证据中的实际会话凭据泄漏：响应对象已脱敏，但 `content[].text` 内序列化 JSON 原来未递归处理。共发现 8 处 CSRF token 和 6 处 access token；没有测试其当前有效性，也没有撤销会话或修改预览配置。

| 路径                                                                                                                                                             | 类别                                       | 是否实际秘密及处置                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `runs/desktop-mcp-core-2026-09-08T17-18-02-431Z.json`、`runs/desktop-mcp-core-2026-09-08T17-52-57-495Z.json`                                                     | MCP 登录响应内嵌 JSON 的 CSRF token        | 是；已脱敏                                           |
| `runs/mcp-core-2026-09-08T16-46-18-719Z.json`、`runs/mcp-core-2026-09-08T17-05-10-894Z.json`、`runs/mcp-core-2026-09-08T17-16-36-112Z.json`                      | MCP 登录响应内嵌 JSON 的 CSRF/access token | 是；已脱敏                                           |
| `runs/server-mcp-core-2026-09-08T17-52-56-155Z.json`、`runs/server-mcp-core-2026-09-08T18-19-05-946Z.json`、`runs/server-mcp-core-2026-09-08T18-22-11-243Z.json` | MCP 登录响应内嵌 JSON 的 CSRF/access token | 是；已脱敏                                           |
| `coverage-matrix.json` 的 `sourceHashes`                                                                                                                         | 文件名含 Credential，值为 SHA-256          | 否；代码文件哈希                                     |
| `production-inventory.json` 的 `externalTargets[].secretDirectory`                                                                                               | 凭据目录引用                               | 否；未包含目录内凭据内容                             |
| `runs/management-2026-09-08T17-13-45-912Z.json`、`runs/management-2026-09-08T17-53-20-441Z.json` 的 `credentialRef`                                              | 凭据引用字段                               | 否；与 `management.smoke.mjs` 内模拟配置字面量一致   |
| `automation-api.md`、`component-runtime.md`                                                                                                                      | Authorization/password/token 示例          | 否；变量引用及明确的替换占位符                       |
| `apps/*/test/**`、Android `src/test/**`、Web `*.test.*`、`packages/storage/test/**`                                                                              | 密码、cookie、token 测试字面量             | 扫描命中经复核为合成 fixture；不是生产或预览运行凭据 |

上表 `runs/` 等简写均相对于 `docs/evidence/project-components/`。8 份原件先以排他创建方式精确复制到工作树外唯一私有目录；复制前后、脱敏前均校验 SHA。每份工作树文件原子替换后，保留原有 runId、通过状态与检查数量。原件路径及新旧 SHA 见 [commit-safety-redaction.json](commit-safety-redaction.json)，原件内容仅保留在该清单指定的 runtime 私有目录，不可提交。

`scripts/project-components/mcp-core.smoke.mjs` 的 `redact` 现在递归解析合法 JSON 字符串，按字段名移除 token、secret、password、cookie、authorization、private key、API key、credential，大小写不敏感；超过 64 层时以固定标记替换。非 JSON 诊断文本保留，因此新增自由文本日志仍需检查，不能把字段脱敏当作所有日志的自动保密保证。

验证：`node --test scripts/project-components/redaction.test.mjs` 5/5，通过真实脱敏函数的 MCP 双份响应、重复 JSON 编码、数组、字段变体、正常证据保留/幂等和深度上限检查。测试只加载脱敏函数，不运行 smoke 的登录及业务请求。Prettier 与 `git diff --check` 通过。

最终扫描覆盖 138 个已修改路径、255 个未跟踪路径和证据目录，共读取 365 个文本文件，其中包含 5 份被 ignore 的 `.log`。14 处原始凭据值仅在内存中用于精确比对，残留命中为 0；8 对原件/脱敏文件 SHA 全部通过。新增私钥 PEM 和常见服务商密钥字面量模式命中为 0。此项为文本审查，不声称完成图片 OCR、二进制反编译或整个历史仓库的秘密扫描。此时暂存区为空。

提交边界：

- 需要纳入评审的改动包括 `apps/android`、`apps/api`、`apps/desktop`、`apps/web`、`packages/storage`、`packages/upload-contract` 的源与测试、`scripts/project-components`、设计文档和已脱敏的 `docs/evidence/project-components`。新增未跟踪源、测试和证据应显式选择，不能只提交 `git diff` 中的已跟踪文件。本次新增 `redaction.test.mjs`、本报告和脱敏清单均应保留。
- `apps/desktop/vendor/ozdqp-uploader/ozdqp-uploader.exe` 是已跟踪且有意更新的供应组件，属于明确例外；其 README 固定 SHA 已与实际文件匹配。它需要随供应组件源码/自测证据一并评审，不应误认作可随意删除的临时构建产物；本报告不声称检查其二进制内部凭据。
- 不应暂存 `node_modules`、`**/dist`、Android `.gradle`/`**/build`/`captures`、APK、桌面 `release`/`.packaging-stage-*`、uploader `bin`/`obj`、覆盖率和临时测试目录、`local.properties`、`.env*`、keystore、SQLite/WAL/SHM、业务数据与缓存。现有 ignore 规则覆盖这些常见路径；不得以强制添加绕过边界。
- 工作树外的 `parallel-runtimes/qa-hub-preview-7c86` 整体不属于提交范围，尤其是 `private-evidence-originals`、运行配置、离线迁移数据副本和真实附件。Android `app/build/evidence` 中的原始捕获、草稿及回退 APK 同样只作本地保留。
- `backend-api-regression-final.log`、`backend-storage-regression-final.log`、`desktop-unit.log`、`format-check.log`、`lint-check.log` 已纳入文本检查，未发现实际凭据，但仍由 `*.log` 忽略。没有自动强制添加或改名；如需进入提交，应明确选择经过审查的证据格式并重新核对哈希。

脱敏完成后已通知覆盖矩阵维护者重新计算这 8 份 proof 的 SHA；不要继续引用脱敏前哈希作为当前工作树文件哈希。
