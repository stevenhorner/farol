namespace Shop.Web.Models;

public record QuoteRequest(string Sku, int Quantity)
{
    public string? Coupon { get; init; }

    public required string Country { get; init; }
}

public record ProductQuote(string Sku, decimal Amount, string? Currency);
