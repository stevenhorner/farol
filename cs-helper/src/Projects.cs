using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Farol.CsHelper;

/// <summary>
/// A .csproj read as XML data. MSBuild never runs: only literal properties and items are read, and property groups
/// whose condition is not a plain configuration test are ignored.
/// </summary>
public sealed class ProjectFile
{
    public required string Path { get; init; }          // repo-relative path of the .csproj
    public required string Dir { get; init; }           // repo-relative directory ("" at the root)
    public required string AbsDir { get; init; }
    public string Sdk { get; set; } = "Microsoft.NET.Sdk";
    public string TargetFramework { get; set; } = "";
    public bool IsTest { get; set; }
    public bool IsExe { get; set; }
    public bool AspNet { get; set; }
    public bool ImplicitUsings { get; set; }
    public bool Nullable { get; set; }
    public bool DefaultCompileItems { get; set; } = true;
    public bool ImplicitConfigurationDefines { get; set; } = true;
    public List<string> CompileInclude { get; } = [];
    public List<string> CompileRemove { get; } = [];
    public List<string> ProjectReferences { get; } = [];     // absolute paths
    public List<(string Name, bool Static, string? Alias, bool Remove)> Usings { get; } = [];
    /// <summary>DefineConstants assignments in evaluation order; Config null applies to every configuration.</summary>
    public List<(string? Config, string Value)> Defines { get; } = [];
    public SortedSet<string> Configurations { get; } = new(StringComparer.Ordinal) { "Debug", "Release" };
    public List<string> Ignored { get; } = [];

    static readonly Regex ConfigCondition = new(@"^\s*'\$\(Configuration\)(?:\|\$\(Platform\))?'\s*==\s*'([^'|]+)(?:\|[^']*)?'\s*$");

