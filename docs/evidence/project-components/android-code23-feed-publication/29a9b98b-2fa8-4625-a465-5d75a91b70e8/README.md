# Android code23 预览 feed 实际发布

本次单次发布于 2026-09-09 01:40:47–01:40:50 UTC 完成，原执行记录为 [publish.json](publish.json)。独立产物复核 [actual-publication-review.json](actual-publication-review.json) 22/22 通过；没有重发 HTTP、CIM、ADB 或设备操作。

13 次实际请求包括：发布前匿名404；API/Web两路 manifest GET、manifest/APK HEAD、完整APK GET；32字节Range 206；旧code22完整下载；Windows .8 manifest；未选stable通道401。code23两路下载均为35,536,941字节、SHA `9cfa87eb36b5be80f218e104fb4c6338fda3e96e5dcc694d897c5907df768548`，manifest386字节SHA `6986c64031f0d013ae99f465009c1653b1f641ea25d740d316f3c6c3ae1b88d9`。4次HEAD为空响应，声明长度匹配；Range内容SHA与已留APK前32字节一致。

执行记录中的API前后均为PID22852、启动时点01:22:20.2728640Z，7条组件配置全关闭。旧code22、receipt及Windows .8 manifest已留副本哈希匹配；Windows保持结论仅针对本次发布时段，后续 .9 发布另计。

原HTTP正文没有另存逐请求raw文件；原receipt保存执行时的状态、允许的响应头、字节数及SHA，本复核将这些指纹与已留及实际Android发布文件交叉核对。公开publish与lock的通用敏感字段/JWT/Bearer/私钥扫描为0命中，未读取私有凭据。

这是预览feed发布和下载验证，不能记为Android原生应用内升级、物理设备、EXE或整项基线通过。原package/source/signature依据见 [prepare.json](prepare.json)，发布前静态审查见 [source-review.json](source-review.json)。锁与pending原件保留，未清理。
