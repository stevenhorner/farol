using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Farol.CsHelper;

/// <summary>
/// Razor views by ASP.NET's conventions (phase 1, no Razor compiler): each .cshtml file is a declaration; an action's
/// View()/PartialView() call reaches the files the view engine would look up; every view depends on the layouts,
/// _ViewStart/_ViewImports and partials in its scope (files starting with "_" in its folder or above, and every file
/// under a Shared folder).
/// </summary>
public static class Views
{
    public static void AddDecls(Workspace ws, Graph graph)
    {
        foreach (var project in ws.Projects)
        {
            var ids = project.Views.Select(v => Paths.Rel(ws.Root, v)).ToList();
            foreach (var (abs, id) in project.Views.Zip(ids))
            {
                var text = File.ReadAllText(abs);
                var hash = Decls.Short(Decls.Collapse(WithoutRazorComments(text)));
                graph.Add(new Decl(id, id, 1, Math.Max(1, text.Split('\n').Length), "view", hash, hash));
                var dir = Dir(id);
                foreach (var other in ids)
                {
                    if (other == id) continue;
                    var inScope = Path.GetFileName(other).StartsWith('_') && (dir == Dir(other) || dir.StartsWith(Dir(other) + "/", StringComparison.Ordinal) || Dir(other) == "");
                    if (inScope || other.Split('/').Contains("Shared")) graph.Edge(id, other);
                }
            }
        }
    }

    static string Dir(string path) => Path.GetDirectoryName(path)?.Replace('\\', '/') ?? "";

    /// <summary>Razor comments (@* … *@) do not count, like C# comments.</summary>
    static string WithoutRazorComments(string text)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '@' && i + 1 < text.Length && text[i + 1] == '*')
            {
                var end = text.IndexOf("*@", i + 2, StringComparison.Ordinal);
                if (end < 0) break;
                i = end + 1;
                continue;
            }
            sb.Append(text[i]);
        }
        return sb.ToString();
    }

    /// <summary>Edges from controller code to the views it renders.</summary>
    public static void AddEdges(Workspace ws, SetIndex index, Graph graph, IReadOnlyList<string> viewRoots, Func<INamedTypeSymbol, bool> isController)
    {
        foreach (var f in index.Found)
        {
            if (f.Decl.Kind != "method" || f.Type is null || !isController(f.Type)) continue;
            var project = ws.Projects.FirstOrDefault(p => f.Decl.File.StartsWith(p.File.Dir == "" ? "" : p.File.Dir + "/", StringComparison.Ordinal));
            if (project is null) continue;
            var views = project.Views.Select(v => Paths.Rel(ws.Root, v)).ToHashSet(StringComparer.Ordinal);
            var controller = Routes.ControllerName(f.Type);
            var area = Routes.Area(f.Type);
            var method = f.Model.GetDeclaredSymbol(f.Node) as IMethodSymbol;
            var isAction = method is not null && Routes.IsAction(method);
            foreach (var call in f.Node.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                var name = call.Expression switch { IdentifierNameSyntax id => id.Identifier.ValueText, MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax or BaseExpressionSyntax } m => m.Name.Identifier.ValueText, _ => null };
                if (name is not ("View" or "PartialView")) continue;
                var target = f.Model.GetSymbolInfo(call).Symbol as IMethodSymbol;
                if (target is not null && SetIndex.IsSource(target)) continue;
                var first = call.ArgumentList.Arguments.FirstOrDefault()?.Expression;
                string? viewName;
                if (first is not null && (target?.Parameters.FirstOrDefault()?.Type.SpecialType == SpecialType.System_String || f.Model.GetTypeInfo(first).Type?.SpecialType == SpecialType.System_String))
                    viewName = f.Model.GetConstantValue(first) is { HasValue: true, Value: string s } ? s : null;
                else viewName = isAction ? Routes.ActionName(method!) : null;
                var candidates = viewName is null ? Dynamic(views, controller) : Candidates(project.File.Dir, controller, area, viewName, viewRoots);
                foreach (var v in candidates) if (views.Contains(v)) graph.Edge(f.Decl.Id, v);
            }
        }
    }

    static IEnumerable<string> Candidates(string projectDir, string controller, string? area, string name, IReadOnlyList<string> viewRoots)
    {
        string P(string rel) => projectDir == "" ? rel : $"{projectDir}/{rel}";
        if (name.StartsWith("~/", StringComparison.Ordinal) || name.StartsWith('/')) return [P(name.TrimStart('~').TrimStart('/'))];
        var file = name.EndsWith(".cshtml", StringComparison.Ordinal) ? name : name + ".cshtml";
        if (name.Contains('/')) return [P($"Views/{file}")];
        var list = new List<string>();
        if (area is not null) list.AddRange([P($"Areas/{area}/Views/{controller}/{file}"), P($"Areas/{area}/Views/Shared/{file}")]);
        list.AddRange([P($"Views/{controller}/{file}"), P($"Views/Shared/{file}")]);
        foreach (var root in viewRoots) list.AddRange([P($"{root}/{controller}/{file}"), P($"{root}/Shared/{file}"), P($"{root}/{file}")]);
        return list;
    }

    /// <summary>A view name computed at run time: every view of the controller's folders and every shared view.</summary>
    static IEnumerable<string> Dynamic(IEnumerable<string> views, string controller) =>
        views.Where(v => v.Split('/') is var parts && parts.Length >= 2 && (parts[^2] == controller || parts.Contains("Shared")));
}
