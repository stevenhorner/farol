using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;

namespace Farol.CsHelper;

/// <summary>What an endpoint receives and returns (src/contracts/types.ts): shapes are maps with exactly the keys of each kind.</summary>
public sealed record ContractOut(
    SortedDictionary<string, Dictionary<string, object?>> Params,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] Dictionary<string, object?>? Body,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] Dictionary<string, object?>? Response);

/// <summary>
/// Contracts of JSON endpoints ([ApiController] actions, minimal APIs) as System.Text.Json reads and writes them:
/// parameters by binding source, the body, and the success response. In a request a field is required only when it is
/// declared so (`required`, [Required]); in a response every field is present, and may be null when it is nullable.
/// </summary>
public static class Contracts
{
    const int MaxDepth = 8;
    static readonly string[] Skipped = ["CancellationToken", "HttpContext", "HttpRequest", "HttpResponse", "ClaimsPrincipal", "Stream", "PipeReader", "IFormCollection"];
    static readonly string[] Wrappers = ["Task", "ValueTask", "ActionResult", "Ok", "Created", "CreatedAtRoute", "Accepted", "AcceptedAtRoute", "JsonHttpResult"];

    static Dictionary<string, object?> Scalar(string n) => new() { ["k"] = "scalar", ["n"] = n };
    static Dictionary<string, object?> Unknown(string n) => new() { ["k"] = "unknown", ["n"] = n };
    public static Dictionary<string, object?> Field(Dictionary<string, object?> s, bool req, bool nullable) => new() { ["s"] = s, ["req"] = req, ["null"] = nullable };

    static bool Has(ISymbol s, string attribute) => s.GetAttributes().Any(a => a.AttributeClass?.Name is { } n && (n == attribute || n == attribute + "Attribute"));

    static string? AttributeName(ISymbol s, string attribute) => s.GetAttributes().Where(a => a.AttributeClass?.Name is { } n && (n == attribute || n == attribute + "Attribute"))
        .Select(a => a.NamedArguments.FirstOrDefault(n => n.Key == "Name").Value.Value as string ?? a.ConstructorArguments.FirstOrDefault().Value as string).FirstOrDefault();

    static bool Nullable(ITypeSymbol t) => t.NullableAnnotation == NullableAnnotation.Annotated || t.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T;

