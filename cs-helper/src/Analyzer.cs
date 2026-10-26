using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Farol.CsHelper;

public sealed record AnalyzeOptions(string Root, string Project, HashSet<string> Comments, List<string> Projects, List<string> Configurations, List<string> Defines, List<string> ViewRoots, List<string> EntryCalls, string? AssetsRoot);

/// <summary>One configuration set being analyzed: its declarations, lookups and partial results.</summary>
sealed class SetRun(ConfigurationSet set)
{
    public ConfigurationSet Set { get; } = set;
    public SetIndex Index { get; } = new();
    public Graph Graph { get; } = new();
    public Dictionary<SyntaxTree, SemanticModel> Models { get; } = [];
    public HashSet<(string, int, string)> Problems { get; } = [];
    public List<Comment> Comments { get; } = [];
    /// <summary>This configuration's syntax tree of each file, and the files collected again in it (see Own).</summary>
    public Dictionary<string, SyntaxTree> Trees { get; } = new(StringComparer.Ordinal);
    public ConcurrentDictionary<string, Dictionary<string, Found>> Recollected { get; } = new(StringComparer.Ordinal);
}

/// <summary>Reads the C# projects of a tree and prints farol's declaration JSON. Nothing of the analyzed code runs.</summary>
public static class Analyzer
{
    static readonly ParallelOptions Parallelism = new() { MaxDegreeOfParallelism = Math.Clamp(Environment.ProcessorCount, 1, 8) };

