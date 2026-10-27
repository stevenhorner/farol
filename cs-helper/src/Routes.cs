using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Farol.CsHelper;

/// <summary>A conventional route: `MapControllerRoute(name, pattern, defaults)` and friends.</summary>
public sealed record Convention(string Pattern, string? Area, string? DefaultController, string? DefaultAction);

/// <summary>
/// MVC and Web API controllers: ASP.NET's own discovery rules, attribute routes ([Route], [HttpGet("…")], tokens,
/// ~/ overrides, [Area], [ActionName]) and conventional routes, one entry point per action and route.
/// </summary>
public static class Routes
{
    static readonly string[] Verbs = ["Get", "Post", "Put", "Delete", "Patch", "Head", "Options"];
    public static readonly Convention Default = new("{controller=Home}/{action=Index}/{id?}", null, null, null);

    static bool Named(AttributeData a, string name) => a.AttributeClass?.Name is { } n && (n == name || n == name + "Attribute");

    static IEnumerable<AttributeData> Chain(INamedTypeSymbol type)
    {
        for (var t = type; t is not null; t = t.BaseType) foreach (var a in t.GetAttributes()) yield return a;
    }

    /// <summary>ASP.NET's rule: public, not abstract, not generic, no [NonController], named *Controller or marked [Controller] (ControllerBase is).</summary>
    public static bool IsController(INamedTypeSymbol type, bool mvcReferenced)
    {
        if (type.TypeKind != TypeKind.Class || type.IsAbstract || type.IsGenericType || type.DeclaredAccessibility != Accessibility.Public || type.ContainingType is not null) return false;
        if (Chain(type).Any(a => Named(a, "NonController"))) return false;
        for (var t = type.BaseType; t is not null; t = t.BaseType) if (!SetIndex.IsSource(t) && t.Name is "ControllerBase" or "Controller") return true;
        if (Chain(type).Any(a => Named(a, "Controller") || Named(a, "ApiController"))) return true;
        return mvcReferenced && type.Name.EndsWith("Controller", StringComparison.Ordinal);
    }

    /// <summary>A JSON API controller: [ApiController], or derived from ControllerBase without Controller's view support.</summary>
    public static bool IsApiController(INamedTypeSymbol type)
    {
        if (Chain(type).Any(a => Named(a, "ApiController"))) return true;
        for (var t = type.BaseType; t is not null; t = t.BaseType)
        {
            if (!SetIndex.IsSource(t) && t.Name == "Controller") return false;
            if (!SetIndex.IsSource(t) && t.Name == "ControllerBase") return true;
        }
        return false;
    }

    public static string ControllerName(INamedTypeSymbol type) => type.Name.EndsWith("Controller", StringComparison.Ordinal) && type.Name.Length > "Controller".Length ? type.Name[..^"Controller".Length] : type.Name;

    public static string? Area(INamedTypeSymbol type) => Chain(type).Where(a => Named(a, "Area")).Select(a => a.ConstructorArguments.FirstOrDefault().Value as string).FirstOrDefault(s => s is not null);

    /// <summary>A public instance method of a controller that MVC exposes (overrides of framework members and Dispose are not).</summary>
    public static bool IsAction(IMethodSymbol m)
    {
        if (m.MethodKind != MethodKind.Ordinary || m.IsStatic || m.IsAbstract || m.IsGenericMethod || m.DeclaredAccessibility != Accessibility.Public) return false;
        if (m.Name == "Dispose" && m.Parameters.Length == 0) return false;
        for (IMethodSymbol? o = m; o is not null; o = o.OverriddenMethod)
        {
            if (o.GetAttributes().Any(a => Named(a, "NonAction"))) return false;
            if (!SetIndex.IsSource(o)) return false;
        }
        return true;
    }

    /// <summary>[ActionName] or the method name without its Async suffix (MVC's SuppressAsyncSuffixInActionNames).</summary>
    public static string ActionName(IMethodSymbol m)
    {
        var named = m.GetAttributes().Where(a => Named(a, "ActionName")).Select(a => a.ConstructorArguments.FirstOrDefault().Value as string).FirstOrDefault(s => s is not null);
        if (named is not null) return named;
        return m.Name.EndsWith("Async", StringComparison.Ordinal) && m.Name.Length > 5 ? m.Name[..^5] : m.Name;
    }

