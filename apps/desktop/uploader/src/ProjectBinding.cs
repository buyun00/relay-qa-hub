namespace Ozdqp;
public static class ProjectBinding
{
    public static string Origin(string value)
    {
        if(!Uri.TryCreate(value,UriKind.Absolute,out var uri)||uri.Scheme is not ("https" or "http")||uri.UserInfo!=""||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!="")throw new UploadException("INVALID_INPUT","项目服务根地址必须明确配置且不含凭据。");
        return uri.GetLeftPart(UriPartial.Authority);
    }
    public static string Prefix(string value)
    {
        if(string.IsNullOrWhiteSpace(value)||value.StartsWith('/')||!value.EndsWith('/')||value.Contains("..")||value.Contains('\\')||value.Contains(':')||value.Any(char.IsControl))throw new UploadException("INVALID_INPUT","项目目标目录前缀无效。");
        return value;
    }
    public static void Validate(JobConfig config)
    {
        if(!Guid.TryParse(config.ProjectId,out _)||config.ComponentVersion<1)throw new UploadException("INVALID_INPUT","任务必须绑定项目和配置版本。");
        foreach(var (key,expected) in new[]{("QA_HUB_PROJECT_ID",config.ProjectId),("QA_HUB_COMPONENT_VERSION",config.ComponentVersion.ToString())})
            if(Environment.GetEnvironmentVariable(key) is { Length: > 0 } actual&&actual!=expected)throw new UploadException("PROJECT_SCOPE_MISMATCH","执行器与任务项目版本不一致。");
        config.ApiBase=Origin(config.ApiBase);config.LoginBase=Origin(config.LoginBase);
        Prefix(config.TargetPrefix);Prefix(config.TestDirectoryPrefix);Prefix(config.ReleaseDirectoryPrefix);
        PackageDownload.ValidateSource(config.DownloadUrl,config.SourceRoot);
    }
}
