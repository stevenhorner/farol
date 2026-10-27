using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Farol.CsHelper;

/// <summary>A .proto file: its package, imports, services (rpc → request, response, streaming) and message shapes.</summary>
public sealed class ProtoFile
{
    public required string Path { get; init; }
    public string Package { get; set; } = "";
    public List<string> Imports { get; } = [];
    public Dictionary<string, Dictionary<string, (string Request, bool RequestStream, string Response, bool ResponseStream)>> Services { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, List<(string Name, string Type, bool Repeated, bool Optional)>> Messages { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, List<string>> Enums { get; } = new(StringComparer.Ordinal);
}

/// <summary>
/// gRPC services: `MapGrpcService&lt;T&gt;()` makes each method T overrides an entry point (`RPC package.Service/Method`).
/// The service base class is generated from the .proto at build time (never in git), so the .proto files are read here:
/// a tokenizer and a small parser, enough for packages, services, messages and enums. Each .proto is a declaration the
/// service implementations depend on.
/// </summary>
public static class Grpc
{
    static readonly HashSet<string> Scalars = ["double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes"];

    public static ProtoFile Parse(string path, string text)
    {
        var tokens = Tokens(text);
        var proto = new ProtoFile { Path = path };
        var i = 0;
        string Next() => i < tokens.Count ? tokens[i++] : "";
        string Peek() => i < tokens.Count ? tokens[i] : "";
        void SkipBlock()
        {
            for (var depth = 0; i < tokens.Count;)
            {
                var t = Next();
                if (t == "{") depth++;
                else if (t == "}" && --depth <= 0) return;
            }
        }
        void SkipStatement() { while (i < tokens.Count && Next() is not ";" and not "}") { } }
        void Message(string prefix)
        {
            var name = prefix + Next();
            var fields = proto.Messages[name] = [];
            if (Next() != "{") return;
            while (i < tokens.Count && Peek() != "}")
            {
                var t = Next();
                if (t == "message") { Message(name + "."); continue; }
                if (t == "enum") { Enum(name + "."); continue; }
                if (t is "option" or "reserved" or "extensions") { SkipStatement(); continue; }
                if (t == "oneof")
                {
                    // Only one field of a oneof is set: each is optional.
                    Next();
                    Next();
                    while (i < tokens.Count && Peek() != "}") { var f = Field(Next()); if (f is { } one) fields.Add(one with { Optional = true }); }
                    Next();
                    continue;
                }
                if (Field(t) is { } field) fields.Add(field);
            }
            Next();
        }
        (string Name, string Type, bool Repeated, bool Optional)? Field(string t)
        {
            if (t is ";" or "}" or "option") { if (t == "option") SkipStatement(); return null; }
            var repeated = t == "repeated";
            var optional = t == "optional";
            var type = repeated || optional ? Next() : t;
            if (type == "map") { while (i < tokens.Count && Peek() != ">") type += Next(); type += Next(); }
            var name = Next();
            SkipStatement();
            return (name, type, repeated, optional);
        }
        void Enum(string prefix)
        {
            var values = proto.Enums[prefix + Next()] = [];
            if (Next() != "{") return;
            while (i < tokens.Count && Peek() != "}")
            {
                var t = Next();
                if (t == "option" || t == "reserved") { SkipStatement(); continue; }
                if (t != ";") { values.Add(t); SkipStatement(); }
            }
            Next();
        }
        while (i < tokens.Count)
        {
            switch (Next())
            {
                case "package": proto.Package = Next(); SkipStatement(); break;
                case "import": var imported = Next(); if (imported is "public" or "weak") imported = Next(); proto.Imports.Add(imported.Trim('"')); SkipStatement(); break;
                case "message": Message(""); break;
                case "enum": Enum(""); break;
                case "service":
                    var rpcs = proto.Services[Next()] = new(StringComparer.Ordinal);
                    Next();
                    while (i < tokens.Count && Peek() != "}")
                    {
                        if (Next() != "rpc") continue;
                        var name = Next();
                        Next();
                        var reqStream = Peek() == "stream" && Next() == "stream";
                        var request = Next();
                        Next(); Next(); Next();
                        var respStream = Peek() == "stream" && Next() == "stream";
                        var response = Next();
                        Next();
                        rpcs[name] = (request, reqStream, response, respStream);
                        if (Peek() == "{") SkipBlock(); else SkipStatement();
                    }
                    Next();
                    break;
                case "option" or "syntax" or "edition": SkipStatement(); break;
            }
        }
        return proto;
    }

    /// <summary>Identifiers (dotted), strings, numbers and punctuation; `//` and `/* */` comments skipped.</summary>
    static List<string> Tokens(string text)
    {
        var tokens = new List<string>();
        for (var i = 0; i < text.Length;)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (text.AsSpan(i).StartsWith("//")) { while (i < text.Length && text[i] != '\n') i++; continue; }
            if (text.AsSpan(i).StartsWith("/*")) { var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal); i = end < 0 ? text.Length : end + 2; continue; }
            if (c is '"' or '\'')
            {
                var end = text.IndexOf(c, i + 1);
                end = end < 0 ? text.Length - 1 : end;
                tokens.Add(text[i..(end + 1)]);
                i = end + 1;
                continue;
            }
            if (char.IsLetterOrDigit(c) || c is '_' or '.' or '-')
            {
                var start = i;
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or '.')) i++;
                if (i == start) i++;
                tokens.Add(text[start..i]);
                continue;
            }
            tokens.Add(c.ToString());
            i++;
        }
        return tokens;
    }

    /// <summary>The shape of a message as gRPC sends it (proto field names); `seen` stops recursion.</summary>
    public static Dictionary<string, object?> Shape(IReadOnlyList<ProtoFile> protos, ProtoFile from, string type, HashSet<string> seen, int depth = 0)
    {
        if (Scalars.Contains(type)) return new() { ["k"] = "scalar", ["n"] = type };
        var (file, name) = Find(protos, from, type);
        if (file is null || name is null || depth > 8) return new() { ["k"] = "unknown", ["n"] = type };
        if (file.Enums.TryGetValue(name, out var values)) return new() { ["k"] = "enum", ["n"] = name, ["v"] = values.OrderBy(v => v, StringComparer.Ordinal).ToList() };
        if (!seen.Add(name)) return new() { ["k"] = "ref", ["n"] = name };
        var fields = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (field, fieldType, repeated, optional) in file.Messages[name])
        {
            var shape = fieldType.StartsWith("map<", StringComparison.Ordinal)
                ? new() { ["k"] = "object", ["n"] = "map", ["f"] = new SortedDictionary<string, object?> { ["*"] = Contracts.Field(Shape(protos, file, fieldType[(fieldType.IndexOf(',') + 1)..^1], seen, depth + 1), false, false) } }
                : Shape(protos, file, fieldType, seen, depth + 1);
            fields[field] = Contracts.Field(repeated ? new() { ["k"] = "list", ["of"] = shape } : shape, !optional, false);
        }
        seen.Remove(name);
        return new() { ["k"] = "object", ["n"] = name, ["f"] = fields };
    }

    /// <summary>A message or enum by name as written in `from`: nested, same package, or fully qualified through imports.</summary>
    static (ProtoFile? File, string? Name) Find(IReadOnlyList<ProtoFile> protos, ProtoFile from, string type)
    {
        var bare = type.TrimStart('.');
        foreach (var file in protos.Where(p => p == from || from.Imports.Any(i => p.Path.EndsWith(i, StringComparison.Ordinal)) || p.Package == from.Package))
        {
            var local = file.Package != "" && bare.StartsWith(file.Package + ".", StringComparison.Ordinal) ? bare[(file.Package.Length + 1)..] : bare;
            if (file.Messages.ContainsKey(local) || file.Enums.ContainsKey(local)) return (file, local);
        }
        return (null, null);
    }

    /// <summary>Each .proto file is a declaration (its tokens, without comments) that depends on the files it imports.</summary>
    public static void AddDecls(Workspace ws, Graph graph)
    {
        foreach (var proto in ws.Protos)
        {
            var text = File.ReadAllText(Path.Combine(ws.Root, proto.Path));
            var hash = Decls.Short(string.Join("\0", Tokens(text)));
            graph.Add(new Decl(proto.Path, proto.Path, 1, Math.Max(1, text.Split('\n').Length), "proto", hash, hash));
            foreach (var imported in proto.Imports)
                foreach (var other in ws.Protos.Where(p => p.Path.EndsWith(imported, StringComparison.Ordinal))) graph.Edge(proto.Path, other.Path);
        }
    }

    /// <summary>The service a gRPC implementation derives from: `Greeter.GreeterBase` → Greeter.</summary>
    public static string? ServiceName(INamedTypeSymbol type)
    {
        foreach (var syntax in type.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<TypeDeclarationSyntax>())
            foreach (var b in syntax.BaseList?.Types ?? [])
            {
                var text = b.Type.ToString();
                var last = text.Split('.')[^1];
                if (last.EndsWith("Base", StringComparison.Ordinal) && last.Length > 4) return last[..^4];
            }
        return null;
    }
}
