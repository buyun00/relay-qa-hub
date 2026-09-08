using System.IO.Compression;
using System.Net;
namespace Ozdqp;
public static class SourceDownloadTests
{
    public static async Task Run(string root,Func<string,Func<Task>,Task> test,CancellationToken ct)
    {
        byte[] bytes;using(var memory=new MemoryStream()){using(var zip=new ZipArchive(memory,ZipArchiveMode.Create,true)){using var writer=new StreamWriter(zip.CreateEntry("fixture.txt").Open());writer.Write("build fixture");}bytes=memory.ToArray();}
        string modified="Tue, 08 Sep 2026 05:00:00 GMT";var source=new SourceIdentity(bytes.Length,modified);
        await test("ios_pinned_source_download_and_completed_snapshot_reuse",async()=>{
            string work=Path.Combine(root,"ios-source"),url="http://10.100.5.129:8000/pkg_zip/ozdqp/ios/ozdqp_ios_latest.zip?download=true";
            int calls=0;
            using var handler=new Handler(request=>{
                calls++;
                if(request.RequestUri!.AbsoluteUri!=url||request.Headers.Contains("Authorization")||request.Headers.Contains("Cookie"))throw new Exception("iOS source changed or received credentials");
                var response=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(request.Method==HttpMethod.Head?Array.Empty<byte>():bytes)};
                response.Content.Headers.ContentLength=bytes.Length;response.Content.Headers.LastModified=DateTimeOffset.Parse(modified);return response;
            });
            var first=await PackageDownload.Get(work,ct,testHandler:handler,expectedSource:source,sourceUrl:url);
            var second=await PackageDownload.Get(work,ct,testHandler:handler,expectedSource:source,sourceUrl:url);
            if(calls!=2||first.Sha256!=second.Sha256||Path.GetFileName(first.Path)!="ozdqp_ios_latest.zip")throw new Exception("iOS checkpoint was replaced");
            if(PackageDownload.LocalPath(work)!=Path.Combine(Path.GetFullPath(work),"input","_pkg_cfg_2001_1002.zip"))throw new Exception("Legacy Android path changed");
        });
        await test("ios_source_rejects_other_hosts_paths_and_traversal",()=>{
            foreach(string url in new[]{"https://untrusted.invalid/a.zip","http://10.100.5.129:8000/pkg_zip/ozdqp/other.zip?download=true","http://10.100.5.129:8000/pkg_zip/ozdqp/ios/../other.zip?download=true","http://10.100.5.129:8000/pkg_zip/ozdqp/ios/sub/a.zip?download=true","http://10.100.5.129:8000/pkg_zip/ozdqp/ios/a.zip?redirect=elsewhere"}){
                try{PackageDownload.ValidateSource(url);throw new Exception("Unsafe source accepted");}catch(UploadException e)when(e.Code=="INVALID_INPUT"){}
            }
            return Task.CompletedTask;
        });
        foreach(string mode in new[]{"stable","changed_before","changed_during"})await test("build_source_"+mode,async()=>{
            string work=Path.Combine(root,"source-"+mode);int calls=0;
            using var handler=new Handler(request=>{
                calls++;if(request.Method==HttpMethod.Get&&request.Headers.IfUnmodifiedSince!=DateTimeOffset.Parse(modified))throw new Exception("missing download precondition");
                var response=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(request.Method==HttpMethod.Head?Array.Empty<byte>():bytes)};
                response.Content.Headers.ContentLength=bytes.Length;
                response.Content.Headers.LastModified=DateTimeOffset.Parse(modified).AddMinutes(mode=="changed_before"||mode=="changed_during"&&request.Method==HttpMethod.Head?1:0);
                return response;
            });
            try
            {
                var identity=await PackageDownload.Get(work,ct,testHandler:handler,expectedSource:source);
                if(mode!="stable"||identity.Size!=bytes.Length||calls!=2)throw new Exception("source check did not guard download");
                await PackageDownload.Get(work,ct,testHandler:handler,expectedSource:source);
                if(calls!=2)throw new Exception("completed task redownloaded mutable latest ZIP");
            }
            catch(UploadException e) when(e.Code=="BUILD_ZIP_CHANGED"&&mode!="stable")
            {if(File.Exists(PackageDownload.LocalPath(work)))throw new Exception("changed ZIP promoted to complete");}
        });
    }
    sealed class Handler(Func<HttpRequestMessage,HttpResponseMessage> response):HttpMessageHandler
    {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>Task.FromResult(response(request));}
}
