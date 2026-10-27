namespace Shop.Core.Orders;

public interface IOrderService
{
    IReadOnlyList<Order> List();
    Order? Find(int id);
    void Cancel(int id);
}
