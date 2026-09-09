# 原 code23 preview feed：发布准备

状态：脚本作者准备完成，作者未执行。本目录记录脚本、临时文件/纯内存测试与静态检查；作者没有执行 prepare/publish，没有读取运行instance/数据库/APK，没有连接HTTP、设备或操作服务。API部署是root另行完成的事实。

随后root已实际执行prepare并审阅候选，执行run为29a9b98b-2fa8-4625-a465-5d75a91b70e8，plan SHA86a6711c18d3c06cf718d875dad9a9fc29d003397ab5619584a4adb42a75afc0。该实际结果属于另一个run目录，不将全任务继续标为尚未prepare。下文命令是准备时交接给root的分阶段方案，作者未代为运行。

脚本为 scripts/project-components/publish-preview-android-code23.mjs，SHA256 6606d9564506ae6af7ba7e404c81db605403a7be95cac40a5d2eb374909b3a1b；测试文件SHA256 a78ab5a096756b119eede7355b42a317cce1d098a2f922227b65bfa30301471a。

## 固定产物与目标

原code23 APK仍为 runtime/android-code23-recovery-65ee5dc8-3f23-4f28-ad97-daa1de8b0ece/qa-hub-preview-code23.apk，35,536,941B，SHA256 9cfa87eb36b5be80f218e104fb4c6338fda3e96e5dcc694d897c5907df768548。package为 com.relayqahub.android.preview.debug，code23 / 0.2.0-preview.9，来源commit 33514cde1862e448cb56d7082177f34a88e42363。签名结论绑定相同APK bytes及保留的原apksigner/原生证据，本脚本不重编译或安装。

唯一feed目录是显式instance的 downloads/android/qa-hub-preview-7c86。正式名 Relay-QA-Hub-Android-23-0.2.0-preview.9.apk；manifest固定schema1/channel preview/package/code/version/fileName/size/SHA/sourceCommit。这是现有Android元数据，不是Ed25519签名清单。

新安装默认项目仍为 b9a42a41-c15d-4393-8568-61d22a30ba98；原安装同origin保留已选项目，可从项目入口/登录面板选择。发布不改身份、runtimeConfig或项目，不以同code不同bytes更换默认项目。

## 给 root 的分阶段命令（作者未执行）

默认无参数只返回not_run，runtimeReads/writes/httpRequests均为0。准备阶段只在全新acceptance和公共proof目录写候选，不创建正式feed目录，不调用HTTP：

~~~powershell
$taskInstance = 'C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\instance.json'
$taskFeedId = [Guid]::NewGuid().ToString()
node scripts/project-components/publish-preview-android-code23.mjs --prepare $taskInstance $taskFeedId absent
if ($LASTEXITCODE -ne 0) { throw 'Keep original feed and preparation failure' }
~~~

absent是明确预期；如root已审旧latest存在，须换成其完整SHA。旧metadata必须是preview包、code不大于23，完整bytes保留。候选在 runtime/acceptance/android-code23-feed-UUID/candidate，私有plan是同父目录prepare.json。公共proof在 docs/evidence/project-components/android-code23-feed-publication/UUID/prepare.json，其中planFile.sha256是下一阶段明确审批参数。

root先审候选、原APK SHA/来源、旧latest状态和保留内容，再单独执行：

~~~powershell
$taskRunnerSha = '6606d9564506ae6af7ba7e404c81db605403a7be95cac40a5d2eb374909b3a1b'
$taskApprovedPlanSha = '<root审阅后确认的64位planFile.sha256>'
$taskApprovedAfterSha = '6c362d01dffe02afd6e017cef2b4e71f0d7337ad06bb5c56b890853c54affe0b'
node scripts/project-components/publish-preview-android-code23.mjs --publish $taskInstance $taskFeedId $taskRunnerSha $taskApprovedPlanSha $taskApprovedAfterSha
if ($LASTEXITCODE -ne 0) { throw 'Preserve failure; no automatic rollback' }
~~~

after证据绑定root部署UUID 7a94eb90-63a2-4841-afa5-318612eb06ce。脚本验证after完整SHA、before完整SHA绑定、两者passed/全部checks、固定retention runner hash、必需数据/其余入口保持检查、schema14/off；并重新核4419当前CIM/receipt/监听归属仍是after记录的进程，重新只读确认所有组件off。冻结API源码8文件及retention helper共9个hash必须匹配。

## 发布与失败保留

发布前再次核候选/保留副本、原包、feed完整清单和instance hash。匿名preview最新若原来缺失，须实际404 + ANDROID_UPDATE_NOT_FOUND；401、未配置、未注册路由404或503不视作可发布。旧feed存在则匿名GET必须与预审完整bytes/hash相同。

创建永久保留的.code23-publication.lock，防止另一次code23发布尝试。APK先复制到同目录唯一pending文件，核完整hash并fsync，再用硬链接原子创建正式名，不能覆盖已有文件。相同bytes已有APK只读复用，异hash拒绝；pending名保留。

latest先写同目录唯一pending文件并fsync，立即再次校验旧preimage。旧latest存在时先在acceptance完整保留，再同目录rename原子替换；原来缺失则hardlink原子create-only。已有latest替换会消耗pending名，但候选manifest和旧完整副本保留。只有精确latest允许替换；code22、receipt、Windows latest均不覆盖、不删除。

root须维持独占feed发布窗口。lock协调本脚本调用，文件系统并不提供针对任意不遵守lock的进程的SHA比较加rename事务。遇到lock/失败不自动解除或回滚；失败proof、候选、pending、原包、旧metadata保留。后置失败可能发生在latest已发布之后，记录failed_retained，不改成成功。

## 后置读取范围（本脚本尚未执行）

- 4419 preview和4274直接downloads分别完整GET manifest/APK、HEAD manifest/APK；核完整35,536,941B/SHA/MIME，4274核实例头。
- 4419 APK Range bytes=0-31须206、精确Content-Range和原包32B一致。4274现有静态server不支持Range，本脚本不虚构其206合同。
- 4274旧code22完整GET仍为原bytes/hash，Windows latest完整GET及源文件hash不变，保留副本也校验。
- 未选stable在真实鉴权组合下须401/UNAUTHENTICATED，不能提供preview alias；与裸route fixture的404边界不同。
- 发布前后API进程身份不变。只使用固定匿名GET/HEAD，无cookie/token，不调用Bug、MCP工具或组件执行接口。

每请求保存方法/URL/时窗/状态/bytes/hash和响应头白名单，排除Set-Cookie/Authorization，不写APK或未知响应正文。完整body仅在内存比较。请求ledger不计镜像。

首轮7/7及最终9/9原始输出保留，无失败覆盖。最终包含源码pin/错误部署证据拒绝、create-only APK、旧manifest保留、原子替换和stale preimage拒绝、HTTP白名单/敏感header过滤/超限拒绝；HTTP均为纯内存Response，没有网络连接。scoped eslint、nodecheck、Prettier通过。

准备不增加物理Android、原生安装或22→23应用内更新结论。当前已装23的设备可能显示up-to-date，发布和下载不等于原生升级验收。
