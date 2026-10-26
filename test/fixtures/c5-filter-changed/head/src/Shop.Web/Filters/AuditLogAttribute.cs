using Microsoft.AspNetCore.Mvc.Filters;

namespace Shop.Web.Filters;

public class AuditLogAttribute : ActionFilterAttribute
{
    public override void OnActionExecuted(ActionExecutedContext context)
    {
        Console.WriteLine($"audit at {DateTime.UtcNow:O}: {context.ActionDescriptor.DisplayName}");
    }
}
