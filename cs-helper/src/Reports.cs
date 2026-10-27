using System.Globalization;
using System.Xml;
using System.Xml.Linq;

namespace Farol.CsHelper;

public sealed record CoverageFile(string Path, SortedDictionary<int, int> Lines);

/// <summary>XML inputs farol reads through the helper (Node has no XML parser): resource files and Cobertura coverage.</summary>
public static class Reports
{
    static XElement Root(string xml)
    {
        try { return XDocument.Parse(xml).Root ?? throw new XmlException("empty document"); }
        catch (XmlException e) { throw new InvalidDataException($"invalid XML: {e.Message}"); }
    }

    /// <summary>A .resx file as a JSON object: resource name → value (comments and schema left out).</summary>
    public static SortedDictionary<string, string> Resx(string xml)
    {
        var values = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var data in Root(xml).Elements().Where(e => e.Name.LocalName == "data"))
            if (data.Attribute("name")?.Value is { } name) values[name] = data.Elements().FirstOrDefault(e => e.Name.LocalName == "value")?.Value ?? "";
        return values;
    }

    /// <summary>
    /// Cobertura XML (coverlet, ReportGenerator): hits per line of each file, file names joined with the first source
    /// directory when they are relative. A line reported by several classes or methods keeps its highest count.
    /// </summary>
    public static CoverageFile[] Cobertura(string xml)
    {
        var root = Root(xml);
        if (root.Name.LocalName != "coverage") throw new InvalidDataException("not a Cobertura report (no <coverage> root)");
        var source = root.Descendants().FirstOrDefault(e => e.Name.LocalName == "source")?.Value.Trim();
        var files = new SortedDictionary<string, SortedDictionary<int, int>>(StringComparer.Ordinal);
        foreach (var cls in root.Descendants().Where(e => e.Name.LocalName == "class"))
        {
            if (cls.Attribute("filename")?.Value is not { Length: > 0 } name) continue;
            var path = Path.IsPathRooted(name) || source is null or "" ? name : Path.Combine(source, name);
            if (!files.TryGetValue(path, out var lines)) files[path] = lines = [];
            foreach (var line in cls.Descendants().Where(e => e.Name.LocalName == "line"))
            {
                if (!int.TryParse(line.Attribute("number")?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number)) continue;
                var hits = long.TryParse(line.Attribute("hits")?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var h) ? (int)Math.Min(h, int.MaxValue) : 0;
                lines[number] = Math.Max(lines.GetValueOrDefault(number), hits);
            }
        }
        return [.. files.Select(f => new CoverageFile(f.Key.Replace('\\', '/'), f.Value))];
    }
}
