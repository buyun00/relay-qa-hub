using System.Net;
using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;

namespace Ozdqp;
public static class AcquisitionTests
{
    static void Check(bool value){if(!value)throw new Exception("Acquisition test assertion failed");}
    static async Task Error(string code,Func<Task> action){try{await action();}catch(UploadException e) when(e.Code==code){return;}throw new Exception("Expected acquisition error "+code);}
    sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> handle):HttpMessageHandler
    {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct){ct.ThrowIfCancellationRequested();return Task.FromResult(handle(request));}}
    sealed class Gateway(Func<string,JsonObject,JsonNode?> write):IPlatform
    {
        public Task<JsonNode?> Get(string path,Dictionary<string,string>? query,CancellationToken ct)=>throw new NotSupportedException();
        public Task<JsonNode?> Write(string method,string path,JsonObject body,CancellationToken ct){Check(method=="POST");return Task.FromResult(write(path,body));}
    }
    static HttpResponseMessage JsonResponse(int code)=>new(HttpStatusCode.OK){Content=new StringContent(new JsonObject{["code"]=code,["data"]=new JsonObject{["provider"]="tencent"}}.ToJsonString(),Encoding.UTF8,"application/json")};
    public static async Task Run(string root,Func<string,Func<Task>,Task> test,CancellationToken ct)
    {
        byte[] zipBytes;
        using(var stream=new MemoryStream())
        {
            using(var zip=new ZipArchive(stream,ZipArchiveMode.Create,true))using(var writer=new StreamWriter(zip.CreateEntry("test.txt").Open()))writer.Write("download-fixture");
            zipBytes=stream.ToArray();
        }
        await test("fixed_download_url_no_auth_and_completed_snapshot_reused",async()=>{
            string work=Path.Combine(root,"download-ok");int calls=0;
            var first=await TestDownloads.Get(work,ct,testHandler:new Handler(req=>{
                calls++;Check(req.RequestUri!.AbsoluteUri==TestDownloads.SourceUrl&&!req.Headers.Contains("Authorization")&&!req.Headers.Contains("Cookie"));
                return new(HttpStatusCode.OK){Content=new ByteArrayContent(zipBytes)};
            }));
            var second=await TestDownloads.Get(work,ct,testHandler:new Handler(req=>throw new Exception("Unexpected re-download")));
            Check(calls==1&&first.Sha256==second.Sha256&&first.ZipEntries==1&&!File.Exists(first.Path+".partial"));
        });
        await test("partial_download_never_promoted_and_retry_starts_fresh",async()=>{
            string work=Path.Combine(root,"download-short");
            await Error("DOWNLOAD_FAILED",async()=>{await TestDownloads.Get(work,ct,testHandler:new Handler(req=>{
                var content=new ByteArrayContent(zipBytes);content.Headers.ContentLength=zipBytes.Length+10;return new(HttpStatusCode.OK){Content=content};
            }));});
            Check(!File.Exists(TestDownloads.LocalPath(work)));
            var file=await TestDownloads.Get(work,ct,testHandler:new Handler(req=>new(HttpStatusCode.OK){Content=new ByteArrayContent(zipBytes)}));
            Check(file.Size==zipBytes.Length);
        });
        await test("download_html_is_rejected",async()=>{
            string work=Path.Combine(root,"download-html");
            await Error("DOWNLOAD_FAILED",async()=>{await TestDownloads.Get(work,ct,testHandler:new Handler(req=>new(HttpStatusCode.OK){Content=new StringContent("login page",Encoding.UTF8,"text/html")}));});
            Check(!File.Exists(TestDownloads.LocalPath(work)));
        });
        await test("password_login_matches_live_frontend_contract",async()=>{
            var gateway=new Gateway((path,form)=>{
                Check(path=="/api/v1/gwapi/login/unified"&&Json.Text(form["password"])=="5F4DCC3B5AA765D61D8327DEB882CF99"&&Json.Text(form["login_type"])=="password"&&Json.Bool(form["generate_token"])&&Json.Text(form["language"])=="zh");
                return new JsonObject{["access_token"]="fixture-access",["refresh_token"]="fixture-refresh"};
            });
            var result=await Authentication.Login(gateway,"https://fixture.invalid","fixture@example.invalid","password","email",ct,"https://login.fixture.invalid");Check(result.AccessToken=="fixture-access");
        });
        await test("subaccount_token_parsed_without_following_untrusted_redirect",async()=>{
            var good=new Gateway((path,form)=>{Check(path.EndsWith("/extension")&&!form.ContainsKey("login_type"));return new JsonObject{["new_skip_url"]="https://login.fixture.invalid"+"/main/#/?access_token=fixture%2Btoken"};});
            var tokens=await Authentication.Login(good,"https://fixture.invalid","fixture","password","subaccount",ct,"https://login.fixture.invalid");Check(tokens.AccessToken=="fixture+token");
            var bad=new Gateway((path,form)=>new JsonObject{["skip_url"]="https://untrusted.invalid/?access_token=fixture"});
            await Error("LOGIN_SCHEMA_CHANGED",async()=>{await Authentication.Login(bad,"https://fixture.invalid","fixture","password","subaccount",ct,"https://login.fixture.invalid");});
        });
        await test("refresh_token_rotation_contract",async()=>{
            var original=new LoginTokens("old-access","old-refresh","https://fixture.invalid","https://login.fixture.invalid");
            var gateway=new Gateway((path,form)=>{Check(path.EndsWith("/token/refresh_token")&&Json.Text(form["refresh_token"])=="old-refresh");return new JsonObject{["access_token"]="new-access",["refresh_token"]="new-refresh"};});
            var tokens=await Authentication.Refresh(gateway,original,ct);Check(tokens.AccessToken=="new-access"&&tokens.RefreshToken=="new-refresh");
            await Error("AUTH_REQUIRED",async()=>{await Authentication.Refresh(new Gateway((p,f)=>new JsonObject()),original,ct);});
        });
        await test("plaintext_login_config_roundtrip_and_origin_binding",async()=>{
            string path=Path.Combine(root,"auth-fixture.json");var tokens=new LoginTokens("fixture-cache-secret","fixture-refresh-secret","https://fixture.invalid","https://login.fixture.invalid","fixture@example.invalid","fixture-password");
            TokenCache.Save(tokens,path);Check(TokenCache.Load(tokens.ApiBase,path,"https://login.fixture.invalid")==tokens&&File.ReadAllText(path).Contains(tokens.Password));
            await Error("AUTH_REQUIRED",()=>{TokenCache.Load("https://different.invalid",path,"https://login.fixture.invalid");return Task.CompletedTask;});
        });
        await test("expired_refresh_uses_saved_password_once",async()=>{
            var original=new LoginTokens("old","expired","https://fixture.invalid","https://login.fixture.invalid","fixture@example.invalid","password");int logins=0;
            var gateway=new Gateway((path,form)=>{if(path.EndsWith("refresh_token"))throw new UploadException("AUTH_REQUIRED","fixture expired");logins++;Check(Json.Text(form["password"])=="5F4DCC3B5AA765D61D8327DEB882CF99");return new JsonObject{["access_token"]="renewed",["refresh_token"]="new-refresh"};});
            var result=await Authentication.Renew(gateway,original,ct);Check(logins==1&&result.AccessToken=="renewed"&&result.Password==original.Password);
        });
        await test("expired_business_token_refreshes_once_before_retrying_write",async()=>{
            int calls=0,refreshes=0;
            using var api=new PlatformClient("https://fixture.invalid","old",refresh:ct=>{refreshes++;return Task.FromResult("new");},testHandler:new Handler(req=>{
                calls++;Check(req.Headers.GetValues("Authorization").Single()==(calls==1?"old":"new"));return JsonResponse(calls==1?305004:0);
            }));
            await api.Write("PUT","/api/v1/developapi/versions/update",new JsonObject(),ct);Check(calls==2&&refreshes==1);
        });
        await test("expired_token_retry_is_bounded",async()=>{
            int calls=0,refreshes=0;
            using var api=new PlatformClient("https://fixture.invalid","old",refresh:ct=>{refreshes++;return Task.FromResult("new");},testHandler:new Handler(req=>{calls++;return JsonResponse(305003);}));
            await Error("AUTH_REQUIRED",async()=>{await api.Get("/api/v1/thirdpartyadminapi/oss_provider",null,ct);});Check(calls==2&&refreshes==1);
        });
    }
}
