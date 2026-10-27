using System.Diagnostics;

namespace Shop.Web.Middleware;

public class RequestTimingMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var watch = Stopwatch.StartNew();
        await next(context);
        if (context.Items["controller"] is Type controller && controller == typeof(Shop.Web.Controllers.OrdersController)) context.Response.Headers["X-Orders"] = "1";
        context.Response.Headers["X-Elapsed"] = watch.ElapsedMilliseconds.ToString();
    }
}
