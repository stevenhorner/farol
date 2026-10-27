using Shop.Core.Orders;
using Shop.Core.Pricing;
using Shop.Web.Filters;
using Shop.Web.Hubs;
using Shop.Web.Jobs;
using Shop.Web.Middleware;
using Shop.Web.Workers;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllersWithViews(options => options.Filters.Add<AuditFilter>());
builder.Services.AddSingleton<IOrderService, OrderService>();
builder.Services.AddSingleton<IPriceCalculator, StandardPriceCalculator>();
builder.Services.AddHostedService<CleanupWorker>();
builder.Services.AddRazorPages();
builder.Services.AddSignalR();

var app = builder.Build();
app.UseMiddleware<RequestTimingMiddleware>();
app.UseStaticFiles();
app.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");
app.MapRazorPages();
app.MapHub<OrderHub>("/hubs/orders");

var api = app.MapGroup("/api");
api.MapGet("/health", () => Results.Ok("ok"));
api.MapGet("/prices/{sku}", (string sku, IPriceCalculator prices) => prices.PriceOf(sku));

Scheduler.Every("purge", TimeSpan.FromHours(1), () =>
{
    OrderArchive.Purge(app.Services.GetRequiredService<IOrderService>().List());
    return Task.CompletedTask;
});

app.Run();
