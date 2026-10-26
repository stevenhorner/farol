namespace Shop.Core.Pricing;

public class StandardPriceCalculator : IPriceCalculator
{
    public decimal PriceOf(string sku) => sku.StartsWith("BOOK") ? 12.5m : 1.2m;
}
