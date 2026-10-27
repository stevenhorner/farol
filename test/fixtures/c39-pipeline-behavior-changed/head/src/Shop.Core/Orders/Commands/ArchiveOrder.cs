using MediatR;

namespace Shop.Core.Orders.Commands;

public record ArchiveOrder(int Id) : IRequest<bool>;

public class ArchiveOrderHandler(IOrderService orders) : IRequestHandler<ArchiveOrder, bool>
{
    public Task<bool> Handle(ArchiveOrder request, CancellationToken cancellationToken) =>
        Task.FromResult(orders.Find(request.Id) is { Cancelled: true });
}

public class LoggingBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
{
    public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
    {
        Console.WriteLine($"handling {typeof(TRequest).FullName}");
        return await next();
    }
}
