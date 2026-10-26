using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Farol.CsHelper;

/// <summary>A project of the solution with its source files (absolute paths) and views.</summary>
public sealed record Project(ProjectFile File, List<string> Sources, List<string> Views);

/// <summary>One compilation of every project with the symbols of one build configuration (or several sharing them).</summary>
public sealed record ConfigurationSet(string[] Configurations, Dictionary<string, Compilation> Compilations);

/// <summary>
/// Finds the projects under the analyzed directory and compiles them with Roslyn, without MSBuild: sources from the
/// SDK's default globs and Compile items, references from the SDK's reference packs and, when the checkout was
/// restored, from the NuGet packages listed in obj/project.assets.json (read as metadata, never loaded).
/// </summary>
public sealed class Workspace
{
    public required string Root { get; init; }
    public required List<Project> Projects { get; init; }
    public List<Problem> Problems { get; } = [];
    public List<string> Notes { get; } = [];

    static readonly string[] SkippedDirs = ["bin", "obj", "node_modules", ".git", ".vs"];

    public static Workspace Load(string root, string projectDir, IReadOnlyList<string> projectGlobs)
    {
        var start = Path.GetFullPath(Path.Combine(root, projectDir));
        var csprojs = Walk(start).Where(f => f.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)).OrderBy(f => f, StringComparer.Ordinal).ToList();
        if (projectGlobs.Count > 0) csprojs = csprojs.Where(f => projectGlobs.Any(g => Paths.Matches(Paths.Normalize(Path.Combine(start, g)), f))).ToList();
        var files = csprojs.Select(f => ProjectFile.Read(root, f)).ToList();
        // Each file belongs to the nearest project above it: a test project nested in the web project's directory keeps
        // its files (tests are never callers), even though MSBuild's default globs would include them in both.
        var owners = files.OrderByDescending(f => f.AbsDir.Length).ToList();
        ProjectFile? OwnerOf(string path) => owners.FirstOrDefault(p => path.StartsWith(p.AbsDir + Path.DirectorySeparatorChar, StringComparison.Ordinal));
        var all = Walk(start).ToList();
        var projects = new List<Project>();
        foreach (var p in files.Where(f => !f.IsTest))
        {
            var sources = new SortedSet<string>(StringComparer.Ordinal);
            if (p.DefaultCompileItems) foreach (var f in all) if (f.EndsWith(".cs", StringComparison.Ordinal) && OwnerOf(f) == p) sources.Add(f);
            foreach (var glob in p.CompileInclude) foreach (var f in all) if (f.EndsWith(".cs", StringComparison.Ordinal) && Paths.Matches(glob, f)) sources.Add(f);
            sources.RemoveWhere(f => p.CompileRemove.Any(g => Paths.Matches(g, f)));
            var views = all.Where(f => f.EndsWith(".cshtml", StringComparison.Ordinal) && OwnerOf(f) == p).OrderBy(f => f, StringComparer.Ordinal).ToList();
            projects.Add(new Project(p, [.. sources], views));
        }
        var ws = new Workspace { Root = root, Projects = projects };
        foreach (var p in files) foreach (var ignored in p.Ignored.Distinct()) ws.Notes.Add($"{p.Path}: {ignored} not evaluated");
        return ws;
    }

    static IEnumerable<string> Walk(string dir)
    {
        if (!Directory.Exists(dir)) yield break;
        foreach (var f in Directory.EnumerateFiles(dir).OrderBy(f => f, StringComparer.Ordinal)) yield return f;
        foreach (var d in Directory.EnumerateDirectories(dir).OrderBy(d => d, StringComparer.Ordinal))
        {
            var name = Path.GetFileName(d);
            if (SkippedDirs.Contains(name, StringComparer.OrdinalIgnoreCase)) continue;
            foreach (var f in Walk(d)) yield return f;
        }
    }

    /// <summary>
    /// Compiles every distinct symbol set. The configurations are Debug, Release and every one a project declares
    /// (narrowed by csharp.configurations); configurations giving every project the same symbols are compiled once.
    /// </summary>
    public List<ConfigurationSet> Compile(IReadOnlyList<string> onlyConfigurations, IReadOnlyList<string> defines, string? assetsRoot)
    {
        var names = Projects.SelectMany(p => p.File.Configurations).Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(c => onlyConfigurations.Count == 0 || onlyConfigurations.Contains(c, StringComparer.OrdinalIgnoreCase))
            .OrderBy(c => c == "Debug" ? 0 : c == "Release" ? 1 : 2).ThenBy(c => c, StringComparer.Ordinal).ToList();
        if (names.Count == 0) names = [.. onlyConfigurations];
        // Configurations are told apart by the symbols some #if tests: the others (FULL for a configuration named Full
        // that no #if mentions) change nothing in the code.
        var tested = TestedSymbols(Projects.SelectMany(p => p.Sources));
        var groups = new List<(string Signature, List<string> Names, Dictionary<string, SortedSet<string>> Symbols)>();
        foreach (var name in names)
        {
            var symbols = Projects.ToDictionary(p => p.File.Path, p => p.File.Symbols(name, defines));
            var signature = string.Join("\n", symbols.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => kv.Key + ":" + string.Join(";", kv.Value.Where(tested.Contains))));
            var group = groups.FirstOrDefault(g => g.Signature == signature);
            if (group.Names is null) groups.Add((signature, [name], symbols));
            else group.Names.Add(name);
        }
        var framework = new Dictionary<string, List<MetadataReference>>();
        var trees = new Dictionary<string, SyntaxTree>();
        var result = new List<ConfigurationSet>();
        foreach (var group in groups)
        {
            var compilations = new Dictionary<string, Compilation>();
            foreach (var project in Ordered())
            {
                var file = project.File;
                var options = new CSharpParseOptions(LanguageVersion.Preview, DocumentationMode.None, SourceCodeKind.Regular, group.Symbols[file.Path]);
                var key = string.Join(";", group.Symbols[file.Path]);
                var projectTrees = project.Sources.Select(s => trees.TryGetValue(key + "|" + s, out var t) ? t : trees[key + "|" + s] = CSharpSyntaxTree.ParseText(File.ReadAllText(s), options, s)).ToList();
                projectTrees.Add(CSharpSyntaxTree.ParseText(string.Join("\n", file.GlobalUsings()), options, Path.Combine(file.AbsDir, "obj", "farol.GlobalUsings.g.cs")));
                if (!framework.TryGetValue(file.Path, out var refs)) framework[file.Path] = refs = References(file, assetsRoot);
                var projectRefs = file.ProjectReferences.Select(r => Projects.FirstOrDefault(p => Paths.Normalize(Path.Combine(Root, p.File.Path)) == Paths.Normalize(r)))
                    .Where(p => p is not null && compilations.ContainsKey(p.File.Path)).Select(p => compilations[p!.File.Path].ToMetadataReference());
                var compilationOptions = new CSharpCompilationOptions(file.IsExe ? OutputKind.ConsoleApplication : OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, nullableContextOptions: file.Nullable ? NullableContextOptions.Enable : NullableContextOptions.Disable);
                compilations[file.Path] = CSharpCompilation.Create(Path.GetFileNameWithoutExtension(file.Path), projectTrees, [.. refs, .. projectRefs], compilationOptions);
            }
            result.Add(new ConfigurationSet([.. group.Names], compilations));
        }
        return result;
    }

    /// <summary>Every identifier an #if or #elif tests, in active and inactive code (a superset is harmless).</summary>
    static HashSet<string> TestedSymbols(IEnumerable<string> files)
    {
        var symbols = new HashSet<string>(StringComparer.Ordinal);
        var options = new CSharpParseOptions(LanguageVersion.Preview, DocumentationMode.None);
        foreach (var file in files)
        {
            var text = File.ReadAllText(file);
            if (!text.Contains("#if", StringComparison.Ordinal)) continue;
            foreach (var trivia in CSharpSyntaxTree.ParseText(text, options).GetRoot().DescendantTrivia(descendIntoTrivia: true))
            {
                if (trivia.GetStructure() is ConditionalDirectiveTriviaSyntax directive)
                    foreach (var id in directive.Condition.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>()) symbols.Add(id.Identifier.ValueText);
                else if (trivia.IsKind(SyntaxKind.DisabledTextTrivia))
                    foreach (Match m in NestedCondition.Matches(trivia.ToString()))
                        foreach (Match id in Identifier.Matches(m.Groups[1].Value)) symbols.Add(id.Value);
            }
        }
        return symbols;
    }

    static readonly Regex NestedCondition = new(@"^\s*#\s*(?:if|elif)\b(.*)$", RegexOptions.Multiline);
    static readonly Regex Identifier = new(@"[A-Za-z_][A-Za-z0-9_]*");

    /// <summary>Projects in ProjectReference order (referenced projects first).</summary>
    IEnumerable<Project> Ordered()
    {
        var done = new HashSet<string>();
        var order = new List<Project>();
        void Visit(Project p, int depth)
        {
            if (done.Contains(p.File.Path) || depth > Projects.Count) return;
            foreach (var r in p.File.ProjectReferences)
            {
                var dep = Projects.FirstOrDefault(q => Paths.Normalize(Path.Combine(Root, q.File.Path)) == Paths.Normalize(r));
                if (dep is not null) Visit(dep, depth + 1);
            }
            if (done.Add(p.File.Path)) order.Add(p);
        }
        foreach (var p in Projects) Visit(p, 0);
        return order;
    }

    static string DotnetRoot => Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", ".."));

    List<MetadataReference> References(ProjectFile file, string? assetsRoot)
    {
        var dlls = new List<string>();
        dlls.AddRange(RefPack("Microsoft.NETCore.App.Ref", file.TargetFramework));
        if (file.AspNet) dlls.AddRange(RefPack("Microsoft.AspNetCore.App.Ref", file.TargetFramework));
        if (dlls.Count == 0) Notes.Add($"{file.Path}: no reference pack found under {DotnetRoot}/packs");
        if (assetsRoot is not null)
        {
            var assets = Path.Combine(assetsRoot, file.Dir, "obj", "project.assets.json");
            if (File.Exists(assets)) dlls.AddRange(NuGetAssemblies(assets, file.TargetFramework));
            else Notes.Add($"{file.Path}: not restored (no obj/project.assets.json): package types are unresolved");
        }
        return dlls.Distinct(StringComparer.Ordinal).Select(d => (MetadataReference)MetadataReference.CreateFromFile(d)).ToList();
    }

    /// <summary>Reference assemblies of a targeting pack: the newest pack version, the project's framework folder or the newest one.</summary>
    static IEnumerable<string> RefPack(string name, string tfm)
    {
        var dir = Path.Combine(DotnetRoot, "packs", name);
        if (!Directory.Exists(dir)) return [];
        var version = Directory.GetDirectories(dir).OrderByDescending(d => Version.TryParse(Path.GetFileName(d).Split('-')[0], out var v) ? v : new Version()).FirstOrDefault();
        var refDir = version is null ? null : Path.Combine(version, "ref");
        if (refDir is null || !Directory.Exists(refDir)) return [];
        var tfmDir = Directory.Exists(Path.Combine(refDir, tfm)) ? Path.Combine(refDir, tfm) : Directory.GetDirectories(refDir).OrderBy(d => d, StringComparer.Ordinal).LastOrDefault();
        return tfmDir is null ? [] : Directory.GetFiles(tfmDir, "*.dll").OrderBy(f => f, StringComparer.Ordinal);
    }

    /// <summary>Compile-time assemblies of the restored packages (project.assets.json is data written by `dotnet restore`).</summary>
    static IEnumerable<string> NuGetAssemblies(string assetsPath, string tfm)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(assetsPath));
        var root = doc.RootElement;
        var folders = root.TryGetProperty("packageFolders", out var pf) ? pf.EnumerateObject().Select(f => f.Name).ToList() : [];
        if (!root.TryGetProperty("targets", out var targets) || !root.TryGetProperty("libraries", out var libraries)) yield break;
        var target = targets.EnumerateObject().FirstOrDefault(t => t.Name == tfm || t.Name.StartsWith(tfm + "/", StringComparison.Ordinal));
        if (target.Value.ValueKind != JsonValueKind.Object) target = targets.EnumerateObject().FirstOrDefault();
        if (target.Value.ValueKind != JsonValueKind.Object) yield break;
        foreach (var lib in target.Value.EnumerateObject())
        {
            if (!lib.Value.TryGetProperty("type", out var type) || type.GetString() != "package" || !lib.Value.TryGetProperty("compile", out var compile)) continue;
            if (!libraries.TryGetProperty(lib.Name, out var info) || !info.TryGetProperty("path", out var path)) continue;
            foreach (var asset in compile.EnumerateObject())
            {
                if (!asset.Name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) continue;
                var file = folders.Select(f => Path.Combine(f, path.GetString()!, asset.Name)).FirstOrDefault(File.Exists);
                if (file is not null) yield return file;
            }
        }
    }
}
