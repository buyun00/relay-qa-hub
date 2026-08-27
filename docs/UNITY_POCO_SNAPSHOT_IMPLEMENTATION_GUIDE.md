# Unity Poco 只读快照扩展：实施与验证手册

> Unity 版本：2022.3.62f3  
> 使用方式：把本文带到存有 Unity 工程的电脑，按顺序修改并验证即可。  
> 本文不要求实施者了解任何管理平台、服务端或任务流程。

## 1. 交付目标

在现有 Poco 只读服务上新增一个 `qa.snapshot` RPC，用于读取少量 Unity 运行时状态。

完成后必须满足：

1. 只在 Debug/测试包中启动；Android 正式 Release 包默认不启动。
2. 只监听本机 `127.0.0.1`，不得监听局域网地址。
3. 沿用现有端口回退：`5001`～`5005`。
4. 保留并兼容现有五个只读 RPC：
   - `Screenshot`
   - `GetScreenSize`
   - `Dump`
   - `GetDebugProfilingData`
   - `GetSDKVersion`
5. 新增且只新增精确方法 `qa.snapshot`。
6. 不允许任意方法调用、反射调用、脚本执行或游戏状态修改。
7. TCP 帧统一使用 UTF-8 字节长度，中文和 emoji 不错帧。
8. Mono/Editor 与 IL2CPP/Android 均能返回快照。
9. 快照明确返回当前业务 UI form/prefab 与最近 120 秒的有界、脱敏 Error/Exception/Assert；标准 `Dump(true)` 继续返回实际节点层级。

## 2. 修改范围

当前实际使用的 Poco 目录：

```text
Assets/ThirdParty/Airtest/PocoSDK/
```

现有启动入口：

```text
Assets/AppAssets/BuildIn/Scripts/Fsbm/Runtime/PocoAutomationBootstrap.cs
```

修改或新增这些文件：

```text
Assets/ThirdParty/Airtest/PocoSDK/PocoManager.cs
Assets/ThirdParty/Airtest/PocoSDK/TcpServer.cs
Assets/ThirdParty/Airtest/PocoSDK/link.xml
Assets/ThirdParty/Airtest/PocoSDK/QaSnapshotBridge.cs                 # 新增
Assets/AppAssets/BuildIn/Scripts/Fsbm/Runtime/OzdqpQaSnapshotProvider.cs # 新增，文件名可调整
```

不要修改旧分支：

```text
Assets/Standard Assets/PocoSDK/
```

不要创建第二个 Poco Server 或第二个 Bootstrap。所有扩展接入现有 `PocoManager`。

## 3. 协议必须保持一致

### 3.1 TCP 帧

```text
[4 字节小端序正文长度][UTF-8 JSON 正文]
```

长度值必须是 UTF-8 `byte[]` 的长度，不能使用 `json.Length`。

最大输入帧：2 MiB。  
`qa.snapshot` 最大结果：256 KiB。

### 3.2 JSON-RPC 请求

`qa.snapshot` 参数放在 `params[0]`：

```json
{
  "jsonrpc": "2.0",
  "id": "snapshot-1",
  "method": "qa.snapshot",
  "params": [
    {
      "schemaVersion": 1,
      "captureId": "6f53a12c9d6f4a409bbce03efcdf2c6a",
      "nonce": "f6257eb6f2b4460db4ce37dc42154790",
      "deadlineUnixMs": 1787712345678
    }
  ]
}
```

校验规则：

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 当前必须为 `1` |
| `captureId` | 1～64 个字符；响应原样返回 |
| `nonce` | 16～128 个字符；30 秒内不得重复 |
| `deadlineUnixMs` | 收到时未过期，且不得比当前 UTC 时间晚超过 3 秒 |

### 3.3 成功结果

