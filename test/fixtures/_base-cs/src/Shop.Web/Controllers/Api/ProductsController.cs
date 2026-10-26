using Microsoft.AspNetCore.Mvc;
using Shop.Core.Pricing;

namespace Shop.Web.Controllers.Api;

[ApiController]
[Route("api/[controller]")]
public class ProductsController(IPriceCalculator prices) : ControllerBase
{
    [HttpGet("{sku}")]
    public ActionResult<decimal> Get(string sku) => prices.PriceOf(sku);
}
