using MediatR;
using Microsoft.AspNetCore.Mvc;
using Shop.Core.Orders.Commands;

namespace Shop.Web.Controllers.Api;

[ApiController]
[Route("api/[controller]")]
public class ArchiveController(IMediator mediator) : ControllerBase
{
    [HttpPost("{id}")]
    public async Task<ActionResult<bool>> Archive(int id) => await mediator.Send(new ArchiveOrder(id));
}
