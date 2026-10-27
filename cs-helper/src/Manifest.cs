using System.Xml;
using System.Xml.Linq;

namespace Farol.CsHelper;

public sealed record Package(string Name, string Version, string Section);

/// <summary>A project file as data: its NuGet packages and every other property, item, import and target as comparable text.</summary>
public sealed record ManifestOutput(Package[] Packages, SortedDictionary<string, string> Other);

/// <summary>
/// Reads an MSBuild project file (.csproj, Directory.Packages.props) from stdin. PackageReference and PackageVersion
/// are dependencies (PrivateAssets="all": build-time only); the rest is keyed so that farol can tell what changed.
/// </summary>
public static class Manifest
{
    public static ManifestOutput Read(string xml)
    {
        XElement root;
        try { root = XDocument.Parse(xml).Root ?? throw new XmlException("empty document"); }
        catch (XmlException e) { throw new InvalidDataException($"invalid XML: {e.Message}"); }
        var packages = new List<Package>();
        var other = new SortedDictionary<string, string>(StringComparer.Ordinal);
        if (root.Attribute("Sdk") is { } sdk) other["Sdk"] = sdk.Value;
        foreach (var element in root.Elements())
        {
            var condition = element.Attribute("Condition")?.Value is { } c ? $"[{Decls.Collapse(c)}]" : "";
            switch (element.Name.LocalName)
            {
                case "PropertyGroup":
                    foreach (var p in element.Elements()) Set(other, $"property:{p.Name.LocalName}{condition}{Cond(p)}", p.Value.Trim());
                    break;
                case "ItemGroup":
                    foreach (var item in element.Elements())
                    {
                        var type = item.Name.LocalName;
                        var name = item.Attribute("Include")?.Value ?? item.Attribute("Update")?.Value;
                        if (type is "PackageReference" or "PackageVersion" && item.Attribute("Include") is { } include)
                        {
                            var version = item.Attribute("Version")?.Value ?? item.Element(item.Name.Namespace + "Version")?.Value ?? item.Attribute("VersionOverride")?.Value ?? "";
                            var privateAssets = item.Attribute("PrivateAssets")?.Value ?? item.Element(item.Name.Namespace + "PrivateAssets")?.Value ?? "";
                            packages.Add(new Package(include.Value, version.Trim(), privateAssets.Equals("all", StringComparison.OrdinalIgnoreCase) ? "devDependencies" : "dependencies"));
                            continue;
                        }
                        var verb = item.Attribute("Include") is not null ? "Include" : item.Attribute("Update") is not null ? "Update" : "Remove";
                        Set(other, $"item:{type}:{verb}={name ?? item.Attribute("Remove")?.Value ?? ""}{condition}", Describe(item));
                    }
                    break;
                default:
                    var label = element.Attribute("Name")?.Value ?? element.Attribute("Project")?.Value ?? element.Attribute("Sdk")?.Value ?? "";
                    Set(other, $"{element.Name.LocalName}:{label}{condition}", Decls.Collapse(element.ToString(SaveOptions.DisableFormatting)));
                    break;
            }
        }
        return new ManifestOutput([.. packages.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ThenBy(p => p.Section, StringComparer.Ordinal)], other);
    }

    static string Cond(XElement e) => e.Attribute("Condition")?.Value is { } c ? $"[{Decls.Collapse(c)}]" : "";

    static void Set(SortedDictionary<string, string> map, string key, string value)
    {
        var k = key;
        for (var n = 2; map.ContainsKey(k); n++) k = $"{key}#{n}";
        map[k] = value;
    }

    static string Describe(XElement item) =>
        string.Join(";", item.Attributes().Where(a => a.Name.LocalName is not ("Include" or "Update" or "Remove")).Select(a => $"{a.Name.LocalName}={a.Value}")
            .Concat(item.Elements().Select(e => $"{e.Name.LocalName}={Decls.Collapse(e.Value)}")));
}
