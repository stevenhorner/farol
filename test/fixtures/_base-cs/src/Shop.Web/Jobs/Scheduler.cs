namespace Shop.Web.Jobs;

/// <summary>Runs a job every period in the background (the project's own scheduler).</summary>
public static class Scheduler
{
    public static void Every(string name, TimeSpan period, Func<Task> job) =>
        _ = Task.Run(async () =>
        {
            while (true)
            {
                await job();
                await Task.Delay(period);
            }
        });
}
