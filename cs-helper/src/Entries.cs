using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Farol.CsHelper;

/// <summary>Entry points of one compilation set: controllers, minimal APIs, hosted services, configured entry calls and programs.</summary>
public sealed class Entries(Workspace ws, ConfigurationSet set, SetIndex index, Graph graph, Dictionary<SyntaxTree, SemanticModel> models)
{
    static readonly Dictionary<string, string> MapVerbs = new() { ["MapGet"] = "GET", ["MapPost"] = "POST", ["MapPut"] = "PUT", ["MapDelete"] = "DELETE", ["MapPatch"] = "PATCH", ["Map"] = "ANY", ["MapMethods"] = "" };

    List<(InvocationExpressionSyntax Call, SemanticModel Model)>? invocations;

    string Rel(SyntaxTree tree) => Paths.Rel(ws.Root, tree.FilePath);

    static int Line(SyntaxNode node) => node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    /// <summary>Every invocation of the set, unbound: callers filter them by name before asking the semantic model.</summary>
    List<(InvocationExpressionSyntax Call, SemanticModel Model)> Invocations() =>
        invocations ??= models.SelectMany(m => m.Key.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>().Select(c => (c, m.Value))).ToList();

    static string? CalledName(InvocationExpressionSyntax call) => call.Expression switch
    {
        MemberAccessExpressionSyntax m => m.Name.Identifier.ValueText,
        SimpleNameSyntax n => n.Identifier.ValueText,
        MemberBindingExpressionSyntax b => b.Name.Identifier.ValueText,
        _ => null,
    };

    /// <summary>The calls of a project method (bound only when the name matches).</summary>
    IEnumerable<(InvocationExpressionSyntax Call, SemanticModel Model)> CallsOf(IMethodSymbol method)
    {
        var key = Decls.Key(method);
        foreach (var (call, model) in Invocations())
            if (CalledName(call) == method.Name && model.GetSymbolInfo(call).Symbol is IMethodSymbol m && Decls.Key(m.ReducedFrom ?? m) == key) yield return (call, model);
    }

    public void Find()
    {
        Controllers();
        RazorPages();
        Hubs();
        GrpcServices();
        MinimalApis();
        HostedServices();
        EntryCalls();
        Programs();
    }

    /// <summary>Route parameter names of an entry key: `GET /orders/{id:int}/{*rest}` → id, rest.</summary>
    static HashSet<string> PathNames(string key) =>
        key.Split('/').Where(s => s.StartsWith('{') && s.EndsWith('}')).Select(s => s.Trim('{', '}', '*').Split(':', '=', '?')[0]).ToHashSet(StringComparer.OrdinalIgnoreCase);

    static bool BodyAllowed(string key) => key.Split(' ')[0] is "POST" or "PUT" or "PATCH" or "ANY";

    void Anchor(EntryBuilder e, IEnumerable<string> ids)
    {
        foreach (var id in ids) e.Anchors.Add(id);
        foreach (var id in index.Startup) e.Anchors.Add(id);
    }

