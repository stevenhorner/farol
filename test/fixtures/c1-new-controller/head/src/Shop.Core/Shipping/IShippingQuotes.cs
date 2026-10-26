namespace Shop.Core.Shipping;

public interface IShippingQuotes
{
    decimal Quote(string sku, string country);
}
