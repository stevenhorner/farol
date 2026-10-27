using Microsoft.AspNetCore.Mvc;
using Shop.Core.Pricing;
using Shop.Web.Models;

namespace Shop.Web.Controllers.Api;

[ApiController]
[Route("api/[controller]")]
public class ProductsController(IPriceCalculator prices) : ControllerBase
{
    [HttpGet("{sku}")]
    public ActionResult<decimal> Get(string sku) => prices.PriceOf(sku);

    [HttpPost("quote")]
    public ActionResult<ProductQuote> Quote([FromBody] QuoteRequest request) =>
        new ProductQuote(request.Sku, prices.PriceOf(request.Sku) * request.Quantity, "GBP");
}
