using Microsoft.AspNetCore.Mvc;
using Shop.Core.Orders;
using Shop.Web.Filters;

namespace Shop.Web.Controllers;

public class OrdersController(IOrderService orders) : BaseController
{
    [HttpGet]
    public IActionResult Index() => View(orders.List());

    [HttpGet]
    public IActionResult Details(int id)
    {
        var order = orders.Find(id);
        if (order is null) return NotFound();
#if LITE
        ViewData["Edition"] = "lite";
#else
        ViewData["Edition"] = "full";
#endif
        return View(order);
    }

    [HttpPost]
    [AuditLog]
    public IActionResult Cancel(int id)
    {
        orders.Cancel(id);
        return RedirectToAction(nameof(Index));
    }
}
