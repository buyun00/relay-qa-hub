# Android 匿名更新与真实鉴权组合修正

本目录是独立审查之后的新证据。上一级 `result.json` 的原31/244测试结果保持原样：当时的下载 fixture 没有同时装配 `BrowserAuth` 与 `ProjectRequestContext`，不能证明实际 main 接线中的匿名更新可用。

新组合 fixture 使用真实 SQLite worker、项目服务、BrowserAuth session 和 ProjectRequestContext，通过 `createApiApp` 的现有接线，在随机 `127.0.0.1` 端口收发真实 HTTP。它不启动 main，不访问4419、其他已运行服务、设备、生产或外部组件。

旧源在 stable 与 preview 两项组合测试中均返回401而非200，原始输出是 `runs/pre-fix-composed-http.log`。这是产品接线缺陷，未修改断言来接受401。

修复只将已注册的 `/api/v1/android-updates/stable/:fileName`、`/api/v1/android-updates/preview/:fileName` 模板的 GET/HEAD 判为公开分发读取。`request.routeOptions.url` 必须精确匹配，未按请求 URL 前缀放行；每个实例仍只注册其配置的一个 channel。BrowserAuth 的 preHandler 在项目 preHandler 之前，顺序未改变。没有 session 的分发客户端可直接读取；普通项目请求仍须建立真实 session 并通过项目归属校验。

第一次修复后运行已经通过匿名分发，但新增测试的正向 Bug 列表对照误用了未注册的 `/api/v1/projects/:projectId/bugs`，所以后半断言得到404。这是测试路径错误，原 `runs/targeted-composed-http.log` 保留。改为源码实际注册的 `/api/v1/bugs?projectId=…` 后，在 `runs/targeted-composed-http-final.log` 中12/12通过。

最终组合测试覆盖：匿名 manifest、APK真实 fixture 字节、HEAD、Range、304；不存在文件404；preview 错 package 元数据503；匿名普通项目/列表和已注册的相邻测试路由401；相同下载模板的 POST 401且保护 handler 没有执行；另一 channel 匿名401、持有合法项目 session 后404；本人项目读取200、非成员项目403、显式项目冲突400。stable 旧 manifest 不新增必填 channel。fixture APK 是合成传输字节，不代表安装包签名或原生安装验证。

最终现有 API test 脚本完整执行编译及全部测试：213个 MJS + 33个 TS，共246/246，无失败、跳过或取消。新3文件 scoped eslint 与格式检查通过，原始输出保留在 `runs/`。各运行之间的失败未覆盖，hash 列于 `result.json`。

本轮没有部署、重启、发布 feed、操作 EXE/APK或读取运行数据库。API保全 runner 的准备暂停于此次修正；真正部署与 code23 feed 发布仍由 root 单独控制。此结果不将此前原31/244证据改写为组合测试已通过，也不将本地 fixture 视为已安装客户端更新验证。
