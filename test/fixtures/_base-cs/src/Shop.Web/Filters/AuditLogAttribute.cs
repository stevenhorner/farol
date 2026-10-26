using Microsoft.AspNetCore.Mvc.Filters;

namespace Shop.Web.Filters;

public class AuditLogAttribute : ActionFilterAttribute
{
    public override void OnActionExecuted(ActionExecutedContext context)
    {
        Console.WriteLine($"audit: {context.ActionDescriptor.DisplayName}");
    }
}
