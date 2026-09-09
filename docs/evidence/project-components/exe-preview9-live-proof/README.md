# EXE .9：独立安装字节复核

**114/114 检查通过。** [机器证明](artifact-review.json)及[实际 reviewer 源码](review-source.mjs.txt)只覆盖本次安装字节、签名、回执和已留存副本；没有 UI/API/MCP/设备请求、进程控制或重新查询。未读取活 profile 应用文件；唯一显式允许的活 profile 路径是原生 updater 回执 `updates/last-update-result.json`。

目标为 `0.2.0-preview.9` / Windows `0.2.0.9`，release `20260909T011704801Z`；构建来源 `bc2b347dae282212a9119e5411b17fe144ca758c`。[原 package-only 证明](../exe-preview9-package-only/README.md)保留其构建当时“尚未发布/安装”的历史状态。

## 独立复核结果

- 已安装 EXE、updater、asar、配置逐字节匹配冻结包。asar SHA `6bc9f7508f663bd34c3896894369a7f9cafc6cc8c57542465315373a77790636`；8 个 Web entry 的大小和 SHA 全部一致，新 bundle `index-Br-CEXQI.js` SHA `813277e9792c91d27b2e153322a0a2bfcad277ec57723df712f7d84ae24ad3ae`。
- 正式 manifest 与已审核 staged manifest 完全一致；原 Ed25519 公钥校验通过。正式和 staged installer 均为 108334255 bytes / SHA `2c50fe1bf5d0f37cdf91c0e0ea449aab6b644f44669fd26a794647d990ad4336`。配置继续为原 SHA `aa98507fd6dbe84c360e845859af69c4f5ed1724975ecc10b7561015cf76ac83`，公钥未变。没有重签或读取私钥。既有包检查中的 Authenticode `NotSigned` 不等同于 Ed25519 更新签名失败；此审计没有重复 Authenticode 查询。
- 新 `RelayQaHubPreview.backup-20260909T011704801Z` 的核心文件与原 `.8` 包一致。原先 8 个 rollback 目录的已记录 marker/config 哈希与 EXE 存在性均保留；它们没有完整旧树哈希基线，因此不扩称全部旧树字节一致。先前 `.8` 升级留下的 `.7` asar 也匹配原证据。旧 `.7` / `.8` installer 保持原哈希。
- 原生 BOM-less UTF-16LE updater 回执为 `installed`、`.9`、目标 release，UTC `2026-09-09T01:44:08.000Z`；原始 SHA `0131b3d8354a42bbe00a0ee25609ae58ded2b8a33583a24a482cea639dafbd83`。原 `.8` 回执仍完整保留。该回执与文件版本不单独代表新进程/UI 已运行。
- **67 个冷副本文件 / 11579757 bytes 已独立重新计算 SHA**，逐项匹配私有 manifest `c1bef9024c01aae4fd1be651640f69ce569abd0ada3ec54109e870ea68ee6f4c`。只读已留存副本，未重新哈希活源；源→副本→源一致及 `01:43:55.136Z–01:43:56.777Z` 的观察窗口来自 root 启动的 watcher。顶层 `updates` 被刻意排除，不能称为整 profile 冷备份，也不能把端点观察扩成连续监控。

## 分开绑定的实际运行证据

Root 实际执行同一冻结 helper，前测 **53/53、11 requests**，后测 **62/62、11 requests**；本 reviewer 只校验这些公共 proof 的原 SHA 与状态，没有重复网络请求。

| 独立 local MCP 记录                                                                             | SHA256                                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [before .8](../exe-preview9-independent/f222d18f-4176-401f-9bdc-af6da4917991/before/proof.json) | `bd7801cd47c188c97b033a1f42d9c53f6b4efcfdcc5d02031a3403a80d35fc62` |
| [after .9](../exe-preview9-independent/f222d18f-4176-401f-9bdc-af6da4917991/after/proof.json)   | `c82c6b92da9b639d91090676258ca80e13e03c15b919dcd7f00c76bb0b42a12d` |

其职责是原员工 A、旧 Bug/评论、90 工具目录及 **服务端已绑定** PNG 读回。该 PNG 为 attachment `bbeaafee-effa-4265-873e-881111e40ae8`，184872 bytes，SHA `e0ed7b4b96935f06855a05ce3372ada01b9585ed459d3d5c183f1c6dc8e7cb8b`。**这不是未提交草稿 PNG 的单文件字节证明。** 未提交草稿由 root 的原生现场与独立冷副本范围另行说明。

Root 提供新 main `13564`、UTC `2026-09-09T01:44:08.4163170Z`、4420 owner 与原生窗口 `3409188`；此 artifact reviewer 没有重新查询进程。Root 随后实际观察原未提交文字和 PNG；打开旧 Bug 后第一次保留的 tree/image 显示“正在读取 Bug 详情”，随后详情和原图正常出现，没有 retry；还展开了 20 条可访问历史与原评论。以下原件来自 root 的操作，并由本 reviewer 独立哈希。没有连续全帧或真实网络错误重试结论。

所有原件位于 `C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/acceptance/exe-preview9-live-f222d18f-4176-401f-9bdc-af6da4917991`；[机器引用清单](native-source-references.json)保存绝对路径、大小、SHA 和操作者。

| Root 原生原件                          | SHA256                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| `after-original-draft-settled.json`    | `e119a3a562b7d7c259a1ee64ff4ae396bfa4e66c8e8e716cc61c805c0a59a08d` |
| `after-original-draft-settled-0.png`   | `bc13b3e9af9a316d352c31c9e41cf5f14205dd86c6f2384412c13c1374ce8f92` |
| `final-original-draft-preserved.json`  | `2723e210bd2e13464a3fa483e8dc7290a9067425324fc325674b5585df03ea5a` |
| `final-original-draft-preserved-0.png` | `4e037ff2ee90923ab589d1d5a545d5343c939298471e668499b7bf9466b3efd2` |
| `first-detail-after-click.json`        | `c2e7d59f327124805760d45080b45b9ce628623db1d8f26226f2921f55098b2c` |
| `first-detail-after-click-0.png`       | `3ed0f72346c647622c95788b3b734ca565aaede91457cb32a4a7d5c71e2af074` |
| `first-detail-loaded.json`             | `4298dfa5a8452e57578a1fcd85caee6e867ac0dded821b5ca91598eaa8d011dc` |
| `first-detail-loaded-0.png`            | `ccde8c9e19e35d43c73b5fca1c55960347748b9afaaef2c734f89fa6738d3e2d` |
| `original-history-expanded.json`       | `a3192f0c920eeabbfa96c48156935dd2ea03c3460599f661d818a37cbcebf0af` |
| `original-comment-visible.json`        | `ceb8e2f32ca99249d85f46c9b223354b1ad8ce700b86f5e4ef58cf943c499a6b` |
| `original-comment-visible-0.png`       | `b3867327cc1b8a994ad0624138b19d7e11f80fd7a216570b5fffeba958a5f79b` |

原生升级总览由根任务另行汇总至 `exe-preview9-live/f222d18f-4176-401f-9bdc-af6da4917991`，本目录不替代其结果或修改 matrix。此复核没有覆盖全部业务动作、外部组件、物理设备或所有基线。