    void Controllers()
    {
        var conventions = new List<Convention>();
        foreach (var (tree, model) in models)
            foreach (var (convention, call) in Routes.Conventions(tree, model))
            {
                if (convention is not null) conventions.Add(convention);
                else graph.Problems.Add(new Problem(Rel(tree), Line(call), "dynamic-route", $"conventional route whose pattern or area is not a constant: {Decls.Collapse(call.ToString())}"));
            }
        if (conventions.Count == 0) conventions.Add(Routes.Default);
        foreach (var compilation in set.Compilations.Values)
        {
            var mvc = compilation.GetTypeByMetadataName("Microsoft.AspNetCore.Mvc.ControllerBase") is not null;
            foreach (var type in SetIndex.SourceTypes(compilation.Assembly.GlobalNamespace))
            {
                if (!Routes.IsController(type, mvc) || !index.BySymbol.TryGetValue(Decls.Key(type), out var typeDecls)) continue;
                var typeLocation = type.Locations.Where(l => l.IsInSource).OrderBy(l => l.SourceTree!.FilePath, StringComparer.Ordinal).First();
                foreach (var action in Routes.Actions(type))
                {
                    var own = SymbolEqualityComparer.Default.Equals(action.ContainingType, type);
                    var location = own ? action.Locations.First(l => l.IsInSource) : typeLocation;
                    var line = location.GetLineSpan().StartLinePosition.Line + 1;
                    var api = Routes.IsApiController(type);
                    foreach (var (key, _) in Routes.Keys(type, action, conventions))
                    {
                        var e = graph.Entry(key, Rel(location.SourceTree!), line, "http");
                        // JSON endpoints only: an MVC action rendering a view has no contract.
                        if (api) e.Contract ??= Contracts.For(action, PathNames(key), BodyAllowed(key), Contracts.Produces(action));
                        Anchor(e, [.. typeDecls, .. index.Targets(action)]);
                    }
                }
            }
        }
    }

