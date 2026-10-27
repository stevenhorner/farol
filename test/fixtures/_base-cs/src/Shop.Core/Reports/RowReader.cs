namespace Shop.Core.Reports;

public static class RowReader
{
    // Rows from a data library come back as dynamic values: their members are only known at run time.
    public static int Count(dynamic row) => (int)row.Details + (int)row.Index() + row.Label().Length;
}