    static bool IsSimple(ITypeSymbol t)
    {
        if (t is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } n) t = n.TypeArguments[0];
        return t.SpecialType != SpecialType.None || t.TypeKind == TypeKind.Enum || t.Name is "Guid" or "DateTime" or "DateTimeOffset" or "DateOnly" or "TimeOnly" or "TimeSpan" or "Uri";
    }

    /// <summary>
    /// The contract of an action or a minimal API handler. `api`: [ApiController] rules (complex types from the body).
    /// `pathNames`: route parameters of the endpoint's template. `response`: the declared payload type, if any.
    /// </summary>
    public static ContractOut For(IMethodSymbol method, ISet<string> pathNames, bool bodyAllowed, ITypeSymbol? produces)
    {
        var parameters = new SortedDictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);
        Dictionary<string, object?>? body = null;
        foreach (var p in method.Parameters)
        {
            if (Has(p, "FromServices") || Has(p, "FromKeyedServices") || Skipped.Contains(p.Type.Name) || p.Type.TypeKind == TypeKind.Interface && !Has(p, "FromBody")) continue;
            var required = !p.IsOptional && !Nullable(p.Type) && !(p.Type.IsReferenceType && p.Type.NullableAnnotation == NullableAnnotation.None);
            var shaped = new Shaper(true).Shape(p.Type, 0);
            string? source = Has(p, "FromBody") ? "body" : Has(p, "FromQuery") ? "query" : Has(p, "FromRoute") ? "path" : Has(p, "FromHeader") ? "header" : Has(p, "FromForm") ? "form" : null;
            source ??= IsSimple(p.Type) ? (pathNames.Contains(p.Name) ? "path" : "query") : p.Type.Name == "IFormFile" ? "form" : bodyAllowed ? "body" : "query";
            if (source == "body") { body = Field(shaped, required, Nullable(p.Type)); continue; }
            var name = AttributeName(p, source switch { "query" => "FromQuery", "path" => "FromRoute", "header" => "FromHeader", _ => "FromForm" }) ?? p.Name;
            parameters[$"{source}:{name}"] = Field(shaped, required || source == "path", Nullable(p.Type));
        }
        var payload = produces ?? Payload(method.ReturnType);
        return new ContractOut(parameters, body, payload is null ? null : new Shaper(false).Shape(payload, 0));
    }

    /// <summary>The type a handler's return value serializes: Task, ActionResult and typed results unwrapped; null when not declared (IActionResult).</summary>
    static ITypeSymbol? Payload(ITypeSymbol t)
    {
        while (t is INamedTypeSymbol { IsGenericType: true } g && Wrappers.Contains(g.Name)) t = g.TypeArguments[0];
        if (t is INamedTypeSymbol { Name: "Results", IsGenericType: true } results)
            return results.TypeArguments.Select(Payload).FirstOrDefault(x => x is not null);
        if (t.SpecialType == SpecialType.System_Void || t.Name is "Task" or "ValueTask" or "IActionResult" or "ActionResult" or "IResult" or "IHttpActionResult" or "NotFound" or "NoContent" or "BadRequest" or "UnauthorizedHttpResult" or "ViewResult" or "RedirectToActionResult")
            return null;
        if (t.AllInterfaces.Any(i => i.Name is "IResult" or "IActionResult")) return null;
        return t;
    }

    /// <summary>The payload type an action declares with [ProducesResponseType(typeof(T), 200)] or [ProducesResponseType&lt;T&gt;(200)].</summary>
    public static ITypeSymbol? Produces(IMethodSymbol method)
    {
        foreach (var a in method.GetAttributes().Where(a => a.AttributeClass?.Name is "ProducesResponseTypeAttribute" or "ProducesResponseType"))
        {
            var status = a.ConstructorArguments.Select(c => c.Value).OfType<int>().FirstOrDefault(200);
            if (status is < 200 or > 299) continue;
            var type = a.AttributeClass?.TypeArguments.FirstOrDefault() ?? a.ConstructorArguments.Select(c => c.Value).OfType<ITypeSymbol>().FirstOrDefault();
            if (type is not null) return type;
        }
        return null;
    }

    /// <summary>Shapes of C# types; `input`: read from a request (fields required only when declared so).</summary>
    sealed class Shaper(bool input)
    {
        readonly HashSet<string> seen = new(StringComparer.Ordinal);

        public Dictionary<string, object?> Shape(ITypeSymbol t, int depth)
        {
            if (t is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } n) t = n.TypeArguments[0];
            if (depth > MaxDepth) return Unknown(t.ToDisplayString());
            switch (t.SpecialType)
            {
                case SpecialType.System_String or SpecialType.System_Char: return Scalar("string");
                case SpecialType.System_Boolean: return Scalar("bool");
                case SpecialType.System_Byte or SpecialType.System_SByte or SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64 or SpecialType.System_UInt64: return Scalar("int");
                case SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_Decimal: return Scalar("float");
                case SpecialType.System_Object: return Unknown("object");
            }
            if (t.TypeKind == TypeKind.Enum) return new() { ["k"] = "enum", ["n"] = t.Name, ["v"] = t.GetMembers().OfType<IFieldSymbol>().Where(f => f.HasConstantValue).Select(f => f.Name).OrderBy(x => x, StringComparer.Ordinal).ToList() };
            if (t is IErrorTypeSymbol || t.TypeKind is TypeKind.Dynamic or TypeKind.TypeParameter) return Unknown(t.ToDisplayString());
            if (IsSimple(t)) return Scalar(t.Name);
            if (t is IArrayTypeSymbol array) return new() { ["k"] = "list", ["of"] = Shape(array.ElementType, depth + 1) };
            var dictionary = t.AllInterfaces.Prepend(t as INamedTypeSymbol).FirstOrDefault(i => i is { IsGenericType: true, Name: "IDictionary" or "IReadOnlyDictionary" or "Dictionary" });
            if (dictionary is not null) return new() { ["k"] = "object", ["n"] = "map", ["f"] = new SortedDictionary<string, object?> { ["*"] = Field(Shape(dictionary.TypeArguments[^1], depth + 1), false, false) } };
            var enumerable = t.AllInterfaces.Prepend(t as INamedTypeSymbol).FirstOrDefault(i => i is { IsGenericType: true, Name: "IEnumerable" } && i.ContainingNamespace?.ToDisplayString() == "System.Collections.Generic");
            if (enumerable is not null) return new() { ["k"] = "list", ["of"] = Shape(enumerable.TypeArguments[0], depth + 1) };
            if (t.Name is "JsonElement" or "JsonNode" or "JsonObject" or "JsonDocument" or "IFormFile") return Unknown(t.Name);
            var name = t.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
            if (!seen.Add(name)) return new() { ["k"] = "ref", ["n"] = name };
            var fields = new SortedDictionary<string, object?>(StringComparer.Ordinal);
            foreach (var p in Properties(t))
            {
                if (Has(p, "JsonIgnore")) continue;
                var key = AttributeName(p, "JsonPropertyName") ?? JsonName(p.Name);
                var required = input ? p.IsRequired || Has(p, "Required") : true;
                fields[key] = Field(Shape(p.Type, depth + 1), required, Nullable(p.Type));
            }
            seen.Remove(name);
            return new() { ["k"] = "object", ["n"] = name, ["f"] = fields };
        }

        /// <summary>Public instance properties System.Text.Json reads (input: settable) or writes (output: readable), base classes included.</summary>
        IEnumerable<IPropertySymbol> Properties(ITypeSymbol t)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            for (var type = t; type is not null && type.SpecialType != SpecialType.System_Object; type = type.BaseType)
                foreach (var p in type.GetMembers().OfType<IPropertySymbol>())
                    if (!p.IsStatic && !p.IsIndexer && p.DeclaredAccessibility == Accessibility.Public && (input ? p.SetMethod is not null || IsCtorParameter(t, p.Name) : p.GetMethod is not null) && names.Add(p.Name)) yield return p;
        }

        static bool IsCtorParameter(ITypeSymbol t, string name) => t.GetMembers(".ctor").OfType<IMethodSymbol>().Any(c => c.Parameters.Any(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)));

        /// <summary>System.Text.Json's default web naming: camelCase.</summary>
        static string JsonName(string name) => name.Length == 0 ? name : char.ToLowerInvariant(name[0]) + name[1..];
    }
}