```json
{
  "jsonrpc": "2.0",
  "id": "snapshot-1",
  "result": {
    "schemaVersion": 1,
    "captureId": "6f53a12c9d6f4a409bbce03efcdf2c6a",
    "status": "complete",
    "capturedAtUnixMs": 1787712345200,
    "data": {
      "appVersion": "1.2.3",
      "unityVersion": "2022.3.62f3",
      "platform": "Android",
      "scene": "Lobby",
      "uptimeSeconds": 125.4,
      "screenWidth": 1920,
      "screenHeight": 1080,
      "buildCommit": "abc1234",
      "environment": "test",
      "gameMode": "ranked",
      "levelId": "level_02",
      "userHash": "sha256:...",
      "custom": {
        "matchId": "1000234"
      }
    }
  }
}
```

业务 Provider 未注册或部分字段暂不可取时，仍返回 `result`，但设置：

```json
{
  "status": "partial",
  "warnings": ["business_provider_unavailable"]
}
```

请求不合法时返回 JSON-RPC `error`。客户端只应看到稳定错误码：

```text
QA_SNAPSHOT_INVALID_PARAMS
QA_SNAPSHOT_SCHEMA_UNSUPPORTED
QA_SNAPSHOT_EXPIRED
QA_SNAPSHOT_NONCE_REUSED
QA_SNAPSHOT_RESPONSE_TOO_LARGE
rpc_failed
```

禁止把 `exception.ToString()`、堆栈、本地路径或内部配置返回给客户端。

## 4. 修改 `TcpServer.cs`

### 4.1 改为严格 UTF-8

在 `SimpleProtocolFilter` 中增加：

```csharp
private const int HeaderSize = 4;
private const int MaxFrameBytes = 2 * 1024 * 1024;
private const int MaxBufferedBytes = MaxFrameBytes + HeaderSize;

private static readonly Encoding WireEncoding =
    new UTF8Encoding(false, true);
```

`pack` 按 UTF-8 字节数写小端长度：

```csharp
public byte[] pack(string content)
{
    byte[] payload = WireEncoding.GetBytes(content ?? string.Empty);
    if (payload.Length <= 0 || payload.Length > MaxFrameBytes)
        throw new InvalidOperationException("protocol_frame_size_invalid");

    int length = payload.Length;
    byte[] frame = new byte[HeaderSize + length];
    frame[0] = (byte)(length & 0xff);
    frame[1] = (byte)((length >> 8) & 0xff);
    frame[2] = (byte)((length >> 16) & 0xff);
    frame[3] = (byte)((length >> 24) & 0xff);
    Buffer.BlockCopy(payload, 0, frame, HeaderSize, length);
    return frame;
}
```

`input(byte[] data)` 追加数据前先限制缓冲区：

```csharp
if (data == null || data.Length == 0)
    return;

if (data.Length > MaxBufferedBytes - buf.Length)
{
    buf = Array.Empty<byte>();
    throw new InvalidOperationException("protocol_buffer_limit_exceeded");
}
```

从 `buf` 读取小端长度并在分配正文前校验：

```csharp
int bodyLength =
    buf[0] |
    (buf[1] << 8) |
    (buf[2] << 16) |
    (buf[3] << 24);

if (bodyLength <= 0 || bodyLength > MaxFrameBytes)
{
    buf = Array.Empty<byte>();
    throw new InvalidOperationException("protocol_frame_size_invalid");
}
```

收齐 `HeaderSize + bodyLength` 后解码：

```csharp
string message = WireEncoding.GetString(data_body);
```

不能假设一次 socket `Read` 就得到整帧；继续使用缓冲区循环，直到正文收齐或连接关闭。

严格 UTF-8 解码失败、负长度、0 长度、超限或缓冲区超限时：

1. 清空当前客户端的协议缓冲区。
2. 关闭当前客户端连接。
3. 只记录稳定错误码。
4. 不影响 Server 接受下一条新连接。

### 4.2 不改变现有 RPC 数据结构

传输层修复后，以下结果必须保持：

```text
GetSDKVersion.result == 6
Screenshot.result == [base64Jpeg, "jpg"]
```

## 5. 修改 `PocoManager.cs`

### 5.1 仅绑定回环地址

增加：

```csharp
using System.Net;
```

