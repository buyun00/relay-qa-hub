using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

namespace Ozdqp;
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding=new UTF8Encoding(false);
        using var cancel=new CancellationTokenSource();Console.CancelKeyPress+=(_,e)=>{e.Cancel=true;cancel.Cancel();};
        Journal? journal=null;JobState? state=null;
        try
        {
            string Arg(string name)=>args.SkipWhile(x=>x!=name).Skip(1).FirstOrDefault()??throw new UploadException("INVALID_INPUT","缺少参数 "+name);
            string ApiArg()=>args.Contains("--api-base")?Arg("--api-base"):new JobConfig().ApiBase;
            if(args.Length==0||args[0] is "help" or "--help")
            {
                Console.WriteLine("OZDQP Uploader 0.3.1 / 固定地址下载 + 账号密码登录\n\n  login [--kind email|subaccount]   登录并保存账号密码，默认邮箱\n  auth-check                       只读检查已保存的登录状态\n  logout                           清除本工具本地登录缓存\n  download --work <目录>            仅从固定地址下载并校验 ZIP\n  preflight --file <ZIP>            本地检查\n  self-test                        本地测试，不访问业务平台\n  run --config <job.json>           登录、下载、执行完整流程\n  resume --config <job.json>        恢复本任务的相同 ZIP\n  confirm-publish --config <job.json> 最终确认发布（prepare_publish 等待后）\n  status --work <任务目录>          读取当前结果\n\nZIP 固定来源："+PackageDownload.SourceUrl+"\n账号密码保存在本地 JSON；后续自动登录。兼容 OZDQP_AUTHORIZATION。\nCtrl+C 保留断点；下载中断后从头下载，已完成下载的旧任务不会取新包。");return 0;
            }
            if(args[0]=="login")
            {
                await Authentication.InteractiveLogin(ApiArg(),args.Contains("--kind")?Arg("--kind"):"email",cancel.Token);
                Console.WriteLine(JsonSerializer.Serialize(new{type="result",command="login",ok=true,message="登录并通过文件服务只读校验，账号密码已保存",configPath=TokenCache.CachePath(ApiArg())}));return 0;
            }
            if(args[0]=="logout"){TokenCache.Forget(ApiArg());Console.WriteLine("{\"type\":\"result\",\"command\":\"logout\",\"ok\":true}");return 0;}
            async Task<PlatformClient> LoggedInClient(string apiBase)
            {
                string auth=Environment.GetEnvironmentVariable("OZDQP_AUTHORIZATION")??"";
                LoginTokens? tokens=null;
                if(string.IsNullOrWhiteSpace(auth))
                {
                    tokens=TokenCache.Load(apiBase);
                    if(tokens==null)tokens=await Authentication.InteractiveLogin(apiBase,"email",cancel.Token);
                    auth=tokens.AccessToken;
                }
                async Task<string> Refresh(CancellationToken ct)
                {
                    using var gateway=new PlatformClient(Authentication.LoginBase,"");
                    tokens=await Authentication.Renew(gateway,tokens!,ct);TokenCache.Save(tokens);return tokens.AccessToken;
                }
                var api=new PlatformClient(apiBase,auth,refresh:tokens==null?null:Refresh);
                try{await Authentication.CheckUploadAccess(api,cancel.Token);return api;}catch{api.Dispose();throw;}
            }
            if(args[0]=="auth-check")
            {
                using var check=await LoggedInClient(ApiArg());Console.WriteLine("{\"type\":\"result\",\"command\":\"auth-check\",\"ok\":true}");return 0;
            }
            if(args[0]=="download")
            {
                using var downloadLock=new Journal(Arg("--work"));
                var file=await PackageDownload.Get(downloadLock.Root,cancel.Token,(received,total)=>Console.WriteLine(JsonSerializer.Serialize(new{type="event",@event="downloadProgress",received,total})));
                Console.WriteLine(JsonSerializer.Serialize(new{type="result",command="download",ok=true,source=PackageDownload.SourceUrl,file},Json.Options));return 0;
            }
            if(args[0]=="self-test"){await SelfTest.Run(cancel.Token);return 0;}
            if(args[0]=="preflight")
            {
                var file=await Files.Inspect(Arg("--file"),cancel.Token);
                Console.WriteLine(JsonSerializer.Serialize(new{protocolVersion=1,type="result",command="preflight",ok=true,file},Json.Options));return 0;
            }
            if(args[0]=="status")
            {
                var path=Path.Combine(Path.GetFullPath(Arg("--work")),"state.json");Console.WriteLine(await File.ReadAllTextAsync(path,cancel.Token));return 0;
            }
            if(args[0] is not ("run" or "resume" or "confirm-publish"))throw new UploadException("INVALID_INPUT","未知命令。");
            string configPath=Path.GetFullPath(Arg("--config"));
            var config=JsonSerializer.Deserialize<JobConfig>(await File.ReadAllTextAsync(configPath,cancel.Token),Json.Options)??throw new UploadException("INVALID_INPUT","配置文件无效。");
            if(string.IsNullOrWhiteSpace(config.WorkDirectory))throw new UploadException("INVALID_INPUT","必须设置唯一 workDirectory，以保存断点。");
            if(config.Mode is not ("upload_only" or "prepare_test" or "publish_workflow" or "prepare_publish"))throw new UploadException("INVALID_INPUT","mode 无效。");
            if(config.PollSeconds<1||config.WaitTimeoutSeconds<1||config.PartSizeBytes<1024*1024||config.PartSizeBytes>128L*1024*1024)throw new UploadException("INVALID_INPUT","超时或分片设置超出支持范围。");
            if(config.UploadConcurrency is <1 or >8)throw new UploadException("INVALID_INPUT","上传并发数必须为 1 到 8。");
            if(string.IsNullOrWhiteSpace(config.Summary)||string.IsNullOrWhiteSpace(config.ProductId)||string.IsNullOrWhiteSpace(config.ChannelId))throw new UploadException("INVALID_INPUT","产品、渠道、版本概述不能为空。");
            config.WorkDirectory=Path.GetFullPath(config.WorkDirectory,Path.GetDirectoryName(configPath)!);
            config.FilePath=PackageDownload.LocalPath(config.WorkDirectory);
            var digest=Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new{config.ApiBase,source=PackageDownload.SourceUrl,config.FilePath,config.ProductId,config.ChannelId,config.Version,config.Summary,config.Description,config.BelongName,config.ExistingVersionId,config.PartSizeBytes,config.Mode})));
            // Keep the exact 0.2.0 digest for existing jobs; new behavior is immutable.
            if(config.UseVersionText||config.RecordedTestWorkflow)
                digest=Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new{digest,config.UseVersionText,config.RecordedTestWorkflow})));
            journal=new Journal(config.WorkDirectory);var loaded=journal.Read();
            if(args[0]=="run"&&loaded!=null)throw new UploadException("VERSION_CONFLICT","任务目录已有状态；请使用 resume，或为新任务选择新目录。");
            if(args[0]!="run"&&loaded==null)throw new UploadException("INVALID_INPUT","找不到可恢复的任务。");
            if(loaded!=null&&loaded.ConfigDigest!=digest)throw new UploadException("VERSION_CONFLICT","任务身份配置已改变；不能把旧断点用于新文件或新目标。");
            state=loaded??new JobState{ConfigDigest=digest};
            if(args[0]=="confirm-publish")Engine.ConfirmPublication(config,state,journal);
            state.DownloadUrl=PackageDownload.SourceUrl;
            state.Stage="AUTHENTICATING";journal.Save(state);journal.Emit(state,"authenticating");
            using var api=await LoggedInClient(config.ApiBase);
            state.Stage="DOWNLOADING";journal.Save(state);journal.Emit(state,"downloading");
            if(state.File!=null&&!File.Exists(config.FilePath))throw new UploadException("FILE_CHANGED","本任务的下载文件已丢失，不能用固定地址上的新包替换旧断点。");
            var identity=state.File==null?await PackageDownload.Get(config.WorkDirectory,cancel.Token,(received,total)=>journal.Emit(state,"downloadProgress",new{received,total})):await Files.Inspect(config.FilePath,cancel.Token);
            if(state.File!=null&&(state.File.Sha256!=identity.Sha256||state.File.Size!=identity.Size))throw new UploadException("FILE_CHANGED","文件内容与断点不一致。");
            state.File=identity;journal.Save(state);
            // Prevent file replacement and writes throughout the run.
            using var fileGuard=new FileStream(config.FilePath,FileMode.Open,FileAccess.Read,FileShare.Read);
            Files.CheckStable(identity);
            var lockRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"OZDQP-Uploader","channel-locks");Directory.CreateDirectory(lockRoot);
            var channel=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(config.ApiBase+"|"+config.ProductId+"|"+config.ChannelId)));
            using var channelLock=new FileStream(Path.Combine(lockRoot,channel+".lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
            await new Engine(config,state,api,new TencentUploader(),journal).Run(cancel.Token);
            await File.WriteAllTextAsync(Path.Combine(journal.Root,"result.json"),JsonSerializer.Serialize(state,Json.Options),cancel.Token);
            return 0;
        }
        catch(OperationCanceledException)
        {
            if(state!=null&&journal!=null){state.RunStatus="PAUSED";journal.Save(state);journal.Emit(state,"paused",new{reason="CanceledOrTimedOut",remoteOutcomePending=state.PendingAction});}return 7;
        }
        catch(Exception error)
        {
            string code=error is UploadException known?known.Code:"UNEXPECTED_ERROR";
            // Do not serialize SDK exceptions: they may contain signed URLs.
            string message=error is UploadException?error.Message:"操作失败。异常类型："+error.GetType().Name+"。详细信息需使用脱敏诊断排查。";
            if(state!=null&&journal!=null){state.RunStatus=code=="AUTH_REQUIRED"?"AUTH_REQUIRED":"FAILED";try{journal.Save(state);journal.Emit(state,"failed",new{code,message,pendingAction=state.PendingAction});}catch{Console.Error.WriteLine("LOCAL_STORAGE_FAILED");}}
            else Console.WriteLine(JsonSerializer.Serialize(new{protocolVersion=1,type="error",code,message}));
            return code=="AUTH_REQUIRED"?3:code.Contains("CONFLICT")?4:6;
        }
        finally{journal?.Dispose();}
    }
}
