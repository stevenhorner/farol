using System.Collections.Immutable;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

namespace Farol.CsHelper;

/// <summary>A Razor view compiled to C#: the generated tree and the view file it comes from (repo-relative).</summary>
public sealed record GeneratedView(SyntaxTree Tree, string View, string Kind);

/// <summary>
/// Razor views (.cshtml) turned into C# by the Razor source generator of the .NET SDK that built this helper (its path
/// is recorded at build time), run through Roslyn's generator driver like the SDK's build does. It is Microsoft's code,
/// not the analyzed repository's; its output is added to the project's compilation, so view code binds like any code.
/// </summary>
public static class Razor
{
    static readonly Lazy<(ImmutableArray<ISourceGenerator> Generators, string? Error)> Loaded = new(Load);

    static (ImmutableArray<ISourceGenerator>, string?) Load()
    {
        var dir = typeof(Razor).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(a => a.Key == "RazorDir")?.Value;
        if (dir is null || !Directory.Exists(dir)) return ([], $"the Razor source generator was not found ({dir ?? "no path"})");
        try
        {
            var loader = new Loader(dir);
            var generators = Directory.GetFiles(dir, "*.dll").OrderBy(f => f, StringComparer.Ordinal)
                .SelectMany(f => new AnalyzerFileReference(f, loader).GetGenerators(LanguageNames.CSharp)).ToImmutableArray();
            return generators.IsEmpty ? ([], $"no source generator in {dir}") : (generators, null);
        }
        catch (Exception e) when (e is IOException or BadImageFormatException or FileLoadException or TypeLoadException)
        {
            return ([], $"the Razor source generator could not be loaded: {e.Message}");
        }
    }

    /// <summary>
    /// The compilation with the project's views compiled in, the generated views, and Razor's errors per view; null
    /// (with a note) when the generator is not available, so the views keep the conventions of phase 1.
    /// </summary>
    public static (Compilation Compilation, List<GeneratedView> Views, List<(string File, int Line, string Message)> Errors)? Generate(Compilation compilation, ProjectFile project, IReadOnlyList<string> views, string root, List<string> notes)
    {
        var (generators, error) = Loaded.Value;
        if (error is not null)
        {
            lock (notes) notes.Add($"{project.Path}: {error}; views are read by convention");
            return null;
        }
        var parse = (CSharpParseOptions)compilation.SyntaxTrees.First().Options;
        var texts = views.Select(v => (AdditionalText)new FileText(v)).ToImmutableArray();
        var global = new Dictionary<string, string>
        {
            ["build_property.RazorLangVersion"] = "latest",
            ["build_property.RootNamespace"] = Path.GetFileNameWithoutExtension(project.Path),
            ["build_property.MSBuildProjectDirectory"] = project.AbsDir,
            ["build_property.GenerateRazorMetadataSourceChecksumAttributes"] = "false",
        };
        var perFile = views.ToDictionary(v => v, v => new Dictionary<string, string> { ["build_metadata.AdditionalFiles.TargetPath"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(Path.GetRelativePath(project.AbsDir, v))) });
        GeneratorDriver driver = CSharpGeneratorDriver.Create(generators, texts, parse, new Options(global, perFile));
        driver = driver.RunGeneratorsAndUpdateCompilation(compilation, out var output, out var diagnostics);
        var failed = diagnostics.FirstOrDefault(d => d.Id == "CS8785");
        if (failed is not null)
        {
            lock (notes) notes.Add($"{project.Path}: the Razor source generator failed ({failed.GetMessage(System.Globalization.CultureInfo.InvariantCulture).Split('\n')[0]}); views are read by convention");
            return null;
        }
        var generated = new List<GeneratedView>();
        foreach (var tree in output.SyntaxTrees.Except(compilation.SyntaxTrees))
            if (CompiledItem(tree) is { } item) generated.Add(new GeneratedView(tree, Paths.Rel(root, Path.Combine(project.AbsDir, item.Path.TrimStart('/'))), item.Kind));
        var errors = driver.GetRunResult().Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error && d.Location.GetMappedLineSpan().Path is { Length: > 0 })
            .Select(d => (Paths.Rel(root, d.Location.GetMappedLineSpan().Path), d.Location.GetMappedLineSpan().StartLinePosition.Line + 1, $"Razor error {d.Id}: {d.GetMessage(System.Globalization.CultureInfo.InvariantCulture)}")).ToList();
        return (output, generated, errors);
    }

    /// <summary>The view a generated file compiles: [assembly: RazorCompiledItem(typeof(...), "mvc.1.0.view", "/Views/Home/Index.cshtml")].</summary>
    static (string Kind, string Path)? CompiledItem(SyntaxTree tree)
    {
        foreach (var attribute in tree.GetRoot().DescendantNodes(n => n is CompilationUnitSyntax or AttributeListSyntax or BaseNamespaceDeclarationSyntax).OfType<AttributeSyntax>())
        {
            if (!attribute.Name.ToString().EndsWith("RazorCompiledItemAttribute", StringComparison.Ordinal) && !attribute.Name.ToString().EndsWith("RazorCompiledItem", StringComparison.Ordinal)) continue;
            var args = attribute.ArgumentList?.Arguments.Select(a => a.Expression).OfType<LiteralExpressionSyntax>().Select(l => l.Token.ValueText).ToList();
            if (args is { Count: >= 2 }) return (args[^2], args[^1]);
        }
        return null;
    }

    sealed class FileText(string path) : AdditionalText
    {
        public override string Path => path;
        public override SourceText GetText(CancellationToken cancellationToken = default) => SourceText.From(File.ReadAllText(path), Encoding.UTF8);
    }

    sealed class Values(Dictionary<string, string> values) : AnalyzerConfigOptions
    {
        public override bool TryGetValue(string key, out string value)
        {
            var found = values.TryGetValue(key, out var v);
            value = v ?? "";
            return found;
        }
    }

    sealed class Options(Dictionary<string, string> global, Dictionary<string, Dictionary<string, string>> perFile) : AnalyzerConfigOptionsProvider
    {
        public override AnalyzerConfigOptions GlobalOptions => new Values(global);
        public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => new Values([]);
        public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) => new Values(perFile.GetValueOrDefault(textFile.Path) ?? []);
    }

    /// <summary>Loads the generator and its dependencies from the SDK folder; Roslyn itself is shared with the helper.</summary>
    sealed class Loader(string dir) : IAnalyzerAssemblyLoader
    {
        readonly Context context = new(dir);
        public void AddDependencyLocation(string fullPath) { }
        public Assembly LoadFromPath(string fullPath) => context.LoadFromAssemblyPath(fullPath);
    }

    sealed class Context(string dir) : AssemblyLoadContext("razor-generator")
    {
        protected override Assembly? Load(AssemblyName name)
        {
            if (name.Name is "Microsoft.CodeAnalysis" or "Microsoft.CodeAnalysis.CSharp") return null;
            var file = Path.Combine(dir, name.Name + ".dll");
            return File.Exists(file) ? LoadFromAssemblyPath(file) : null;
        }
    }
}
