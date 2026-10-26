using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Farol.CsHelper;

/// <summary>
/// Declarations, edges and entry points of every compiled configuration, by id. The first configuration that has a
/// declaration gives its hash (hashes include inactive #if text, so they do not depend on the configuration).
/// </summary>
public sealed class Graph
{
    public Dictionary<string, Decl> Decls { get; } = new(StringComparer.Ordinal);
    public HashSet<(string From, string To)> Edges { get; } = [];
    public Dictionary<string, EntryBuilder> Entries { get; } = new(StringComparer.Ordinal);
    public List<Problem> Problems { get; } = [];

    public void Add(Decl d) => Decls.TryAdd(d.Id, d);

    public void Edge(string from, string to)
    {
        if (from != to) Edges.Add((from, to));
    }

    /// <summary>Adds another graph: its declarations only where this one has none, everything else united.</summary>
    public void Merge(Graph other)
    {
        foreach (var d in other.Decls.Values) Add(d);
        Edges.UnionWith(other.Edges);
        foreach (var e in other.Entries.Values)
        {
            var mine = Entry(e.Key, e.File, e.Line, e.Kind);
            mine.Anchors.UnionWith(e.Anchors);
            mine.Inline.UnionWith(e.Inline);
            mine.Computed.AddRange(e.Computed);
        }
        Problems.AddRange(other.Problems);
    }

    public EntryBuilder Entry(string key, string file, int line, string kind)
    {
        if (!Entries.TryGetValue(key, out var e)) Entries[key] = e = new EntryBuilder(key, file, line, kind);
        return e;
    }
}

public sealed class EntryBuilder(string key, string file, int line, string kind)
{
    public string Key { get; } = key;
    public string File { get; } = file;
    public int Line { get; } = line;
    public string Kind { get; } = kind;
    public SortedSet<string> Anchors { get; } = new(StringComparer.Ordinal);
    public SortedSet<string> Inline { get; } = new(StringComparer.Ordinal);
    public List<Computed> Computed { get; } = [];
}