    /// <summary>Actions of a controller, its own first, then inherited ones from project base classes it does not hide.</summary>
    public static IEnumerable<IMethodSymbol> Actions(INamedTypeSymbol type)
    {
        var seen = new HashSet<string>();
        for (var t = type; t is not null && SetIndex.IsSource(t); t = t.BaseType)
            foreach (var m in t.GetMembers().OfType<IMethodSymbol>().OrderBy(m => m.Locations.FirstOrDefault()?.SourceSpan.Start ?? 0))
            {
                var signature = m.Name + "(" + string.Join(",", m.Parameters.Select(p => p.Type.ToDisplayString())) + ")";
                if (seen.Add(signature) && IsAction(m)) yield return m;
            }
    }

    /// <summary>Route keys of an action: attribute routes when the action or its controller has any, conventional otherwise.</summary>
    public static List<(string Key, string? Computed)> Keys(INamedTypeSymbol controller, IMethodSymbol action, IReadOnlyList<Convention> conventions)
    {
        var name = ControllerName(controller);
        var actionName = ActionName(action);
        var area = Area(controller);
        var controllerTemplates = Chain(controller).Where(a => Named(a, "Route")).Select(Template).Where(t => t is not null).Select(t => t!).Distinct().ToList();
        var verbsWithTemplate = new List<(string Verb, string Template)>();
        var verbsWithout = new List<string>();
        var actionTemplates = new List<string>();
        foreach (var a in action.GetAttributes())
        {
            var verb = Verbs.FirstOrDefault(v => Named(a, "Http" + v))?.ToUpperInvariant();
            if (verb is not null)
            {
                if (Template(a) is { } t) verbsWithTemplate.Add((verb, t));
                else verbsWithout.Add(verb);
            }
            else if (Named(a, "AcceptVerbs"))
            {
                var verbs = a.ConstructorArguments.SelectMany(c => c.Kind == TypedConstantKind.Array ? c.Values : [c]).Select(c => c.Value as string).Where(v => v is not null).Select(v => v!.ToUpperInvariant());
                var route = a.NamedArguments.FirstOrDefault(n => n.Key == "Route").Value.Value as string;
                foreach (var v in verbs) { if (route is not null) verbsWithTemplate.Add((v, route)); else verbsWithout.Add(v); }
            }
            else if (Named(a, "Route") && Template(a) is { } t) actionTemplates.Add(t);
        }
        var methods = verbsWithout.Count > 0 ? verbsWithout.Distinct().ToList() : ["ANY"];
        var keys = new List<(string, string?)>();
        string Replace(string path) => path.Replace("[controller]", name, StringComparison.OrdinalIgnoreCase).Replace("[action]", actionName, StringComparison.OrdinalIgnoreCase).Replace("[area]", area ?? "", StringComparison.OrdinalIgnoreCase);
        IEnumerable<string> Combine(string template)
        {
            if (template.StartsWith('/') || template.StartsWith("~/", StringComparison.Ordinal)) return [template];
            return controllerTemplates.Count == 0 ? [template] : controllerTemplates.Select(c => c + "/" + template);
        }
        if (verbsWithTemplate.Count > 0 || actionTemplates.Count > 0 || controllerTemplates.Count > 0)
        {
            foreach (var (verb, t) in verbsWithTemplate) foreach (var path in Combine(t)) keys.Add(($"{verb} {Clean(Replace(path))}", null));
            var plain = actionTemplates.Count > 0 ? actionTemplates.SelectMany(Combine) : verbsWithTemplate.Count == 0 ? controllerTemplates : [];
            foreach (var path in plain) foreach (var verb in methods) keys.Add(($"{verb} {Clean(Replace(path))}", null));
            return keys;
        }
        foreach (var c in conventions)
        {
            if (Expand(c, name, actionName, area) is not { } path) continue;
            foreach (var verb in methods) keys.Add(($"{verb} {Clean(path)}", null));
        }
        return keys;
    }