    void MinimalApis()
    {
        foreach (var (call, model) in Invocations())
        {
            if (call.Expression is not MemberAccessExpressionSyntax access || !MapVerbs.TryGetValue(access.Name.Identifier.ValueText, out var verb)) continue;
            var symbol = model.GetSymbolInfo(call).Symbol as IMethodSymbol;
            if (symbol is not null && (symbol.ReducedFrom ?? symbol).ContainingType.Name != "EndpointRouteBuilderExtensions") continue;
            var args = call.ArgumentList.Arguments;
            if (args.Count < 2) continue;
            var file = Rel(call.SyntaxTree);
            var (path, computed) = Segment(args[0].Expression, model);
            var verbs = new List<string>();
            if (verb != "") verbs.Add(verb);
            else if (args.Count >= 3 && Constants(args[1].Expression, model) is { } list) verbs.AddRange(list.Select(v => v.ToUpperInvariant()));
            else { graph.Problems.Add(new Problem(file, Line(call), "dynamic-route", $"HTTP methods that are not constants: {Decls.Collapse(call.ToString())}")); continue; }
            var handler = args[^1].Expression;
            var handlerMethod = (handler is AnonymousFunctionExpressionSyntax ? model.GetSymbolInfo(handler).Symbol : model.GetSymbolInfo(handler).Symbol ?? model.GetSymbolInfo(handler).CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
            var anchors = new List<string>();
            string inline = "";
            if (handler is AnonymousFunctionExpressionSyntax lambda)
            {
                inline = Decls.Hash(lambda, lambda.Span, []);
                anchors.AddRange(index.RefsIn(lambda, model));
            }
            else anchors.AddRange(index.Targets(model.GetSymbolInfo(handler).Symbol ?? model.GetSymbolInfo(handler).CandidateSymbols.FirstOrDefault()));
            // Endpoint filters chained on the registration run before the handler.
            for (SyntaxNode n = call; n.Parent is MemberAccessExpressionSyntax { Parent: InvocationExpressionSyntax outer } chained; n = outer)
                if (chained.Name.Identifier.ValueText.StartsWith("AddEndpointFilter", StringComparison.Ordinal)) anchors.AddRange(index.RefsIn(outer, model));
            foreach (var (prefix, prefixComputed) in Prefixes(access.Expression, model, 0))
                foreach (var v in verbs)
                {
                    var e = graph.Entry($"{v} {Routes.Clean(prefix + "/" + path)}", file, Line(call), "http");
                    if (handlerMethod is not null) e.Contract ??= Contracts.For(handlerMethod, PathNames(e.Key), BodyAllowed(e.Key), null);
                    if (inline != "") e.Inline.Add(inline);
                    foreach (var c in prefixComputed.Concat(computed ? [new Computed(file, Line(call))] : [])) e.Computed.Add(c);
                    Anchor(e, anchors);
                }
        }
    }

    /// <summary>A route segment: its constant value, or the expression in braces when it is computed at run time.</summary>
    static (string Path, bool Computed) Segment(ExpressionSyntax e, SemanticModel model) =>
        model.GetConstantValue(e) is { HasValue: true, Value: string s } ? (s, false) : ("{" + Decls.Collapse(e.ToString()) + "}", true);

    static List<string>? Constants(ExpressionSyntax e, SemanticModel model)
    {
        IEnumerable<ExpressionSyntax>? items = e switch
        {
            ArrayCreationExpressionSyntax a => a.Initializer?.Expressions,
            ImplicitArrayCreationExpressionSyntax a => a.Initializer.Expressions,
            CollectionExpressionSyntax c => c.Elements.OfType<ExpressionElementSyntax>().Select(x => x.Expression),
            _ => null,
        };
        if (items is null) return null;
        var values = items.Select(i => model.GetConstantValue(i) is { HasValue: true, Value: string s } ? s : null).ToList();
        return values.Any(v => v is null) ? null : values.Select(v => v!).ToList();
    }

    /// <summary>
    /// Prefixes a route builder expression stands for: MapGroup calls, local variables and, for a parameter, the
    /// argument of every caller (a few levels deep). App and endpoint builders have none.
    /// </summary>
    List<(string Prefix, List<Computed> Computed)> Prefixes(ExpressionSyntax e, SemanticModel model, int depth)
    {
        if (depth > 4) return [("", [])];
        switch (e)
        {
            case ParenthesizedExpressionSyntax p: return Prefixes(p.Expression, model, depth);
            case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax access } call:
                var inner = Prefixes(access.Expression, model, depth);
                if (access.Name.Identifier.ValueText != "MapGroup" || call.ArgumentList.Arguments.Count == 0) return inner;
                var (segment, computed) = Segment(call.ArgumentList.Arguments[0].Expression, model);
                var at = new Computed(Rel(call.SyntaxTree), Line(call));
                return inner.Select(i => (i.Prefix + "/" + segment, computed ? [.. i.Computed, at] : i.Computed)).ToList();
            case IdentifierNameSyntax id:
                var symbol = model.GetSymbolInfo(id).Symbol;
                if (symbol is ILocalSymbol local && local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is VariableDeclaratorSyntax { Initializer.Value: { } init } declarator)
                    return Prefixes(init, models[declarator.SyntaxTree], depth + 1);
                if (symbol is IParameterSymbol { ContainingSymbol: IMethodSymbol { MethodKind: MethodKind.Ordinary } method } parameter && SetIndex.IsSource(method))
                {
                    var result = new List<(string, List<Computed>)>();
                    foreach (var (site, siteModel) in CallsOf(method))
                    {
                        var reduced = siteModel.GetSymbolInfo(site).Symbol is IMethodSymbol { ReducedFrom: not null };
                        ExpressionSyntax? arg = reduced && parameter.Ordinal == 0 ? (site.Expression as MemberAccessExpressionSyntax)?.Expression
                            : site.ArgumentList.Arguments.ElementAtOrDefault(parameter.Ordinal - (reduced ? 1 : 0))?.Expression;
                        if (arg is not null) result.AddRange(Prefixes(arg, siteModel, depth + 1));
                    }
                    return result.Count > 0 ? result.DistinctBy(r => r.Item1).ToList() : [("", [])];
                }
                return [("", [])];
            default:
                return [("", [])];
        }
    }

    static readonly System.Text.RegularExpressions.Regex Handler = new(@"^On(Get|Post|Put|Delete|Patch|Head|Options)(\w*?)(Async)?$");

