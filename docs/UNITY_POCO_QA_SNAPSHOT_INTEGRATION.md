# Unity Poco QA Snapshot 对接说明

> 历史说明（实施前审计稿）：文中“当前不存在 `qa.snapshot`”等判断已被后续实现取代。当前权威实现与扩展契约请以 `docs/UNITY_POCO_SNAPSHOT_IMPLEMENTATION_GUIDE.md` 为准；本文件仅保留早期边界和回滚背景，不再作为现状证明。

状态：设计与用户执行手册（2026-08-26）。本轮只写文档，未修改 Unity 工作区、Relay、Jenkins，也未构建或安装任何 Unity APK。QA Hub Android APK 与 Unity 游戏 APK 是两条完全独立的构建链。

## 1. 适用范围与已审计事实

目标是给 QA Hub Android 现场采集客户端提供一个**可选的、只读的 Unity 上下文补充**。QA Hub API/数据库仍是 Bug、附件、状态和审计的唯一事实源；Poco 不可用、超时或返回不完整时，普通 MediaProjection 截图仍必须能够创建草稿和提交缺陷。

本说明基于以下已审计事实：

- Unity 版本为 `2022.3.62f3`。
- 当前 active fork 是 `baloot_client/Assets/ThirdParty/Airtest/PocoSDK`。
- `Assets/Standard Assets/PocoSDK`（以及其他旧目录）是 legacy，不是本次修改目标。
- active Poco 当前只有 5 个标准 RPC；`qa.snapshot`、`PocoMethod`、`Invoke` 均不存在。不要根据其他版本的示例假装这些 API 已存在。
- 当前 TCP 服务绑定 `IPAddress.Any`，会暴露到局域网；必须改为显式 loopback。
- 当前 framing 使用 `Encoding.Default`，并按字符长度而不是 UTF-8 byte length 计数；中文或非 ASCII 数据可能造成截断/错帧，必须修正。

先在 Unity 仓库确认 active fork 的真实注册表、服务器和 framing 类型名，再把下面的结构映射到已有类型。文中的 `PocoRpcRegistry`、`PocoTcpServer` 等是**结构示意名**，不是对当前 SDK 类型名的断言；不得为迁移方便新造一套并行服务器。

## 2. 最小文件清单

只在 Unity 项目的 active fork 内修改以下职责对应的文件；实际文件名以搜索结果为准：

1. 现有 Poco RPC registry/handler 文件：增加 exact `qa.snapshot` 的只读注册和处理器。不得引入 generic `Invoke`、反射扫描或任意方法分派。
2. 现有 Poco TCP server/bootstrap 文件：把监听地址改为 `IPAddress.Loopback`/`127.0.0.1`，加入 QA 构建门禁和 5001..5005 端口选择。
3. 现有 framing/codec 文件：统一使用 `Encoding.UTF8`，长度以 byte 数计，所有读取使用 exact-byte 语义并检查上限。
4. 新增一个小型 snapshot DTO/provider 文件，例如 `QaPocoSnapshotProvider.cs`：只暴露明确的内部状态接口，不从 App 或其他进程读取数据。
5. 新增或更新 `link.xml`：仅保留 IL2CPP 下被 exact registry 直接创建的 DTO/provider/handler 类型；不启用全程序集反射保留。
6. Unity QA/Debug 构建设置中的 scripting define 或等价配置：例如 `QA_POCO_BRIDGE`；只有 QA/Debug 或 `OZDQP_AI_TESTING` 才允许启动。

不要修改 `D:\Relay-QA-Hub\apps\android` 来“实现” Unity bridge，也不要把 Unity APK 放入 QA Hub APK 的构建或发布目录。

## 3. 目标边界与请求/响应契约

### 3.1 传输与请求

App adapter 只尝试 loopback 的 5001..5005，并先用短超时的标准 `GetSDKVersion` 握手。握手或后续调用失败时返回 `unavailable`，不阻断系统截图/缺陷草稿。

