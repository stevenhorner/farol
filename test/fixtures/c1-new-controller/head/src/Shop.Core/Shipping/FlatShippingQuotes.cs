namespace Shop.Core.Shipping;

public class FlatShippingQuotes : IShippingQuotes
{
    public decimal Quote(string sku, string country) => country == "GB" ? 3.5m : 9.9m;
}
