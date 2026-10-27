namespace Shop.Web.Models;

public record QuoteRequest(string Sku, int Quantity)
{
    public string? Coupon { get; init; }
}

public record ProductQuote(string Sku, decimal Price, string? Currency);
