using System.Diagnostics;

namespace Shop.Web.Middleware;

public class RequestTimingMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var watch = Stopwatch.StartNew();
        await next(context);
        context.Response.Headers["X-Elapsed"] = watch.ElapsedMilliseconds.ToString();
    }
}
