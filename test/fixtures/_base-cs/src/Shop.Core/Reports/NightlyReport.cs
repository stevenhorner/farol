namespace Shop.Core.Reports;

public static class NightlyReport
{
    public static string Build() => $"report {DateTime.UtcNow:yyyy-MM-dd}";
}