    /// <summary>Symbols of one configuration: the SDK's TRACE, the project's DefineConstants, the configuration and framework symbols.</summary>
    public SortedSet<string> Symbols(string configuration, IEnumerable<string> extra)
    {
        var value = "TRACE";
        foreach (var (config, v) in Defines)
            if (config is null || string.Equals(config, configuration, StringComparison.OrdinalIgnoreCase))
                value = v.Replace("$(DefineConstants)", value, StringComparison.OrdinalIgnoreCase);
        var symbols = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var s in value.Split(new[] { ';', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) symbols.Add(s);
        if (ImplicitConfigurationDefines) symbols.Add(configuration.ToUpperInvariant().Replace('-', '_').Replace('.', '_').Replace(' ', '_'));
        foreach (var s in FrameworkSymbols(TargetFramework)) symbols.Add(s);
        foreach (var s in extra) symbols.Add(s);
        return symbols;
    }

    /// <summary>NET, NET8_0, NETCOREAPP and the NETx_OR_GREATER compatibility symbols of a netX.Y framework.</summary>
    public static IEnumerable<string> FrameworkSymbols(string tfm)
    {
        var m = Regex.Match(tfm, @"^net(\d+)\.(\d+)");
        if (!m.Success) yield break;
        int major = int.Parse(m.Groups[1].Value), minor = int.Parse(m.Groups[2].Value);
        yield return "NET";
        yield return "NETCOREAPP";
        yield return $"NET{major}_{minor}";
        for (var v = 5; v <= major; v++) yield return $"NET{v}_0_OR_GREATER";
        foreach (var v in new[] { "1_0", "1_1", "2_0", "2_1", "2_2", "3_0", "3_1" }) yield return $"NETCOREAPP{v}_OR_GREATER";
    }

    public static ProjectFile Read(string root, string absPath)
    {
        var rel = Paths.Rel(root, absPath);
        var dir = System.IO.Path.GetDirectoryName(rel)?.Replace('\\', '/') ?? "";
        var p = new ProjectFile { Path = rel, Dir = dir, AbsDir = System.IO.Path.GetDirectoryName(absPath)! };
        // Directory.Build.props is imported before the project: the nearest one up to the repository root.
        for (var d = p.AbsDir; d.Length >= root.Length; d = System.IO.Path.GetDirectoryName(d) ?? "")
        {
            var props = System.IO.Path.Combine(d, "Directory.Build.props");
            if (File.Exists(props)) { p.Apply(XDocument.Load(props).Root!, System.IO.Path.GetDirectoryName(props)!); break; }
            if (d == root) break;
        }
        var xml = XDocument.Load(absPath).Root!;
        var sdk = xml.Attribute("Sdk")?.Value ?? xml.Elements().FirstOrDefault(e => e.Name.LocalName == "Sdk")?.Attribute("Name")?.Value;
        if (sdk is not null) p.Sdk = sdk.Split('/')[0].Trim();
        p.AspNet |= p.Sdk is "Microsoft.NET.Sdk.Web" or "Microsoft.NET.Sdk.Razor" or "Microsoft.NET.Sdk.BlazorWebAssembly";
        p.IsExe |= p.Sdk is "Microsoft.NET.Sdk.Web" or "Microsoft.NET.Sdk.Worker";
        p.Apply(xml, p.AbsDir);
        return p;
    }

    void Apply(XElement xml, string baseDir)
    {
        foreach (var group in xml.Elements().Where(e => e.Name.LocalName == "PropertyGroup"))
        {
            var condition = group.Attribute("Condition")?.Value;
            string? config = null;
            if (condition is not null)
            {
                var m = ConfigCondition.Match(condition);
                if (!m.Success) { Ignored.Add($"PropertyGroup Condition=\"{condition}\""); continue; }
                config = m.Groups[1].Value;
                Configurations.Add(config);
            }
            foreach (var prop in group.Elements())
            {
                if (prop.Attribute("Condition") is not null) { Ignored.Add($"{prop.Name.LocalName} Condition"); continue; }
                SetProperty(prop.Name.LocalName, prop.Value.Trim(), config);
            }
        }
        foreach (var group in xml.Elements().Where(e => e.Name.LocalName == "ItemGroup" && e.Attribute("Condition") is null))
            foreach (var item in group.Elements()) AddItem(item, baseDir);
    }

    void SetProperty(string name, string value, string? config)
    {
        switch (name)
        {
            case "DefineConstants": Defines.Add((config, value)); break;
            case "Configurations": foreach (var c in value.Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) Configurations.Add(c); break;
            case "DisableImplicitConfigurationDefines" when config is null: ImplicitConfigurationDefines = !Is(value); break;
            case "TargetFramework" when config is null: TargetFramework = value; break;
            case "TargetFrameworks" when config is null && TargetFramework == "": TargetFramework = value.Split(';', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim() ?? ""; break;
            case "OutputType" when config is null: IsExe = value.Equals("Exe", StringComparison.OrdinalIgnoreCase) || value.Equals("WinExe", StringComparison.OrdinalIgnoreCase); break;
            case "IsTestProject" when config is null: IsTest = Is(value); break;
            case "ImplicitUsings" when config is null: ImplicitUsings = Is(value) || value == "enable"; break;
            case "Nullable" when config is null: Nullable = value is "enable" or "annotations" or "warnings"; break;
            case "EnableDefaultCompileItems" when config is null: DefaultCompileItems = Is(value) || value == ""; break;
        }
    }

    static bool Is(string value) => value.Equals("true", StringComparison.OrdinalIgnoreCase);

    void AddItem(XElement item, string baseDir)
    {
        var include = item.Attribute("Include")?.Value;
        var remove = item.Attribute("Remove")?.Value;
        switch (item.Name.LocalName)
        {
            case "Compile":
                if (include is not null) CompileInclude.AddRange(Split(include, baseDir));
                if (remove is not null) CompileRemove.AddRange(Split(remove, baseDir));
                break;
            case "ProjectReference" when include is not null:
                ProjectReferences.Add(System.IO.Path.GetFullPath(System.IO.Path.Combine(baseDir, include.Replace('\\', '/'))));
                break;
            case "PackageReference" when include is not null:
                if (include is "Microsoft.NET.Test.Sdk" or "xunit" or "xunit.v3" or "NUnit" or "MSTest.TestFramework" or "MSTest") IsTest = true;
                break;
            case "FrameworkReference" when include == "Microsoft.AspNetCore.App":
                AspNet = true;
                break;
            case "Using":
                var name = include ?? remove;
                if (name is not null) Usings.Add((name, Is(item.Attribute("Static")?.Value ?? ""), item.Attribute("Alias")?.Value, include is null));
                break;
        }
    }

    /// <summary>Absolute glob patterns of an item list ("a.cs;b/**/*.cs").</summary>
    static IEnumerable<string> Split(string value, string baseDir) =>
        value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(v => !v.Contains("$("))
            .Select(v => Paths.Normalize(System.IO.Path.Combine(baseDir, v.Replace('\\', '/'))));

    /// <summary>The implicit global usings of the project's SDK, plus its Using items.</summary>
    public IEnumerable<string> GlobalUsings()
    {
        var names = new List<(string Name, bool Static, string? Alias)>();
        if (ImplicitUsings)
        {
            foreach (var n in new[] { "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks" }) names.Add((n, false, null));
            if (Sdk == "Microsoft.NET.Sdk.Web")
                foreach (var n in new[] { "System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing", "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging" }) names.Add((n, false, null));
            if (Sdk == "Microsoft.NET.Sdk.Worker")
                foreach (var n in new[] { "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging" }) names.Add((n, false, null));
        }
        foreach (var u in Usings)
        {
            if (u.Remove) names.RemoveAll(x => x.Name == u.Name);
            else names.Add((u.Name, u.Static, u.Alias));
        }
        return names.Distinct().Select(u => u.Alias is not null ? $"global using {u.Alias} = global::{u.Name};" : u.Static ? $"global using static global::{u.Name};" : $"global using global::{u.Name};");
    }
}

public static class Paths
{
    public static string Rel(string root, string abs) => System.IO.Path.GetRelativePath(root, abs).Replace('\\', '/');

    public static string Normalize(string path) => System.IO.Path.GetFullPath(path).Replace('\\', '/');

    /// <summary>Whether an absolute path matches an absolute MSBuild-style glob (*, ** and ?).</summary>
    public static bool Matches(string glob, string path)
    {
        var pattern = "^" + Regex.Escape(glob.Replace('\\', '/')).Replace(@"\*\*/", "(.*/)?").Replace(@"\*\*", ".*").Replace(@"\*", "[^/]*").Replace(@"\?", "[^/]") + "$";
        return Regex.IsMatch(path.Replace('\\', '/'), pattern, RegexOptions.IgnoreCase);
    }
}
