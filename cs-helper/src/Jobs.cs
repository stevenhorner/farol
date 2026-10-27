using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Farol.CsHelper;

/// <summary>
/// Libraries that run project code by type rather than by call: MediatR (a request reaches its handlers, every request
/// its pipeline behaviors), Hangfire (jobs enqueued or scheduled with a delegate) and Quartz (IJob classes). Read from
/// syntax and names first, so they work when the packages were not restored and their types are unknown.
/// </summary>
public static class Jobs
{
    static readonly string[] Handlers = ["IRequestHandler", "INotificationHandler", "IStreamRequestHandler", "IRequestPreProcessor", "IRequestPostProcessor", "IRequestExceptionHandler"];
    static readonly string[] Requests = ["IRequest", "IStreamRequest", "IBaseRequest", "INotification"];
    static readonly string[] HangfireMethods = ["Enqueue", "Schedule", "AddOrUpdate", "ContinueJobWith"];
    static readonly string[] HangfireTypes = ["BackgroundJob", "RecurringJob", "IBackgroundJobClient", "IRecurringJobManager", "BackgroundJobClientExtensions", "RecurringJobManagerExtensions", "RecurringJobExtensions"];

    /// <summary>The generic interfaces a type declares in its base list, by name, with their type argument syntax.</summary>
    static IEnumerable<(string Name, SeparatedSyntaxList<TypeSyntax> Arguments, SemanticModel Model)> BaseInterfaces(INamedTypeSymbol type, Compilation compilation)
    {
        foreach (var syntax in type.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<TypeDeclarationSyntax>())
        {
            var model = compilation.GetSemanticModel(syntax.SyntaxTree);
            foreach (var b in syntax.BaseList?.Types ?? [])
            {
                var name = b.Type is QualifiedNameSyntax q ? q.Right : b.Type as SimpleNameSyntax;
                if (name is not null) yield return (name.Identifier.ValueText, name is GenericNameSyntax g ? g.TypeArgumentList.Arguments : default, model);
            }
        }
    }

    /// <summary>MediatR: edges from each request type to its handlers, and from every request type to open pipeline behaviors.</summary>
    public static void MediatR(Compilation compilation, SetIndex index, Graph graph)
    {
        var types = SetIndex.SourceTypes(compilation.Assembly.GlobalNamespace).ToList();
        var requests = types.Where(t => BaseInterfaces(t, compilation).Any(b => Requests.Contains(b.Name))).ToList();
        foreach (var type in types)
        {
            if (!index.BySymbol.TryGetValue(Decls.Key(type), out var handlerDecls)) continue;
            foreach (var (name, arguments, model) in BaseInterfaces(type, compilation))
            {
                if (name == "IPipelineBehavior" || name == "IStreamPipelineBehavior")
                {
                    var request = arguments.Count > 0 ? model.GetTypeInfo(arguments[0]).Type : null;
                    var targets = request is ITypeParameterSymbol ? requests : request is INamedTypeSymbol closed ? [closed] : [];
                    foreach (var r in targets) Link(r, handlerDecls, index, graph);
                }
                else if (Handlers.Contains(name) && arguments.Count > 0 && model.GetTypeInfo(arguments[0]).Type is INamedTypeSymbol handled)
                    Link(handled, handlerDecls, index, graph);
            }
        }
    }

    static void Link(INamedTypeSymbol request, IEnumerable<string> handler, SetIndex index, Graph graph)
    {
        foreach (var from in index.BySymbol.GetValueOrDefault(Decls.Key(request)) ?? []) foreach (var to in handler) graph.Edge(from, to);
    }

    /// <summary>A Hangfire call that runs its delegate later as a job (resolved, or by name when Hangfire was not restored).</summary>
    public static bool IsHangfire(InvocationExpressionSyntax call, SemanticModel model, out string method)
    {
        method = call.Expression switch { MemberAccessExpressionSyntax m => m.Name.Identifier.ValueText, _ => "" };
        if (!HangfireMethods.Contains(method) || call.Expression is not MemberAccessExpressionSyntax access) return false;
        if (model.GetSymbolInfo(call).Symbol is IMethodSymbol m2) return HangfireTypes.Contains((m2.ReducedFrom ?? m2).ContainingType.Name);
        var receiver = model.GetTypeInfo(access.Expression).Type;
        var receiverName = receiver is null or IErrorTypeSymbol ? access.Expression.ToString().Split('.')[^1] : receiver.Name;
        return HangfireTypes.Contains(receiverName) || receiver is IErrorTypeSymbol { Name: "IBackgroundJobClient" or "IRecurringJobManager" };
    }

    /// <summary>Quartz: a class implementing IJob runs on its trigger.</summary>
    public static bool IsQuartzJob(INamedTypeSymbol type, Compilation compilation) =>
        type.TypeKind == TypeKind.Class && !type.IsAbstract && (type.AllInterfaces.Any(i => i.Name == "IJob" && !SetIndex.IsSource(i)) || BaseInterfaces(type, compilation).Any(b => b.Name == "IJob"));

    /// <summary>A label for a delegate job: the method its body calls (`EmailSender.SendDigest`), or null.</summary>
    public static string? DelegateLabel(ExpressionSyntax argument, SemanticModel model)
    {
        var body = argument is LambdaExpressionSyntax { ExpressionBody: { } e } ? e : null;
        while (body is AwaitExpressionSyntax a) body = a.Expression;
        if (body is not InvocationExpressionSyntax call) return null;
        if (model.GetSymbolInfo(call).Symbol is IMethodSymbol m) return $"{(m.ReducedFrom ?? m).ContainingType.Name}.{m.Name}";
        return call.Expression is MemberAccessExpressionSyntax access ? access.Name.Identifier.ValueText : null;
    }
}
