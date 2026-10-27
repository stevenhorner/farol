using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Farol.CsHelper;

/// <summary>
/// What a compiled view uses besides code: its layout, partials and view components (by the names the generated code
/// passes), _ViewStart and _ViewImports above it, and the scripts and stylesheets it links (client files of wwwroot).
/// A name computed at run time reaches every candidate in scope (phase 1's rule).
/// </summary>
public static class RazorEdges
{
    static readonly string[] PartialMethods = ["Partial", "PartialAsync", "RenderPartial", "RenderPartialAsync"];
    static readonly string[] AssetExtensions = [".js", ".mjs", ".css"];

    public static void Add(Workspace ws, ConfigurationSet set, SetIndex index, Graph graph, Dictionary<SyntaxTree, SemanticModel> models, IReadOnlyList<string> viewRoots)
    {
        foreach (var (projectPath, generated) in set.Views)
        {
            var project = ws.Projects.First(p => p.File.Path == projectPath);
            var views = project.Views.Select(v => Paths.Rel(ws.Root, v)).ToHashSet(StringComparer.Ordinal);
            var components = Components(set.Compilations[projectPath], index);
            foreach (var view in generated)
            {
                var model = models[view.Tree];
                var root = view.Tree.GetRoot();
                foreach (var v in views) if (v != view.View && IsStartFile(v) && Above(v, view.View)) graph.Edge(view.View, v);
                foreach (var name in Names(root, model))
                {
                    var targets = name is null ? views.Where(v => InScope(v, view.View)) : Candidates(project.File.Dir, view.View, name, viewRoots).Where(views.Contains);
                    foreach (var t in targets) if (t != view.View) graph.Edge(view.View, t);
                }
                foreach (var component in ComponentNames(root, model))
                    foreach (var id in component is null ? components.Values.SelectMany(x => x) : components.GetValueOrDefault(component.ToLowerInvariant()) ?? []) graph.Edge(view.View, id);
                foreach (var asset in Assets(root, project.File.Dir))
                {
                    var abs = Path.Combine(ws.Root, asset);
                    if (!File.Exists(abs)) continue;
                    var hash = Decls.Short(Decls.Collapse(File.ReadAllText(abs)));
                    graph.Add(new Decl(asset, asset, 1, Math.Max(1, File.ReadAllLines(abs).Length), "client", hash, hash));
                    graph.Edge(view.View, asset);
                }
            }
        }
    }

    static string Dir(string path) => Path.GetDirectoryName(path)?.Replace('\\', '/') ?? "";

    static bool Above(string file, string view) => view.StartsWith(Dir(file) + "/", StringComparison.Ordinal) || Dir(file) == "";

    static bool IsStartFile(string path) => Path.GetFileName(path) is "_ViewStart.cshtml" or "_ViewImports.cshtml";

    /// <summary>Partials and layouts a view could name: `_` files in its folder and above, and every Shared file.</summary>
    static bool InScope(string candidate, string view) => (Path.GetFileName(candidate).StartsWith('_') && Above(candidate, view)) || candidate.Split('/').Contains("Shared");

    /// <summary>Files the view engine looks up for a partial or layout name, relative to the view that names it.</summary>
    static IEnumerable<string> Candidates(string projectDir, string view, string name, IReadOnlyList<string> viewRoots)
    {
        string P(string rel) => projectDir == "" ? rel : $"{projectDir}/{rel}";
        var file = name.EndsWith(".cshtml", StringComparison.Ordinal) ? name : name + ".cshtml";
        if (name.StartsWith("~/", StringComparison.Ordinal) || name.StartsWith('/')) return [P(file.TrimStart('~').TrimStart('/'))];
        if (name.Contains('/')) return [Paths.Rel("/", Path.GetFullPath(Path.Combine("/", Dir(view), file)))];
        var list = new List<string> { $"{Dir(view)}/{file}" };
        for (var d = Dir(view); d.Length > 0; d = Dir(d)) list.Add($"{d}/Shared/{file}");
        list.AddRange([P($"Views/Shared/{file}"), P($"Pages/Shared/{file}")]);
        list.AddRange(viewRoots.Select(r => P($"{r}/Shared/{file}")));
        return list;
    }

