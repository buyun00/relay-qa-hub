# Web 双标签与撤销资格后的草稿恢复

2026-09-08T17:47:27.078Z；实际浏览器操作通过。

- 同一浏览器会话的两个标签各自选定A/B；A保留文字、人员和JPEG，B保留不同文字且无A附件。
- A membership v1→revoked/v2，A轮询后自动移除业务页面并显示本地草稿恢复；B保持可操作。
- A撤权期间B实际创建DWB1788889232622-1；后端读回B正确project/reporter/文本，0附件；A仍0个Bug。
- 真实点击文本与JPEG保存，Downloads生成701字节JSON和43311字节JPEG；导出projectId/A文本/人员/File元数据正确，JPEG哈希与原始完全相同。
- GM显式恢复A至membership v3；重新姓名登录自动恢复原A草稿、修复人、关闭人及JPEG。B页面保持自己的项目。

测试身份 Web双窗1788889232622；A b79a70c9-ef3e-4d85-b376-247c473789a9，B 25e1d898-9e59-4dbb-998e-bfebf2abc0bf。成员撤销/恢复审计和HTTP读回见 dual-window-fixture.json；截图、DOM、导出文件哈希见 JSON。此结果只覆盖同一浏览器的两个标签，不把它推广为所有独立设备并发或人工延迟注入验证。