在已有 Poco RPC registry 中直接注册方法名 `qa.snapshot`。请求体使用 UTF-8 JSON，字段如下（v1）：

```json
{
  "method": "qa.snapshot",
  "captureId": "01J8Q0K3M4E8Y0J4E4ZJ9C8J5N",
  "nonce": "b64url-16-to-32-random-bytes",
  "deadlineMs": 800,
  "schemaVersion": 1,
  "want": ["screenSize", "sdkVersion", "qaSnapshot", "dump", "profiling"]
}
```

约束：

- `captureId` 是 App 同一次取证会话的唯一 ID；Poco 响应必须原样 echo，不能自行生成另一个 ID。
- `nonce` 每次请求随机且不可复用。Unity 进程保存一个有限的短期 nonce cache（建议 TTL 30 秒、最多 64 项），重复 nonce 直接拒绝。
- `deadlineMs` 必须是 `1..3000` 的整数；处理开始后超过 deadline 只返回超时/部分结果，不继续运行耗时采集。
- `schemaVersion` 只接受已实现的版本（当前为 `1`）。未知版本返回 `unsupported_schema`。
- `want` 只能包含固定 allowlist；未知项目拒绝，不把它解释为任意方法名。
- 请求总 byte 数建议不超过 16 KiB；超限先丢弃，再解析 JSON。

### 3.2 响应

成功、部分成功和不可用都返回同一形状；App 以 `enrichmentStatus` 决定展示“已获取 Unity 上下文 / 部分 / 未连接”。

```json
{
  "ok": true,
  "method": "qa.snapshot",
  "captureId": "01J8Q0K3M4E8Y0J4E4ZJ9C8J5N",
  "schemaVersion": 1,
  "enrichmentStatus": "complete",
  "data": {
    "build": {
      "version": "qa-2026.08.26.1",
      "gitSha": "0123456789abcdef0123456789abcdef01234567"
    },
    "scene": "MainMenu",
    "gameTimeSeconds": 123.45,
    "testUserId": "sha256:6a2f...",
    "level": "tutorial-01",
    "mode": "qa",
    "network": {
      "environment": "staging",
      "region": "cn-test",
      "reachable": true
    },
    "screenSize": { "width": 1440, "height": 2560 },
    "sdkVersion": "1.0.0",
    "recentErrors": [
      { "code": "E_EXAMPLE", "message": "bounded and redacted", "ageSeconds": 2 }
    ],
    "custom": { "modeVariant": "A" }
  },
  "artifacts": {
    "unityScreenshot": {
      "encoding": "base64",
      "contentType": "image/png",
      "byteLength": 123456,
      "data": "..."
    },
    "uiDump": {
      "encoding": "gzip+base64",
      "contentType": "application/json",
      "byteLength": 2345,
      "data": "..."
    }
  },
  "errors": []
}
```

失败或部分结果仍须带 `captureId`，例如：

```json
{
  "ok": false,
  "method": "qa.snapshot",
  "captureId": "01J8Q0K3M4E8Y0J4E4ZJ9C8J5N",
  "schemaVersion": 1,
  "enrichmentStatus": "unavailable",
  "data": null,
  "artifacts": {},
  "errors": [{ "code": "deadline_exceeded", "retryable": true }]
}
```

建议 v1 上限：单个请求 16 KiB，元数据 JSON 256 KiB，压缩后的 UI hierarchy 512 KiB，Unity PNG 8 MiB，`recentErrors` 最多 10 条、每条 message 最多 256 个 Unicode scalar；所有数组和字符串都要在 DTO 反序列化前后再检查一次。超限返回 `limit_exceeded`，不能静默截断成看似完整的数据。录屏过程中不要持续 Dump 全层级，只在用户打点或停止录屏时调用一次。

## 4. provider 与安全 DTO

Provider 只读、同步边界短、字段显式。业务项目提供接口，QA bridge 只依赖该接口，不把业务状态硬编码到 Android App：

