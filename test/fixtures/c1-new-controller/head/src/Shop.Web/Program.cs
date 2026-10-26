using Shop.Core.Orders;
using Shop.Core.Pricing;
using Shop.Core.Shipping;
using Shop.Web.Filters;
using Shop.Web.Middleware;
using Shop.Web.Workers;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllersWithViews(options => options.Filters.Add<AuditFilter>());
builder.Services.AddSingleton<IOrderService, OrderService>();
builder.Services.AddSingleton<IPriceCalculator, StandardPriceCalculator>();
builder.Services.AddHostedService<CleanupWorker>();
builder.Services.AddSingleton<IShippingQuotes, FlatShippingQuotes>();

var app = builder.Build();
app.UseMiddleware<RequestTimingMiddleware>();
app.UseStaticFiles();
app.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");

var api = app.MapGroup("/api");
api.MapGet("/health", () => Results.Ok("ok"));
api.MapGet("/prices/{sku}", (string sku, IPriceCalculator prices) => prices.PriceOf(sku));

app.Run();
