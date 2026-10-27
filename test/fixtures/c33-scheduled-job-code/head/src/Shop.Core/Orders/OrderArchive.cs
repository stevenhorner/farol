namespace Shop.Core.Orders;

public static class OrderArchive
{
    public static int Purge(IEnumerable<Order> orders) => orders.Count(o => o.Cancelled && o.Total > 0);
}