将：

```csharp
new AsyncTcpServer(port + i)
```

改为：

```csharp
new AsyncTcpServer(IPAddress.Loopback, port + i)
```

继续依次尝试 `5001`～`5005`，第一个成功后停止。日志打印实际监听结果：

```text
Poco read-only RPC listening on 127.0.0.1:5001
```

监听结果不得是：

```text
0.0.0.0:500x
[::]:500x
局域网IP:500x
```

### 5.2 注册 `qa.snapshot`

在现有 RPC 注册代码旁增加：

```csharp
rpc.addRpcMethod("qa.snapshot", QaSnapshot);
```

增加处理函数：

```csharp
private object QaSnapshot(List<object> param)
{
    return QaSnapshotBridge.Handle(param);
}
```

不得恢复或新增：

```text
Invoke(methodName, ...)
SendMessage(...)
SetText(...)
任意反射调用
任意 C# 类型名或成员名调用
```

### 5.3 清理错误响应

现有 `RPCParser` 若使用 `exception.ToString()` 作为回包 message，改为：

```csharp
string publicMessage = exception is QaSnapshotRpcException
    ? exception.Message
    : "rpc_failed";

Debug.LogException(exception); // 完整详情只写本机日志
errorDefinition["message"] = publicMessage;
```

`QaSnapshotRpcException.Message` 只能是第 3.3 节中的稳定错误码。

## 6. 新增 `QaSnapshotBridge.cs`

位置：

```text
Assets/ThirdParty/Airtest/PocoSDK/QaSnapshotBridge.cs
```

该文件与现有 Poco 代码属于同一个程序集，负责：

1. 把 `parameters[0]` 转为 `JObject`。
2. 校验 schema、captureId、nonce、deadline。
3. 维护最多 64 条、保留 30 秒的 nonce 缓存。
4. 收集 Unity 通用字段。
5. 调用业务侧注册的 Provider。
6. 截断超长字段并限制结果为 256 KiB。
7. 返回普通 DTO 或 `Dictionary<string, object>`。

### 6.1 对外类型

```csharp
public interface IQaSnapshotProvider
{
    QaGameSnapshotData Collect();
}

public sealed class QaGameSnapshotData
{
    public string BuildCommit;
    public string Environment;
    public string GameMode;
    public string LevelId;
    public string UserHash;
    public Dictionary<string, string> Custom;
    public QaUiSnapshot Ui;
    public List<QaRecentError> RecentErrors;
    public int RecentErrorWindowMs;
    public int DroppedErrorCount;
}

public sealed class QaSnapshotRpcException : Exception
{
    public QaSnapshotRpcException(string code) : base(code) { }
}
```

桥接类至少暴露：

```csharp
public static void SetProvider(IQaSnapshotProvider provider);
public static object Handle(List<object> parameters);
```

业务程序集引用 Poco 程序集并注册 Provider；Poco 程序集不要反向引用 `Assembly-CSharp`，否则容易形成循环依赖。

### 6.2 默认 Unity 数据

没有 Provider 时也要采集：

```csharp
Application.version
Application.unityVersion
Application.platform.ToString()
SceneManager.GetActiveScene().name
Time.realtimeSinceStartup
Screen.width
Screen.height
```

此时返回 `status = "partial"` 和 `business_provider_unavailable`，不能因为业务字段缺失让整个 RPC 失败。

### 6.3 处理顺序

`Handle` 按以下顺序执行：

1. `parameters` 必须只有一个对象参数。
2. `schemaVersion` 必须为 `1`。
3. 校验 `captureId`、`nonce` 的非空和长度。
4. 校验 deadline 未过期且不超过当前时间后 3 秒。
5. 清理过期 nonce；发现重复 nonce 立即拒绝。
6. 记录本次 nonce。
7. 收集默认 Unity 数据。
8. Provider 存在时调用 `Collect()`；单个业务字段失败时返回 `partial`。
9. 再检查一次 deadline；已超时时返回 `partial`，绝不等待或重试。
10. 序列化预检；结果超过 256 KiB 时拒绝或裁剪 `custom`。

