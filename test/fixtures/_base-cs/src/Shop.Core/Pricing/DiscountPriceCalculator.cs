namespace Shop.Core.Pricing;

public class DiscountPriceCalculator(IPriceCalculator inner) : IPriceCalculator
{
    public decimal PriceOf(string sku) => Math.Round(inner.PriceOf(sku) * 0.9m, 2);
}
