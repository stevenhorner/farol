using Shop.Core.Orders;
using Shop.Core.Reports;

namespace Shop.Web.Workers;

public class CleanupWorker(IOrderService orders) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            OrderArchive.Purge(orders.List());
            RowReader.Count(orders.List());
            await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
        }
    }
}
