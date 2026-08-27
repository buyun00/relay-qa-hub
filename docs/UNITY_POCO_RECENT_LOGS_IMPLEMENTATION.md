# Unity Poco 截图附带最近日志：修改与验证

## 1. 修改文件

新增：

```text
Assets/ThirdParty/Airtest/PocoSDK/QaRecentLogBuffer.cs
```

修改：

```text
Assets/ThirdParty/Airtest/PocoSDK/QaSnapshotBridge.cs
```

如果现有文件使用 namespace，新文件必须使用和 `QaSnapshotBridge.cs` 相同的 namespace。

## 2. 新增日志缓冲区

新建 `QaRecentLogBuffer.cs`，内容如下。代码只收集 `Error`、`Assert`、`Exception`，忽略普通 `Log` 和 `Warning`。内存中最多保留 100 条报错，每次快照最多返回最近 120 秒内的最新 10 条。

```csharp
using System;
using System.Collections.Generic;
using UnityEngine;

// 如果 QaSnapshotBridge.cs 有 namespace，把本文件放进同一个 namespace。

[Serializable]
public sealed class QaRecentLogEntry
{
    public long timeUnixMs;
    public string level;
    public string message;
    public string stackTrace;
}

public static class QaRecentLogBuffer
{
    private const int BufferCapacity = 100;
    private const int DefaultSnapshotCount = 10;
    private const long DefaultMaxAgeMs = 120 * 1000L;
    private const int MaxMessageCharacters = 512;
    private const int MaxStackTraceCharacters = 2048;

    private static readonly object Gate = new object();
    private static readonly Queue<QaRecentLogEntry> Entries =
        new Queue<QaRecentLogEntry>(BufferCapacity);

    private static readonly DateTime UnixEpoch =
        new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    private static void ResetState()
    {
        Application.logMessageReceivedThreaded -= OnLogMessageReceived;

        lock (Gate)
        {
            Entries.Clear();
        }
    }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterAssembliesLoaded)]
    private static void Install()
    {
        // 防止重复注册。
        Application.logMessageReceivedThreaded -= OnLogMessageReceived;
        Application.logMessageReceivedThreaded += OnLogMessageReceived;
    }

    private static void OnLogMessageReceived(
        string condition,
        string stackTrace,
        LogType type)
    {
        if (type != LogType.Error &&
            type != LogType.Assert &&
            type != LogType.Exception)
        {
            return;
        }

        var entry = new QaRecentLogEntry
        {
            timeUnixMs = UtcNowUnixMs(),
            level = type.ToString(),
            message = Truncate(condition, MaxMessageCharacters),
            stackTrace = Truncate(stackTrace, MaxStackTraceCharacters),
        };

        lock (Gate)
        {
            while (Entries.Count >= BufferCapacity)
            {
                Entries.Dequeue();
            }

            Entries.Enqueue(entry);
        }
    }

    public static List<QaRecentLogEntry> GetSnapshot()
    {
        return GetSnapshot(DefaultSnapshotCount, DefaultMaxAgeMs);
    }

    public static List<QaRecentLogEntry> GetSnapshot(
        int maxCount,
        long maxAgeMs)
    {
        if (maxCount <= 0 || maxAgeMs <= 0)
        {
            return new List<QaRecentLogEntry>();
        }

        lock (Gate)
        {
            QaRecentLogEntry[] source = Entries.ToArray();
            long cutoffUnixMs = UtcNowUnixMs() - maxAgeMs;
            var result = new List<QaRecentLogEntry>(
                Math.Min(maxCount, source.Length));

            for (int i = source.Length - 1;
                 i >= 0 && result.Count < maxCount;
                 i--)
            {
                QaRecentLogEntry item = source[i];
                if (item.timeUnixMs < cutoffUnixMs)
                {
                    break;
                }

                // 从队尾向前读取，再插到列表头部，保持时间正序。
                result.Insert(0, new QaRecentLogEntry
                {
                    timeUnixMs = item.timeUnixMs,
                    level = item.level,
                    message = item.message,
                    stackTrace = item.stackTrace,
                });
            }

            return result;
        }
    }

    private static long UtcNowUnixMs()
    {
        return (long)(DateTime.UtcNow - UnixEpoch).TotalMilliseconds;
    }

    private static string Truncate(string value, int maxCharacters)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        return value.Length <= maxCharacters
            ? value
            : value.Substring(0, maxCharacters);
    }
}
```

不要在 `OnLogMessageReceived` 中调用 `Debug.Log`，否则会再次触发回调并形成递归。

## 3. 接入 `qa.snapshot`

在 `QaSnapshotBridge.Handle(...)` 中找到构造 `result.data` 的位置，在最终序列化之前加入 `recentLogs`。

如果 `data` 是 `Dictionary<string, object>`：

```csharp
data["recentLogs"] = QaRecentLogBuffer.GetSnapshot(10, 120 * 1000L);
```

如果 `data` 是 DTO，给 DTO 增加字段：

```csharp
public List<QaRecentLogEntry> recentLogs;
```

构造 DTO 时赋值：

```csharp
recentLogs = QaRecentLogBuffer.GetSnapshot(10, 120 * 1000L),
```

保持现有内容不变：

- 不修改 `qa.snapshot` 方法名。
- 不增加新的 RPC。
- 不修改 `schemaVersion`。
- 不修改现有 `captureId`、`nonce`、`deadline` 校验。
- 不修改现有 `status` 判定。
- 保留现有 256 KiB 响应大小检查。

没有日志时正常返回空数组：

