namespace Shop.Core.Orders;

public class OrderService : IOrderService
{
    readonly List<Order> orders = [new Order(1, "BOOK-1", 12.5m, false), new Order(2, "PEN-2", 1.2m, false)];

    public IReadOnlyList<Order> List() => orders.Where(o => !o.Cancelled).ToList();

    public Order? Find(int id) => orders.FirstOrDefault(o => o.Id == id);

    public void Cancel(int id)
    {
        var index = orders.FindIndex(o => o.Id == id);
        if (index < 0) throw new KeyNotFoundException($"order {id}");
        orders[index] = orders[index] with { Cancelled = true };
    }
}