```csharp
public interface IQaSnapshotProvider
{
    QaSnapshotPayload Collect(in QaSnapshotRequestContext context);
}

public readonly struct QaSnapshotRequestContext
{
    public readonly string CaptureId;
    public readonly DateTimeOffset DeadlineUtc;
    public readonly int SchemaVersion;
}

public sealed class QaSnapshotPayload
{
    public string BuildVersion { get; init; }
    public string GitSha { get; init; }
    public string Scene { get; init; }
    public double GameTimeSeconds { get; init; }
    public string RedactedTestUserId { get; init; }
    public string Level { get; init; }
    public string Mode { get; init; }
    public string NetworkEnvironment { get; init; }
    public string NetworkRegion { get; init; }
    public bool? NetworkReachable { get; init; }
    public IReadOnlyList<QaRecentError> RecentErrors { get; init; }
    public IReadOnlyDictionary<string, string> Custom { get; init; }
}
```

实际工程可把 DTO 属性改为项目的序列化风格，但只允许上述意义的字段。测试用户标识必须是不可逆或项目批准的脱敏 ID；`Custom` 只允许预注册的 key。禁止采集账号 token、cookie、聊天内容、支付信息、通知栏内容、设备文件路径、完整网络 URL/query、任意玩家隐私或内部密钥。错误日志必须先做数量、byte、字段和敏感词限制。

建议注册结构（伪代码，需按 active fork 的真实 registry API 改名）：

```csharp
// 由 QA 构建显式创建，不扫描程序集，不调用 generic Invoke。
registry.RegisterReadOnly(
    "qa.snapshot",
    new QaSnapshotRpcHandler(provider, screenshotReader, dumpReader, limits));
```

`QaSnapshotRpcHandler` 只能识别 `qa.snapshot`，并将请求映射到固定的 `screenSize/sdkVersion/profiling/dump/qaSnapshot` 采集函数。不要添加 `SetText`、touch、`SendMessage`、任意 method name 或反射调用入口。`qa.snapshot` 若在旧 SDK 的 registry 中无法安全接入，则第一版只提供标准 `Screenshot`/`Dump`，把自定义字段标为 unavailable；不能假装支持新扩展。

## 5. screenshot、Dump 与 captureId 的采集顺序

App 悬浮球点击时先隐藏悬浮球，用同一个 `captureId` 和时间戳并发/近并发收集：

1. Android MediaProjection 的用户所见系统画面（主证据）。
2. Poco Screenshot 的干净 Unity framebuffer（可得时）。
3. Poco `Dump(true)` 的可见 UI hierarchy（压缩、裁剪、上限）。
4. `GetScreenSize`、`GetSDKVersion`、profiling（可得时）。
5. `qa.snapshot`（能力存在且 handshake 成功时）。

Unity 采集失败必须只影响对应 artifact，并在响应 `errors` 中给出稳定 code；不能使普通截图缺陷失败。所有证据包在 QA Hub 侧以同一 `captureId` 关联。`ReadPixels`/Poco Dump 必须在 Mono 与 IL2CPP、弱机上测量 P50/P95 延迟和帧影响；若超出项目允许的现场阈值，降低采集频率或标记 partial，不能在录屏期间循环 Dump。

## 6. loopback、端口与 framing

### 6.1 监听地址和构建门禁

Poco 服务必须显式绑定 `IPAddress.Loopback`（只接受 `127.0.0.1`），绝不再使用 `IPAddress.Any`。QA Hub App adapter 也只连 `127.0.0.1`，不扫描局域网、不把 Poco 当 LAN 服务。Android 17 同机 loopback 不应凭空增加广泛的 `ACCESS_LOCAL_NETWORK` 权限；未来连接真实局域网设备时再单独评估权限。

服务只允许在以下构建/运行条件同时满足时启动：

- QA/Debug 构建，或定义了 `OZDQP_AI_TESTING`；并且
- 显式的 QA bridge 开关已打开。

