# Phase D r2：媒体范围优先级修正

仅修改 `apps/api/src/workflow-projection.ts` 和对应 HTTP 测试；另外六个 Phase D 文件保持原字节。当前八份 source pins 与验证日志见 [result.json](result.json)。原八份源码、原 result/README 的10份逐字节副本保留于 [candidate-before/manifest.json](candidate-before/manifest.json)，原18份日志哈希也已重新核对，均未覆盖。

独立审查指出原实现合并两个通配范围的 q 值，导致更具体的 `application/*;q=0` 被 `*/*;q=1` 覆盖。新增真实随机回环 HTTP 负例先复现 **200≠406**，原始失败保留在 [before-fix-http.txt](before-fix-http.txt)：17请求、1测试失败、adapter测试仍通过。

修正后按 **精确 vendor → application/* → */*** 三层优先级选择 q 值，显式0不降级采用更宽泛类型。新增正反顺序的应用类型拒绝、精确 vendor 覆盖应用拒绝、正权重应用类型覆盖全局拒绝四个实际请求均符合预期。最终 [组合日志](combined-after.txt) 为 **5/5测试、24个实际回环 HTTP请求**；storage/API noEmit、限定八文件 lint 和 format 全部退出0。500是原有安全异常映射测试的预期响应，403/404/400/406为相应用例的预期拒绝。

接线与验收边界沿用 [原说明](../README.md)：schema17注册、worker/full-main接线、16→17迁移和实际部署尚未完成。本轮没有写 dist、启动或重启主服务、客户端操作或覆盖矩阵。该修正只证明已列媒体选择分支，不泛称所有 RFC 内容协商情况已验收。
