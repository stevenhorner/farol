using Microsoft.AspNetCore.Mvc;

namespace Shop.Web.Controllers;

public class HomeController : BaseController
{
    public IActionResult Index() => View();

    public IActionResult About() => View("About");
}