### 6.4 数据限制

- `Custom` 最多 20 项。
- key 最多 64 个字符。
- value 最多 256 个字符。
- 最近错误如需返回，最多 10 条，每条必须脱敏、截断。
- 截图和完整 UI 树不要塞进 `qa.snapshot`；继续调用已有 `Screenshot` 和 `Dump`。

禁止返回：

- token、cookie、密码、手机号、身份证或完整设备标识。
- 原始用户 ID、聊天正文、支付信息。
- 本地绝对路径、服务器密钥、完整异常堆栈。
- 可用于任意类型反序列化的类型名或对象图。

`userHash` 只能是不可逆哈希或已有匿名测试标识。

### 6.5 截图时页面与近期错误（必接调试字段）

基础场景名、版本号不足以辅助定位 UI Bug。`schemaVersion=1` 保持不变，在 `data` 中增加以下可选字段；旧 App 和旧数据必须继续兼容：

```json
{
  "data": {
    "ui": {
      "loadedCount": 8,
      "shownCount": 1,
      "truncated": false,
      "omittedCount": 0,
      "groups": [
        {
          "name": "MenuLayer",
          "depth": 40,
          "forms": [
            {
              "assetKey": "Assets/UI/Hall/Hall-3_optimized.prefab",
              "prefabName": "Hall-3_optimized",
              "instanceName": "Hall-3_optimized(Clone)",
              "rootInstanceId": -4452,
              "shown": true,
              "logicVisible": true,
              "activeSelf": true,
              "activeInHierarchy": true,
              "siblingIndex": 7,
              "isCurrent": true
            }
          ]
        }
      ]
    },
    "recentErrors": [
      {
        "type": "Exception",
        "message": "NullReferenceException in HallLobbyMainView",
        "stackTrace": "HallLobbyMainView.Refresh()\nHallView.OnOpen()",
        "firstAtUnixMs": 1787795179000,
        "lastAtUnixMs": 1787795179000,
        "occurrences": 1,
        "fingerprint": "sha256:..."
      }
    ],
    "recentErrorWindowMs": 120000,
    "droppedErrorCount": 0
  }
}
```

职责必须拆开：

- 标准 `Dump(true)` 继续提供截图时的 GameObject/Transform 子树；不要把第二份完整树塞入 `qa.snapshot`。
- `data.ui` 只提供 Poco 不知道的业务语义：UI group、form/prefab 资源键、逻辑可见性、层级顺序和当前页。
- `rootInstanceId` 必须等于标准 Dump 节点的 `payload._instanceId`，供 QA Hub 把业务页面与实际子树对上。
- `recentErrors` 由游戏进程内部缓存；Android App 不得尝试跨应用读取 logcat。

当前项目可直接使用的 UI 只读入口是 `FsbmEntry.UI`、`UIManager` 的 UI groups、`IUIGroup.CurrentUIForm/UIForms`、`IUIForm.AssetName/Handle/Group` 与 `UIFormLogic.Visible`。页面顺序使用 group `Depth`、root Transform 的 `GetSiblingIndex()` 和 `CurrentUIForm`，不要依赖当前未刷新的 `DepthInUIGroup`。

页面数据上限：group 最多 16 个，form 最多 64 个；只返回 `shown && activeInHierarchy` 的 form。达到上限时必须设置 `truncated=true`、`omittedCount` 并追加稳定 warning `ui_context_truncated`。

### 6.6 近期错误环形缓冲

在游戏进程启动早期订阅 `Application.logMessageReceivedThreaded`，只接收 `LogType.Error`、`LogType.Exception`、`LogType.Assert`。线程回调中只能处理字符串、时间戳和有界内存队列，不得访问 GameObject、Scene、UI，也不得再次调用 `Debug.Log`。

固定边界：

