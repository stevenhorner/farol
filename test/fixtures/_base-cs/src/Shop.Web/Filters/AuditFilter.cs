using Microsoft.AspNetCore.Mvc.Filters;

namespace Shop.Web.Filters;

public class AuditFilter : IActionFilter
{
    public void OnActionExecuting(ActionExecutingContext context) { }

    public void OnActionExecuted(ActionExecutedContext context) { }
}
