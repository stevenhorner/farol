using Shop.Core.Orders;
using Xunit;

namespace Shop.Core.Tests;

public class OrderServiceTests
{
    [Fact]
    public void ListsOrders()
    {
        var service = new OrderService();
        Assert.Equal(2, service.List().Count);
    }

    [Fact]
    public void CancelsOrders()
    {
        var service = new OrderService();
        service.Cancel(1);
        Assert.Single(service.List());
    }
}
