using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ozdqp;
public sealed record LoginTokens(string AccessToken,string RefreshToken,string ApiBase,string LoginBase,string Account="",string Password="",string Kind="email");
public static class Authentication
{
    public static string ReadSecret(string prompt)
    {
        if(Console.IsInputRedirected)throw new UploadException("AUTH_REQUIRED","请在交互终端执行 login 登录，或由宿主注入 OZDQP_AUTHORIZATION。");
        Console.Error.Write(prompt);var text=new StringBuilder();ConsoleKeyInfo key;
        while((key=Console.ReadKey(true)).Key!=ConsoleKey.Enter){if(key.Key==ConsoleKey.Backspace){if(text.Length>0)text.Length--;}else if(!char.IsControl(key.KeyChar))text.Append(key.KeyChar);}
        Console.Error.WriteLine();return text.ToString();
    }
    public static async Task<LoginTokens> Login(IPlatform gateway,string apiBase,string account,string password,string kind,CancellationToken ct,string loginBase)
    {
        loginBase=ProjectBinding.Origin(loginBase);apiBase=ProjectBinding.Origin(apiBase);
        if(kind is not ("email" or "subaccount"))throw new UploadException("INVALID_INPUT","登录类型为 email 或 subaccount。");
        if(string.IsNullOrWhiteSpace(account)||string.IsNullOrEmpty(password))throw new UploadException("INVALID_INPUT","账号和密码不能为空。");
        byte[] bytes=Encoding.UTF8.GetBytes(password);string digest;
        try{digest=Convert.ToHexString(MD5.HashData(bytes));}finally{CryptographicOperations.ZeroMemory(bytes);}
        // Matches the live website's UTF-8 MD5 uppercase password transform.
        var form=new JsonObject{["account"]=account,["password"]=digest,["language"]="zh"};
        if(kind=="email"){form["login_type"]="password";form["generate_token"]=true;}
        var data=await gateway.Write("POST","/api/v1/gwapi/login/"+(kind=="email"?"unified":"extension"),form,ct);
        string access=Json.Text(data?["access_token"]);
        if(string.IsNullOrEmpty(access)&&kind=="subaccount")
        {
            string link=Json.Text(data?["new_skip_url"]);if(string.IsNullOrWhiteSpace(link))link=Json.Text(data?["skip_url"]);
            if(Uri.TryCreate(link,UriKind.Absolute,out var uri)&&uri.Scheme=="https"&&(uri.Authority==new Uri(loginBase).Authority||uri.Authority==new Uri(apiBase).Authority))
            {
                var matches=Regex.Matches(uri.Query+uri.Fragment,"[?&]access_token=([^&#]+)");
                if(matches.Count==1)access=Uri.UnescapeDataString(matches[0].Groups[1].Value.Replace("+"," "));
            }
        }
        if(string.IsNullOrWhiteSpace(access)||access.Contains("REDACTED",StringComparison.OrdinalIgnoreCase))throw new UploadException("LOGIN_SCHEMA_CHANGED","登录响应没有可用 access_token。可能需要网页验证或子账号跳转适配；没有尝试绕过。");
        return new LoginTokens(access,Json.Text(data?["refresh_token"]),new Uri(apiBase).GetLeftPart(UriPartial.Authority),loginBase,account,password,kind);
    }
    public static async Task<LoginTokens> InteractiveLogin(string apiBase,string kind,CancellationToken ct,string loginBase)
    {
        if(Console.IsInputRedirected)throw new UploadException("AUTH_REQUIRED","尚未登录；请在 PowerShell 执行 login。");
        Console.Error.Write(kind=="subaccount"?"子账号：":"登录邮箱：");string account=Console.ReadLine()??"";
        string password=ReadSecret("密码（不回显）：");
        using var gateway=new PlatformClient(ProjectBinding.Origin(loginBase),"");
        LoginTokens tokens;
        try{tokens=await Login(gateway,apiBase,account,password,kind,ct,loginBase);}finally{password="";}
        using var check=new PlatformClient(apiBase,tokens.AccessToken);
        await CheckUploadAccess(check,ct);
        TokenCache.Save(tokens);return tokens;
    }
    public static Task<JsonNode?> CheckUploadAccess(IPlatform api,CancellationToken ct)=>api.Get("/api/v1/thirdpartyadminapi/oss_provider",null,ct);
    public static async Task<LoginTokens> Refresh(IPlatform gateway,LoginTokens current,CancellationToken ct)
    {
        if(string.IsNullOrWhiteSpace(current.RefreshToken))throw new UploadException("AUTH_REQUIRED","登录没有可用刷新令牌，请重新执行 login。");
        JsonNode? data;
        try{data=await gateway.Write("POST","/api/v1/gwapi/user/token/refresh_token",new JsonObject{["refresh_token"]=current.RefreshToken},ct);}
        catch(UploadException){throw new UploadException("AUTH_REQUIRED","登录续期失败，请重新执行 login 后恢复任务。");}
        string access=Json.Text(data?["access_token"]),refresh=Json.Text(data?["refresh_token"]);
        if(string.IsNullOrWhiteSpace(access)||string.IsNullOrWhiteSpace(refresh))throw new UploadException("AUTH_REQUIRED","登录续期响应不完整，请重新登录。");
        return current with{AccessToken=access,RefreshToken=refresh};
    }
    public static async Task<LoginTokens> Renew(IPlatform gateway,LoginTokens current,CancellationToken ct)
    {
        try{return await Refresh(gateway,current,ct);}
        catch(UploadException e) when(e.Code=="AUTH_REQUIRED"&&!string.IsNullOrEmpty(current.Account)&&!string.IsNullOrEmpty(current.Password))
        {
            try{return await Login(gateway,current.ApiBase,current.Account,current.Password,current.Kind,ct,current.LoginBase);}
            catch(UploadException){throw new UploadException("AUTH_REQUIRED","保存的账号密码登录失败，请重新执行 login 更新账号密码。");}
        }
    }
}
public static class TokenCache
{
    public static string CachePath(string api)=>Environment.GetEnvironmentVariable("OZDQP_AUTH_FILE") is { Length: > 0 } configured
        ? Path.GetFullPath(configured)
        : throw new UploadException("AUTH_REQUIRED","必须明确设置本实例的 OZDQP_AUTH_FILE。");
    public static void Save(LoginTokens tokens,string? testPath=null)
    {
        var path=testPath??CachePath(tokens.ApiBase);Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path+".tmp",JsonSerializer.Serialize(tokens,Json.Options),new UTF8Encoding(false));File.Move(path+".tmp",path,true);
    }
    public static LoginTokens? Load(string api,string? testPath=null,string? loginBase=null)
    {
        var path=testPath??CachePath(api);if(!File.Exists(path))return null;
            LoginTokens? result;
            try{result=JsonSerializer.Deserialize<LoginTokens>(File.ReadAllText(path),Json.Options);}
            catch(JsonException){throw new UploadException("AUTH_REQUIRED","登录配置格式无效，请重新 login。");}
            if(result==null||result.ApiBase!=ProjectBinding.Origin(api)||string.IsNullOrEmpty(loginBase)||result.LoginBase!=ProjectBinding.Origin(loginBase))throw new UploadException("AUTH_REQUIRED","登录缓存环境不匹配。");
            return result;
    }
    public static void Forget(string api)=>File.Delete(CachePath(api));
}
