using Microsoft.Data.SqlClient;

namespace Shop.Core.Data;

// Microsoft.Data.SqlClient is not restored in the fixture: SqlConnection and its Execute extension are unknown types.
public static class Db
{
    public static int PurgeCarts(SqlConnection connection) => connection.Execute("DELETE FROM carts WHERE expired = 1");
}
