using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Ozdqp;

// Executes the real HTTP API client and workflow against loopback fixtures.
// Tencent COS signing/STS is deliberately not represented as verified by these tests.
public static class SelfTest
{
    static void Assert(bool value,string message){if(!value)throw new Exception("Self-test assertion: "+message);}
    static async Task Expect(string code,Func<Task> action)
    {
        try{await action();}catch(UploadException e) when(e.Code==code){return;}
        throw new Exception("Expected error: "+code);
    }
    public static async Task Run(CancellationToken ct)
    {
        string root=Path.Combine(Path.GetTempPath(),"OZDQP-Uploader-self-test",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        string zipPath=Path.Combine(root,"fixture.zip");
        using(var zip=ZipFile.Open(zipPath,ZipArchiveMode.Create))
        using(var entry=zip.CreateEntry("payload.bin",CompressionLevel.NoCompression).Open())
        {
            byte[] block=new byte[1024*1024];new Random(12345).NextBytes(block);
            for(int i=0;i<51;i++)entry.Write(block);
        }
        var identity=await Files.Inspect(zipPath,ct);var results=new List<object>();
        async Task Case(string name,Func<Task> test)
        {
            await test();results.Add(new{name,passed=true});Console.WriteLine(JsonSerializer.Serialize(new{type="selfTestCase",name,passed=true}));
        }
        async Task Scenario(string name,Func<Fixture,JobConfig,JobState,Journal,Engine,Task> body)
        {
            await using var fixture=new Fixture(identity);using var api=new PlatformClient(fixture.Origin,"fixture-secret-not-for-logs",true);
            var c=new JobConfig{ApiBase=fixture.Origin,FilePath=zipPath,Summary="fixture",Version="9.9.9",TesterId=7,TestResultReference="local-fixture-only",PollSeconds=1,WaitTimeoutSeconds=1,WorkDirectory=Path.Combine(root,name)};
            var s=new JobState{File=identity};using var journal=new Journal(c.WorkDirectory);
            var engine=new Engine(c,s,api,new FixtureUploader(fixture.Origin),journal);
            await body(fixture,c,s,journal,engine);
            if(File.Exists(Path.Combine(c.WorkDirectory,"events.jsonl")))Assert(!File.ReadAllText(Path.Combine(c.WorkDirectory,"events.jsonl")).Contains("fixture-secret"),"secret leaked in logs");
        }
        await Case("fresh_upload_full_workflow",()=>Scenario("fresh",async(f,c,s,j,e)=>{
            await e.Run(ct);Assert(s.Stage=="PUBLISHED"&&s.FinalRemoteStatus==100,"published result");Assert(f.Uploads==1&&f.Registers==1&&f.CreateCount==1,"fresh upload requests");
            Assert(f.Actions.SequenceEqual(new[]{"create","update:10","object","register","bind","update:40","start","pass","update:60","update:99"}),"workflow order");
            Assert(f.ReceivedSha==identity.Sha256,"transferred bytes SHA256");
            var count=f.Writes;await e.Run(ct);Assert(f.Writes==count,"completed job wrote again");
        }));
        await Case("md5_hit_skips_object_transfer",()=>Scenario("reuse",async(f,c,s,j,e)=>{
            f.Md5Hit=true;await e.Run(ct);Assert(s.Reused&&f.Uploads==0&&f.Registers==0&&s.Stage=="PUBLISHED","dedup branch");
        }));
        await Case("lost_update_ack_reconciles_without_rewrite",()=>Scenario("lost-update",async(f,c,s,j,e)=>{
            f.LoseUpdateAck=true;await Expect("REMOTE_RESULT_UNKNOWN",()=>e.Run(ct));Assert(s.PendingAction=="PREPARE_VERSION","pending mutation recorded");
            await e.Run(ct);Assert(f.PrepareWrites==1&&s.Stage=="PUBLISHED","update repeated on recovery");
        }));
        await Case("lost_create_ack_stops_without_adopting_other_version",()=>Scenario("lost-create",async(f,c,s,j,e)=>{
            f.LoseCreateAck=true;await Expect("REMOTE_RESULT_UNKNOWN",()=>e.Run(ct));await Expect("REMOTE_RESULT_UNKNOWN",()=>e.Run(ct));Assert(f.CreateCount==1&&s.VersionId==0,"unknown create retried/adopted");
        }));
        await Case("lost_object_registration_ack_reconciles_without_reupload",()=>Scenario("lost-register",async(f,c,s,j,e)=>{
            f.LoseRegisterAck=true;await Expect("REMOTE_RESULT_UNKNOWN",()=>e.Run(ct));Assert(s.PendingAction=="REGISTER_OBJECT","register pending");
            await e.Run(ct);Assert(f.Registers==1&&f.Uploads==1&&s.Stage=="PUBLISHED","register repeated or object skipped incorrectly");
        }));
        await Case("existing_version_conflict_leaves_no_write_intent",()=>Scenario("conflict",async(f,c,s,j,e)=>{
            f.Seed();await Expect("VERSION_CONFLICT",()=>e.Run(ct));Assert(s.PendingAction==null&&f.CreateCount==0,"conflict produced pending create");
        }));
        await Case("test_result_checkpoint_and_resume",()=>Scenario("test-gate",async(f,c,s,j,e)=>{
            c.TestResultReference="";await Expect("TEST_RESULT_REQUIRED",()=>e.Run(ct));Assert(f.Status==40&&!f.Actions.Contains("pass"),"test gate bypassed");
            c.TestResultReference="fixture-reviewed";await e.Run(ct);Assert(f.CreateCount==1&&f.Uploads==1&&s.Stage=="PUBLISHED","checkpoint repeated upload");
        }));
        await Case("prepare_publish_stops_at_60_and_resume_does_not_publish",()=>Scenario("publish-gate",async(f,c,s,j,e)=>{
            c.Mode="prepare_publish";c.RecordedTestWorkflow=true;c.UseVersionText=true;c.TestResultReference="";
            c.Summary="must-not-be-submitted";c.Description="must-not-be-submitted";
            await e.Run(ct);
            Assert(f.Status==60&&s.Stage=="AWAITING_PUBLISH_CONFIRMATION"&&s.RunStatus=="WAITING","wrong confirmation boundary");
            Assert(f.PublishWrites==0&&f.Actions.Contains("pass")&&s.Done.Contains("WAIT_RELEASE_ASSETS"),"must finish testing and resource preparation only");
            Assert(s.TestStatusSource=="user_selected_recorded_workflow"&&s.TestResultReference=="","must not invent test evidence");
            Assert(f.CreatedSummary=="9.9.9"&&f.CreatedDescription=="9.9.9","version-only release text");
            using var api=new PlatformClient(f.Origin,"fixture-secret-not-for-logs",true);
            var count=f.Writes;await new Engine(c,j.Read()!,api,new FixtureUploader(f.Origin),j).Run(ct);
            Assert(f.PublishWrites==0&&f.Writes==count,"ordinary restart/resume crossed confirmation boundary");
            var restored=j.Read()!;Engine.ConfirmPublication(c,restored,j);
            await new Engine(c,restored,api,new FixtureUploader(f.Origin),j).Run(ct);
            Assert(f.PublishWrites==1&&restored.Stage=="PUBLISHED"&&restored.PublishConfirmedAt!="","explicit confirmation did not publish exactly once");
            count=f.Writes;await new Engine(c,restored,api,new FixtureUploader(f.Origin),j).Run(ct);Assert(f.Writes==count,"completed confirmation repeated a write");
        }));
        await Case("changed_release_directory_is_not_published",()=>Scenario("confirm-url",async(f,c,s,j,e)=>{
            c.Mode="prepare_publish";await e.Run(ct);Engine.ConfirmPublication(c,s,j);f.ChangeReleaseDirectory();
            await Expect("VERSION_CONFLICT",()=>e.Run(ct));Assert(f.PublishWrites==0,"changed release directory published");
        }));
        await Case("early_confirmation_and_changed_remote_state_do_not_publish",()=>Scenario("confirm-guard",async(f,c,s,j,e)=>{
            c.Mode="prepare_publish";
            await Expect("PUBLISH_NOT_READY",()=>{Engine.ConfirmPublication(c,s,j);return Task.CompletedTask;});Assert(f.Writes==0,"early confirmation wrote remotely");
            await e.Run(ct);Engine.ConfirmPublication(c,s,j);f.Status=50;
            await Expect("VERSION_CONFLICT",()=>e.Run(ct));Assert(f.PublishWrites==0,"published after remote state changed");
        }));
        await Case("recorded_full_workflow_needs_no_fabricated_test_result",()=>Scenario("recorded-full",async(f,c,s,j,e)=>{
            c.RecordedTestWorkflow=true;c.TestResultReference="";c.UseVersionText=true;c.Version=null;
            await e.Run(ct);Assert(s.Stage=="PUBLISHED"&&s.Version=="9.9.9"&&f.PublishWrites==1,"full workflow did not publish");
            Assert(f.CreatedSummary==s.Version&&f.CreatedDescription==s.Version,"automatic version was not used for update text");
        }));
        await Case("publishing_99_is_not_success_and_poll_resumes",()=>Scenario("not-final",async(f,c,s,j,e)=>{
            f.HoldPublish=true;await Expect("PROCESSING_TIMEOUT",()=>e.Run(ct));Assert(s.FinalRemoteStatus==99&&s.RunStatus!="SUCCEEDED","99 falsely accepted");
            f.HoldPublish=false;await e.Run(ct);Assert(f.PublishWrites==1&&s.Stage=="PUBLISHED","publish write repeated");
        }));
        await Case("release_processing_error_blocks_publish",()=>Scenario("release-error",async(f,c,s,j,e)=>{
            f.ReleaseError=true;await Expect("REMOTE_PROCESSING_FAILED",()=>e.Run(ct));Assert(f.PublishWrites==0,"published after processing error");
        }));
        await Case("authorization_failure_has_no_business_writes",()=>Scenario("auth",async(f,c,s,j,e)=>{
            f.Unauthorized=true;await Expect("AUTH_REQUIRED",()=>e.Run(ct));Assert(f.Writes==0,"unauthorized mutation");
        }));
        await Case("invalid_business_code_is_not_success",()=>Scenario("schema",async(f,c,s,j,e)=>{
            f.InvalidCode=true;await Expect("SCHEMA_CHANGED",()=>e.Run(ct));Assert(f.Writes==0,"malformed code mutation");
        }));
        await Case("changed_file_and_unsafe_zip_are_rejected",async()=>{
            var badIdentity=identity with{Size=identity.Size+1};await Expect("FILE_CHANGED",()=>Task.Run(()=>Files.CheckStable(badIdentity),ct));
            var unsafePath=Path.Combine(root,"unsafe.zip");using(var zip=ZipFile.Open(unsafePath,ZipArchiveMode.Create))zip.CreateEntry("../escape.txt");
            await Expect("INVALID_INPUT",async()=>{await Files.Inspect(unsafePath,ct);});
        });
        await Case("journal_excludes_concurrent_task_owner",()=>{
            using var first=new Journal(Path.Combine(root,"lock-test"));
            return Expect("JOB_LOCKED",()=>{using var second=new Journal(first.Root);return Task.CompletedTask;});
        });
        await AcquisitionTests.Run(root,Case,ct);
        await MultipartTransferTests.Run(root,Case,ct);
        await SourceDownloadTests.Run(root,Case,ct);
        await Case("server_auth_cache_is_explicit_and_separate_from_desktop",()=>{
            var prior=Environment.GetEnvironmentVariable("OZDQP_AUTH_FILE");
            try {
                var first=Path.Combine(root,"server-owner-a","auth.json");
                var second=Path.Combine(root,"server-owner-b","auth.json");
                Environment.SetEnvironmentVariable("OZDQP_AUTH_FILE",first);
                const string api="https://fq2ivi.ipwana.com";
                TokenCache.Save(new LoginTokens("fixture-access","fixture-refresh",api,Authentication.LoginBase,"owner-a","fixture-password"));
                Assert(TokenCache.CachePath(api)==first&&TokenCache.Load(api)?.Account=="owner-a","explicit server cache not used");
                Environment.SetEnvironmentVariable("OZDQP_AUTH_FILE",second);
                Assert(TokenCache.Load(api)==null,"credentials crossed owner boundary");
                Environment.SetEnvironmentVariable("OZDQP_AUTH_FILE",first);
                Assert(TokenCache.Load(api)?.Account=="owner-a","original server cache replaced");
            } finally { Environment.SetEnvironmentVariable("OZDQP_AUTH_FILE",prior); }
            return Task.CompletedTask;
        });
        var report=new{version="0.4.1",verification="local-loopback-and-handler-fixtures",passed=results.Count,failed=0,realPlatformTested=false,realAccountLoginTested=false,tencentSdkTransferTested=false,fixture=identity,tests=results,at=DateTimeOffset.UtcNow};
        string reportPath=Path.Combine(root,"report.json");await File.WriteAllTextAsync(reportPath,JsonSerializer.Serialize(report,Json.Options),ct);
        Console.WriteLine(JsonSerializer.Serialize(new{type="selfTestResult",passed=results.Count,failed=0,reportPath,realPlatformTested=false}));
    }
    sealed class FixtureUploader(string origin):IObjectUploader
    {
        public async Task Upload(JobConfig c,JobState s,IPlatform api,Journal j,CancellationToken ct)
        {
            if(s.Done.Contains("COS_UPLOAD"))return;
            using var client=new HttpClient();await using var file=File.OpenRead(c.FilePath);using var content=new StreamContent(file);
            using var response=await client.PutAsync(origin+"fixture-object",content,ct);response.EnsureSuccessStatusCode();
            s.PublicUrl="https://fixture.invalid/"+s.ObjectKey;s.Done.Add("COS_UPLOAD");j.Save(s);
        }
    }
    sealed class Fixture:IAsyncDisposable
    {
        readonly HttpListener listener=new();readonly Task loop;readonly CancellationTokenSource stop=new();readonly FileIdentity file;
        public string Origin{get;}public int Status;public int Uploads,Registers,CreateCount,PrepareWrites,PublishWrites,Writes;public string ReceivedSha="";public string CreatedSummary="",CreatedDescription="";
        public void ChangeReleaseDirectory(){detail!["url"]="release/dir/other/";}
        public bool Md5Hit,LoseUpdateAck,LoseCreateAck,LoseRegisterAck,HoldPublish,ReleaseError,Unauthorized,InvalidCode;
        public List<string> Actions{get;}=[];JsonObject? detail;bool started;
        const string Key="test/pkg/fixture.zip",TestDir="test/dir/fixture/",ReleaseDir="release/dir/fixture/";
        public Fixture(FileIdentity file)
        {
            this.file=file;var socket=new TcpListener(IPAddress.Loopback,0);socket.Start();int port=((IPEndPoint)socket.LocalEndpoint).Port;socket.Stop();
            Origin=$"http://127.0.0.1:{port}/";listener.Prefixes.Add(Origin);listener.Start();loop=Loop();
        }
        public void Seed(){detail=new JsonObject{["id"]=42,["version"]="9.9.9",["product_id"]="2002",["channel_id"]="1002",["sub_type"]=1,["script_type"]=3,["update_type"]=1,["test_package_unzip_log"]=null};Status=1;}
        async Task Loop()
        {
            try{while(!stop.IsCancellationRequested){var context=await listener.GetContextAsync();await Handle(context);}}
            catch(Exception) when(stop.IsCancellationRequested){}
        }
        async Task Handle(HttpListenerContext x)
        {
            try
            {
                string path=x.Request.Url!.AbsolutePath;
                if(path=="/fixture-object")
                {
                    using var sha=SHA256.Create();ReceivedSha=Convert.ToHexString(await sha.ComputeHashAsync(x.Request.InputStream)).ToLowerInvariant();Uploads++;Actions.Add("object");x.Response.StatusCode=200;return;
                }
                if(Unauthorized){x.Response.StatusCode=401;return;}
                if(InvalidCode){await Reply(x,new JsonObject{["code"]="not-a-number"});return;}
                if(x.Request.Headers["Authorization"]!="fixture-secret-not-for-logs"){x.Response.StatusCode=403;return;}
                JsonNode? data=null;JsonObject? body=null;
                if(x.Request.HasEntityBody){using var reader=new StreamReader(x.Request.InputStream);body=JsonNode.Parse(await reader.ReadToEndAsync()) as JsonObject;}
                if(x.Request.HttpMethod!="GET")Writes++;
                string name=path.Split('/').Last();
                switch(name)
                {
                    case "nextver":data=JsonValue.Create("9.9.9");break;
                    case "create":
                        CreatedSummary=Json.Text(body?["summarize"]);CreatedDescription=Json.Text(body?["content"]);
                        Assert(body!.ContainsKey("tag_id")&&body["tag_id"]==null&&body["remark"] is JsonObject&&Json.Text(body["ext"])=="[]"&&body["apps"] is JsonArray,"observed form field types");
                        Seed();CreateCount++;Actions.Add("create");if(LoseCreateAck){LoseCreateAck=false;x.Response.StatusCode=500;return;}break;
                    case "list":
                        if(path.Contains("/record/"))data=new JsonObject{["list"]=started?new JsonArray(new JsonObject{["vid"]=42,["test_id"]=7,["start_time"]="2026-01-01 00:00:00"}):new JsonArray(),["total"]=started?1:0};
                        else data=new JsonObject{["list"]=detail==null?new JsonArray():new JsonArray(detail.DeepClone()),["total"]=detail==null?0:1};break;
                    case "detail":
                        if(Status==99&&!HoldPublish)Status=100;
                        detail!["status"]=Status;detail["publish_time"]=Status==100?"2026-01-01 00:01:00":"";data=detail.DeepClone();break;
                    case "update":
                        Assert(Json.Int(body?["id"])==42,"wrong update ID");
                        if(body!.ContainsKey("update_status"))
                        {
                            int action=Json.Int(body["update_status"]);Actions.Add("update:"+action);
                            Status=action==10?20:action;
                            if(action==10)PrepareWrites++;if(action==99)PublishWrites++;
                            if(body.ContainsKey("url"))detail!["url"]=body["url"]!.DeepClone();
                            if(action==10&&LoseUpdateAck){LoseUpdateAck=false;x.Response.StatusCode=500;return;}
                        }
                        else {Assert(Json.Text(body["url"])==Key,"wrong bind path");detail!["url"]=TestDir;Actions.Add("bind");}break;
                    case "oss_provider":data=new JsonObject{["provider"]="tencent"};break;
                    case "check_files_by_md5":data=Md5Hit?new JsonObject{["md5"]=file.Md5,["oss_provider"]="tencent",["url"]="https://fixture.invalid/"+Key}:new JsonObject{["url"]=""};break;
                    case "versionpath":data=new JsonObject{["path"]="test/pkg/",["file_name"]="fixture.zip"};break;
                    case "add_files_url":Assert(Json.Text(body?["md5"])==file.Md5,"register md5");Registers++;Actions.Add("register");Md5Hit=true;if(LoseRegisterAck){LoseRegisterAck=false;x.Response.StatusCode=500;return;}break;
                    case "tmpunziplog":break;
                    case "start":started=true;Actions.Add("start");break;
                    case "pass":Assert(started,"pass without start");Status=50;detail!["url"]=ReleaseDir;Actions.Add("pass");break;
                    case "filecopystatus":data=JsonValue.Create(true);break;
                    case "check_unzip_on_test_ok":data=new JsonObject{["42"]=new JsonObject{["status"]="end",["path"]=ReleaseDir,["err_msg"]=ReleaseError?"fixture-error":""}};break;
                    default:x.Response.StatusCode=404;return;
                }
                await Reply(x,new JsonObject{["code"]=0,["data"]=data});
            }
            catch{ x.Response.StatusCode=500; }
            finally{x.Response.Close();}
        }
        static async Task Reply(HttpListenerContext x,JsonObject body){byte[] bytes=Encoding.UTF8.GetBytes(body.ToJsonString());x.Response.ContentType="application/json";x.Response.ContentLength64=bytes.Length;await x.Response.OutputStream.WriteAsync(bytes);}
        public async ValueTask DisposeAsync(){stop.Cancel();listener.Close();await loop;stop.Dispose();}
    }
}
