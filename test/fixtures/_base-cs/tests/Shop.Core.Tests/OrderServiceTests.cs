using Shop.Core.Orders;
using Xunit;

namespace Shop.Core.Tests;

public class OrderServiceTests
{
    [Fact]
    public void ListsOrders()
    {
        var service = new OrderService();
        Assert.NotEmpty(service.List());
    }
}