    static string? Template(AttributeData a) => a.ConstructorArguments.FirstOrDefault(c => c.Value is string).Value as string ?? a.NamedArguments.FirstOrDefault(n => n.Key == "Template").Value.Value as string;

    /// <summary>The URL of an action under a conventional route, or null when the route does not apply to it.</summary>
    static string? Expand(Convention c, string controller, string action, string? area)
    {
        var pattern = c.Pattern;
        var hasArea = pattern.Contains("{area", StringComparison.OrdinalIgnoreCase) || c.Area is not null;
        if (hasArea != (area is not null) || (c.Area is not null && !string.Equals(c.Area, area, StringComparison.OrdinalIgnoreCase))) return null;
        if (!pattern.Contains("{controller", StringComparison.OrdinalIgnoreCase) && !string.Equals(c.DefaultController, controller, StringComparison.OrdinalIgnoreCase)) return null;
        if (!pattern.Contains("{action", StringComparison.OrdinalIgnoreCase) && !string.Equals(c.DefaultAction, action, StringComparison.OrdinalIgnoreCase)) return null;
        var segments = pattern.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(s =>
            s.StartsWith("{controller", StringComparison.OrdinalIgnoreCase) ? controller :
            s.StartsWith("{action", StringComparison.OrdinalIgnoreCase) ? action :
            s.StartsWith("{area", StringComparison.OrdinalIgnoreCase) ? area! : s);
        return string.Join("/", segments);
    }

    public static string Clean(string path)
    {
        var parts = path.TrimStart('~').Split('/', StringSplitOptions.RemoveEmptyEntries);
        return "/" + string.Join("/", parts);
    }

    /// <summary>Conventional routes of one compilation, with a dynamic-route problem for patterns that are not constants.</summary>
    public static IEnumerable<(Convention? Convention, InvocationExpressionSyntax Call)> Conventions(SyntaxTree tree, SemanticModel model)
    {
        foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (call.Expression is not MemberAccessExpressionSyntax access) continue;
            var name = access.Name.Identifier.ValueText;
            if (name is "MapDefaultControllerRoute" or "UseMvcWithDefaultRoute") { yield return (Default, call); continue; }
            if (name is not ("MapControllerRoute" or "MapAreaControllerRoute" or "MapRoute" or "MapAreaRoute")) continue;
            string? area = null;
            if (name.Contains("Area"))
            {
                var (value, constant) = Arg(call, model, "areaName", 1);
                if (!constant) { yield return (null, call); continue; }
                area = value;
            }
            var patternArg = ArgExpression(call, name.Contains("Area") ? 2 : 1, "pattern", "template");
            if (patternArg is null || model.GetConstantValue(patternArg) is not { HasValue: true, Value: string pattern }) { yield return (null, call); continue; }
            var defaults = ArgExpression(call, name.Contains("Area") ? 3 : 2, "defaults") as AnonymousObjectCreationExpressionSyntax;
            string? DefaultOf(string member) => defaults?.Initializers.FirstOrDefault(i => (i.NameEquals?.Name.Identifier.ValueText ?? (i.Expression as IdentifierNameSyntax)?.Identifier.ValueText) == member) is { } init && model.GetConstantValue(init.Expression) is { HasValue: true, Value: string v } ? v : null;
            yield return (new Convention(pattern, area, DefaultOf("controller"), DefaultOf("action")), call);
        }
    }

    static (string? Value, bool Constant) Arg(InvocationExpressionSyntax call, SemanticModel model, string name, int position)
    {
        var e = ArgExpression(call, position, name);
        return e is not null && model.GetConstantValue(e) is { HasValue: true, Value: string v } ? (v, true) : (null, false);
    }

    static ExpressionSyntax? ArgExpression(InvocationExpressionSyntax call, int position, params string[] names)
    {
        var args = call.ArgumentList.Arguments;
        var named = args.FirstOrDefault(a => a.NameColon is not null && names.Contains(a.NameColon.Name.Identifier.ValueText));
        if (named is not null) return named.Expression;
        return position < args.Count && args[position].NameColon is null ? args[position].Expression : null;
    }
}