    /// <summary>
    /// Razor Pages: each page under Pages/ (or Areas/&lt;area&gt;/Pages/) is a route from its path and its @page template;
    /// each handler of its page model (OnGet, OnPostDeleteAsync…) is an entry point, `?handler=` for named ones.
    /// </summary>
    void RazorPages()
    {
        foreach (var (projectPath, generated) in set.Views)
        {
            var project = ws.Projects.First(p => p.File.Path == projectPath);
            var prefix = project.File.Dir == "" ? "" : project.File.Dir + "/";
            foreach (var view in generated.Where(v => v.Kind.EndsWith("razor-page", StringComparison.Ordinal) && v.View.StartsWith(prefix, StringComparison.Ordinal)))
            {
                if (PageRoute(view.View[prefix.Length..]) is not { } route) continue;
                var model = models[view.Tree];
                var root = view.Tree.GetRoot();
                var template = Metadata(root, "RouteTemplate");
                var path = template is null ? route : template.StartsWith('/') ? template : $"{route}/{template}";
                var pageModel = root.DescendantNodes().OfType<PropertyDeclarationSyntax>().Where(p => p.Identifier.ValueText == "Model")
                    .Select(p => (model.GetDeclaredSymbol(p) as IPropertySymbol)?.Type as INamedTypeSymbol).FirstOrDefault(t => t is not null && SetIndex.IsSource(t));
                var typeDecls = pageModel is null ? [] : index.BySymbol.GetValueOrDefault(Decls.Key(pageModel)) ?? [];
                var handlers = new List<(string Verb, string Name, IMethodSymbol Method)>();
                for (var t = pageModel; t is not null && SetIndex.IsSource(t); t = t.BaseType)
                    foreach (var m in t.GetMembers().OfType<IMethodSymbol>())
                        if (m is { MethodKind: MethodKind.Ordinary, IsStatic: false, DeclaredAccessibility: Accessibility.Public } && Handler.Match(m.Name) is { Success: true } h && !handlers.Any(x => x.Verb == h.Groups[1].Value.ToUpperInvariant() && x.Name == h.Groups[2].Value))
                            handlers.Add((h.Groups[1].Value.ToUpperInvariant(), h.Groups[2].Value, m));
                if (handlers.Count == 0) Anchor(graph.Entry($"ANY {Routes.Clean(path)}", view.View, 1, "http"), [view.View, .. typeDecls]);
                foreach (var (verb, name, method) in handlers)
                    Anchor(graph.Entry($"{verb} {Routes.Clean(path)}{(name == "" ? "" : $"?handler={name}")}", view.View, 1, "http"), [view.View, .. typeDecls, .. index.Targets(method)]);
            }
        }
    }

    /// <summary>The URL of a page file: Pages/Orders/Edit.cshtml → /Orders/Edit, Index → its folder, Areas/A/Pages/X → /A/X.</summary>
    static string? PageRoute(string rel)
    {
        var parts = rel.Split('/');
        if (Path.GetFileName(rel).StartsWith('_')) return null;
        string[] route = parts is ["Pages", .. var rest] ? rest : parts is ["Areas", var area, "Pages", .. var inArea] ? [area, .. inArea] : [];
        if (route.Length == 0) return null;
        route[^1] = route[^1][..^".cshtml".Length];
        return "/" + string.Join("/", route[^1] == "Index" ? route[..^1] : route);
    }

    /// <summary>A [RazorCompiledItemMetadata(key, value)] value of a generated view.</summary>
    static string? Metadata(SyntaxNode root, string key) =>
        root.DescendantNodes().OfType<AttributeSyntax>().Where(a => a.Name.ToString().Contains("RazorCompiledItemMetadata", StringComparison.Ordinal))
            .Select(a => a.ArgumentList?.Arguments.Select(x => x.Expression).OfType<LiteralExpressionSyntax>().Select(l => l.Token.ValueText).ToList())
            .FirstOrDefault(args => args is { Count: 2 } && args[0] == key)?[1];

