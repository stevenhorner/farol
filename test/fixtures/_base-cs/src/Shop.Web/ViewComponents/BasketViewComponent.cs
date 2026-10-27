using Microsoft.AspNetCore.Mvc;
using Shop.Core.Orders;

namespace Shop.Web.ViewComponents;

public class BasketViewComponent(IOrderService orders) : ViewComponent
{
    public IViewComponentResult Invoke() => View(orders.List().Count);
}
