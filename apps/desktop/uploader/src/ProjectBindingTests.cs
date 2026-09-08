namespace Ozdqp;
// Explicit fixture configuration belongs only to local tests, never Program.
public static class TestDownloads
{
    public const string SourceUrl="https://artifacts.fixture.invalid/source/fixture.zip";
    const string Root="https://artifacts.fixture.invalid/source/";
    public static string ValidateSource(string? source)=>PackageDownload.ValidateSource(source,Root+"ios/");
    public static string LocalPath(string work)=>PackageDownload.LocalPath(work,SourceUrl,Root);
    public static Task<FileIdentity> Get(string work,CancellationToken ct,Action<long,long?>? progress=null,HttpMessageHandler? testHandler=null,SourceIdentity? expectedSource=null,string? sourceUrl=null)=>PackageDownload.Get(work,ct,progress,testHandler,expectedSource,sourceUrl??SourceUrl,sourceUrl==null?Root:Root+"ios/");
}
public static class ProjectBindingTests
{
    public static async Task Run(Func<string,Func<Task>,Task> test)
    {
        await test("project_binding_requires_explicit_scope_and_targets",()=>{
            var config=new JobConfig{ProjectId=Guid.NewGuid().ToString(),ComponentVersion=2,ApiBase="https://api.fixture.invalid",LoginBase="https://login.fixture.invalid",SourceRoot="https://artifacts.fixture.invalid/a/",DownloadUrl="https://artifacts.fixture.invalid/a/one.zip",TargetPrefix="a/test/pkg/",TestDirectoryPrefix="a/test/dir/",ReleaseDirectoryPrefix="a/release/dir/"};
            ProjectBinding.Validate(config);
            foreach(Action mutate in new Action[]{()=>config.ProjectId="",()=>config.ComponentVersion=0,()=>config.ApiBase="",()=>config.LoginBase="",()=>config.SourceRoot="https://artifacts.fixture.invalid/b/",()=>config.TargetPrefix="../escape/"}){
                var old=System.Text.Json.JsonSerializer.Serialize(config,Json.Options); mutate();
                try{ProjectBinding.Validate(config);throw new Exception("Missing/foreign project binding accepted");}catch(UploadException e)when(e.Code=="INVALID_INPUT"){}
                config=System.Text.Json.JsonSerializer.Deserialize<JobConfig>(old,Json.Options)!;
            }
            var prior=Environment.GetEnvironmentVariable("QA_HUB_PROJECT_ID");
            try{Environment.SetEnvironmentVariable("QA_HUB_PROJECT_ID",Guid.NewGuid().ToString());try{ProjectBinding.Validate(config);throw new Exception("Foreign supervisor scope accepted");}catch(UploadException e)when(e.Code=="PROJECT_SCOPE_MISMATCH"){} }
            finally{Environment.SetEnvironmentVariable("QA_HUB_PROJECT_ID",prior);}
            return Task.CompletedTask;
        });
        await test("source_binding_has_no_default_and_cannot_escape_project_root",()=>{
            foreach(string? source in new string?[]{null,"https://other.fixture.invalid/a/one.zip","https://artifacts.fixture.invalid/b/one.zip","https://artifacts.fixture.invalid/a/../b/one.zip","https://artifacts.fixture.invalid/a/%2e%2e/b/one.zip","https://artifacts.fixture.invalid/a/sub/one.zip"}){
                try{PackageDownload.ValidateSource(source,"https://artifacts.fixture.invalid/a/");throw new Exception("Unbound source accepted");}catch(UploadException e)when(e.Code=="INVALID_INPUT"){}
            }
            try{PackageDownload.ValidateSource("https://artifacts.fixture.invalid/a/one.zip");throw new Exception("Missing root accepted");}catch(UploadException e)when(e.Code=="INVALID_INPUT"){}
            return Task.CompletedTask;
        });
    }
}