- 内存 ring 最多 64 条不同错误，保留最近 120 秒；相同 fingerprint 合并 `occurrences/firstAt/lastAt`。
- 每次 snapshot 最多返回最新 10 条。
- message 最多 256 个 Unicode scalar 且最多 1 KiB UTF-8。
- `stackTrace` 可选，只保留脱敏后的前 8 帧且最多 2 KiB UTF-8；不得返回本地绝对路径或完整原始调用栈。
- token、cookie、Authorization、手机号、URL query、账号标识和本地路径必须在进入 ring 前 fail-closed 脱敏；脱敏异常时丢弃该条或写 `[redacted]`，绝不保留原文。
- Provider 在 Unity 主线程同步复制 ring 快照，不读磁盘、不调 Android logcat、不等待异步任务。

QA Hub Web 已按上述字段兼容读取：有字段且数组为空表示“窗口内无错误”；字段缺失表示“当前游戏构建尚未接入”，不能把二者混为一谈。

## 7. 新增业务 Provider

建议位置：

```text
Assets/AppAssets/BuildIn/Scripts/Fsbm/Runtime/OzdqpQaSnapshotProvider.cs
```

参考结构：

```csharp
using System.Collections.Generic;
using UnityEngine;

namespace Fsbm.Runtime
{
    internal sealed class OzdqpQaSnapshotProvider : IQaSnapshotProvider
    {
        public QaGameSnapshotData Collect()
        {
            return new QaGameSnapshotData
            {
                // 替换成项目已有的真实只读 getter。
                BuildCommit = BuildInfo.Commit,
                Environment = RuntimeEnvironment.CurrentName,
                GameMode = GameState.CurrentMode,
                LevelId = GameState.CurrentLevelId,
                UserHash = AnonymousUserId.CurrentHash,
                Custom = new Dictionary<string, string>
                {
                    ["matchId"] = MatchState.CurrentMatchId,
                    ["roomState"] = MatchState.CurrentRoomState
                }
            };
        }
    }

    internal static class OzdqpQaSnapshotRegistration
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Register()
        {
            QaSnapshotBridge.SetProvider(new OzdqpQaSnapshotProvider());
        }
    }
}
```

示例中的 `BuildInfo`、`GameState`、`MatchState` 等是占位名，必须替换为项目真实代码。没有可靠来源的字段先不返回，不要为了快照另造一套状态缓存。

Provider 必须：

- 在 Unity 主线程同步完成。
- 正常耗时小于 10 ms，硬上限 50 ms。
- 只读，不发送网络请求，不读取大文件，不等待异步任务。
- 不改变场景、UI、账号、战斗或网络状态。
- 不长期持有 Scene、GameObject 或大对象引用。

## 8. 启动条件与 IL2CPP

### 8.1 `PocoAutomationBootstrap.cs`

保留现有单一启动入口。Android 上只允许以下任一条件成立时创建 `PocoManager`：

```text
Debug.isDebugBuild == true
或定义了 OZDQP_AI_TESTING
```

未定义 `OZDQP_AI_TESTING` 的 Release 正式包必须在创建 GameObject/Manager 前直接返回。

### 8.2 `link.xml`

仅为确实通过反射或 JSON 映射访问的具体类型增加保留规则。确认 IL2CPP 中以下类型不会被裁剪：

```text
QaSnapshotBridge
QaSnapshotRpcException
QaGameSnapshotData
IQaSnapshotProvider 的实际实现类
```

如果所有 DTO 都通过直接 C# 调用和 Dictionary 构造，优先依靠静态引用。不要直接对整个游戏程序集使用 `preserve="all"`。

## 9. 真实验证顺序

不要逐个小函数反复做形式测试。代码完成后直接按下列顺序跑通主链路，非阻断问题先记下，最后统一处理。

### 9.1 Unity 编译与启动

1. 打开项目并等待 Script Compilation 完成。
2. Console 不得出现新增编译错误。
3. 进入 Play Mode。
4. Hierarchy/日志确认只存在一个 `PocoManager`。
5. 日志确认实际监听 `127.0.0.1:5001`～`5005` 中的一个端口。

### 9.2 Windows 探测脚本