    /// <summary>SignalR: `MapHub&lt;THub&gt;("/path")` makes every public method of the hub an entry point (`WS /path#Method`).</summary>
    void Hubs()
    {
        foreach (var (call, model) in Invocations())
        {
            if (call.Expression is not MemberAccessExpressionSyntax { Name: GenericNameSyntax { Identifier.ValueText: "MapHub", TypeArgumentList.Arguments: [var argument] } } access || call.ArgumentList.Arguments.Count == 0) continue;
            if (model.GetSymbolInfo(argument).Symbol is not INamedTypeSymbol hub || !SetIndex.IsSource(hub)) continue;
            var file = Rel(call.SyntaxTree);
            var (path, computed) = Segment(call.ArgumentList.Arguments[0].Expression, model);
            var hubDecls = index.BySymbol.GetValueOrDefault(Decls.Key(hub)) ?? [];
            var methods = new List<IMethodSymbol>();
            for (var t = hub; t is not null && SetIndex.IsSource(t); t = t.BaseType)
                foreach (var m in t.GetMembers().OfType<IMethodSymbol>())
                    if (m is { MethodKind: MethodKind.Ordinary, IsStatic: false, DeclaredAccessibility: Accessibility.Public, IsOverride: false } && !methods.Any(x => x.Name == m.Name)) methods.Add(m);
            foreach (var (prefix, prefixComputed) in Prefixes(access.Expression, model, 0))
                foreach (var m in methods)
                {
                    var e = graph.Entry($"WS {Routes.Clean(prefix + "/" + path)}#{m.Name}", file, Line(call), "ws");
                    foreach (var c in prefixComputed.Concat(computed ? [new Computed(file, Line(call))] : [])) e.Computed.Add(c);
                    Anchor(e, [.. hubDecls, .. index.Targets(m)]);
                }
        }
    }

    /// <summary>
    /// gRPC: `MapGrpcService&lt;T&gt;()` makes each method T overrides an entry point `RPC package.Service/Method`, anchored on
    /// it and the .proto that defines the service (its generated base class is not in git), with the messages as contract.
    /// </summary>
    void GrpcServices()
    {
        foreach (var (call, model) in Invocations())
        {
            if (call.Expression is not MemberAccessExpressionSyntax { Name: GenericNameSyntax { Identifier.ValueText: "MapGrpcService", TypeArgumentList.Arguments: [var argument] } }) continue;
            if (model.GetSymbolInfo(argument).Symbol is not INamedTypeSymbol impl || !SetIndex.IsSource(impl) || Grpc.ServiceName(impl) is not { } service) continue;
            var typeDecls = index.BySymbol.GetValueOrDefault(Decls.Key(impl)) ?? [];
            var proto = ws.Protos.FirstOrDefault(p => p.Services.ContainsKey(service));
            if (proto is not null) foreach (var t in typeDecls) graph.Edge(t, proto.Path);
            var qualified = proto is null || proto.Package == "" ? service : $"{proto.Package}.{service}";
            foreach (var m in impl.GetMembers().OfType<IMethodSymbol>().Where(m => m.IsOverride && m.DeclaredAccessibility == Accessibility.Public))
            {
                var e = graph.Entry($"RPC {qualified}/{m.Name}", Rel(call.SyntaxTree), Line(call), "rpc");
                if (proto is not null && proto.Services[service].TryGetValue(m.Name, out var rpc))
                {
                    Dictionary<string, object?> Stream(Dictionary<string, object?> s, bool stream) => stream ? new() { ["k"] = "list", ["of"] = s } : s;
                    e.Contract ??= new ContractOut([], Contracts.Field(Stream(Grpc.Shape(ws.Protos, proto, rpc.Request, []), rpc.RequestStream), true, false), Stream(Grpc.Shape(ws.Protos, proto, rpc.Response, []), rpc.ResponseStream));
                }
                Anchor(e, [.. typeDecls, .. index.Targets(m), .. proto is null ? [] : new[] { proto.Path }]);
            }
        }
    }

