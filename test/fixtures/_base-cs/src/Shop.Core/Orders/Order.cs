namespace Shop.Core.Orders;

public record Order(int Id, string Sku, decimal Total, bool Cancelled);