把下面内容临时保存为 `Probe-PocoSnapshot.ps1`，不必提交到 Unity 仓库：

```powershell
param([int]$Port = 5001)

$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false, $true

function Read-Exact([System.IO.Stream]$Stream, [int]$Count) {
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) { throw "connection_closed" }
        $offset += $read
    }
    return ,$buffer
}

function Invoke-PocoRpc([string]$Method, [object[]]$Params) {
    $request = [ordered]@{
        jsonrpc = "2.0"
        id = [Guid]::NewGuid().ToString("N")
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 10 -Compress

    $payload = $utf8.GetBytes($request)
    $header = [BitConverter]::GetBytes([int]$payload.Length)
    if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.ReceiveTimeout = 3000
        $client.SendTimeout = 3000
        $client.Connect("127.0.0.1", $Port)
        $stream = $client.GetStream()
        $stream.Write($header, 0, $header.Length)
        $stream.Write($payload, 0, $payload.Length)

        $responseHeader = Read-Exact $stream 4
        if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($responseHeader) }
        $responseLength = [BitConverter]::ToInt32($responseHeader, 0)
        if ($responseLength -le 0 -or $responseLength -gt 2097152) {
            throw "invalid_response_length:$responseLength"
        }

        $responseBody = Read-Exact $stream $responseLength
        return ($utf8.GetString($responseBody) | ConvertFrom-Json)
    }
    finally {
        $client.Dispose()
    }
}

$version = Invoke-PocoRpc "GetSDKVersion" @()
$version | ConvertTo-Json -Depth 10

$request = [ordered]@{
    schemaVersion = 1
    captureId = [Guid]::NewGuid().ToString("N")
    nonce = [Guid]::NewGuid().ToString("N")
    deadlineUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 2000
}

$snapshot = Invoke-PocoRpc "qa.snapshot" @($request)
$snapshot | ConvertTo-Json -Depth 10
```

预期：

- `GetSDKVersion.result` 为整数 `6`。
- `qa.snapshot.result.captureId` 与请求一致。
- Provider 已注册时 `status` 为 `complete`；未注册时允许 `partial`。
- `scene`、`appVersion`、屏幕尺寸和运行时间存在。
- `data.ui.groups[].forms[]` 能指出当前 shown/current form、prefab assetKey、siblingIndex 和 rootInstanceId。
- `rootInstanceId` 能在同一 captureId 的 `Dump(true)` 中找到相同 `_instanceId` 节点及其子树。
- 触发一条测试 Error/Exception 后，`recentErrors` 在 120 秒窗口内出现；空窗口明确返回 `[]`。
- 响应没有完整原始异常堆栈、绝对路径或敏感信息。

### 9.3 中文和 emoji

让一个安全的 Provider 测试字段临时返回：

```text
大厅-中文-🙂
```

重新运行探测脚本。该值必须完整返回，并且紧接着的下一次请求仍然成功。这证明帧长度按 UTF-8 字节数计算。

### 9.4 端口回退

1. 用临时程序占用 `127.0.0.1:5001`。
2. 再进入 Play Mode。
3. Poco 应选择 `5002`～`5005` 中第一个空闲端口。
4. 用 `-Port` 指定实际端口，两个 RPC 均应成功。
5. 释放 `5001` 后重新启动，服务可以回到 `5001`。

以日志和实际 TCP 监听为准，不能把配置端口误当成实际端口。

### 9.5 回环监听

Editor 运行时执行：

```powershell
Get-NetTCPConnection -State Listen |
    Where-Object LocalPort -In 5001,5002,5003,5004,5005 |
    Select-Object LocalAddress,LocalPort,OwningProcess
```

预期 `LocalAddress` 为 `127.0.0.1`，不能是 `0.0.0.0`、`::` 或局域网 IP。

### 9.6 非法请求后恢复

至少验证：

1. `schemaVersion = 2`。
2. 已过期 deadline。
3. 连续两次相同 nonce。
4. 不存在的方法名。
5. 帧长度为负数、0 或超过 2 MiB。
6. 只发送半个正文后断开。