    /// <summary>BackgroundService and IHostedService implementations: TASK entries anchored on the type (its overrides run).</summary>
    void HostedServices()
    {
        foreach (var compilation in set.Compilations.Values)
            foreach (var type in SetIndex.SourceTypes(compilation.Assembly.GlobalNamespace))
            {
                if (type.TypeKind != TypeKind.Class || type.IsAbstract || !index.BySymbol.TryGetValue(Decls.Key(type), out var decls)) continue;
                var hosted = type.AllInterfaces.Any(i => i.Name == "IHostedService" && !SetIndex.IsSource(i));
                for (var t = type.BaseType; t is not null && !hosted; t = t.BaseType) hosted = t.Name == "BackgroundService" && !SetIndex.IsSource(t);
                hosted |= Jobs.IsQuartzJob(type, compilation);
                if (!hosted) continue;
                var location = type.Locations.Where(l => l.IsInSource).OrderBy(l => l.SourceTree!.FilePath, StringComparer.Ordinal).First();
                Anchor(graph.Entry($"TASK {type.ToDisplayString()}", Rel(location.SourceTree!), location.GetLineSpan().StartLinePosition.Line + 1, "task"), decls);
            }
    }

    /// <summary>csharp.entryCalls and Hangfire: delegates passed to these methods (schedulers, job registries) are TASK entries.</summary>
    void EntryCalls()
    {
        var ordinal = new Dictionary<string, int>();
        foreach (var (call, model) in Invocations())
        {
            if (!index.IsEntryCall(call, model, out var method)) continue;
            var file = Rel(call.SyntaxTree);
            var label = call.ArgumentList.Arguments.Select(a => model.GetConstantValue(a.Expression)).Where(c => c.HasValue && c.Value is string).Select(c => (string)c.Value!).FirstOrDefault();
            foreach (var arg in call.ArgumentList.Arguments.Select(a => a.Expression))
            {
                var anchors = new List<string>();
                string inline = "";
                string? name = null;
                if (arg is AnonymousFunctionExpressionSyntax lambda)
                {
                    inline = Decls.Hash(lambda, lambda.Span, []);
                    anchors.AddRange(index.RefsIn(lambda, model));
                    name = Jobs.DelegateLabel(lambda, model);
                }
                else if (model.GetSymbolInfo(arg).Symbol is IMethodSymbol group && model.GetTypeInfo(arg).Type is null)
                {
                    name = $"{group.ContainingType.Name}.{group.Name}";
                    anchors.AddRange(index.Targets(group));
                }
                else continue;
                ordinal[file] = ordinal.GetValueOrDefault(file) + 1;
                var e = graph.Entry($"TASK {method} {label ?? name ?? $"{file}#{ordinal[file]}"}", file, Line(call), "task");
                if (inline != "") e.Inline.Add(inline);
                Anchor(e, anchors);
            }
        }
    }

    /// <summary>An executable project whose files register no endpoint runs as a program: RUN entries anchored on its startup code.</summary>
    void Programs()
    {
        foreach (var project in ws.Projects.Where(p => p.File.IsExe))
        {
            var prefix = project.File.Dir == "" ? "" : project.File.Dir + "/";
            if (graph.Entries.Values.Any(e => e.Kind == "http" && e.File.StartsWith(prefix, StringComparison.Ordinal))) continue;
            var startup = index.Startup.Where(id => graph.Decls.TryGetValue(id, out var d) && d.File.StartsWith(prefix, StringComparison.Ordinal)).ToList();
            if (startup.Count == 0) continue;
            var e = graph.Entry($"RUN {(project.File.Dir == "" ? "." : project.File.Dir)}", graph.Decls[startup[0]].File, 1, "main");
            foreach (var id in startup) e.Anchors.Add(id);
        }
    }
}
