using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Farol.CsHelper;

/// <summary>A declaration found in one compilation, with the syntax it covers (skip: spans that are other declarations).</summary>
public sealed record Found(Decl Decl, SyntaxNode Node, SemanticModel Model, List<TextSpan> Skip, INamedTypeSymbol? Type, string? SymbolKey);

/// <summary>
/// Collects the declarations of a syntax tree: each type part (header: modifiers, attributes, base list, fields,
/// auto-properties and members without a body), each member with a body, top-level statements, and each service
/// registration (`services.AddX(...)`) of startup code.
/// </summary>
public static class Decls
{
    public static string Key(ISymbol symbol) => symbol.OriginalDefinition.GetDocumentationCommentId() ?? symbol.ToDisplayString();

    static string IdOf(string key) => key.Length > 2 && key[1] == ':' ? key[2..] : key;

    public static List<Found> Collect(SyntaxTree tree, SemanticModel model, string file)
    {
        var found = new List<Found>();
        var root = (CompilationUnitSyntax)tree.GetRoot();
        var globals = root.Members.OfType<GlobalStatementSyntax>().ToList();
        if (globals.Count > 0)
        {
            var id = $"<top-level statements> @ {file}";
            var span = TextSpan.FromBounds(globals[0].SpanStart, globals[^1].Span.End);
            var registrations = Registrations(globals.Select(g => g.Statement), model, id, file, found);
            var node = globals[0].Parent!;
            found.Add(Make(id, file, node, span, "module", model, registrations, null, null));
        }
        foreach (var type in root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax).OfType<MemberDeclarationSyntax>())
        {
            if (type is not (BaseTypeDeclarationSyntax or DelegateDeclarationSyntax)) continue;
            if (model.GetDeclaredSymbol(type) is not INamedTypeSymbol symbol) continue;
            var key = Key(symbol);
            var partial = type is TypeDeclarationSyntax t && t.Modifiers.Any(SyntaxKind.PartialKeyword);
            var skip = new List<TextSpan>();
            if (type is TypeDeclarationSyntax typeDecl)
            {
                foreach (var member in typeDecl.Members)
                {
                    if (member is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax) { skip.Add(member.Span); continue; }
                    if (!HasBody(member) || model.GetDeclaredSymbol(member) is not ISymbol memberSymbol) continue;
                    skip.Add(member.Span);
                    var memberKey = Key(memberSymbol);
                    var memberId = IdOf(memberKey);
                    var registrations = IsRegistrationContainer(member, memberSymbol) && Body(member) is BlockSyntax block ? Registrations(block.Statements, model, memberId, file, found) : [];
                    var kind = member is BasePropertyDeclarationSyntax ? "property" : "method";
                    found.Add(Make(memberId, file, member, member.Span, kind, model, registrations, symbol, memberKey));
                }
            }
            found.Add(Make(partial ? $"{IdOf(key)} @ {file}" : IdOf(key), file, type, type.Span, "type", model, skip, symbol, key));
        }
        return found;
    }

    /// <summary>`hash` leaves out the spans of sub-declarations (members of a type, registrations); `core` also leaves out route registrations.</summary>
    static Found Make(string id, string file, SyntaxNode node, TextSpan span, string kind, SemanticModel model, List<TextSpan> skip, INamedTypeSymbol? type, string? key)
    {
        var lines = node.SyntaxTree.GetLineSpan(span);
        var routes = RouteStatements(node, span, skip);
        var hash = Hash(node, span, skip);
        var core = routes.Count == 0 ? hash : Hash(node, span, [.. skip, .. routes]);
        return new Found(new Decl(id, file, lines.StartLinePosition.Line + 1, lines.EndLinePosition.Line + 1, kind, hash, core), node, model, skip, type, key);
    }

    /// <summary>Members that are declarations of their own: they have code (a body or an expression body).</summary>
    public static bool HasBody(MemberDeclarationSyntax member) => member switch
    {
        BaseMethodDeclarationSyntax m => m.Body is not null || m.ExpressionBody is not null,
        PropertyDeclarationSyntax p => p.ExpressionBody is not null || (p.AccessorList?.Accessors.Any(a => a.Body is not null || a.ExpressionBody is not null) ?? false),
        IndexerDeclarationSyntax i => i.ExpressionBody is not null || (i.AccessorList?.Accessors.Any(a => a.Body is not null || a.ExpressionBody is not null) ?? false),
        EventDeclarationSyntax e => e.AccessorList?.Accessors.Any(a => a.Body is not null || a.ExpressionBody is not null) ?? false,
        _ => false,
    };

    static SyntaxNode? Body(MemberDeclarationSyntax member) => (member as BaseMethodDeclarationSyntax)?.Body;

    /// <summary>Startup code: ConfigureServices methods and IServiceCollection extension methods.</summary>
    static bool IsRegistrationContainer(MemberDeclarationSyntax member, ISymbol symbol) =>
        symbol is IMethodSymbol m && (m.Name == "ConfigureServices" || (m.IsExtensionMethod && m.Parameters.Length > 0 && m.Parameters[0].Type.Name == "IServiceCollection"));

    /// <summary>
    /// Each `services.AddX(...)` statement becomes a declaration of its own, so a new registration is additive while a
    /// changed or removed one is a change. Returns their spans (left out of the container's hash).
    /// </summary>
    static List<TextSpan> Registrations(IEnumerable<StatementSyntax> statements, SemanticModel model, string container, string file, List<Found> found)
    {
        var spans = new List<TextSpan>();
        var seen = new Dictionary<string, int>();
        foreach (var statement in statements)
        {
            if (statement is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax invocation } || !IsServiceRegistration(invocation, model)) continue;
            spans.Add(statement.Span);
            var text = Collapse(statement.ToString());
            if (text.Length > 120) text = text[..100] + "…" + Short(text);
            seen[text] = seen.GetValueOrDefault(text) + 1;
            var id = $"{container} | {text}{(seen[text] > 1 ? $" #{seen[text]}" : "")}";
            var lines = statement.SyntaxTree.GetLineSpan(statement.Span);
            var hash = Hash(statement, statement.Span, []);
            found.Add(new Found(new Decl(id, file, lines.StartLinePosition.Line + 1, lines.EndLinePosition.Line + 1, "registration", hash, hash), statement, model, [], null, null));
        }
        return spans;
    }

    static bool IsServiceRegistration(InvocationExpressionSyntax invocation, SemanticModel model)
    {
        if (invocation.Expression is not MemberAccessExpressionSyntax access || !access.Name.Identifier.ValueText.StartsWith("Add", StringComparison.Ordinal)) return false;
        var receiver = model.GetTypeInfo(access.Expression).Type;
        if (receiver is null or IErrorTypeSymbol) return access.Expression.ToString().EndsWith("ervices", StringComparison.Ordinal);
        return receiver.Name == "IServiceCollection" || receiver.AllInterfaces.Any(i => i.Name == "IServiceCollection");
    }

    /// <summary>Statements that register routes (`app.MapGet(...)`, `var api = app.MapGroup(...)`): compared entry by entry.</summary>
    public static List<TextSpan> RouteStatements(SyntaxNode node, TextSpan span, List<TextSpan> skip)
    {
        var spans = new List<TextSpan>();
        var skipped = new SpanSet(skip);
        foreach (var statement in node.DescendantNodes(span, n => !skipped.Covers(n.Span)).OfType<StatementSyntax>())
        {
            if (!span.Contains(statement.Span) || skipped.Covers(statement.Span)) continue;
            var expression = statement switch
            {
                ExpressionStatementSyntax e => e.Expression,
                LocalDeclarationStatementSyntax { Declaration.Variables.Count: 1 } l => l.Declaration.Variables[0].Initializer?.Value,
                _ => null,
            };
            if (expression is InvocationExpressionSyntax invocation && IsRouteCall(invocation)) spans.Add(statement.Span);
        }
        return spans;
    }

    static bool IsRouteCall(InvocationExpressionSyntax invocation)
    {
        for (ExpressionSyntax? e = invocation; e is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax access; e = access.Expression)
        {
            var name = access.Name.Identifier.ValueText;
            if (name.StartsWith("Map", StringComparison.Ordinal) && name != "MapControllers" && name != "MapRazorPages") return true;
        }
        return false;
    }

    /// <summary>
    /// Hash of the tokens of a span: comments and formatting do not count, preprocessor directives and the text of
    /// inactive #if branches do, so a change in code another configuration compiles still changes the declaration.
    /// </summary>
    public static string Hash(SyntaxNode node, TextSpan span, IReadOnlyList<TextSpan> skip)
    {
        var sb = new StringBuilder();
        var skipped = new SpanSet(skip);
        bool Skipped(TextSpan s) => !span.Contains(s) || skipped.Covers(s);
        // Every token is visited (skipped members too): the leading trivia of a member's first token holds the inactive
        // #if text between members, which belongs to the type.
        foreach (var token in node.DescendantTokens(span))
        {
            foreach (var trivia in token.LeadingTrivia) AddTrivia(sb, trivia, Skipped);
            if (!Skipped(token.Span)) sb.Append((int)token.Kind()).Append(':').Append(token.Text).Append('\0');
            foreach (var trivia in token.TrailingTrivia) AddTrivia(sb, trivia, Skipped);
        }
        return Short(sb.ToString());
    }

    static void AddTrivia(StringBuilder sb, SyntaxTrivia trivia, Func<TextSpan, bool> skipped)
    {
        if ((trivia.IsDirective || trivia.IsKind(SyntaxKind.DisabledTextTrivia)) && !skipped(trivia.Span)) sb.Append('#').Append(Collapse(trivia.ToString())).Append('\0');
    }

    public static string Collapse(string text) => string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    public static string Short(string text) => Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(text)))[..16].ToLowerInvariant();
}
