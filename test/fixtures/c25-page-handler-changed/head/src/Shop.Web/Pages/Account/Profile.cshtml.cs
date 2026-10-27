using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Shop.Core.Orders;

namespace Shop.Web.Pages.Account;

public class ProfileModel(IOrderService orders) : PageModel
{
    public string Name { get; private set; } = "";

    public void OnGet(int? id) => Name = id is null ? "you" : $"customer {id}";

    public IActionResult OnPostSave(int? id)
    {
        if (orders.List().Count < 1) return NotFound();
        return RedirectToPage(new { id });
    }
}
