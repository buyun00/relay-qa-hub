using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Ozdqp;
public interface IPlatform
{
    Task<JsonNode?> Get(string path, Dictionary<string,string>? query, CancellationToken ct);
    Task<JsonNode?> Write(string method, string path, JsonObject data, CancellationToken ct);
}
public sealed class PlatformClient : IPlatform, IDisposable
{
    readonly HttpClient client;
    readonly Uri origin;
    readonly Func<CancellationToken,Task<string>>? refresh;
    string authorization;
    public PlatformClient(string apiBase, string authorization, bool allowLoopback = false, Func<CancellationToken,Task<string>>? refresh = null, HttpMessageHandler? testHandler = null)
    {
        this.authorization=authorization;this.refresh=refresh;
        origin = new Uri(apiBase);
        if (origin.Scheme != "https" && !(allowLoopback && origin.IsLoopback)) throw new UploadException("INVALID_INPUT", "平台 API 必须使用 HTTPS。");
        var handler = testHandler??new HttpClientHandler { AllowAutoRedirect = false };
        client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(90) };
        client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");
        client.DefaultRequestHeaders.TryAddWithoutValidation("ruixue-language", "zh");
    }
    public Task<JsonNode?> Get(string path, Dictionary<string,string>? query, CancellationToken ct) => Request("GET",path,query,null,ct);
    public Task<JsonNode?> Write(string method, string path, JsonObject data, CancellationToken ct) => Request(method,path,null,data,ct);
    async Task<JsonNode?> Request(string method,string path,Dictionary<string,string>? query,JsonObject? body,CancellationToken ct)
    {
        if (!path.StartsWith("/api/v1/")) throw new UploadException("INVALID_INPUT", "未知 API 路径。");
        var target = new Uri(origin, path + (query?.Count > 0 ? "?" + string.Join("&",query.Select(kv=>Uri.EscapeDataString(kv.Key)+"="+Uri.EscapeDataString(kv.Value))) : ""));
        int retries = method == "GET" ? 3 : 1;
        bool refreshed=false;
        async Task<bool> Renew()
        {
            if(refreshed||refresh==null)return false;
            refreshed=true;authorization=await refresh(ct);return true;
        }
        for(int i=0;i<retries;i++)
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), target);
            if(!string.IsNullOrWhiteSpace(authorization))request.Headers.TryAddWithoutValidation("Authorization",authorization);
            if(body!=null)request.Content = new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json");
            try
            {
                using var response = await client.SendAsync(request,ct);
                if(response.StatusCode==HttpStatusCode.Unauthorized)
                {
                    if(await Renew()){i--;continue;}
                    throw new UploadException("AUTH_REQUIRED","业务登录已失效，请重新 login 后恢复。");
                }
                if(response.StatusCode==HttpStatusCode.Forbidden)throw new UploadException("FORBIDDEN","该账户没有操作权限。");
                if(!response.IsSuccessStatusCode)
                {
                    if(method=="GET"&&((int)response.StatusCode>=500||(int)response.StatusCode==429)&&i+1<retries){await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2,i)),ct);continue;}
                    throw new UploadException(method=="GET"?"HTTP_FAILED":"REMOTE_RESULT_UNKNOWN",$"接口 {path} 返回 HTTP {(int)response.StatusCode}。");
                }
                var text=await response.Content.ReadAsStringAsync(ct);
                JsonObject? root;
                try { root=JsonNode.Parse(text) as JsonObject; } catch { throw new UploadException("REMOTE_RESULT_UNKNOWN",$"接口 {path} 响应不是有效 JSON。"); }
                if(root==null||!root.ContainsKey("code"))throw new UploadException("SCHEMA_CHANGED",$"接口 {path} 缺少 code 字段。");
                if(!int.TryParse(Json.Text(root["code"]),out var businessCode))throw new UploadException("SCHEMA_CHANGED",$"接口 {path} code 格式发生变化。");
                if(businessCode is 305002 or 305003 or 305004)
                {
                    if(await Renew()){i--;continue;}
                    throw new UploadException("AUTH_REQUIRED","平台登录令牌已过期，请重新 login 后恢复。");
                }
                if(businessCode!=0)throw new UploadException("BUSINESS_FAILED",$"接口 {path} 返回业务错误码。详情需在平台查看。");
                return root["data"]?.DeepClone();
            }
            catch(OperationCanceledException) when (!ct.IsCancellationRequested && method=="GET" && i+1<retries) { await Task.Delay(TimeSpan.FromSeconds(i+1),ct); }
            catch(HttpRequestException) when(method=="GET" && i+1<retries) { await Task.Delay(TimeSpan.FromSeconds(i+1),ct); }
            catch(HttpRequestException) { throw new UploadException("REMOTE_RESULT_UNKNOWN",$"接口 {path} 连接异常；写操作结果需核对后恢复。"); }
        }
        throw new UploadException("NETWORK_TIMEOUT","接口请求超时。");
    }
    public void Dispose()=>client.Dispose();
}
public interface IObjectUploader
{
    Task Upload(JobConfig config, JobState state, IPlatform platform, Journal journal, CancellationToken ct);
}
