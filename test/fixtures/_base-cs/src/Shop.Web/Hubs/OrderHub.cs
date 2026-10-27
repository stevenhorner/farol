using Microsoft.AspNetCore.SignalR;
using Shop.Core.Orders;

namespace Shop.Web.Hubs;

public class OrderHub(IOrderService orders) : Hub
{
    public Task Subscribe(int id) => Groups.AddToGroupAsync(Context.ConnectionId, $"order-{id}");

    public int OpenOrders() => orders.List().Count;
}
