using Quartz;

namespace Shop.Web.Jobs;

// Quartz is not restored in the fixture: IJob is an unknown type.
public class ReindexJob : IJob
{
    public Task Execute(IJobExecutionContext context) => Task.Run(() => Console.WriteLine("reindex all"));
}