Release 构建中不得启动监听器、不得保留可被远程开启的隐藏开关。启动日志只写端口、版本和状态，不写 token/nonce/用户数据。对同机恶意客户端仍按不可信处理：短超时、nonce/deadline、严格 allowlist 和大小限制必须保留。

### 6.2 5001..5005 探测与握手

按 5001、5002、5003、5004、5005 顺序尝试 `127.0.0.1`。每个端口连接和 `GetSDKVersion` 使用短超时（建议 connect 200 ms、单 RPC 800 ms），成功后缓存当前会话端口；端口被占用、服务不是 Poco、协议错误或超时都进入下一个端口。所有端口失败返回 `unavailable`，App 继续使用 MediaProjection。不得通过广播或 LAN 探测找到其他 App 的 Poco。

### 6.3 严格 UTF-8 byte framing

修复现有 framing 时必须遵守：

```csharp
static readonly Encoding WireEncoding = new UTF8Encoding(false, true);
const int MaxFrameBytes = 2 * 1024 * 1024;

byte[] EncodeFrame(string json)
{
    byte[] payload = WireEncoding.GetBytes(json);
    if (payload.Length > MaxFrameBytes) throw new ProtocolLimitException();
    // 协议的长度前缀写 payload.Length，而不是 json.Length。
    return WriteLengthPrefixAndPayload(payload.Length, payload);
}

string DecodeFrame(Stream stream)
{
    int byteLength = ReadLengthPrefix(stream);
    if (byteLength < 0 || byteLength > MaxFrameBytes)
        throw new ProtocolLimitException();
    byte[] payload = ReadExactly(stream, byteLength);
    return WireEncoding.GetString(payload);
}
```

长度前缀的端序和宽度必须沿用现有 Poco 协议，但计算值必须是 UTF-8 bytes；读写不得用 `Read` 一次就假定拿满，必须循环到 exact byte count 或连接关闭。无效 UTF-8、负长度、超限、半帧、额外尾部数据都要安全失败并关闭当前连接。用包含中文/emoji 的协议回归证明发送方和接收方不会再按字符数错帧。

## 7. IL2CPP 保留与兼容

在 active fork 的 QA 构建资源中加入最小 `link.xml`（示意）：

```xml
<linker>
  <assembly fullname="Assembly-CSharp">
    <type fullname="Company.Qa.QaSnapshotRpcHandler" preserve="all" />
    <type fullname="Company.Qa.QaSnapshotProvider" preserve="all" />
    <type fullname="Company.Qa.QaSnapshotPayload" preserve="all" />
  </assembly>
</linker>
```

把 `Company.Qa...` 替换为项目真实 namespace/type；只保留 exact registry 会实例化的类型，不因方便而保留整个业务程序集。Mono 和 IL2CPP 都要验证：`GetSDKVersion`、标准 Screenshot/Dump、`qa.snapshot`（若该版本接入）和超限/超时路径行为一致。若旧版 Poco 没有可用 direct registry API，保留标准 RPC，并将自定义 snapshot 作为小型、可审计的兼容补丁；不要引入 `PocoMethod`/`Invoke` 反射模拟。

## 8. 用户执行的最小验证

以下是 Unity 项目维护者需要在本地执行的定向验证；本轮未由 QA Hub 侧执行或确认：

1. 在 active fork 中搜索并确认实际 Poco 版本、registry、server、framing 文件；确认没有误改 `Standard Assets/PocoSDK` legacy。
2. 编辑器/QA 构建启动后，用 `127.0.0.1:5001..5005` 验证 `GetSDKVersion`；占用 5001 时验证回退到下一可用端口。
3. 发送上面的 `qa.snapshot` 请求，确认 response 的 `captureId` 原样一致、schema/version 正确，超时、重复 nonce、未知 want、超大 hierarchy 和 deadline 失败均返回稳定错误而非卡住游戏。
4. 用中文/emoji 字段做 framing 回归；确认 `Encoding.UTF8.GetByteCount` 与实际 payload byte 数一致，不能出现半帧。
5. 用 `netstat`/Windows 防火墙或等价手段证明 `127.0.0.1` 可连接、局域网 IP 不可连接；确认 QA bridge 仅在 QA/Debug/OZDQP_AI_TESTING 启动，Release 不启动。
6. 分别跑 Mono、IL2CPP；覆盖横竖屏、弱机、切后台、Unity 崩溃、App 被杀、Poco 不存在、旧版/超时和 `FLAG_SECURE` 场景。Poco 不可用时，普通 MediaProjection 截图仍能提交。
7. 录屏期间确认没有持续 Dump；在用户打点或停止时最多拉取一次。记录 `ReadPixels`/Dump P50/P95 与帧影响。

