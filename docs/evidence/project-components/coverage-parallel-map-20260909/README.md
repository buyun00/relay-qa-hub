# 并行实测证据映射与审计

本目录记录主任务在 `3b57719` 后对映射器的扩充与独立审计。新增四份冻结证据只作为 validationEvidence：Web A/B 草稿实测164项、Android原生人员实测33项、Phase A完整main实测247项，以及Phase B源码/临时HTTP/归档迁移证据。各原始JSON按字节SHA固定；本次没有据此新增业务入口通过，也没有把源码测试计作已安装客户端验收。先前提交的MCP人员59项只允许基线02/04的server_mcp入口晋级，整项仍为7/24。

- 最终 `audit-final.json`：648/648；完整运行当前/历史映射器，使用真实证据读取与内存输出，检查失败结果、人工进度与备注、复验标记、两轮稳定性；7份证据分别模拟hash篡改和缺失，篡改均在任何虚拟写入前拒绝。
- `chain.json`：实际生成器→映射器→生成器在独立临时输出目录运行两轮，12/12检查通过；613个合成失败入口及移入退役历史的两项均保留。
- `final-checks.json`：最终两脚本语法、定向ESLint及Prettier检查均exit0。映射器SHA `2ff1c4bbfcd8df06e1c093c32cbfde6f8c5f3182fbcc40dfb3a3328db5e35938`；最终审计源码SHA `142ec793779524949f5cad7acb05eab5ccccf355fd5b153ae58acf0badf16a63`。

首次审计 `audit.json` 的648项中44项失败：测试假定所有证据检查都采用actual/expected，实际Android使用passed/evidence，Phase B部分使用exitCode。仅修正审计器对三种已知结构的判断，未知结构继续拒绝；r2为648/648。r2报告的method文字沿用“三份”旧描述，但实际proofAudit数组为7份；后续改为从数组长度生成。

实际矩阵刷新后重新执行产生 `audit-r3.json`：647/648，旧审计硬编码两项必须发生状态变化，但历史映射器在已刷新输入上保留其中一项既有passed。修正预期为02/04中历史输出尚未passed的项目，仍逐项要求最终两入口passed，并拒绝任何其他入口变化；没有放宽失败保全检查。r4为648/648，其后仅格式检查失败；保留r4源码和日志，格式化后的最终执行仍648/648。全部失败JSON、各版源文件及执行helper保留，没有改写产品或原始实测结果。

最终审计所读矩阵已是[实际生成后的结果](../coverage-regeneration-live/6e77e27e-cc84-4fcb-92f5-2175eb0dd9be/README.md)，它与r2/chain原输入不同，两者各自的protectedBefore/protectedAfter明确记录。所有审计均未请求API、操作设备、启停服务或刷新业务数据。Phase B完整main的246项证据已另行提交，但不在本次映射器新增的四份证据中。
