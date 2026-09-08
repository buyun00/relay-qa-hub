namespace Ozdqp;

public static class MultipartTransfers
{
    // The loop waits for in-flight requests even on failure. Successful ACKs are
    // checkpointed before propagating an error; multipart completion stays outside.
    public static async Task Run(IEnumerable<int> numbers,int concurrency,
        Func<int,CancellationToken,Task<string>> transfer,Action<int,string> checkpoint,CancellationToken ct)
    {
        if(concurrency is <1 or >8)throw new UploadException("INVALID_INPUT","上传并发数必须为 1 到 8。");
        var checkpointGate=new object();
        await Parallel.ForEachAsync(numbers,new ParallelOptions{MaxDegreeOfParallelism=concurrency,CancellationToken=ct},async(number,token)=>{
            var etag=await transfer(number,token);
            if(string.IsNullOrWhiteSpace(etag))throw new UploadException("UPLOAD_FAILED","COS 未返回分片 ETag。");
            lock(checkpointGate)checkpoint(number,etag);
        });
    }
}