除 loopback 之外，不要把 Wi-Fi/LAN 暴露作为“方便调试”的替代方案。App adapter 的允许列表只包含只读 RPC，不能连接或控制另一台设备。

## 9. 回滚方案

若出现帧率回退、协议不兼容、IL2CPP 崩溃或 loopback 端口无法安全约束：

1. 关闭 QA 构建中的 QA bridge 开关，发布 QA 包不再启动 Poco listener；普通 MediaProjection/附件上传保留。
2. 在 Unity 仓库中只回退本次变更涉及的 registry、server、framing、DTO/provider、link.xml 文件（优先使用已提交的单一变更 commit 的 `git revert`，不要 reset/clean 用户工作树）。
3. 暂时只使用标准 `Screenshot`/`Dump`，App 将 `qa.snapshot` 标为 `unavailable`；不能伪造 complete。
4. 若问题来自 active fork 版本差异，保留失败证据和版本号，重新按旧版标准 RPC 方案评估；不得把修复移植到 legacy 目录。

## 10. 用户负责的提交、Jenkins 与 MuMu 步骤

这些步骤需要 Unity 项目维护者自行执行，本轮没有执行、没有提交 Unity main、没有点击 Jenkins、没有下载 `/apk`、没有安装 Unity APK：

1. 在 `D:\Relay-Unity-Orchestrator` 对应的 Unity 项目 active fork 完成本地修改和 Mono/IL2CPP 定向验证，人工检查只改了 `baloot_client/Assets/ThirdParty/Airtest/PocoSDK` 及明确列出的 QA 文件。
2. 在 Unity 项目的 `main` 提交变更；提交前不要 reset、clean、stash、rebase 或覆盖已有用户改动。QA Hub 仓库不替代 Unity 仓库提交。
3. 由用户在 Jenkins 页面点击既有 Unity 项目的构建按钮，记录该次构建号、提交 SHA 和产物来源。只有该提交确实包含 Poco QA bridge 修改后，才从对应 `/apk` 下载**该次 Unity APK**。
4. 连接 MuMu 后核对真实 API：

   ```powershell
   $adb = 'C:\Users\lin0\AppData\Local\Android\Sdk\platform-tools\adb.exe'
   & $adb connect 127.0.0.1:16384
   & $adb -s 127.0.0.1:16384 shell getprop ro.build.version.sdk
   & $adb -s 127.0.0.1:16384 shell getprop ro.build.version.release
   ```

   安装的是 Unity 游戏 APK，不是 `D:\Relay-QA-Hub\apps\android\app\build\outputs\apk\debug\app-debug.apk`。用 `adb install -r <本次Unity APK>` 后，在 QA/Debug 构建内验证 loopback Poco、同一 `captureId` 和 fallback。

5. QA Hub Android APK 仍由 `D:\Relay-QA-Hub` 自有 Gradle 工程构建；不要使用 Unity Jenkins 或 Unity `/apk` 代替 QA Hub APK。

完成上述本地步骤后，用户应把构建号、Unity commit、APK SHA-256、MuMu `ro.build.version.sdk`、Poco 端口、Mono/IL2CPP 结果和失败项回填 QA Hub 证据。当前这些外部步骤均未验证，不得在 QA Hub `PROGRESS.md` 中标为已完成。
