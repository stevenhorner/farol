using System.Text.Json;
using System.Text.Json.Serialization;

namespace Farol.CsHelper;

/// <summary>One top-level declaration: a type part, a member with a body, top-level statements, a startup registration or a view.</summary>
public sealed record Decl(string Id, string File, int Line, int End, string Kind, string Hash, string Core);

/// <summary>An entry point: an HTTP endpoint, a background task or a program.</summary>
public sealed record Entry(string Key, string File, int Line, string Kind, int[] Anchors, string Inline, Computed[]? Computed, ContractOut? Contract);

public sealed record Computed(string File, int Line);

public sealed record Problem(string File, int Line, string Kind, string Detail);

public sealed record Comment(string File, int Line, string Text);

/// <summary>The JSON farol reads (src/decls/types.ts): the same shape as the Go and Python helpers print.</summary>
public sealed record Output(string Module, string[] Files, Decl[] Decls, int[][] Edges, Entry[] Entries, Problem[] Problems, Comment[] Comments);

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static void Write<T>(T value)
    {
        using var stdout = Console.OpenStandardOutput();
        JsonSerializer.Serialize(stdout, value, Options);
        stdout.WriteByte((byte)'\n');
    }
}
