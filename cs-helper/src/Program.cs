// cshelper reads C# projects the way the compiler does (Roslyn, from the .NET SDK) and prints, as JSON, what farol
// needs: declarations with a hash of their code, the references between them and the entry points. It never runs
// MSBuild or code of the analyzed repository.
//
//   cshelper analyze --root <dir> --project <rel> [--comments a.cs,b.cs] [--projects g1,g2] [--configurations c1,c2]
//                    [--defines S1,S2] [--view-roots r1,r2] [--entry-calls Ns.Type.Method,…] [--assets-root <dir>]
//   cshelper manifest < project.csproj
using Farol.CsHelper;

try
{
    if (args.Length > 0 && args[0] == "manifest")
    {
        Json.Write(Manifest.Read(Console.In.ReadToEnd()));
        return 0;
    }
    if (args.Length == 0 || args[0] != "analyze") throw new ArgumentException("usage: cshelper analyze --root <dir> --project <rel> … | cshelper manifest");
    var flags = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var i = 1; i < args.Length; i += 2)
    {
        if (!args[i].StartsWith("--", StringComparison.Ordinal) || i + 1 >= args.Length) throw new ArgumentException($"unexpected argument {args[i]}");
        flags[args[i][2..]] = args[i + 1];
    }
    List<string> List(string name) => flags.TryGetValue(name, out var v) ? [.. v.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)] : [];
    if (!flags.TryGetValue("root", out var root)) throw new ArgumentException("--root is required");
    var options = new AnalyzeOptions(
        Path.GetFullPath(root).TrimEnd('/', '\\'),
        flags.GetValueOrDefault("project", "."),
        [.. List("comments")],
        List("projects"),
        List("configurations"),
        List("defines"),
        List("view-roots"),
        List("entry-calls"),
        flags.TryGetValue("assets-root", out var assets) ? Path.GetFullPath(assets) : null);
    Json.Write(Analyzer.Run(options));
    return 0;
}
catch (Exception e) when (e is ArgumentException or InvalidDataException or IOException)
{
    Console.Error.WriteLine($"cshelper: {e.Message}");
    return 1;
}
