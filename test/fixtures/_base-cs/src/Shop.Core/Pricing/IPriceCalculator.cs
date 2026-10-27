namespace Shop.Core.Pricing;

public interface IPriceCalculator
{
    decimal PriceOf(string sku);
}
