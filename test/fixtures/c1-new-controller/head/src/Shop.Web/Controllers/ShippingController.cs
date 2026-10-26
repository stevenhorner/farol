using Microsoft.AspNetCore.Mvc;
using Shop.Core.Shipping;

namespace Shop.Web.Controllers;

public class ShippingController(IShippingQuotes quotes) : BaseController
{
    [HttpGet]
    public IActionResult Quote(string sku, string country) => View(quotes.Quote(sku, country));
}