    public static Output Run(AnalyzeOptions o)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var timings = new List<string>();
        void Lap(string name) { timings.Add($"{name} {clock.ElapsedMilliseconds} ms"); clock.Restart(); }
        var ws = Workspace.Load(o.Root, o.Project, o.Projects);
        var sets = ws.Compile(o.Configurations, o.Defines, o.AssetsRoot);
        Lap("parse");
        ws.Notes.Add($"{sets.Count} configuration set(s): {string.Join(" | ", sets.Select(s => string.Join(", ", s.Configurations)))}");
        var runs = sets.Select(s => new SetRun(s)).ToArray();
        // A file without #if has the same declarations in every configuration: the other configurations reuse the first
        // one's (their syntax and hashes are equal).
        Collect(runs[0], o, null);
        var first = runs[0].Index.Found.GroupBy(f => f.Decl.File).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        Parallel.ForEach(runs.Skip(1), Parallelism, run => Collect(run, o, first));
        Lap("declarations");
        // Code binds the same way in every configuration unless its file holds #if directives or it names a declaration
        // that only some configurations have: only that code is bound again in the other configurations (in their own
        // compilation); the rest keeps the first configuration's edges.
        var everywhere = runs.Select(r => r.Graph.Decls.Keys.ToHashSet(StringComparer.Ordinal)).Aggregate((a, b) => { a.IntersectWith(b); return a; });
        var conditionalNames = runs.SelectMany(r => r.Index.Found).Where(f => !everywhere.Contains(f.Decl.Id)).Select(SimpleName).Where(n => n != "").ToHashSet(StringComparer.Ordinal);
        References(runs[0], runs[0].Index.Found, Parallelism);
        var rebound = 0;
        Parallel.ForEach(runs.Skip(1), Parallelism, run =>
        {
            var found = run.Index.Found.Where(f => Rebind(f, conditionalNames)).Select(f => Own(run, f, o)).ToList();
            Interlocked.Add(ref rebound, found.Count);
            References(run, found, new ParallelOptions { MaxDegreeOfParallelism = 1 });
            run.Graph.Edges.UnionWith(runs[0].Graph.Edges.Where(e => run.Graph.Decls.ContainsKey(e.From) && run.Graph.Decls.ContainsKey(e.To)));
        });
        Lap("references");
        Parallel.ForEach(runs, Parallelism, run => Finish(ws, run, o));
        Lap("entry points");
        if (runs.Length > 1) ws.Notes.Add($"other configurations bound {rebound} of {runs.Skip(1).Sum(r => r.Index.Found.Count)} declarations again");
        ws.Notes.Add($"timings: {string.Join(", ", timings)}");
        var graph = new Graph();
        Views.AddDecls(ws, graph);
        var problems = new HashSet<(string, int, string)>();
        var comments = new List<Comment>();
        var commentsDone = new HashSet<string>();
        foreach (var r in runs)
        {
            graph.Merge(r.Graph);
            problems.UnionWith(r.Problems);
            foreach (var c in r.Comments.GroupBy(c => c.File).Where(g => commentsDone.Add(g.Key))) comments.AddRange(c);
        }
        foreach (var note in ws.Notes) Console.Error.WriteLine($"cshelper: {note}");
        foreach (var (file, line, detail) in problems) graph.Problems.Add(new Problem(file, line, "parse-error", detail));
        return Build(ws, graph, comments);
    }

    static void References(SetRun run, IEnumerable<Found> found, ParallelOptions parallelism)
    {
        foreach (var compilation in run.Set.Compilations.Values) run.Index.Link(compilation, run.Graph);
        var edges = new ConcurrentBag<List<(string, string)>>();
        Parallel.ForEach(found, parallelism, f => edges.Add(run.Index.EdgesOf(f)));
        foreach (var list in edges) foreach (var (from, to) in list) run.Graph.Edge(from, to);
        foreach (var f in run.Index.Found.Where(f => f.Decl.Kind == "registration")) run.Graph.Edge(f.Decl.Id.Split(" | ")[0], f.Decl.Id);
    }

    /// <summary>A declaration reused from the first configuration, collected again in this configuration's compilation.</summary>
    static Found Own(SetRun run, Found f, AnalyzeOptions o)
    {
        var tree = run.Trees[f.Decl.File];
        var model = run.Models[tree];
        if (ReferenceEquals(f.Model, model)) return f;
        if (!run.Recollected.TryGetValue(f.Decl.File, out var again)) run.Recollected[f.Decl.File] = again = Decls.Collect(tree, model, f.Decl.File).ToDictionary(x => x.Decl.Id, StringComparer.Ordinal);
        return again.GetValueOrDefault(f.Decl.Id) ?? f;
    }

    /// <summary>Whether a file has conditional compilation (#if): its code may differ between configurations.</summary>
    static bool Conditional(SyntaxTree tree) => tree.GetText().ToString().Contains("#if", StringComparison.Ordinal);

    static void Collect(SetRun run, AnalyzeOptions o, Dictionary<string, List<Found>>? reuse)
    {
        foreach (var compilation in run.Set.Compilations.Values)
            foreach (var tree in compilation.SyntaxTrees)
            {
                if (tree.FilePath.EndsWith("farol.GlobalUsings.g.cs", StringComparison.Ordinal)) continue;
                var model = run.Models[tree] = compilation.GetSemanticModel(tree);
                var file = Paths.Rel(o.Root, tree.FilePath);
                run.Trees[file] = tree;
                var decls = reuse is not null && !Conditional(tree) ? reuse.GetValueOrDefault(file) ?? [] : Decls.Collect(tree, model, file);
                foreach (var f in decls)
                {
                    run.Index.Index(f);
                    run.Graph.Add(f.Decl);
                    if (IsStartup(f)) run.Index.Startup.Add(f.Decl.Id);
                }
                if (reuse is not null && !Conditional(tree)) continue;
                foreach (var d in tree.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error))
                    run.Problems.Add((file, d.Location.GetLineSpan().StartLinePosition.Line + 1, $"syntax error: {d.GetMessage(System.Globalization.CultureInfo.InvariantCulture)}"));
                if (o.Comments.Contains(file)) run.Comments.AddRange(CommentsOf(tree, file));
            }
    }

    /// <summary>Uncalled members, views and entry points, once every edge of the set is known.</summary>
    static void Finish(Workspace ws, SetRun run, AnalyzeOptions o)
    {
        var mvc = run.Set.Compilations.Values.Any(c => c.GetTypeByMetadataName("Microsoft.AspNetCore.Mvc.ControllerBase") is not null);
        // A member nothing in the project calls is called by a library or by convention (middleware InvokeAsync, view
        // code): it depends on its type. Controller methods are entry points of their own.
        var called = run.Graph.Edges.Select(e => e.To).ToHashSet(StringComparer.Ordinal);
        foreach (var f in run.Index.Found)
        {
            if (f.Decl.Kind is not ("method" or "property") || f.Type is null || called.Contains(f.Decl.Id) || Routes.IsController(f.Type, mvc)) continue;
            foreach (var t in run.Index.BySymbol.GetValueOrDefault(Decls.Key(f.Type)) ?? []) run.Graph.Edge(t, f.Decl.Id);
        }
        Views.AddEdges(ws, run.Index, run.Graph, o.ViewRoots, t => Routes.IsController(t, mvc));
        new Entries(ws, run.Set, run.Index, run.Graph, run.Models, o.EntryCalls).Find();
    }

    static string SimpleName(Found f) => f.SymbolKey is not { Length: > 2 } key ? "" : f.Decl.Kind == "type" ? key[2..].Split('`')[0].Split('.')[^1] : key[2..].Split('(')[0].Split('.')[^1];

    /// <summary>Whether a declaration may bind differently in another configuration (see Run).</summary>
    static bool Rebind(Found f, HashSet<string> conditionalNames) =>
        Conditional(f.Node.SyntaxTree) ||
        f.Node.DescendantTokens().Any(t => t.IsKind(SyntaxKind.IdentifierToken) && conditionalNames.Contains(t.ValueText));

    /// <summary>Startup code runs before every entry point: top-level statements, Main, and the Startup class.</summary>
    static bool IsStartup(Found f) =>
        f.Decl.Kind == "module" ||
        (f.Decl.Kind == "method" && f.SymbolKey is { } key && (MemberName(key) == "Main" || f.Type?.Name == "Startup"));

    static string MemberName(string key) => key.Split('(')[0].Split('.')[^1];

    static IEnumerable<Comment> CommentsOf(SyntaxTree tree, string file)
    {
        foreach (var trivia in tree.GetRoot().DescendantTrivia(descendIntoTrivia: true))
        {
            var comment = trivia.Kind() is SyntaxKind.SingleLineCommentTrivia or SyntaxKind.MultiLineCommentTrivia;
            var directive = trivia.Kind() is SyntaxKind.PragmaWarningDirectiveTrivia or SyntaxKind.NullableDirectiveTrivia;
            if (comment || directive) yield return new Comment(file, trivia.GetLocation().GetLineSpan().StartLinePosition.Line + 1, trivia.ToString().Trim());
        }
    }

    /// <summary>Sorted, index-based output: declarations by file, line and id; edges and anchors as indices.</summary>
    static Output Build(Workspace ws, Graph graph, List<Comment> comments)
    {
        var decls = graph.Decls.Values.OrderBy(d => d.File, StringComparer.Ordinal).ThenBy(d => d.Line).ThenBy(d => d.Id, StringComparer.Ordinal).ToArray();
        var at = decls.Select((d, i) => (d.Id, i)).ToDictionary(x => x.Id, x => x.i, StringComparer.Ordinal);
        var edges = graph.Edges.Where(e => at.ContainsKey(e.From) && at.ContainsKey(e.To)).Select(e => new[] { at[e.From], at[e.To] })
            .Distinct(new PairComparer()).OrderBy(e => e[0]).ThenBy(e => e[1]).ToArray();
        var entries = graph.Entries.Values.OrderBy(e => e.Key, StringComparer.Ordinal).Select(e => new Entry(
            e.Key, e.File, e.Line, e.Kind,
            e.Anchors.Where(at.ContainsKey).Select(a => at[a]).Distinct().Order().ToArray(),
            string.Join(",", e.Inline),
            e.Computed.Count == 0 ? null : e.Computed.Distinct().OrderBy(c => c.File, StringComparer.Ordinal).ThenBy(c => c.Line).ToArray())).ToArray();
        var files = ws.Projects.SelectMany(p => p.Sources.Concat(p.Views)).Select(f => Paths.Rel(ws.Root, f)).Distinct().Order(StringComparer.Ordinal).ToArray();
        var problems = graph.Problems.Distinct().OrderBy(p => p.File, StringComparer.Ordinal).ThenBy(p => p.Line).ThenBy(p => p.Detail, StringComparer.Ordinal).ToArray();
        var sortedComments = comments.OrderBy(c => c.File, StringComparer.Ordinal).ThenBy(c => c.Line).ToArray();
        return new Output("", files, decls, edges, entries, problems, sortedComments);
    }

    sealed class PairComparer : IEqualityComparer<int[]>
    {
        public bool Equals(int[]? a, int[]? b) => a is not null && b is not null && a[0] == b[0] && a[1] == b[1];
        public int GetHashCode(int[] a) => HashCode.Combine(a[0], a[1]);
    }
}