```json
"recentLogs": []
```

有日志时返回格式：

```json
{
  "schemaVersion": 1,
  "captureId": "原请求的 captureId",
  "status": "complete",
  "data": {
    "recentLogs": [
      {
        "timeUnixMs": 1787790000456,
        "level": "Exception",
        "message": "NullReferenceException: Object reference not set",
        "stackTrace": "BattleView.Refresh() ..."
      }
    ]
  }
}
```

## 4. Editor 验证

### 4.1 产生测试日志

在现有测试入口临时执行：

```csharp
Debug.Log("[QA_LOG_TEST] normal");
Debug.LogWarning("[QA_LOG_TEST] warning");
Debug.LogError("[QA_LOG_TEST] error");
Debug.Assert(false, "[QA_LOG_TEST] assert");

try
{
    throw new InvalidOperationException("[QA_LOG_TEST] exception");
}
catch (Exception exception)
{
    Debug.LogException(exception);
}
```

### 4.2 调用快照

使用现有 Poco RPC 探测脚本调用：

```text
qa.snapshot
```

确认响应满足：

1. `data.recentLogs` 存在。
2. 能看到 `error`、`assert`、`exception` 三条测试日志。
3. 看不到 `normal` 和 `warning`。
4. `level` 分别为 `Error`、`Assert`、`Exception`。
5. Assert 和 Exception 的 `stackTrace` 不为空。
6. `captureId` 与请求一致。
7. 原有场景、版本和业务字段仍然存在。

### 4.3 验证数量上限

临时执行：

```csharp
for (int i = 0; i < 120; i++)
{
    Debug.LogError("[QA_LOG_LIMIT_TEST] " + i);
}
```

再次调用 `qa.snapshot`，确认：

1. `recentLogs` 只有 10 条，并且只包含最近 120 秒的日志。
2. 返回的是 `110`～`119` 的最新日志。
3. `qa.snapshot` 响应没有超过现有 256 KiB 上限。

### 4.4 验证重新启动

停止并重新进入 Play Mode，立即调用 `qa.snapshot`，确认上一次运行的测试日志已经清空。

## 5. Android IL2CPP 验证

1. 构建当前 Poco 已启用的 Android 测试包。
2. 安装并启动游戏。
3. 在游戏中触发一条可识别的测试日志，例如：

   ```csharp
   Debug.LogError("[QA_ANDROID_LOG_TEST] error");
   ```

4. 不退出游戏，使用 QA Hub 悬浮球截图。
5. 等待 Poco 采集完成后打开 Bug 草稿并提交。
6. 找到该次截图对应的 `poco_snapshot.json`。
7. 确认：

   - `captureId` 与本次截图一致。
   - `data.recentLogs` 中存在 `[QA_ANDROID_LOG_TEST] error`。
   - `level` 为 `Error`。
   - 原有 Poco Screenshot、Dump 和其他 `qa.snapshot` 字段没有丢失。

8. 不产生任何新日志，再截图一次，确认即使 `recentLogs` 为空或只有之前的少量日志，截图和提单仍正常完成。

## 6. IL2CPP 字段缺失时处理

如果 Editor 返回正常，但 Android IL2CPP 的 `recentLogs` 字段或成员丢失，在现有 `link.xml` 中精确保留新增类型。把 namespace 替换为实际值：

```xml
<linker>
  <assembly fullname="实际 Poco 程序集名">
    <type fullname="实际命名空间.QaRecentLogEntry" preserve="all" />
    <type fullname="实际命名空间.QaRecentLogBuffer" preserve="all" />
  </assembly>
</linker>
```

重新构建 IL2CPP APK，再执行第 5 节验证。

## 7. 常见问题检查

### `recentLogs` 不存在

检查：

1. `QaSnapshotBridge` 是否确实执行了 `GetSnapshot(10)`。
2. 新字段是否放在最终返回的 `result.data` 中。
3. 是否在加入字段之后又被另一段 DTO 转换覆盖。

### `recentLogs` 一直为空

检查：

1. `QaRecentLogBuffer.Install()` 是否执行。
2. 是否订阅了 `Application.logMessageReceivedThreaded`。
3. 测试日志是否在调用 `qa.snapshot` 之前产生。
4. 是否有另一处代码执行了 `ResetState()` 或清空队列。

### 同一条日志出现多次

检查是否还有其他脚本重复订阅 `Application.logMessageReceivedThreaded`。本实现必须保留：

```csharp
Application.logMessageReceivedThreaded -= OnLogMessageReceived;
Application.logMessageReceivedThreaded += OnLogMessageReceived;
```

### `qa.snapshot` 超过大小限制

依次减小：

```text
GetSnapshot(10, 120 * 1000L) → GetSnapshot(5, 120 * 1000L)
MaxStackTraceCharacters 2048 → 1024
MaxMessageCharacters 512     → 256
```

不要移除现有响应大小检查。

## 8. 完成标准

- [ ] Editor 中 `qa.snapshot.data.recentLogs` 只返回 `Error`、`Assert`、`Exception`。
- [ ] 普通 `Log` 和 `Warning` 不进入 `recentLogs`。
- [ ] 最多只返回最近 120 秒内的最新 10 条。
- [ ] 重新启动游戏后旧日志被清空。
- [ ] Android IL2CPP 测试包能返回真实游戏日志。
- [ ] 日志和截图使用同一个 `captureId`。
- [ ] 原有 Poco Screenshot、Dump、版本、场景和业务字段不受影响。
- [ ] 没有日志时仍能正常截图和提交 Bug。