每种情况均应满足：

- 当前连接被拒绝或关闭。
- Unity 不崩溃、不冻结。
- 下一条合法请求仍成功。
- 客户端看不到堆栈或本地路径。

### 9.7 Android Debug/测试包

安装并启动 APK 后，把电脑端口转发到 Android 设备回环端口：

```powershell
adb forward tcp:15001 tcp:5001
.\Probe-PocoSnapshot.ps1 -Port 15001
```

若 Unity 实际监听 `5002`：

```powershell
adb forward tcp:15002 tcp:5002
.\Probe-PocoSnapshot.ps1 -Port 15002
```

验证结束后清理：

```powershell
adb forward --remove tcp:15001
adb forward --remove tcp:15002
```

设备允许时检查监听：

```powershell
adb shell ss -ltn
```

只能出现 `127.0.0.1:5001`～`5005`，不能出现 `0.0.0.0:500x`。

### 9.8 Release 关闭

构建未定义 `OZDQP_AI_TESTING` 的 Android Release 包：

1. 启动游戏。
2. 日志中没有 Poco 监听成功信息。
3. 设备 `5001`～`5005` 均无监听。
4. 游戏本身正常启动和运行。

### 9.9 Mono 与 IL2CPP

| 后端 | 必须验证 |
|---|---|
| Mono/Editor | 标准 RPC、`qa.snapshot`、中文/emoji、非法帧后恢复 |
| IL2CPP/Android | 服务启动、标准 RPC、`qa.snapshot`、业务字段存在 |

若 IL2CPP 中只有业务字段缺失，先检查 Provider 注册时机和 `link.xml`，不要先扩大整个程序集的保留范围。

## 10. 提交前清单

- [ ] 只修改有效 Poco 目录，没有修改旧 Poco 分支。
- [ ] 没有第二个 Server 或 Bootstrap。
- [ ] 只监听 `127.0.0.1`。
- [ ] 端口在 `5001`～`5005`，端口占用时可回退。
- [ ] 帧长度使用 UTF-8 字节数。
- [ ] 输入帧、缓冲区和快照结果都有上限。
- [ ] 原有五个只读 RPC 正常。
- [ ] 只新增 `qa.snapshot`，没有任意 Invoke/反射入口。
- [ ] Provider 快速、同步、只读、无额外网络和大文件读取。
- [ ] 页面 form/prefab 与 Dump `_instanceId` 能对应，达到上限时明确标记 truncated。
- [ ] 最近错误 ring 仅收 Error/Exception/Assert，120 秒/64 条/返回 10 条边界生效。
- [ ] 响应没有敏感数据、绝对路径或完整原始异常堆栈。
- [ ] 重放、过期和非法帧会被拒绝。
- [ ] 非法连接后下一条合法请求仍成功。
- [ ] Debug/测试包可用，Release 正式包不监听。
- [ ] Mono 验证通过。
- [ ] IL2CPP Android 验证通过。

## 11. 完成后提供这些结果

```text
1. Unity 提交 SHA
2. 实际修改文件列表
3. Debug/测试包的启用条件
4. 实际监听地址和端口
5. GetSDKVersion 返回结果
6. 脱敏后的 qa.snapshot 成功响应
7. 中文/emoji 结果
8. Release 不监听结果
9. Mono 与 IL2CPP 结果
10. 不阻断主链路、准备以后再处理的问题
```

## 12. 回滚方法

如果改动引起构建或运行问题：

1. 保存 Console、Player 日志和复现步骤。
2. 回滚本次对 `PocoManager.cs`、`TcpServer.cs`、`link.xml` 的修改。
3. 删除本次新增的 Bridge 和 Provider 文件。
4. 重新编译并确认原有五个只读 RPC 恢复。
5. 不要通过修改或删除旧 Poco 目录处理程序集冲突；应检查新增文件位置和 asmdef 引用。

建议把本次 Unity 修改保持为一个独立提交，便于审查、移植和回滚。
