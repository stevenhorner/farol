using Shop.Web.Controllers;

namespace Shop.Web.Infrastructure;

public static class CacheTools
{
    public static void Reset() => HomeController.ResetCache();
}
