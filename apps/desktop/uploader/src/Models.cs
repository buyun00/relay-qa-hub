using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using System.IO.Compression;

namespace Ozdqp;
public static class Json
{
    public static readonly JsonSerializerOptions Options = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    public static string Text(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : n?.ToJsonString() ?? "";
    public static int Int(JsonNode? n) => int.TryParse(Text(n), out var i) ? i : 0;
    public static bool Bool(JsonNode? n) => Text(n) == "true";
    public static JsonObject Clone(JsonObject obj) => (JsonObject)obj.DeepClone();
}
public sealed class JobConfig
{
    public string ApiBase { get; set; } = "";
    public string LoginBase { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public int ComponentVersion { get; set; }
    public string SourceRoot { get; set; } = "";
    public string TargetPrefix { get; set; } = "";
    public string TestDirectoryPrefix { get; set; } = "";
    public string ReleaseDirectoryPrefix { get; set; } = "";
    public string FilePath { get; set; } = "";
    public string ProductId { get; set; } = "";
    public string ChannelId { get; set; } = "";
    public string? Version { get; set; }
    public string Summary { get; set; } = "";
    public string Description { get; set; } = "";
    public string BelongName { get; set; } = "";
    public int? ExistingVersionId { get; set; }
    public int TesterId { get; set; }
    public string Mode { get; set; } = "publish_workflow";
    public string TestResultReference { get; set; } = "";
    public bool UseVersionText { get; set; }
    public bool RecordedTestWorkflow { get; set; }
    public int UploadConcurrency { get; set; } = 4;
    public SourceIdentity? ExpectedSource { get; set; }
    public string? DownloadUrl { get; set; }
    public int PollSeconds { get; set; } = 3;
    public int WaitTimeoutSeconds { get; set; } = 1800;
    public long PartSizeBytes { get; set; } = 5 * 1024 * 1024;
    public int? ConfirmedTestUnzipStatus { get; set; }
    public string WorkDirectory { get; set; } = "";
}
public sealed record SourceIdentity(long Size, string LastModified,
    [property:System.Text.Json.Serialization.JsonIgnore(Condition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? Sha256=null);
public sealed class JobState
{
    public string ProjectId { get; set; } = "";
    public int ComponentVersion { get; set; }
    public string JobId { get; set; } = Guid.NewGuid().ToString();
    public string ConfigDigest { get; set; } = "";
    public bool PublishConfirmed { get; set; }
    public string PublishConfirmedAt { get; set; } = "";
    public string TestStatusSource { get; set; } = "";
    public string DownloadUrl { get; set; } = "";
    public string Stage { get; set; } = "NEW";
    public string RunStatus { get; set; } = "NEW";
    public string Version { get; set; } = "";
    public int VersionId { get; set; }
    public FileIdentity? File { get; set; }
    public HashSet<string> Done { get; set; } = [];
    public string? PendingAction { get; set; }
    public string ObjectKey { get; set; } = "";
    public string PublicUrl { get; set; } = "";
    public string TestDir { get; set; } = "";
    public string ReleaseDir { get; set; } = "";
    public string Bucket { get; set; } = "";
    public string Region { get; set; } = "";
    public string UploadId { get; set; } = "";
    public Dictionary<int, string> Parts { get; set; } = [];
    public bool Reused { get; set; }
    public int FinalRemoteStatus { get; set; }
    public string PublishTime { get; set; } = "";
    public int TesterId { get; set; }
    public string TestResultReference { get; set; } = "";
    public string StartTime { get; set; } = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
    public string EndTime { get; set; } = DateTime.Now.AddDays(1).ToString("yyyy-MM-dd HH:mm:ss");
    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
}
public sealed record FileIdentity(string Path, long Size, DateTime LastWriteUtc, string Md5, string Sha256, int ZipEntries);
public sealed class UploadException(string code, string message) : Exception(message) { public string Code { get; } = code; }
public static class Files
{
    public static async Task<FileIdentity> Inspect(string path, CancellationToken ct)
    {
        path = System.IO.Path.GetFullPath(path);
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.SequentialScan);
        if (file.Length == 0) throw new UploadException("INVALID_INPUT", "ZIP 文件为空。");
        using var md5 = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = new byte[1024 * 1024]; int read;
        while ((read = await file.ReadAsync(buffer, ct)) > 0) { md5.AppendData(buffer.AsSpan(0, read)); sha.AppendData(buffer.AsSpan(0, read)); }
        file.Position = 0;
        using var zip = new ZipArchive(file, ZipArchiveMode.Read, true);
        int entries = zip.Entries.Count;
        if (entries == 0) throw new UploadException("INVALID_INPUT", "ZIP 没有文件条目。");
        foreach (var e in zip.Entries)
            if (e.FullName.Replace('\\', '/').Split('/').Contains("..") || e.FullName.StartsWith('/') || e.FullName.Contains(':'))
                throw new UploadException("INVALID_INPUT", "ZIP 含不安全路径条目。");
        return new(path, file.Length, File.GetLastWriteTimeUtc(path), Convert.ToHexString(md5.GetHashAndReset()).ToLowerInvariant(), Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant(), entries);
    }
    public static void CheckStable(FileIdentity id)
    {
        var f = new FileInfo(id.Path);
        if (f.Length != id.Size || f.LastWriteTimeUtc != id.LastWriteUtc) throw new UploadException("FILE_CHANGED", "上传文件已改变，不能继续原任务。");
    }
}
public sealed class Journal : IDisposable
{
    readonly FileStream exclusive;
    readonly object writeGate = new();
    public string Root { get; }
    public string StatePath => Path.Combine(Root, "state.json");
    public Journal(string root)
    {
        Root = Path.GetFullPath(root); Directory.CreateDirectory(Root);
        try { exclusive = new FileStream(Path.Combine(Root, "job.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { throw new UploadException("JOB_LOCKED", "该任务正在另一个进程中运行。"); }
    }
    public JobState? Read()
    {
        if (!File.Exists(StatePath)) return null;
        using var file = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return JsonSerializer.Deserialize<JobState>(file, Json.Options);
    }
    public void Save(JobState s)
    {
        lock (writeGate)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(s, Json.Options);
            string tmp = StatePath + ".tmp";
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    using (var f = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None)) { f.Write(bytes); f.Flush(true); }
                    File.Move(tmp, StatePath, true);
                    return;
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    // Readers on Windows can temporarily deny replacement. Retry only
                    // this local atomic checkpoint, never the successful COS request.
                    int nativeCode = error.HResult & 0xffff;
                    if (OperatingSystem.IsWindows() && nativeCode is 5 or 32 or 33 && attempt < 10)
                    {
                        Thread.Sleep(Math.Min(250, 20 << Math.Min(attempt, 4)));
                        continue;
                    }
                    throw new UploadException("CHECKPOINT_WRITE_FAILED", "服务端保存上传断点失败，原状态和临时文件已保留。请检查磁盘或文件占用后恢复原任务。");
                }
            }
        }
    }
    public void Emit(JobState s, string kind, object? data = null)
    {
        string line = JsonSerializer.Serialize(new { protocolVersion = 1, type = "event", @event = kind, jobId = s.JobId, at = DateTimeOffset.UtcNow, stage = s.Stage, data });
        File.AppendAllText(Path.Combine(Root, "events.jsonl"), line + "\n");
        Console.WriteLine(line);
    }
    public void Dispose() => exclusive.Dispose();
}
