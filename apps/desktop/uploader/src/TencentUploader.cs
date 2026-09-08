using COSXML;
using COSXML.Auth;
using COSXML.Model.Object;
using System.Text.Json.Nodes;
using System.Diagnostics;

namespace Ozdqp;
public sealed class TencentUploader : IObjectUploader
{
    public async Task Upload(JobConfig c,JobState s,IPlatform api,Journal journal,CancellationToken ct)
    {
        if(s.Done.Contains("COS_UPLOAD"))return;
        CosXmlServer? server=null;DateTimeOffset refreshAt=DateTimeOffset.MinValue;
        using var credentialGate=new SemaphoreSlim(1,1);var stateGate=new object();
        void Diagnostic(string kind,object data) { lock(stateGate)journal.Emit(s,kind,data); }
        async Task Refresh()
        {
            var sts=await api.Get("/api/v1/thirdpartyadminapi/oss_sts",null,ct) as JsonObject??throw new UploadException("SCHEMA_CHANGED","STS 配置为空。");
            if(Json.Text(sts["provider"])!="tencent")throw new UploadException("UNSUPPORTED_PROVIDER","STS provider 不受支持。");
            string bucket=Json.Text(sts["bucket"]),region=Json.Text(sts["region"]),domain=Json.Text(sts["domain"]);
            if(string.IsNullOrWhiteSpace(bucket)||string.IsNullOrWhiteSpace(region)||!Uri.TryCreate(domain,UriKind.Absolute,out var domainUri)||domainUri.Scheme!="https")throw new UploadException("SCHEMA_CHANGED","STS 缺少 bucket、region 或 HTTPS domain。");
            if(!string.IsNullOrEmpty(s.Bucket)&&(s.Bucket!=bucket||s.Region!=region))throw new UploadException("OBJECT_CONFLICT","STS 存储目标改变，不能恢复旧分片。");
            var credentials=sts["credentials"] as JsonObject??throw new UploadException("AUTH_REQUIRED","STS credentials 不可用。请使用当前平台凭证。");
            string Find(params string[] names)=>names.Select(n=>Json.Text(credentials[n])).FirstOrDefault(x=>!string.IsNullOrWhiteSpace(x))??"";
            string id=Find("access_key_id","tmpSecretId","TmpSecretId"),key=Find("access_key_secret","tmpSecretKey","TmpSecretKey"),token=Find("security_token","session_token","sessionToken","SecurityToken","token");
            if(new[]{id,key,token}.Any(x=>string.IsNullOrEmpty(x)||x.Contains("REDACTED",StringComparison.OrdinalIgnoreCase)))throw new UploadException("AUTH_REQUIRED","STS 临时凭证字段不完整，需核对平台 credentials 合同。");
            long now=DateTimeOffset.UtcNow.ToUnixTimeSeconds(),expiry=now+300;
            foreach(var name in new[]{"expired_time","expiredTime","expiration","Expiration"})
            {
                string value=Json.Text(credentials[name]??sts[name]);
                if(long.TryParse(value,out long n)&&n>now)expiry=Math.Min(expiry,n>100000000000?n/1000:n);
                else if(DateTimeOffset.TryParse(value,out var date)&&date.ToUnixTimeSeconds()>now)expiry=Math.Min(expiry,date.ToUnixTimeSeconds());
            }
            // The SDK maps ConnectionTimeoutMs to HttpWebRequest.Timeout: this
            // bounds the whole synchronous part request, not just connecting.
            // A 5 MiB part must survive temporary slow uplink periods.
            var config=new CosXmlConfig.Builder().SetRegion(region).IsHttps(true).SetDebugLog(false).SetConnectionLimit(Math.Max(8,c.UploadConcurrency)).SetConnectionTimeoutMs(180000).SetReadWriteTimeoutMs(90000).Build();
            server=new CosXmlServer(config,new DefaultSessionQCloudCredentialProvider(id,key,now-30,expiry,token));
            refreshAt=DateTimeOffset.FromUnixTimeSeconds(Math.Max(now+5,expiry-60));
            lock(stateGate){s.Bucket=bucket;s.Region=region;s.PublicUrl=domain.TrimEnd('/')+"/"+s.ObjectKey;journal.Save(s);}
        }
        async Task<CosXmlServer> CurrentServer(CosXmlServer? failed,CancellationToken token)
        {
            await credentialGate.WaitAsync(token);
            try
            {
                if(server==null||DateTimeOffset.UtcNow>=refreshAt||(failed!=null&&ReferenceEquals(server,failed)))await Refresh();
                return server!;
            }
            finally{credentialGate.Release();}
        }
        await Refresh();
        bool reconcilingCompletion=s.PendingAction=="COS_COMPLETE";
        if(reconcilingCompletion)
        {
            // Unique server-allocated key plus task-specific ETag is required;
            // a matching object size alone cannot prove this multipart completed.
            try
            {
                var head=await Task.Run(()=>server!.HeadObject(new HeadObjectRequest(s.Bucket,s.ObjectKey)),ct);
                if(head.size==s.File!.Size&&head.eTag.Trim('"')==ExpectedMultipartEtag(s.Parts))
                {s.PendingAction=null;s.Done.Add("COS_UPLOAD");journal.Save(s);return;}
                throw new UploadException("OBJECT_CONFLICT","COS 成品文件与本任务的大小或分片摘要不一致，已停止合并恢复。");
            }
            catch(UploadException){throw;}
            catch(Exception error) { Diagnostic("cosRequestFailed",new{operation="HeadObject",error=CosDiagnostics.Describe(error)}); }
            // Upload-scoped STS may not permit HeadObject. A still-active upload
            // can instead be reconciled with ListParts and every part's byte MD5.
            // Never initialize a replacement upload when completion is pending.
            if(string.IsNullOrEmpty(s.UploadId))throw new UploadException("REMOTE_RESULT_UNKNOWN","COS 合并结果不确定且缺少原 uploadId，已保留断点。");
        }
        if(s.PendingAction!=null&&!reconcilingCompletion)throw new UploadException("REMOTE_RESULT_UNKNOWN","存在其他未决操作："+s.PendingAction);
        if(string.IsNullOrEmpty(s.UploadId))
        {
            var result=await Task.Run(()=>server!.InitMultipartUpload(new InitMultipartUploadRequest(s.Bucket,s.ObjectKey)),ct);
            s.UploadId=result.initMultipartUpload.uploadId;
            if(string.IsNullOrWhiteSpace(s.UploadId))throw new UploadException("UPLOAD_FAILED","未取得 COS uploadId。");journal.Save(s);
        }
        else
        {
            // Reconcile server parts; local-only parts must never be trusted.
            var confirmed=new Dictionary<int,string>();int marker=0;
            do
            {
                var request=new ListPartsRequest(s.Bucket,s.ObjectKey,s.UploadId);request.SetMaxParts(1000);if(marker>0)request.SetPartNumberMarker(marker);
                Diagnostic("reconcileParts",new{marker});
                COSXML.Model.Object.ListPartsResult result;
                try { result=await Task.Run(()=>server!.ListParts(request),ct); }
                catch(Exception error) {
                    Diagnostic("cosRequestFailed",new{operation="ListParts",error=CosDiagnostics.Describe(error)});
                    if(reconcilingCompletion)throw new UploadException("REMOTE_RESULT_UNKNOWN","不能确认原 COS 合并结果或活动分片，已保留原任务，请核对云端状态。");
                    throw;
                }
                foreach(var part in result.listParts.parts??[])
                {
                    int number=int.Parse(part.partNumber);long expected=Math.Min(c.PartSizeBytes,s.File!.Size-(number-1)*c.PartSizeBytes);
                    if(number<1||expected<=0||long.Parse(part.size)!=expected)throw new UploadException("OBJECT_CONFLICT","服务端分片大小与当前文件布局不一致。");
                    if(s.Parts.TryGetValue(number,out var local)&&local!=part.eTag)throw new UploadException("OBJECT_CONFLICT","服务端分片 ETag 与本地断点不一致。");
                    // A remote-only part may be an ACK lost before checkpoint.
                    // Verify its byte MD5 before adopting it.
                    var md5=await PartMd5(s.File.Path,(number-1)*c.PartSizeBytes,expected,ct);
                    if(part.eTag.Trim('"')!=md5)throw new UploadException("OBJECT_CONFLICT","服务端分片与本地文件摘要不同。");
                    confirmed[number]=part.eTag;
                }
                if(!result.listParts.isTruncated)break;
                int next=int.Parse(result.listParts.nextPartNumberMarker);if(next<=marker)throw new UploadException("SCHEMA_CHANGED","COS 分片分页标记未前进。");marker=next;
            }while(true);
            if(reconcilingCompletion&&confirmed.Count!=(s.File!.Size+c.PartSizeBytes-1)/c.PartSizeBytes)
                throw new UploadException("REMOTE_RESULT_UNKNOWN","合并恢复时原上传的分片不完整，不能重新合并，已保留断点。");
            s.Parts=confirmed;journal.Save(s);
            Diagnostic("reconciledParts",new{completedParts=confirmed.Count});
        }
        int total=checked((int)((s.File!.Size+c.PartSizeBytes-1)/c.PartSizeBytes));
        if(total>10000)throw new UploadException("INVALID_INPUT","分片数量超过 10000，请调整 partSizeBytes 后创建新任务。");
        var pending=Enumerable.Range(1,total).Where(number=>!s.Parts.ContainsKey(number)).ToArray();
        journal.Emit(s,"uploadParallelism",new{concurrency=c.UploadConcurrency,totalParts=total,pendingParts=pending.Length});
        await MultipartTransfers.Run(pending,c.UploadConcurrency,async(current,token)=>{
            token.ThrowIfCancellationRequested();Files.CheckStable(s.File);
            long offset=(current-1)*c.PartSizeBytes,length=Math.Min(c.PartSizeBytes,s.File.Size-offset);
            CosXmlServer? failed=null;
            for(int attempt=0;;attempt++)
            {
                CosXmlServer? currentServer=null;
                var watch=Stopwatch.StartNew();
                try
                {
                    currentServer=await CurrentServer(failed,token);
                    var request=new UploadPartRequest(s.Bucket,s.ObjectKey,current,s.UploadId,s.File.Path,offset,length);
                    var result=await Task.Run(()=>currentServer.UploadPart(request),token);
                    return result.eTag;
                }
                catch(OperationCanceledException){throw;}
                catch(UploadException){throw;}
                catch(Exception error)
                {
                    Diagnostic("cosRequestFailed",new{operation="UploadPart",part=current,attempt=attempt+1,elapsedMs=watch.ElapsedMilliseconds,error=CosDiagnostics.Describe(error)});
                    if(attempt>=2)throw new UploadException("UPLOAD_FAILED",$"COS 分片 {current} 上传失败，断点已保存。恢复会先核对服务端分片。");
                    failed=currentServer;await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2,attempt)),token);
                }
            }
        },(current,etag)=>{
            lock(stateGate)
            {
                s.Parts[current]=etag;journal.Save(s);
                journal.Emit(s,"progress",new{completedParts=s.Parts.Count,totalParts=total,completedBytes=s.Parts.Keys.Sum(n=>Math.Min(c.PartSizeBytes,s.File.Size-(n-1)*c.PartSizeBytes)),totalBytes=s.File.Size});
            }
        },ct);
        Files.CheckStable(s.File);ct.ThrowIfCancellationRequested();
        s.PendingAction="COS_COMPLETE";journal.Save(s);
        var complete=CreateCompletion(s.Bucket,s.ObjectKey,s.UploadId,s.Parts);
        try { await Task.Run(()=>server!.CompleteMultiUpload(complete),ct); }
        catch(Exception error) { Diagnostic("cosRequestFailed",new{operation="CompleteMultipartUpload",error=CosDiagnostics.Describe(error)});throw; }
        s.PendingAction=null;s.Done.Add("COS_UPLOAD");journal.Save(s);
    }
    public static CompleteMultipartUploadRequest CreateCompletion(string bucket,string key,string uploadId,IReadOnlyDictionary<int,string> parts)
    {
        var request=new CompleteMultipartUploadRequest(bucket,key,uploadId);
        foreach(var part in parts.OrderBy(x=>x.Key))request.SetPartNumberAndETag(part.Key,part.Value);
        return request;
    }
    static string ExpectedMultipartEtag(Dictionary<int,string> parts)
    {
        try {var all=parts.OrderBy(x=>x.Key).SelectMany(x=>Convert.FromHexString(x.Value.Trim('"'))).ToArray();return Convert.ToHexString(System.Security.Cryptography.MD5.HashData(all)).ToLowerInvariant()+"-"+parts.Count;}
        catch{return "";}
    }
    static async Task<string> PartMd5(string path,long offset,long length,CancellationToken ct)
    {
        await using var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);file.Position=offset;
        using var hash=System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.MD5);
        byte[] buffer=new byte[1024*1024];while(length>0){int n=await file.ReadAsync(buffer.AsMemory(0,(int)Math.Min(buffer.Length,length)),ct);if(n==0)throw new EndOfStreamException();hash.AppendData(buffer.AsSpan(0,n));length-=n;}
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }
}
