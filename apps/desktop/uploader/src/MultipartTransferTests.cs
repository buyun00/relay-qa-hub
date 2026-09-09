using COSXML;
using COSXML.Auth;
using COSXML.Model.Object;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;

namespace Ozdqp;
public static class MultipartTransferTests
{
    static void Check(bool value,string message){if(!value)throw new Exception("Multipart test: "+message);}
    public static async Task Run(string root,Func<string,Func<Task>,Task> test,CancellationToken ct)
    {
        await test("checkpoint_retries_temporary_windows_reader_without_repeating_transfer",async()=>{
            if(!OperatingSystem.IsWindows())return;
            using var journal=new Journal(Path.Combine(root,"checkpoint-reader"));var state=new JobState();journal.Save(state);
            using var reader=new FileStream(journal.StatePath,FileMode.Open,FileAccess.Read,FileShare.ReadWrite);
            state.Parts[1]="confirmed-etag";
            var save=Task.Run(()=>journal.Save(state),ct);
            await Task.Delay(300,ct);
            Check(!save.IsCompleted&&journal.Read()!.Parts.Count==0,"checkpoint must remain intact while replacement is blocked");
            reader.Dispose();await save.WaitAsync(TimeSpan.FromSeconds(5),ct);
            Check(journal.Read()!.Parts[1]=="confirmed-etag","acknowledgment was not saved after reader released");
        });
        await test("checkpoint_persistent_access_denial_is_bounded_and_keeps_original_state",async()=>{
            if(!OperatingSystem.IsWindows())return;
            using var journal=new Journal(Path.Combine(root,"checkpoint-blocked"));var state=new JobState();journal.Save(state);
            var original=await File.ReadAllBytesAsync(journal.StatePath,ct);
            using var reader=new FileStream(journal.StatePath,FileMode.Open,FileAccess.Read,FileShare.ReadWrite);
            state.Parts[1]="confirmed-etag";var watch=Stopwatch.StartNew();bool failed=false;
            try{journal.Save(state);}catch(UploadException e) when(e.Code=="CHECKPOINT_WRITE_FAILED"){failed=true;}
            Check(failed&&watch.Elapsed<TimeSpan.FromSeconds(5),"persistent access denial must stop with the checkpoint error");
            Check((await File.ReadAllBytesAsync(journal.StatePath,ct)).SequenceEqual(original),"last durable checkpoint was overwritten");
            Check(File.Exists(journal.StatePath+".tmp"),"pending checkpoint evidence was lost");
            reader.Dispose();journal.Save(state);
            Check(journal.Read()!.Parts.Count==1,"original checkpoint cannot be recovered after unlock");
        });
        await test("cos_completion_serializes_parts_in_numeric_order_after_parallel_acks",()=>{
            var parts=new Dictionary<int,string>{{3,"etag3"},{1,"etag1"},{12,"etag12"},{2,"etag2"}};
            var request=TencentUploader.CreateCompletion("fixture-1250000000","fixture.bin","fixture-upload",parts);
            using var bytes=new MemoryStream();request.GetRequestBody().OnWrite(bytes);
            var xml=System.Xml.Linq.XDocument.Parse(System.Text.Encoding.UTF8.GetString(bytes.ToArray()));
            var numbers=xml.Descendants().Where(e=>e.Name.LocalName=="PartNumber").Select(e=>int.Parse(e.Value)).ToArray();
            Check(numbers.SequenceEqual(new[]{1,2,3,12}),"multipart completion must follow byte order, not acknowledgment order");
            Check(parts.Keys.SequenceEqual(new[]{3,1,12,2}),"building completion must not mutate checkpoints");
            return Task.CompletedTask;
        });
        await test("cos_diagnostics_preserve_status_without_credentials",()=>{
            var server=new COSXML.CosException.CosServerException(403,"Authorization=secret") { errorCode="ExpiredToken",requestId="fixture-request",errorMessage="signed-url-secret",resource="secret-path" };
            string text=JsonSerializer.Serialize(CosDiagnostics.Describe(server));
            Check(text.Contains("ExpiredToken")&&text.Contains("403")&&text.Contains("fixture-request")&&!text.Contains("secret"),"server diagnostic redaction");
            var client=new COSXML.CosException.CosClientException(100,"https://signed.invalid?token=secret",new WebException("Authorization=secret",WebExceptionStatus.Timeout));
            text=JsonSerializer.Serialize(CosDiagnostics.Describe(client));
            Check(text.Contains("Timeout")&&!text.Contains("secret")&&!text.Contains("signed.invalid"),"transport diagnostic redaction");
            server.requestId="secret?token=value";
            Check(!JsonSerializer.Serialize(CosDiagnostics.Describe(server)).Contains("secret"),"identifier allowlist");
            return Task.CompletedTask;
        });
        await test("sdk_parallel_parts_have_correct_bytes_and_bounded_concurrency",async()=>{
            const int count=8,size=256*1024;var payload=new byte[count*size];new Random(123).NextBytes(payload);
            string file=Path.Combine(root,"parallel-payload.bin");await File.WriteAllBytesAsync(file,payload,ct);
            var socket=new TcpListener(IPAddress.Loopback,0);socket.Start();int port=((IPEndPoint)socket.LocalEndpoint).Port;socket.Stop();
            using var listener=new HttpListener();listener.Prefixes.Add($"http://127.0.0.1:{port}/");listener.Start();
            var requests=new ConcurrentBag<Task>();int active=0,maxActive=0,received=0;var gate=new object();
            async Task Serve(HttpListenerContext context)
            {
                lock(gate){active++;maxActive=Math.Max(maxActive,active);}
                try
                {
                    int part=int.Parse(context.Request.QueryString["partNumber"]!);
                    using var bytes=new MemoryStream();await context.Request.InputStream.CopyToAsync(bytes,ct);
                    Check(context.Request.HttpMethod=="PUT"&&part>=1&&part<=count,"unexpected SDK request");
                    var actual=bytes.ToArray();Check(actual.AsSpan().SequenceEqual(payload.AsSpan((part-1)*size,size)),"part offset/content mismatch");
                    await Task.Delay(120,ct);context.Response.Headers["ETag"]='"'+Convert.ToHexString(MD5.HashData(actual)).ToLowerInvariant()+'"';
                    context.Response.Headers["x-cos-request-id"]="loopback-fixture";
                    context.Response.StatusCode=200;context.Response.ContentLength64=0;Interlocked.Increment(ref received);
                }
                finally{context.Response.Close();lock(gate)active--;}
            }
            var accept=Task.Run(async()=>{while(listener.IsListening){try{requests.Add(Serve(await listener.GetContextAsync()));}catch(HttpListenerException){break;}catch(ObjectDisposedException){break;}}},ct);
            try
            {
                long now=DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                var config=new CosXmlConfig.Builder().SetRegion("fixture").SetHost($"127.0.0.1:{port}").IsHttps(false).SetDebugLog(false).SetConnectionLimit(8).Build();
                var sdk=new CosXmlServer(config,new DefaultSessionQCloudCredentialProvider("fixture-id","fixture-key",now-30,now+3600,"fixture-token"));
                async Task<(long ms,int max)> Measure(int concurrency)
                {
                    maxActive=0;var completed=new Dictionary<int,string>();var watch=Stopwatch.StartNew();
                    await MultipartTransfers.Run(Enumerable.Range(1,count),concurrency,async(number,token)=>{
                        var request=new UploadPartRequest("fixture-1250000000","fixture.bin",number,"fixture-upload",file,(number-1)*size,size);
                        // Override only the test transport destination; no real COS/STS request.
                        request.RequestURLWithSign=$"http://127.0.0.1:{port}/fixture.bin?partNumber={number}&uploadId=fixture-upload";
                        var result=await Task.Run(()=>sdk.UploadPart(request),token);
                        return result.eTag;
                    },(number,etag)=>completed.Add(number,etag),ct);
                    Check(completed.Count==count,"missing checkpoint");return(watch.ElapsedMilliseconds,maxActive);
                }
                var serial=await Measure(1);var parallel=await Measure(4);
                Check(serial.max==1&&parallel.max==4&&received==count*2,"requests did not overlap at configured limit");
                Console.WriteLine(JsonSerializer.Serialize(new{type="multipartBenchmark",transport="actual-tencent-sdk-loopback",parts=count,partBytes=size,simulatedRequestLatencyMs=120,serialMs=serial.ms,parallelMs=parallel.ms,maxConcurrent=parallel.max,realCosTested=false}));
            }
            finally{listener.Stop();await accept;await Task.WhenAll(requests);}
        });
        await test("failed_parallel_request_drains_acks_and_resume_sends_only_missing_parts",async()=>{
            int active=0,entered=0;var ready=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var completed=new Dictionary<int,string>();using var journal=new Journal(Path.Combine(root,"parallel-checkpoint"));var state=new JobState();
            bool failed=false;
            try
            {
                await MultipartTransfers.Run(Enumerable.Range(1,4),4,async(number,token)=>{
                    Interlocked.Increment(ref active);if(Interlocked.Increment(ref entered)==4)ready.SetResult();
                    try{await ready.Task.WaitAsync(ct);if(number==1)throw new UploadException("UPLOAD_FAILED","fixture failure");await Task.Delay(60,ct);return "etag-"+number;}
                    finally{Interlocked.Decrement(ref active);}
                },(number,etag)=>{completed.Add(number,etag);state.Parts[number]=etag;journal.Save(state);},ct);
            }
            catch(UploadException e) when(e.Code=="UPLOAD_FAILED"){failed=true;}
            Check(failed&&active==0&&completed.Count==3&&journal.Read()!.Parts.Count==3,"in-flight acknowledgments lost or returned too early");
            var resumed=new List<int>();await MultipartTransfers.Run(Enumerable.Range(1,4).Where(n=>!completed.ContainsKey(n)),4,(number,token)=>{resumed.Add(number);return Task.FromResult("etag-"+number);},(number,etag)=>completed.Add(number,etag),ct);
            Check(resumed.SequenceEqual(new[]{1})&&completed.Count==4,"resume repeated a completed part");
        });
        await test("parallel_cancellation_finishes_before_journal_closes",async()=>{
            using var cancel=CancellationTokenSource.CreateLinkedTokenSource(ct);int active=0,entered=0,committed=0;bool cancelled=false;
            try{await MultipartTransfers.Run(Enumerable.Range(1,20),4,async(number,token)=>{
                Interlocked.Increment(ref active);if(Interlocked.Increment(ref entered)==4)cancel.Cancel();
                try{await Task.Delay(5000,token);return "etag";}finally{Interlocked.Decrement(ref active);}
            },(_,_)=>committed++,cancel.Token);}catch(OperationCanceledException){cancelled=true;}
            Check(cancelled&&active==0&&committed==0&&entered<=4,"cancellation left work running");
        });
    }
}
