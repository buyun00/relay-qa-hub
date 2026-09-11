namespace Ozdqp;

public sealed record ClientLease<T>(T Client,DateTimeOffset RefreshAt) where T:class;

// Every request acquires a current client, including control requests made after
// long-running parallel transfers. Raw cached clients never escape this owner.
public sealed class RefreshingClient<T>(Func<CancellationToken,Task<ClientLease<T>>> refresh,
    Func<DateTimeOffset>? now=null) : IDisposable where T:class
{
    readonly SemaphoreSlim gate=new(1,1);
    ClientLease<T>? lease;
    async Task<T> Current(T? failed,CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if(lease==null||(now?.Invoke()??DateTimeOffset.UtcNow)>=lease.RefreshAt||ReferenceEquals(lease.Client,failed))
                lease=await refresh(ct);
            return lease.Client;
        }
        finally{gate.Release();}
    }
    public async Task<TResult> Run<TResult>(Func<T,TResult> request,CancellationToken ct,T? failed=null)
    {
        var client=await Current(failed,ct);
        return await Task.Run(()=>request(client),ct);
    }
    public void Dispose()=>gate.Dispose();
}
