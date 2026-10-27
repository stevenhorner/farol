namespace Shop.Core.Orders;

public static class CancellationLog
{
    public static void Record(int id) => Console.WriteLine($"cancelled {id}");
}