    /// <summary>Layout and partial names: `Layout = "…"`, `&lt;partial name="…"&gt;`, `Html.PartialAsync("…")`; null when computed.</summary>
    static IEnumerable<string?> Names(SyntaxNode root, SemanticModel model)
    {
        foreach (var node in root.DescendantNodes())
        {
            if (node is AssignmentExpressionSyntax { Left: IdentifierNameSyntax { Identifier.ValueText: "Layout" } or MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Layout" or "Name" } } assignment)
            {
                var target = model.GetSymbolInfo(assignment.Left).Symbol as IPropertySymbol;
                var isLayout = target is { Name: "Layout" } && !SetIndex.IsSource(target);
                var isPartial = target is { Name: "Name", ContainingType.Name: "PartialTagHelper" };
                if (!isLayout && !isPartial) continue;
                if (assignment.Right.IsKind(SyntaxKind.NullLiteralExpression)) continue;
                yield return Constant(assignment.Right, model);
            }
            else if (node is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax access } call && PartialMethods.Contains(access.Name.Identifier.ValueText) && call.ArgumentList.Arguments.Count > 0)
            {
                if (model.GetSymbolInfo(call).Symbol is IMethodSymbol m && SetIndex.IsSource(m.ReducedFrom ?? m)) continue;
                yield return Constant(call.ArgumentList.Arguments[0].Expression, model);
            }
        }
    }

    /// <summary>A constant string, also through the static TagHelperAttribute fields Razor emits for attribute values.</summary>
    static string? Constant(ExpressionSyntax e, SemanticModel model)
    {
        while (e is CastExpressionSyntax cast) e = cast.Expression;
        if (e is ParenthesizedExpressionSyntax p) return Constant(p.Expression, model);
        if (model.GetConstantValue(e) is { HasValue: true, Value: string s }) return s;
        if (e is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Value", Expression: IdentifierNameSyntax field }
            && model.GetSymbolInfo(field).Symbol is IFieldSymbol f
            && f.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is VariableDeclaratorSyntax { Initializer.Value: BaseObjectCreationExpressionSyntax { ArgumentList.Arguments: { Count: >= 2 } args } })
            return Literal(args[1].Expression);
        return null;
    }

    /// <summary>A string literal, or the literal inside `new HtmlString("…")`.</summary>
    static string? Literal(ExpressionSyntax e) => e switch
    {
        LiteralExpressionSyntax l when l.IsKind(SyntaxKind.StringLiteralExpression) => l.Token.ValueText,
        BaseObjectCreationExpressionSyntax { ArgumentList.Arguments: [var only] } => Literal(only.Expression),
        _ => null,
    };

    /// <summary>`Component.InvokeAsync("Name")` (also behind &lt;vc:name&gt;); null when the name is computed.</summary>
    static IEnumerable<string?> ComponentNames(SyntaxNode root, SemanticModel model)
    {
        foreach (var call in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (call.Expression is not MemberAccessExpressionSyntax { Name.Identifier.ValueText: "InvokeAsync" } || call.ArgumentList.Arguments.Count == 0) continue;
            if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol m || (m.ReducedFrom ?? m).ContainingType.Name is not ("IViewComponentHelper" or "DefaultViewComponentHelper" or "ViewComponentHelperExtensions")) continue;
            var first = call.ArgumentList.Arguments[0].Expression;
            if (first is TypeOfExpressionSyntax) continue;
            yield return model.GetConstantValue(first) is { HasValue: true, Value: string s } ? s : null;
        }
    }

    /// <summary>View components of a project by lower-case name: [ViewComponent(Name = …)] or the class name without its suffix.</summary>
    public static Dictionary<string, List<string>> Components(Compilation compilation, SetIndex index)
    {
        var map = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var type in SetIndex.SourceTypes(compilation.Assembly.GlobalNamespace))
        {
            if (ComponentName(type) is not { } name || !index.BySymbol.TryGetValue(Decls.Key(type), out var ids)) continue;
            if (!map.TryGetValue(name.ToLowerInvariant(), out var list)) map[name.ToLowerInvariant()] = list = [];
            list.AddRange(ids);
        }
        return map;
    }

    public static string? ComponentName(INamedTypeSymbol type)
    {
        if (type.TypeKind != TypeKind.Class || type.IsAbstract) return null;
        var attribute = type.GetAttributes().FirstOrDefault(a => a.AttributeClass?.Name is "ViewComponentAttribute" or "ViewComponent");
        var derived = false;
        for (var t = type.BaseType; t is not null; t = t.BaseType) derived |= t.Name == "ViewComponent" && !SetIndex.IsSource(t);
        if (attribute is null && !derived && !type.Name.EndsWith("ViewComponent", StringComparison.Ordinal)) return null;
        var named = attribute?.NamedArguments.FirstOrDefault(n => n.Key == "Name").Value.Value as string;
        return named ?? (type.Name.EndsWith("ViewComponent", StringComparison.Ordinal) && type.Name.Length > "ViewComponent".Length ? type.Name[..^"ViewComponent".Length] : type.Name);
    }

    /// <summary>Scripts and stylesheets a view links (`~/js/site.js`, `src="/css/a.css"`), as repo-relative wwwroot paths.</summary>
    static IEnumerable<string> Assets(SyntaxNode root, string projectDir)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var token in root.DescendantTokens().Where(t => t.IsKind(SyntaxKind.StringLiteralToken)))
            foreach (var url in Urls(token.ValueText))
            {
                var path = url.Split('?', '#')[0];
                if (!(path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith('/')) || path.StartsWith("//", StringComparison.Ordinal) || !AssetExtensions.Any(e => path.EndsWith(e, StringComparison.OrdinalIgnoreCase))) continue;
                var rel = "wwwroot/" + path.TrimStart('~').TrimStart('/');
                if (seen.Add(rel)) yield return projectDir == "" ? rel : $"{projectDir}/{rel}";
            }
    }

    /// <summary>The value itself when it is a URL, and every src/href attribute value of markup.</summary>
    static IEnumerable<string> Urls(string text)
    {
        if (!text.Contains('<')) { yield return text.Trim(); yield break; }
        foreach (var attribute in new[] { "src=", "href=" })
            for (var i = text.IndexOf(attribute, StringComparison.OrdinalIgnoreCase); i >= 0; i = text.IndexOf(attribute, i + 1, StringComparison.OrdinalIgnoreCase))
            {
                var start = i + attribute.Length;
                if (start >= text.Length || (text[start] != '"' && text[start] != '\'')) continue;
                var end = text.IndexOf(text[start], start + 1);
                if (end > start) yield return text[(start + 1)..end];
            }
    }
}
