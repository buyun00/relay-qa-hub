namespace Ozdqp;

public static class RefreshingClientTests
{
    sealed record Client(int Number);
    static void Check(bool value,string message){if(!value)throw new Exception("Credential test: "+message);}
    public static async Task Run(Func<string,Func<Task>,Task> test,CancellationToken ct)
    {
        await test("completion_after_long_part_reacquires_current_credentials",async()=>{
            var now=DateTimeOffset.UtcNow;int refreshes=0;
            using var clients=new RefreshingClient<Client>(_=>Task.FromResult(new ClientLease<Client>(new(++refreshes),now.AddMinutes(4))),()=>now);
            using var finishPart=new ManualResetEventSlim();
            var started=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var part=clients.Run(client=>{started.TrySetResult(true);finishPart.Wait(ct);return client.Number;},ct);
            await started.Task;
            now=now.AddMinutes(6);finishPart.Set();
            Check(await part==1,"in-flight part identity changed");
            var completion=await clients.Run(client=>client.Number,ct);
            Check(completion==2&&refreshes==2,"completion reused the expired part credential");
        });
        await test("head_list_and_completion_reuse_only_unexpired_credentials",async()=>{
            var now=DateTimeOffset.UtcNow;int refreshes=0;
            using var clients=new RefreshingClient<Client>(_=>Task.FromResult(new ClientLease<Client>(new(++refreshes),now.AddMinutes(4))),()=>now);
            Check(await clients.Run(client=>client.Number,ct)==1,"head client");
            now=now.AddMinutes(3);
            Check(await clients.Run(client=>client.Number,ct)==1,"valid list client unnecessarily replaced");
            now=now.AddMinutes(1);
            Check(await clients.Run(client=>client.Number,ct)==2&&refreshes==2,"refresh boundary not enforced");
        });
        await test("parallel_failures_refresh_once_and_do_not_invalidate_a_new_client",async()=>{
            var now=DateTimeOffset.UtcNow;int refreshes=0;
            using var clients=new RefreshingClient<Client>(_=>Task.FromResult(new ClientLease<Client>(new(++refreshes),now.AddMinutes(4))),()=>now);
            var failed=await clients.Run(client=>client,ct);
            var retry=await Task.WhenAll(Enumerable.Range(0,8).Select(_=>clients.Run(client=>client.Number,ct,failed)));
            Check(retry.All(number=>number==2)&&refreshes==2,"parallel failures created redundant credential refreshes");
        });
        await test("cancelled_refresh_releases_the_gate_without_executing_request",async()=>{
            int refreshes=0,requests=0;
            var started=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            using var clients=new RefreshingClient<Client>(async token=>{
                int number=Interlocked.Increment(ref refreshes);
                if(number==1){started.TrySetResult(true);await Task.Delay(Timeout.Infinite,token);}
                return new(new(number),DateTimeOffset.UtcNow.AddMinutes(4));
            });
            using var cancelled=CancellationTokenSource.CreateLinkedTokenSource(ct);
            var pending=clients.Run(client=>{requests++;return client.Number;},cancelled.Token);
            await started.Task;cancelled.Cancel();
            try{await pending;throw new Exception("cancelled request completed");}catch(OperationCanceledException){}
            Check(requests==0&&await clients.Run(client=>client.Number,ct)==2,"cancelled refresh blocked recovery");
        });
    }
}
