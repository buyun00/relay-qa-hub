using System.Net;
using System.Diagnostics;

namespace Ozdqp;
public static class PackageDownload
{
    public const string SourceUrl="http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip?download=true";
    public static string LocalPath(string work)=>Path.Combine(Path.GetFullPath(work),"input","_pkg_cfg_2001_1002.zip");
    public static async Task<FileIdentity> Get(string work,CancellationToken ct,Action<long,long?>? progress=null,HttpMessageHandler? testHandler=null,SourceIdentity? expectedSource=null)
    {
        string target=LocalPath(work);Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        // Complete files are immutable snapshots belonging to this task.
        if(File.Exists(target))return await Files.Inspect(target,ct);
        string partial=target+".partial";
        using var client=new HttpClient(testHandler??new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false}){Timeout=Timeout.InfiniteTimeSpan};
        using var idle=CancellationTokenSource.CreateLinkedTokenSource(ct);idle.CancelAfter(TimeSpan.FromSeconds(60));
        try
        {
            // This client never receives business Authorization or browser cookies.
            using var request=new HttpRequestMessage(HttpMethod.Get,SourceUrl);
            if(expectedSource!=null)request.Headers.IfUnmodifiedSince=DateTimeOffset.Parse(expectedSource.LastModified);
            using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,idle.Token);
            if(expectedSource!=null)CheckSource(response,expectedSource);
            if(response.StatusCode!=HttpStatusCode.OK)throw new UploadException("DOWNLOAD_FAILED",$"固定 ZIP 地址返回 HTTP {(int)response.StatusCode}，未开始平台写操作。");
            var type=response.Content.Headers.ContentType?.MediaType??"";
            if(type.Contains("html")||type.Contains("json"))throw new UploadException("DOWNLOAD_FAILED","下载地址返回网页或 JSON，未取得 ZIP。");
            long? expected=response.Content.Headers.ContentLength;long received=0;
            await using(var input=await response.Content.ReadAsStreamAsync(idle.Token))
            await using(var output=new FileStream(partial,FileMode.Create,FileAccess.Write,FileShare.None,1024*1024,true))
            {
                byte[] buffer=new byte[1024*1024];var watch=Stopwatch.StartNew();progress?.Invoke(0,expected);
                while(true)
                {
                    idle.CancelAfter(TimeSpan.FromSeconds(60));int n=await input.ReadAsync(buffer,idle.Token);if(n==0)break;
                    await output.WriteAsync(buffer.AsMemory(0,n),idle.Token);received+=n;
                    if(watch.ElapsedMilliseconds>=1000){progress?.Invoke(received,expected);watch.Restart();}
                }
                await output.FlushAsync(ct);output.Flush(true);
            }
            if(expected.HasValue&&received!=expected.Value)throw new UploadException("DOWNLOAD_FAILED","下载长度与服务器声明不一致，保留 partial；下次重新下载。");
            idle.CancelAfter(Timeout.InfiniteTimeSpan);
            FileIdentity identity;
            try{identity=await Files.Inspect(partial,ct);}catch(InvalidDataException){throw new UploadException("DOWNLOAD_FAILED","下载内容不是有效 ZIP，未开始上传。");}
            if(expectedSource!=null)
            {
                idle.CancelAfter(TimeSpan.FromSeconds(60));
                using var head=await client.SendAsync(new HttpRequestMessage(HttpMethod.Head,SourceUrl),HttpCompletionOption.ResponseHeadersRead,idle.Token);
                CheckSource(head,expectedSource);
            }
            File.Move(partial,target,false);progress?.Invoke(received,expected);
            return identity with{Path=target};
        }
        catch(OperationCanceledException) when(!ct.IsCancellationRequested){throw new UploadException("DOWNLOAD_TIMEOUT","ZIP 下载连续 60 秒没有完成当前网络操作，可恢复任务重新下载。");}
        catch(HttpRequestException){throw new UploadException("DOWNLOAD_FAILED","ZIP 下载网络异常；完整文件未提交，恢复时重新下载。");}
    }
    static void CheckSource(HttpResponseMessage response,SourceIdentity expected)
    {
        if(response.StatusCode!=HttpStatusCode.OK||response.Content.Headers.ContentLength!=expected.Size||response.Content.Headers.LastModified!=DateTimeOffset.Parse(expected.LastModified))
            throw new UploadException("BUILD_ZIP_CHANGED","增量 ZIP 已被其他构建替换，停止本次自动上传；未开始平台写操作。");
    }
}
