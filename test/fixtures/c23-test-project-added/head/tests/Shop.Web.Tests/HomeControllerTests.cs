using Shop.Web.Controllers;
using Xunit;

namespace Shop.Web.Tests;

public class HomeControllerTests
{
    [Fact]
    public void RendersTheHomePage() => Assert.NotNull(new HomeController().Index());
}
