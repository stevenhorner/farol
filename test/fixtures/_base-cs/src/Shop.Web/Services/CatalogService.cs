using Grpc.Core;
using Shop.Catalog;
using Shop.Core.Pricing;

namespace Shop.Web.Services;

// Catalog.CatalogBase is generated from Protos/catalog.proto at build time (Grpc.Tools): never in git.
public class CatalogService(IPriceCalculator prices) : Catalog.CatalogBase
{
    public override Task<ProductReply> GetProduct(ProductRequest request, ServerCallContext context) =>
        Task.FromResult(new ProductReply { Sku = request.Sku, Price = (double)prices.PriceOf(request.Sku) });

    public override async Task ListProducts(ListRequest request, IServerStreamWriter<ProductReply> responseStream, ServerCallContext context)
    {
        foreach (var sku in new[] { "BOOK-1", "PEN-2" }) await responseStream.WriteAsync(new ProductReply { Sku = sku });
    }
}
