using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Shop.Web.Controllers;

public abstract class BaseController : Controller
{
    protected string CurrentUser => User.Identity?.Name ?? "anonymous";

    public override void OnActionExecuting(ActionExecutingContext context)
    {
        ViewData["User"] = CurrentUser;
        base.OnActionExecuting(context);
    }
}