/// <summary>Lookups of one compilation set: symbol → declarations, interface and virtual dispatch, members by name.</summary>
public sealed class SetIndex
{
    public Dictionary<string, List<string>> BySymbol { get; } = new(StringComparer.Ordinal);
    /// <summary>Methods and properties by simple name, for members of values whose type is unknown (controller actions are entry points, never such calls).</summary>
    public Dictionary<string, List<string>> MethodsByName { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, List<string>> PropertiesByName { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, List<string>> Dispatch { get; } = new(StringComparer.Ordinal);
    public List<Found> Found { get; } = [];
    public List<string> Startup { get; } = [];

    public void Index(Found f)
    {
        Found.Add(f);
        if (f.SymbolKey is null) return;
        if (!BySymbol.TryGetValue(f.SymbolKey, out var list)) BySymbol[f.SymbolKey] = list = [];
        list.Add(f.Decl.Id);
        if (f.Decl.Kind is "method" or "property" && !(f.Decl.Kind == "method" && f.Type is not null && IsControllerType(f.Type)))
        {
            var name = f.SymbolKey[2..].Split('(')[0].Split('.')[^1];
            var map = f.Decl.Kind == "method" ? MethodsByName : PropertiesByName;
            if (!map.TryGetValue(name, out var byName)) map[name] = byName = [];
            byName.Add(f.Decl.Id);
        }
    }

    /// <summary>Declarations a symbol's code lives in, plus the project implementations and overrides it dispatches to.</summary>
    public IEnumerable<string> Targets(ISymbol? symbol)
    {
        if (symbol is null) yield break;
        if (symbol is IAliasSymbol alias) symbol = alias.Target;
        if (symbol is IMethodSymbol m)
        {
            m = m.ReducedFrom ?? m;
            if (m.PartialImplementationPart is not null) m = m.PartialImplementationPart;
            if (m.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove && m.AssociatedSymbol is not null) symbol = m.AssociatedSymbol!;
            else if (m.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction) yield break;
            else symbol = m;
        }
        if (symbol is not (INamedTypeSymbol or IMethodSymbol or IPropertySymbol or IFieldSymbol or IEventSymbol)) yield break;
        var key = Decls.Key(symbol);
        if (BySymbol.TryGetValue(key, out var own)) foreach (var id in own) yield return id;
        else if (symbol is not INamedTypeSymbol && symbol.ContainingType is { } type && BySymbol.TryGetValue(Decls.Key(type), out var parts)) foreach (var id in parts) yield return id;
        if (Dispatch.TryGetValue(key, out var impls)) foreach (var id in impls) yield return id;
    }

    /// <summary>
    /// Interface and virtual dispatch inside the project, and members only the framework calls: constructors (DI),
    /// overrides of library members and implementations of library interfaces depend on their type.
    /// </summary>
    public void Link(Compilation compilation, Graph graph)
    {
        foreach (var type in SourceTypes(compilation.Assembly.GlobalNamespace))
        {
            if (!BySymbol.TryGetValue(Decls.Key(type), out var typeDecls)) continue;
            foreach (var iface in type.AllInterfaces)
            {
                foreach (var member in iface.GetMembers())
                {
                    if (type.FindImplementationForInterfaceMember(member) is not { } impl) continue;
                    if (IsSource(iface)) AddDispatch(Decls.Key(member), impl);
                    else foreach (var id in Targets(impl)) foreach (var t in typeDecls) graph.Edge(t, id);
                }
            }
            foreach (var member in type.GetMembers())
            {
                var libraryCalled = member is IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor or MethodKind.Destructor or MethodKind.UserDefinedOperator or MethodKind.Conversion } || member is IPropertySymbol;
                for (var o = Overridden(member); o is not null; o = Overridden(o))
                {
                    if (IsSource(o)) AddDispatch(Decls.Key(o), member);
                    else libraryCalled = true;
                }
                if (libraryCalled && BySymbol.TryGetValue(Decls.Key(member), out var memberDecls)) foreach (var id in memberDecls) foreach (var t in typeDecls) graph.Edge(t, id);
            }
        }
    }

    void AddDispatch(string key, ISymbol impl)
    {
        if (!Dispatch.TryGetValue(key, out var list)) Dispatch[key] = list = [];
        list.AddRange(BySymbol.GetValueOrDefault(Decls.Key(impl)) ?? []);
    }

    static ISymbol? Overridden(ISymbol s) => s switch
    {
        IMethodSymbol m => m.OverriddenMethod,
        IPropertySymbol p => p.OverriddenProperty,
        IEventSymbol e => e.OverriddenEvent,
        _ => null,
    };

    public static bool IsSource(ISymbol s) => s.Locations.Any(l => l.IsInSource);

    static bool IsControllerType(INamedTypeSymbol type)
    {
        for (var t = type; t is not null; t = t.BaseType) if (!IsSource(t) && t.Name is "ControllerBase" or "Controller") return true;
        return type.Name.EndsWith("Controller", StringComparison.Ordinal);
    }

    public static IEnumerable<INamedTypeSymbol> SourceTypes(INamespaceSymbol ns)
    {
        foreach (var member in ns.GetMembers())
        {
            if (member is INamespaceSymbol child) foreach (var t in SourceTypes(child)) yield return t;
            else if (member is INamedTypeSymbol type && IsSource(type)) foreach (var t in WithNested(type)) yield return t;
        }
    }

    static IEnumerable<INamedTypeSymbol> WithNested(INamedTypeSymbol type)
    {
        yield return type;
        foreach (var nested in type.GetTypeMembers()) foreach (var t in WithNested(nested)) yield return t;
    }

    /// <summary>The edges of a declaration: every symbol its code names, resolved with the semantic model.</summary>
    public List<(string, string)> EdgesOf(Found f)
    {
        var edges = new List<(string, string)>();
        var span = f.Decl.Kind == "module" ? TextSpan.FromBounds(f.Node.DescendantNodes().OfType<GlobalStatementSyntax>().First().SpanStart, f.Node.DescendantNodes().OfType<GlobalStatementSyntax>().Last().Span.End) : f.Node.Span;
        var registration = f.Decl.Kind == "registration";
        // Route registrations belong to their entry points (handlers and filters are anchors), not to the startup code.
        var skip = new SpanSet(registration ? f.Skip : [.. f.Skip, .. Decls.RouteStatements(f.Node, span, f.Skip)]);
        foreach (var node in f.Node.DescendantNodesAndSelf(span, n => !skip.Covers(n.Span) || n.FullSpan.Contains(span)))
        {
            if (!span.Contains(node.Span) || skip.Covers(node.Span)) continue;
            // The services a registration names (`AddScoped<IFoo, Foo>()`) are not code it runs: whoever calls IFoo reaches Foo.
            // Code inside its configuration lambdas (filters, options) is.
            if (registration && !node.Ancestors().Any(a => a is AnonymousFunctionExpressionSyntax) && node.AncestorsAndSelf().Any(a => a is TypeArgumentListSyntax or TypeOfExpressionSyntax)) continue;
            foreach (var id in Resolve(node, f)) if (id != f.Decl.Id) edges.Add((f.Decl.Id, id));
        }
        return edges;
    }

    /// <summary>Declarations the code of a node (a handler lambda, a filter registration) names.</summary>
    public IEnumerable<string> RefsIn(SyntaxNode node, SemanticModel model)
    {
        var f = new Found(new Decl("", "", 0, 0, "", "", ""), node, model, [], null, null);
        return node.DescendantNodesAndSelf().SelectMany(n => Resolve(n, f)).Distinct();
    }

    IEnumerable<string> Resolve(SyntaxNode node, Found f)
    {
        switch (node)
        {
            case SimpleNameSyntax name:
                var info = f.Model.GetSymbolInfo(name);
                if (info.Symbol is { } symbol)
                {
                    if (OwnState(name, symbol, f)) return [];
                    return Targets(symbol);
                }
                if (info.CandidateSymbols.Length > 0) return info.CandidateSymbols.SelectMany(Targets);
                // Unresolved member of a value whose type is unknown (a package that was not restored): every project
                // member with that name (conservative).
                if (name.Parent is MemberAccessExpressionSyntax access && access.Name == name && f.Model.GetTypeInfo(access.Expression).Type is null or IErrorTypeSymbol)
                    return (access.Parent is InvocationExpressionSyntax call && call.Expression == access ? MethodsByName : PropertiesByName).GetValueOrDefault(name.Identifier.ValueText) ?? [];
                return [];
            case ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax or ConstructorInitializerSyntax or ElementAccessExpressionSyntax or BinaryExpressionSyntax or PrefixUnaryExpressionSyntax or PostfixUnaryExpressionSyntax:
                var s = f.Model.GetSymbolInfo(node);
                return s.Symbol is not null ? Targets(s.Symbol) : s.CandidateSymbols.SelectMany(Targets);
            default:
                return [];
        }
    }

    /// <summary>A member reading its own type's fields (implicitly or through this/base) is not a use of the type.</summary>
    static bool OwnState(SimpleNameSyntax name, ISymbol symbol, Found f)
    {
        if (f.Type is null || symbol is not (IFieldSymbol or IPropertySymbol or IEventSymbol) || symbol.IsStatic) return false;
        if (name.Parent is MemberAccessExpressionSyntax access && access.Name == name && access.Expression is not (ThisExpressionSyntax or BaseExpressionSyntax)) return false;
        for (var t = f.Type; t is not null; t = t.BaseType) if (SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, symbol.ContainingType?.OriginalDefinition)) return true;
        return false;
    }
}
