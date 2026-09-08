using System.Text.Json.Nodes;

namespace Ozdqp;
public sealed class Engine(JobConfig c, JobState s, IPlatform api, IObjectUploader uploader, Journal log)
{
    const string V="/api/v1/developapi/versions/", R="/api/v1/developapi/record/", O="/api/v1/thirdpartyadminapi/";
    static Dictionary<string,string> Q(params (string,string)[] values)=>values.ToDictionary(x=>x.Item1,x=>x.Item2);
    Dictionary<string,string> Vid()=>Q(("vid",s.VersionId.ToString()));
    void Save()=>log.Save(s);
    void Stage(string stage){s.Stage=stage;s.RunStatus="RUNNING";Save();log.Emit(s,"stage");}
    async Task Step(string name, Func<Task> action, Func<Task<bool>>? reconcile=null)
    {
        if(s.Done.Contains(name))return;
        Stage(name);
        if(s.PendingAction==name)
        {
            if(reconcile!=null && await reconcile()) { s.Done.Add(name);s.PendingAction=null;Save();log.Emit(s,"reconciled");return; }
            throw new UploadException("REMOTE_RESULT_UNKNOWN",$"上次 {name} 的远端结果尚不明确。已停止重复发送，请先核对服务器状态。");
        }
        if(s.PendingAction!=null)throw new UploadException("REMOTE_RESULT_UNKNOWN","存在另一条待核对的写操作："+s.PendingAction);
        s.PendingAction=name;Save();
        try { await action(); }
        catch(UploadException e) when(e.Code is "AUTH_REQUIRED" or "FORBIDDEN")
        {
            // Explicit HTTP authentication rejection is safe to retry with a new credential.
            s.PendingAction=null;Save();throw;
        }
        s.Done.Add(name);s.PendingAction=null;Save();
    }
    async Task<JsonObject> Detail(CancellationToken ct)
    {
        var d=await api.Get(V+"detail",Vid(),ct) as JsonObject ?? throw new UploadException("SCHEMA_CHANGED","版本详情为空。");
        if(Json.Int(d["id"])!=s.VersionId || Json.Text(d["version"])!=s.Version || Json.Text(d["product_id"])!=c.ProductId || Json.Text(d["channel_id"])!=c.ChannelId)
            throw new UploadException("VERSION_CONFLICT","远端版本身份与本任务不一致。");
        return d;
    }
    public static JsonObject Form(JobConfig c,JobState s,JsonObject? detail=null)
    {
        var result=new JsonObject {
            ["sub_type"]=1,["script_type"]=3,["update_type"]=1,["is_legal_audit"]=0,
            ["version"]=s.Version,["summarize"]=c.UseVersionText?s.Version:c.Summary,["content"]=c.UseVersionText?s.Version:c.Description,
            ["tag_id"]=null,["remark"]=new JsonObject{["remark"]=""},["product_id"]=c.ProductId,["channel_id"]=c.ChannelId,
            ["no_package"]=0,["module_id"]=0,["apps"]=new JsonArray(),["start_time"]=s.StartTime,["end_time"]=s.EndTime,
            ["is_review"]=0,["milestone"]=0,["is_force"]=0,["belong_name"]=c.BelongName,["attaches"]=new JsonArray(),
            ["relation_feedback"]=new JsonObject(),["syncs"]=new JsonArray(),["ext"]="[]",["auto_packing_status"]=0 };
        if(detail!=null)
        {
            var keys="sub_type script_type update_type is_legal_audit version summarize content tag_id product_id channel_id no_package rely_vid module_id apps start_time end_time is_review milestone is_force belong_name attaches syncs ext auto_packing_status preip_list url version_module_category_id feedbacks".Split(' ');
            foreach(var key in keys)if(detail.ContainsKey(key))result[key]=detail[key]?.DeepClone();
            // remarks is an array of history, not the writable remark object.
            result["id"]=s.VersionId;
            if(Json.Int(result["sub_type"])!=1||Json.Int(result["script_type"])!=3||Json.Int(result["update_type"])!=1)
                throw new UploadException("UNSUPPORTED_TYPE","首版仅支持已录制的 APP 小版本热更新类型 1/3/1。");
        }
        return result;
    }
    async Task Update(string name, int? action, string? url, int[] expectedBefore, int[] expectedAfter, CancellationToken ct)
    {
        if(s.Done.Contains(name))return;
        JsonObject? f=null;
        if(s.PendingAction!=name)
        {
            var d=await Detail(ct);
            if(!expectedBefore.Contains(Json.Int(d["status"])))throw new UploadException("VERSION_CONFLICT",$"{name} 前的状态 {Json.Text(d["status"])} 不符合预期。");
            if(name=="REQUEST_PUBLISH"&&Json.Text(d["url"])!=s.ReleaseDir)
                throw new UploadException("VERSION_CONFLICT","正式资源目录在确认发布前发生变化。");
            f=Form(c,s,d);if(action.HasValue)f["update_status"]=action.Value;if(url!=null)f["url"]=url;
            if(action is 60 or 99)f["publish_type"]=1;
        }
        await Step(name,async()=>{
            await api.Write("PUT",V+"update",f!,ct);
        },async()=>{
            var d=await Detail(ct);return expectedAfter.Contains(Json.Int(d["status"])) && (url==null || Json.Text(d["url"])==url || (name=="BIND_PACKAGE"&&Json.Text(d["url"])==s.TestDir));
        });
    }
    async Task<List<JsonObject>> FindVersion(CancellationToken ct)
    {
        var result=new List<JsonObject>();
        for(int page=1;page<=1000;page++)
        {
            var data=await api.Get(V+"list",Q(("page",page.ToString()),("size","100"),("sub_types","1"),("is_review","-1")),ct);
            var list=data?["list"] as JsonArray ?? throw new UploadException("SCHEMA_CHANGED","版本列表缺少 data.list。");
            foreach(var item in list.OfType<JsonObject>())
                if(Json.Text(item["version"])==s.Version && Json.Text(item["product_id"])==c.ProductId&&Json.Text(item["channel_id"])==c.ChannelId)result.Add(item);
            if(list.Count==0||page*100>=Json.Int(data?["total"]))return result;
        }
        throw new UploadException("VERSION_CONFLICT","版本列表过大，无法完成可靠查重。");
    }
    async Task Poll(string stage,Func<Task<bool>> predicate,CancellationToken ct)
    {
        if(s.Done.Contains(stage))return;
        Stage(stage);var deadline=DateTimeOffset.UtcNow.AddSeconds(c.WaitTimeoutSeconds);
        while(true)
        {
            ct.ThrowIfCancellationRequested();
            if(await predicate()){s.Done.Add(stage);Save();return;}
            if(DateTimeOffset.UtcNow>=deadline)throw new UploadException("PROCESSING_TIMEOUT",$"{stage} 等待超时，可从当前任务恢复继续查询。");
            await Task.Delay(TimeSpan.FromSeconds(c.PollSeconds),ct);
        }
    }
    public async Task Run(CancellationToken ct)
    {
        Files.CheckStable(s.File!);
        if(s.VersionId>0&&s.PendingAction=="CREATE_VERSION"&&s.Done.Contains("CREATE_ACK"))
        {
            await Detail(ct);s.Done.Add("CREATE_VERSION");s.PendingAction=null;Save();
        }
        if(s.VersionId==0)
        {
            if(string.IsNullOrEmpty(s.Version))
            {
                s.Version=c.Version??Json.Text(await api.Get(V+"nextver",Q(("sub_type","1"),("script_type","3"),("update_type","1"),("product_id",c.ProductId),("channel_id",c.ChannelId)),ct));
                if(string.IsNullOrWhiteSpace(s.Version))throw new UploadException("SCHEMA_CHANGED","未取得版本号。");Save();
            }
            if(c.ExistingVersionId.HasValue){s.VersionId=c.ExistingVersionId.Value;await Detail(ct);s.Done.Add("CREATE_VERSION");Save();}
            else
            {
                async Task<bool> RecoverCreate(){if(!s.Done.Contains("CREATE_ACK"))return false;var found=await FindVersion(ct);if(found.Count==1){s.VersionId=Json.Int(found[0]["id"]);Save();return true;}return false;}
                if(!s.Done.Contains("CREATE_VERSION")&&s.PendingAction!="CREATE_VERSION")
                {
                    var found=await FindVersion(ct);if(found.Count!=0)throw new UploadException("VERSION_CONFLICT","同产品/渠道/版本已存在；请显式指定 existingVersionId。");
                }
                await Step("CREATE_VERSION",async()=>{
                    await api.Write("POST",V+"create",Form(c,s),ct);
                    s.Done.Add("CREATE_ACK");Save();
                    if(!await RecoverCreate())throw new UploadException("REMOTE_RESULT_UNKNOWN","创建已接受但无法定位唯一版本，恢复时先查询。");
                },RecoverCreate);
            }
        }
        await Detail(ct);
        await Update("PREPARE_VERSION",10,null,[1],[20],ct);
        if(!s.Done.Contains("OBJECT_READY"))
        {
            Stage("RESOLVE_OBJECT");
            var provider=await api.Get(O+"oss_provider",null,ct);
            if(Json.Text(provider?["provider"])!="tencent")throw new UploadException("UNSUPPORTED_PROVIDER","首版仅支持腾讯 COS。");
            if(s.File!.Size>50L*1024*1024 && string.IsNullOrEmpty(s.ObjectKey))
            {
                var hit=await api.Get(O+"check_files_by_md5",Q(("md5",s.File.Md5),("oss_provider","tencent"),("distinction","version-package")),ct);
                var url=Json.Text(hit?["url"]);
                if(!string.IsNullOrEmpty(url))
                {
                    if(Json.Text(hit?["md5"])!=s.File.Md5||Json.Text(hit?["oss_provider"])!="tencent")throw new UploadException("OBJECT_CONFLICT","查重结果不匹配当前文件。");
                    var u=new Uri(url);if(u.Scheme!="https")throw new UploadException("OBJECT_CONFLICT","查重返回非 HTTPS URL。");
                    s.PublicUrl=u.AbsoluteUri;s.ObjectKey=Uri.UnescapeDataString(u.AbsolutePath.TrimStart('/'));s.Reused=true;Save();
                }
            }
            if(!s.Reused)
            {
                if(string.IsNullOrEmpty(s.ObjectKey))
                {
                    var path=await api.Get("/api/v1/developapi/oss/versionpath",Q(("vid",s.VersionId.ToString()),("file_name",Path.GetFileName(s.File.Path))),ct);
                    s.ObjectKey=Json.Text(path?["path"])+Json.Text(path?["file_name"]);Save();
                }
                if(!s.ObjectKey.StartsWith(ProjectBinding.Prefix(c.TargetPrefix),StringComparison.Ordinal)||!s.ObjectKey.EndsWith(".zip")||s.ObjectKey.Contains(".."))throw new UploadException("OBJECT_CONFLICT","平台分配了非预期的项目包路径。");
                Stage("UPLOADING");await uploader.Upload(c,s,api,log,ct);Files.CheckStable(s.File);
                if(s.File.Size>50L*1024*1024)
                    await Step("REGISTER_OBJECT",async()=>{await api.Write("POST",O+"add_files_url",new JsonObject{["md5"]=s.File.Md5,["oss_provider"]="tencent",["url"]=s.PublicUrl,["distinction"]="version-package"},ct);},async()=>{
                        var h=await api.Get(O+"check_files_by_md5",Q(("md5",s.File.Md5),("oss_provider","tencent"),("distinction","version-package")),ct);return Json.Text(h?["url"])==s.PublicUrl;
                    });
            }
            if(!s.ObjectKey.StartsWith(ProjectBinding.Prefix(c.TargetPrefix),StringComparison.Ordinal)||!s.ObjectKey.EndsWith(".zip")||s.ObjectKey.Contains(".."))throw new UploadException("OBJECT_CONFLICT","对象不在项目测试包目录，不能绑定。");
            s.TestDir=ProjectBinding.Prefix(c.TestDirectoryPrefix)+Path.GetFileNameWithoutExtension(s.ObjectKey)+"/";
            s.Done.Add("OBJECT_READY");Save();
        }
        await Update("BIND_PACKAGE",null,s.ObjectKey,[20],[20],ct);
        await Poll("WAIT_TEST_ASSETS",async()=>{
            var unzip=await api.Get(V+"tmpunziplog",Q(("version_id",s.VersionId.ToString())),ct);
            var d=await Detail(ct);
            var active=d["test_package_unzip_log"];
            var structured=d["unzip_process_info"];
            if(structured is JsonObject x && Json.Text(x["status"])=="end" && !string.IsNullOrEmpty(Json.Text(x["err_msg"])))throw new UploadException("REMOTE_PROCESSING_FAILED","测试解压报告错误。");
            if(Json.Text(d["url"])!=s.TestDir)return false;
            if(structured is JsonObject info && Json.Text(info["status"])=="end"&&Json.Text(info["err_msg"])=="")return true;
            if(c.ConfirmedTestUnzipStatus.HasValue && active is JsonObject obj && Json.Int(obj["status"])==c.ConfirmedTestUnzipStatus.Value)return true;
            // Observed platform removes the active log after completion. Require
            // both independent views to be empty AND the task-specific directory.
            return unzip==null && d.ContainsKey("test_package_unzip_log") && active==null;
        },ct);
        if(c.Mode=="upload_only"){Complete("TEST_ASSETS_READY");return;}
        await Update("REQUEST_TEST",40,s.TestDir,[20],[40],ct);
        if(c.Mode=="prepare_test"){Complete("TEST_REQUESTED");return;}
        if(c.TesterId<=0 || (!c.RecordedTestWorkflow&&string.IsNullOrWhiteSpace(c.TestResultReference)))throw new UploadException("TEST_RESULT_REQUIRED","完整发布需填写 testerId 和与当前版本对应的 testResultReference；任务已保留在提测阶段。");
        if((s.Done.Contains("START_TEST")||s.PendingAction is "START_TEST" or "PASS_TEST")&&(s.TesterId!=c.TesterId||s.TestResultReference!=c.TestResultReference))throw new UploadException("VERSION_CONFLICT","测试状态操作已开始，不能替换本任务的测试人或测试结论引用。");
        s.TesterId=c.TesterId;s.TestResultReference=c.TestResultReference;Save();
        if(c.RecordedTestWorkflow&&s.TestStatusSource!="user_selected_recorded_workflow")
        {
            s.TestStatusSource="user_selected_recorded_workflow";Save();
            log.Emit(s,"testStatusAuthorized",new{testerId=c.TesterId,source=s.TestStatusSource,executesGameTests=false});
        }
        async Task<JsonObject?> FindTest()
        {
            for(int page=1;page<=1000;page++)
            {
                var d=await api.Get(R+"list",Q(("page",page.ToString()),("size","100")),ct);
                var list=d?["list"] as JsonArray??throw new UploadException("SCHEMA_CHANGED","测试记录列表结构变化。");
                var found=list.OfType<JsonObject>().Where(x=>Json.Int(x["vid"])==s.VersionId).ToList();
                if(found.Count>1)throw new UploadException("VERSION_CONFLICT","同版本存在多条测试记录，需核对。");
                if(found.Count==1)return found[0];if(list.Count==0||page*100>=Json.Int(d?["total"]))return null;
            }return null;
        }
        await Step("START_TEST",async()=>{await api.Write("PUT",R+"start",new JsonObject{["vid"]=s.VersionId,["test_id"]=c.TesterId,["remark"]=""},ct);},async()=>{
            var test=await FindTest();return test!=null&&Json.Int(test["test_id"])==c.TesterId&&!string.IsNullOrWhiteSpace(Json.Text(test["start_time"]))&&!Json.Text(test["start_time"]).StartsWith("0000");
        });
        await Step("PASS_TEST",async()=>{await api.Write("PUT",R+"pass",new JsonObject{["vid"]=s.VersionId},ct);},async()=>{
            var d=await Detail(ct);return new[]{50,60,99,100}.Contains(Json.Int(d["status"]));
        });
        await Poll("WAIT_RELEASE_COPY",async()=>Json.Bool(await api.Get(R+"filecopystatus",Vid(),ct)),ct);
        await Poll("WAIT_RELEASE_ASSETS",async()=>{
            var data=await api.Write("POST",V+"check_unzip_on_test_ok",new JsonObject{["vid_list"]=new JsonArray(s.VersionId)},ct);
            var x=data?[s.VersionId.ToString()];
            if(!string.IsNullOrEmpty(Json.Text(x?["err_msg"])))throw new UploadException("REMOTE_PROCESSING_FAILED","正式目录解压报告错误。");
            if(Json.Text(x?["status"])!="end")return false;
            var expected=ProjectBinding.Prefix(c.ReleaseDirectoryPrefix)+Path.GetFileNameWithoutExtension(s.ObjectKey)+"/";
            if(Json.Text(x?["path"])!=expected)throw new UploadException("OBJECT_CONFLICT","正式目录不匹配本次上传对象。");
            s.ReleaseDir=expected;Save();return true;
        },ct);
        await Update("PREPARE_PUBLISH",60,s.ReleaseDir,[50],[60],ct);
        if(c.Mode=="prepare_publish"&&!s.PublishConfirmed)
        {
            // Verify the remote boundary before enabling the final confirmation.
            var d=await Detail(ct);s.FinalRemoteStatus=Json.Int(d["status"]);
            if(s.FinalRemoteStatus!=60||Json.Text(d["url"])!=s.ReleaseDir||string.IsNullOrEmpty(s.ReleaseDir))
                throw new UploadException("VERSION_CONFLICT","最终确认前的版本状态或正式资源目录发生变化。");
            s.Stage="AWAITING_PUBLISH_CONFIRMATION";s.RunStatus="WAITING";Save();
            log.Emit(s,"awaitingPublishConfirmation",new{version=s.Version,versionId=s.VersionId,remoteStatus=s.FinalRemoteStatus});
            return;
        }
        await Update("REQUEST_PUBLISH",99,s.ReleaseDir,[60],[99,100],ct);
        await Poll("WAIT_PUBLISHED",async()=>{
            var d=await Detail(ct);s.FinalRemoteStatus=Json.Int(d["status"]);s.PublishTime=Json.Text(d["publish_time"]);Save();
            if(s.FinalRemoteStatus!=100)return false;
            if(Json.Text(d["url"])!=s.ReleaseDir||string.IsNullOrWhiteSpace(s.PublishTime)||s.PublishTime.StartsWith("0000"))throw new UploadException("SCHEMA_CHANGED","最终状态缺少一致的目录或发布时间。");return true;
        },ct);
        Complete("PUBLISHED");
    }
    void Complete(string stage){s.Stage=stage;s.RunStatus="SUCCEEDED";Save();log.Emit(s,"completed",new{version=s.Version,versionId=s.VersionId,published=stage=="PUBLISHED",reused=s.Reused,remoteStatus=s.FinalRemoteStatus,publishTime=s.PublishTime});}
    public static void ConfirmPublication(JobConfig config,JobState state,Journal journal)
    {
        if(config.Mode!="prepare_publish"||state.Stage!="AWAITING_PUBLISH_CONFIRMATION"||
            state.RunStatus!="WAITING"||state.FinalRemoteStatus!=60||!state.Done.Contains("PREPARE_PUBLISH")||state.PendingAction!=null)
            throw new UploadException("PUBLISH_NOT_READY","任务尚未到达最终确认发布步骤。");
        state.PublishConfirmed=true;state.PublishConfirmedAt=DateTimeOffset.UtcNow.ToString("O");journal.Save(state);
        journal.Emit(state,"publishConfirmed",new{version=state.Version,versionId=state.VersionId,confirmedAt=state.PublishConfirmedAt});
    }
}
