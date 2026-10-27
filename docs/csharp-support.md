# Adding C#/.NET support — design proposal

Status: **phases 0 to 3 implemented** (see [how-it-works.md](how-it-works.md#cnet) for what farol does today,
and DECISIONS.md 2026-10-26 (9)–(11), 2026-10-27 and 2026-10-27 (2) for the choices made while building it). Phase 2 runs the SDK's Razor *source generator* through Roslyn's generator driver instead of the Razor
compiler API this document describes (that API changes between SDK versions). The
open questions of the first draft are decided (see [Decisions taken](#decisions-taken)). This document explains how farol could analyze C#/.NET backends
(ASP.NET Core MVC, Web API, minimal APIs, Razor Pages, SignalR, gRPC, worker services) with the same pipeline,
JSON contract and reports it already uses for Go and Python. Each choice below that is adopted needs its own dated
entry in [DECISIONS.md](DECISIONS.md) before the code lands, as the project rules require (new top-level module
`cs-helper/`, new configuration keys, new report formats).

- [Summary](#summary)
- [How Go and Python were added (the template)](#how-go-and-python-were-added-the-template)
- [What is different about C#/.NET](#what-is-different-about-cnet)
- [The C# helper (`cs-helper/`)](#the-c-helper-cs-helper)
- [Declarations and hashes](#declarations-and-hashes)
- [References (edges)](#references-edges)
- [Entry points](#entry-points)
- [Razor views](#razor-views)
- [Roles and default globs](#roles-and-default-globs)
- [Dependencies (NuGet)](#dependencies-nuget)
- [Signals](#signals)
- [Contracts](#contracts)
- [Changes on the TypeScript side](#changes-on-the-typescript-side)
- [Configuration](#configuration)
- [Tests](#tests)
- [CI and the GitHub Action](#ci-and-the-github-action)
- [Guarantees and how they hold for .NET](#guarantees-and-how-they-hold-for-net)
- [Known limits and fail-closed behavior](#known-limits-and-fail-closed-behavior)
- [Phased plan](#phased-plan)
- [Decisions taken](#decisions-taken)

## Summary

It is feasible, and most of farol does not need to change. Go and Python support were built as a **helper program
in the target language** that prints one JSON shape (`DeclHelperSchema`, `src/decls/types.ts`); everything after
that (impact, reach, classification, risk score, verdict, reports) is language-neutral. C# fits the same model:

| Piece | Go | Python | C# (proposed) |
|---|---|---|---|
| Helper | `go-helper/` (Go stdlib: `go/parser`, `go/types`) | `py-helper/` (Python stdlib: `ast`) | `cs-helper/` (.NET console app on **Roslyn**, the C# compiler API) |
| Built/run with | `go build`, cached by source hash | `python3 -I` | `dotnet build`, cached by source hash + SDK version |
| Type information | full (`go/types`) | local inference | full semantic model (Roslyn `SemanticModel`) |
| Entry points | chi, gin, echo, net/http, gRPC, `main` | FastAPI, Flask, Django, MCP, Celery, Temporal, Prefect, scripts | MVC controllers (conventional + attribute routes), minimal APIs, Razor Pages, SignalR hubs, gRPC services, hosted services, `Main`/top-level statements |
| Manifest / lockfile | `go.mod` / `go.sum` | `pyproject.toml`, `requirements.txt` / `uv.lock`… | `*.csproj`, `Directory.Packages.props` / `packages.lock.json` |
| Coverage | coverprofile | coverage.py JSON | coverlet JSON (and Cobertura XML) |
| Lint / security | golangci-lint JSON (gosec) | ruff JSON (`S` rules) | SARIF (Roslyn analyzers, `CA*`/`SCS*` security rules) |
| Vulnerabilities | govulncheck | pip-audit | `dotnet list package --vulnerable --format json` |

Roslyn is the only reliable reader of C#, exactly as `go/types` is for Go, and the spec's rule "use the compiler's
own API, no regex/tree-sitter" points at it directly. C# has a richer type system than Python, so references can be
resolved more precisely than in the Python helper; the hard parts are elsewhere: **conventional (string-based)
routing, Razor views, dependency injection through interfaces, partial classes, conditional compilation and
MSBuild**. Each has a fail-closed answer below.

## How Go and Python were added (the template)

Reading the existing code, a new language touches these places:

1. **Helper** (`go-helper/`, `py-helper/`): reads an exported git tree and prints `DeclHelperSchema` JSON:
   `module`, `files`, `decls` (id, file, line, end, kind, `hash`, `core`), `edges` (`[from, to]` indices),
   `entries` (key, file, line, kind `http|ws|rpc|tool|task|main`, `anchors`, `inline`, optional `contract`,
   `computed`), `problems` (`type-error|parse-error|dynamic-route`) and `comments` (for suppressions).
2. **`src/cli/lang-workspace.ts`**: builds or locates the helper (`goHelperBinary`, `runPythonHelper`), runs it on
   base and head trees (`readTree`, cached by git tree hash), and returns `LangWorkspace` via
   `declImpacts`/`declImportGraph`/`declRouteTable` from `src/decls/impact.ts`.
3. **`src/config/schema.ts`**: `language` enum, per-language default roles and excludes, the "must be a backend"
   check.
4. **`src/classify/dependencies.ts`** plus a language module (`src/golang/gomod.ts`, `src/python/pyproject.ts`):
   manifest parsing and `ECOSYSTEM_FILES`, `MANIFESTS`, `LOCKFILES`.
5. **`src/signals/`** (`go.ts`, `python.ts`): coverage, lint, security and audit formats; suppressions read from the
   helper's `comments`.
6. **`src/cli/analyze.ts`, `signals.ts`, `routes.ts`, `impact.ts`**: a few `language === 'go' ? … : …` branches.
7. **Report**: syntax highlighting table in `src/report/html-assets.ts` (generated by `scripts/embed-assets.mjs`).
8. **Tests**: `test/scenarios/<lang>.test.ts` with fixtures `_base-<lang>` and `<letter><n>-<name>`, golden
   `expected.json`.
9. **Docs**: `how-it-works.md`, `reasons.md`, `reference.md`, `DECISIONS.md`, `README.md`, `examples/`.

C# follows the same nine steps. The rest of this document is about what each step needs.

## What is different about C#/.NET

Things a typical ASP.NET Core application does that Go and Python projects in farol's test set do not:

- **Conventional routing.** Many MVC apps declare one or two patterns in startup code
  (`MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}")`) and every public method of every
  controller becomes an endpoint by naming convention, with no route string next to the method. Attribute routing
  (`[Route]`, `[HttpGet("x")]`) is often mixed in.
- **Server-rendered views.** Actions `return View()`, and the view is found by convention
  (`Views/<Controller>/<Action>.cshtml`, then `Views/Shared/`). Views contain C# code, use layouts, partials, view
  components, tag helpers and `@inject`. A change to a `.cshtml` file is a change to what an endpoint does.
- **Dependency injection through interfaces.** Controllers receive `IFooService` in their constructor; the concrete
  class is chosen in `Program.cs`/`Startup.cs`. A call to an interface method must reach every implementation in the
  project, as farol already does for Go interfaces.
- **Inheritance-heavy code.** A shared base controller, base classes with virtual methods, framework overrides
  (`OnActionExecuting`, `ExecuteAsync`, `Dispose`) that only the framework calls.
- **Partial classes.** One class spread over many files, sometimes by hand, sometimes by generated code
  (`*.Designer.cs`, source generators).
- **Conditional compilation.** `#if`/`#else` blocks driven by `DefineConstants`, which can differ per build
  configuration (`Debug`, `Release`, or custom product editions). Code inside an inactive branch is not parsed into a
  syntax tree, but it is still code someone ships.
- **MSBuild.** Projects are `.csproj` XML files evaluated by MSBuild, which can import other files
  (`Directory.Build.props/.targets`), run custom targets and pull build logic from NuGet packages. Evaluating them is
  executing code.
- **Solutions with several projects.** A `.sln`/`.slnx` with a web project, class libraries and test projects that
  reference each other through `ProjectReference`.
- **Mixed assets.** `wwwroot/` JavaScript and CSS, resource files (`.resx`), configuration (`appsettings*.json`,
  `web.config`) and SQL scripts usually live in the same repository.

## The C# helper (`cs-helper/`)

A .NET console application, new top-level module `cs-helper/` (DECISIONS entry required), with the same command
line contract as `go-helper`:

```
cshelper analyze --root <dir> --project <rel> [--comments a.cs,b.cs] [--configuration <name>] [--define SYM ...]
cshelper manifest <file>          # .csproj / Directory.Packages.props / packages.lock.json → JSON (stdin or path)
cshelper resx                     # .resx → JSON {key: value}, for the i18n additive rule
cshelper cobertura                # Cobertura XML coverage → farol's coverage JSON (optional, see Signals)
```

### Reading the code without MSBuild

**Do not use `MSBuildWorkspace`** (`Microsoft.CodeAnalysis.Workspaces.MSBuild`) or a design-time build. They run
MSBuild targets of the analyzed repository and of its NuGet packages, which breaks farol's rule "never execute code of
the analyzed repo". Instead the helper builds a `CSharpCompilation` by hand:

1. **Find projects.** Every `*.csproj` under `--project` (or the ones listed in a `.sln`/`.slnx` there, or the
   `csharp.projects` globs). Test projects are left out (see [Roles](#roles-and-default-globs)): tests are not
   callers, as in the TypeScript spec.
2. **Read each `.csproj` as XML data** with `System.Xml` (no evaluation). Read only what the compiler needs:
   - `Sdk` (`Microsoft.NET.Sdk`, `.Web`, `.Worker`, `.Razor`…), `TargetFramework(s)`, `LangVersion`, `Nullable`,
     `ImplicitUsings`, `RootNamespace`, `AllowUnsafeBlocks`;
   - `DefineConstants`, including `PropertyGroup Condition="'$(Configuration)|$(Platform)'=='X|AnyCPU'"` blocks,
     matched only by this literal and common shape; any other condition is reported as a `type-error` problem on the
     `.csproj` and the condition is ignored (fail closed: the PR stays `unknown` only if that project file changed);
   - `Compile Include/Remove`, `EnableDefaultCompileItems`, `Content`/`None` items for `.cshtml`;
   - `ProjectReference` (projects become `CompilationReference`s of each other) and `PackageReference`;
   - `Using` items and the SDK's implicit usings (a fixed table per SDK kind, as the SDK defines them).
   - `Directory.Build.props` above the project is read the same way (literal properties only); anything it cannot
     read is a problem, as above.
3. **Collect sources** with the SDK's default globs (`**/*.cs` minus `bin/`, `obj/`, and other projects'
   directories), applying `Compile Remove`.
4. **References.**
   - **Framework:** reference assemblies from the installed SDK's targeting packs
     (`<dotnet>/packs/Microsoft.NETCore.App.Ref/<ver>/ref/<tfm>/*.dll`, plus `Microsoft.AspNetCore.App.Ref` for the
     Web SDK). These are metadata-only assemblies shipped with the SDK: reading them runs nothing.
   - **NuGet packages:** when the workflow ran `dotnet restore` before farol (as Go needs `go mod download`), read the
     resolved package list from `obj/project.assets.json` of the checkout and load the `ref/` or `lib/` assemblies from
     the NuGet global packages folder as metadata. When they are missing, the helper still runs: farol needs edges
     **between project declarations**, and Roslyn resolves those even when external types are error types. Missing
     package references are noted once in diagnostics, not as problems per file.
   - Analyzers and source generators listed by packages are **never loaded** (they are code).
5. **Parse** each file with `CSharpParseOptions(languageVersion, preprocessorSymbols)` and create one compilation per
   project, in `ProjectReference` order.

### Building the helper offline

`goHelperBinary()` builds `go-helper` with the local toolchain; the C# helper is built with `dotnet build` the same
way, keyed by `sourceHash(cs-helper/)`, `dotnet --version` and the platform, into `~/.cache/farol/cs-helper/<key>`.

The helper needs Roslyn (`Microsoft.CodeAnalysis.CSharp`), which is not in the base class library, unlike the Go and
Python helpers' standard-library rule. Two options for the DECISIONS entry:

| Option | Pros | Cons |
|---|---|---|
| **A. Reference the Roslyn assemblies the SDK ships** (`<sdk>/Roslyn/bincore/Microsoft.CodeAnalysis*.dll`) via `<Reference HintPath>` resolved at build time from `dotnet --list-sdks` | no download, no NuGet restore, works offline like Go's `GOPROXY=off`; Roslyn version matches the SDK the project builds with | relies on the SDK's internal layout (stable since .NET Core 2, but not a public contract); helper code must compile against several Roslyn versions |
| **B. `PackageReference` to a pinned `Microsoft.CodeAnalysis.CSharp`** | public, versioned API; one known Roslyn version | first build needs network (or a pre-filled NuGet cache in CI); a pinned Roslyn may not know the newest C# version the project uses |

**Decided: A**, with a clear error message when the folder is not found (same style as
`missingTool(...)`: "the .NET SDK (dotnet) is required to analyze a C# project"). Same for the Razor compiler
(`<sdk>/Sdks/Microsoft.NET.Sdk.Razor/source-generators/`) in phase 2.

Environment for every `dotnet` call: `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1` and
`DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1`. The helper's own build still runs a restore, but a project with no
`PackageReference` restores offline from the SDK's own packs, so no network is needed.

## Declarations and hashes

Mapping to `decls` (one entry per declaration, `id` = `<file>#<Namespace.Type.Member>`):

| C# construct | `kind` | Hash covers |
|---|---|---|
| class / record / struct / interface (each **partial part** separately) | `type` | header (modifiers, base list, type parameters, constraints, attributes) + fields, auto-properties, events, constants and nested-type headers; not method bodies |
| method, constructor, destructor, operator, conversion | `method` | the whole member, attributes included |
| property / indexer with accessor bodies | `method` | the whole member |
| field with initializer, `const` | `var` | type + value (like Go constants: appending an enum member does not change the others; reordering does when values are implicit) |
| enum | `type` | each member's name and value |
| delegate | `type` | signature |
| top-level statements (`Program.cs` without a class) | `module` | all statements |
| static constructor / module initializer | `module` | the body; every declaration of the type depends on it |

- **Token hash, without trivia:** walk `node.DescendantTokens()` and hash `Kind` + `ValueText`. Comments,
  whitespace and `///` XML docs are trivia, so they do not count.
- **Conditional compilation:** inactive `#if` branches are `DisabledTextTrivia`. Unlike comments, **they are
  included in the hash** (with the directive trivia), so a change inside `#if SOME_EDITION` still counts as a change
  to that declaration even when the analyzed configuration does not compile it. Edges come only from active code,
  so the helper compiles **every build configuration** and unions the edges: see
  [Build configurations](#build-configurations).
- **`core` hash:** the same as `hash` minus route attributes (`[Route]`, `[HttpGet("…")]`, `[ActionName]`,
  `[Area]`) and minus minimal-API `Map*` registration calls, so a route template change is compared route by route
  (added/removed entry), not as a changed method. Same idea as Go's core hash.
- **Partial classes:** each part is its own `type` declaration in its own file; edges to "the class" go to every
  part. Generated parts (`*.g.cs`, `*.Designer.cs`) are excluded by default.

## Build configurations

**Decided: every configuration by default.** Analyzing only `Debug` is not enough:

- `Debug` compiles the `#if DEBUG` branches and the symbols only `Debug` defines. It never compiles `#if !DEBUG` or
  `#else` code (production-only behavior such as error pages, caching or HTTPS settings), nor code behind symbols that
  only other configurations define (product editions, platform builds).
- Changes in that code are **still detected**, because disabled text is part of each declaration's hash.
- What is lost are **edges**. If only `Release` code calls `ServiceX`, a `Debug`-only analysis cannot see any entry
  point reaching `ServiceX`: its risk is underestimated. Worse, a *new* file used only from such code would look
  disconnected and the PR could be `isolated`, which breaks the fail-closed rule.

How the helper does it:

1. **Symbol sets.** For each project, take the `Debug` and `Release` configurations the SDK always has
   (`DEBUG;TRACE` and `TRACE`), plus every configuration named in `<Configurations>` or in a
   `'$(Configuration)|$(Platform)'=='X|…'` condition, with the `DefineConstants` each one sets (the SDK's
   `$(DefineConstants)` inheritance and `;`/`,` separators respected), plus the target framework symbols (`NET`,
   `NET10_0`, `NET10_0_OR_GREATER`, …) and `csharp.defines`.
2. **Deduplicate.** Configurations with the same symbol set are compiled once; most solutions have two to four
   distinct sets.
3. **Union.** Declarations and hashes are the same in every set (disabled text is hashed), so they are read once.
   Edges and entry points are the union over all sets; an entry point that exists only in some configurations is
   still an entry point.
4. **Cost.** Parsing is per set (cheap), binding is per set (the main cost, parallel per syntax tree). The tree-hash
   cache keeps base trees free on later runs. `csharp.configurations` narrows the list when a solution has many
   identical-looking editions and analysis time matters.

## References (edges)

For every declaration, walk its syntax and ask the `SemanticModel` for the symbol of each `IdentifierName`,
`MemberAccessExpression`, `ObjectCreationExpression`, `InvocationExpression`, attribute and `typeof`/`nameof`. Keep
symbols whose `DeclaringSyntaxReferences` are in the project and add an edge to their declaration(s).

Rules, mostly carried over from the Go helper:

- **Interfaces and DI.** A call through an interface (or an abstract/virtual member) reaches **every project
  implementation/override** (`SymbolFinder`-style search done once per compilation:
  `FindImplementationForInterfaceMember` over all project types). This is what makes constructor-injected services
  work without reading the DI container.
- **Library-called members.** A member only the framework calls depends on its type, not the other way round:
  overrides of framework virtuals (`OnActionExecuting`, `ExecuteAsync`, `Dispose`, `ToString`, `Equals`,
  `GetHashCode`), interface implementations of framework interfaces (`IActionFilter`, `IHostedService`,
  `IMiddleware`, `IValidatableObject`…), and members with no caller in the project. As in Go, calling `ToString()`
  through `object` must not reach every `ToString` of the project.
- **Attributes are uses.** `[MyFilter]` on an action creates an edge from the action to the attribute class
  (and its methods that the framework calls), so a changed action filter reaches every action it decorates.
- **Inheritance.** A type depends on its base type and interfaces (header hash already covers the base list). A
  base controller's virtual/override members reach every derived controller's actions.
- **Extension methods, generics, lambdas, local functions** resolve through the semantic model with no special
  handling.
- **Unresolved and ambiguous symbols** (missing references, `dynamic`, overload failures): use
  `SymbolInfo.CandidateSymbols`; with none, fall back to **every project member with that name** (the Python
  helper's conservative rule). `dynamic` receivers always use the name fallback.
- **Reflection and strings** (`Activator.CreateInstance`, `Type.GetType("…")`, `nameof` is fine) are not followed;
  `nameof(X)` creates an edge to `X` since it is resolved by the compiler.
- **Type-only uses.** Unlike TypeScript, C# types are not erased: a type used only in a signature still exists at run
  time, and changing a record's properties changes serialization. Keep edges for type uses (as the Go helper does).

## Entry points

Each becomes an `entries[]` item. Keys follow the existing style (`GET /path`, `WS /hub`, `RPC pkg.Service/Method`,
`TASK name`, `RUN <project>`).

### MVC and Web API controllers

A **controller** is a public, non-abstract class that derives (directly or not) from
`Microsoft.AspNetCore.Mvc.ControllerBase`, or has `[Controller]`/`[ApiController]`, or whose name ends in
`Controller` (ASP.NET's own rule), and has no `[NonController]`. Its **actions** are public, non-static,
non-generic instance methods without `[NonAction]`, including inherited public methods.

**Attribute routes:** combine `[Route]` on the class and on the method, verb attributes
(`[HttpGet("x/{id}")]`, `[HttpPost]`, `[AcceptVerbs]`), `[controller]`/`[action]`/`[area]` tokens, `~/` and `/`
overrides, `[Area("X")]`, `[ActionName("X")]`. Templates are read with the semantic model's constant value
(`GetConstantValue`), so `const` strings and `nameof` work. A template that is not a constant is kept as `{expr}` with
`computed` set, exactly like Go's computed paths.

**Conventional routes:** the helper reads the `MapControllerRoute`/`MapDefaultControllerRoute`/
`MapAreaControllerRoute` calls in the startup code (`Program.cs`, `Startup.Configure`, `UseEndpoints` lambdas) with
constant `pattern`, `defaults` and `name` arguments. Every action of a controller **without attribute routes** gets
one entry per pattern, e.g. pattern `{controller=Home}/{action=Index}/{id?}` gives `GET /Orders/Edit/{id?}` for
`OrdersController.Edit` marked `[HttpGet]`, or `ANY /Orders/Edit/{id?}` when no verb attribute is present (the
`ANY` method already exists for Go). Patterns that are not constants are a `dynamic-route` problem on the startup
file, which makes the PR `unknown` only when it changes that file (same rule as Go and Python).

**Anchors** of an action entry: the action method, its controller's `type` declaration(s) (constructor,
fields: DI dependencies), base controller types, filter attributes on the action/controller, global filters
registered in startup (`options.Filters.Add<…>()`), and the views it renders ([Razor views](#razor-views)).

### Minimal APIs

`app.MapGet/MapPost/MapPut/MapDelete/MapPatch/MapMethods/Map(pattern, handler)` and `MapGroup(prefix)` (including
groups assigned to variables and passed to extension methods, which the Go helper already handles for chi and gin).
Lambda handlers are `inline` hashes; method-group handlers are anchors. Endpoint filters (`AddEndpointFilter<T>`) and
`RequireAuthorization` policies are anchors.

### Razor Pages

Every `.cshtml` with `@page` under `Pages/` (or the configured root) is a route: `Pages/Orders/Edit.cshtml` with
`@page "{id:int}"` → `ANY /Orders/Edit/{id:int}`; `Index` maps to its folder. Anchors: the page model class
(`@model`, code-behind `Edit.cshtml.cs`), its `OnGet`/`OnPost[Handler][Async]` methods (as verbs), `_Layout`,
`_ViewStart`, `_ViewImports`.

### SignalR hubs

`MapHub<THub>("/path")`: one entry per public hub method, `WS /path#Method`, kind `ws`, anchored on that method and
the hub type. Strongly typed client interfaces (`Hub<IClient>`) are uses of the interface.

### gRPC

`MapGrpcService<TService>()`: each overridden method of the generated base class becomes
`RPC <package>.<Service>/<Method>`. The generated base comes from `.proto` files through a source generator the
helper does not run, so the helper reads the `.proto` files listed in `<Protobuf Include>` instead (or treats each
`override` of the service class as a method). Done in phase 3: the `.proto` files of each project are read (they
need not be listed in `<Protobuf Include>`).

### Background work

- `AddHostedService<T>()` registrations and classes deriving from `BackgroundService` or implementing
  `IHostedService`: `TASK <Type>`, kind `task`, anchored on `ExecuteAsync`/`StartAsync`/`StopAsync`.
- Timers and job libraries (Hangfire `RecurringJob.AddOrUpdate`, Quartz `IJob`) can be added like Celery and
  Prefect were for Python, framework by framework.
- Project-specific schedulers (a custom `RunPeriodically(...)` helper) are not knowable in general. Proposed:
  `csharp.entryCalls` (see [Configuration](#configuration)), a list of fully qualified methods whose delegate
  arguments become `TASK` entries.

### Startup, middleware and programs

- Each executable project (`OutputType` `Exe`, Web/Worker SDK) with no route becomes `RUN <project dir>`.
- **Startup code** (`Program.cs` top-level statements, `Startup.ConfigureServices`/`Configure`) and every
  middleware class registered with `UseMiddleware<T>`/`app.Use(...)` are anchors of **every** entry of that
  project, like the Python app module's import-time code. A change there reaches all routes, which is the right
  risk signal for a DI registration or a middleware change.

## Razor views

Views are where a .NET MVC app differs most from the languages farol already supports. Proposed in two steps.

### Phase 1: convention mapping (no Razor compiler)

- Each `.cshtml` file is one declaration (`kind: "view"`), hashed on its text with Razor comments `@* … *@` and
  whitespace runs removed.
- **Action → view edges** from the action's `View()`/`PartialView()`/`ViewComponent` calls:
  - `View()` with no name → `Views/<Controller>/<Action>.cshtml`, then `Views/Shared/<Action>.cshtml` (areas:
    `Areas/<Area>/Views/...` first);
  - `View("Name")` with a constant → the same lookup with `Name`; a path (`"~/Views/X/Y.cshtml"`) → that file;
  - a name that is not a constant → edges to **every** view of the controller's folder and `Shared/` (fail closed,
    reported as info in diagnostics, not as `unknown`).
- **Layouts and imports:** `_ViewStart.cshtml`, `_ViewImports.cshtml` and the layout they name apply to every view
  in their folder and below. Since the helper cannot read which layout a view picks at run time in general, a change
  to any `_Layout*.cshtml`, `_ViewStart` or `_ViewImports` reaches every action that renders a view in scope.
- **Partials and view components inside views** cannot be read without parsing Razor; in phase 1 every partial
  (`_*.cshtml` and `Views/Shared/**`) is treated as used by every view in scope. That is conservative and noisy;
  phase 2 removes the noise. **Decided:** this over-approximation is accepted for phase 1.
- C# code inside views (`@model`, `@inject`, `@{ … }`) creates no edges in phase 1, so a changed service used only
  from a view would look unreachable (`existing-file-unreachable`, still `touches-existing`, never `isolated`).

### Phase 2: Razor compiler

Use the Razor compiler that the SDK ships (`Microsoft.AspNetCore.Razor.Language` / `Microsoft.CodeAnalysis.Razor`
from `Sdks/Microsoft.NET.Sdk.Razor`), which is Microsoft's code, not the analyzed repository's, to turn each
`.cshtml` into its generated C# class in memory, add it to the compilation, and map generated spans back to `.cshtml`
lines with the Razor source mappings. Then:

- views get real edges: model types, `@inject` services, static helpers, tag helpers (`TagHelper` classes are
  types in the project), view components (`Component.InvokeAsync("Name")`, `<vc:name>`);
- partial names (`<partial name="X">`, `Html.PartialAsync("X")`) are read as constant arguments, replacing the
  phase 1 "all partials" rule;
- Blazor `.razor` components become possible the same way (each `@page` component is an entry).

## Roles and default globs

Proposed `CSHARP_DEFAULT_ROLES` in `src/config/schema.ts`, overridable key by key like the other languages:

| Role | Default globs | Why |
|---|---|---|
| `test` | `**/*.Tests/**`, `**/*.Test/**`, `**/*.UnitTests/**`, `**/*.IntegrationTests/**`, `**/test/**`, `**/tests/**`, `**/*Tests.cs`, `**/*Test.cs` | test projects and files; also any project whose `.csproj` references `Microsoft.NET.Test.Sdk` (the helper reports those directories in its output so the role can be assigned without a glob) |
| `global` | `**/Directory.Build.props`, `**/Directory.Build.targets`, `**/global.json`, `**/NuGet.config`, `**/nuget.config`, `**/.editorconfig`* | they change how every project builds (MSBuild code, SDK version, package sources, analyzer severities) |
| `i18n` | `**/*.resx` (not `*.Designer.cs`) | resource strings: additive when only keys are added, via `cshelper resx` + the existing deep comparison |
| `infra` | the existing `DEFAULT_INFRA` plus `**/appsettings*.json`, `**/web.config`, `**/launchSettings.json`, `**/*.pubxml`, **`**/*.sql`** | configuration, deployment and database scripts |
| `client` (new role) | **`**/wwwroot/**`** minus vendored and built files (see below) | browser code and styles served by the app |
| `barrel` | none | C# has no barrels |
| `story` | none | |

\* `.editorconfig` only when it changes analyzer severities; otherwise it is formatting. Proposed: `global` by
default, documented, overridable.

Default `exclude`: `**/bin/**`, `**/obj/**`, `**/*.g.cs`, `**/*.g.i.cs`, `**/*.Designer.cs`,
`**/*.AssemblyInfo.cs`, `**/Migrations/*.Designer.cs`, `**/*ModelSnapshot.cs` (generated EF Core files; the
migration itself stays source), `**/wwwroot/lib/**` (vendored client libraries).

### SQL scripts (decided: included)

`**/*.sql` is in the C# default `roles.infra`, so any added, modified or deleted SQL script makes the PR
`touches-existing` (`infra-file-changed`) and appears in the infra section of the reports. Database scripts ship with
the app but no entry point calls them, which is what the `infra` role means.

Phase 2 adds a **destructive statement check** on the added lines of SQL files, read with a small SQL tokenizer in the
helper (so comments and string literals are skipped, not regex): `DROP TABLE/COLUMN/INDEX/PROCEDURE/VIEW`,
`TRUNCATE`, `ALTER … DROP`, `DELETE`/`UPDATE` without `WHERE`, `ALTER COLUMN` type changes, `sp_rename`. Each is a
security-style finding (medium; `DROP TABLE`/`TRUNCATE` high), which adds weight to the score and makes the verdict
careful. EF Core migration classes (`Migrations/*.cs`) are C# source, read by the helper like any other file.

### Client files under `wwwroot` (decided: included)

The C# helper does not read JavaScript or CSS, but changing an existing script that every page loads is a change to
existing code. A new role, **`client`** (DECISIONS entry, new value in the output schema's role enum and the report
strings), handles them:

- **Default globs:** `**/wwwroot/**`, minus `**/wwwroot/lib/**` (vendored libraries; their changes come through
  `libman.json`/`package.json`, which keep their own roles), `**/*.min.js`, `**/*.min.css`, `**/*.map` and other
  build outputs the configuration lists in `exclude` (bundles generated by an npm or Tailwind build should be
  excluded and their *sources* added to `roles.client`, e.g. `Scripts/**`, `Styles/**`).
- **Classification:** an existing client file modified, deleted or renamed → `touches-existing`, new reason
  `client-file-changed` (file = the client file). A new client file → `client-file-added` (info). Images, fonts and
  other binary assets are `client` too but never weigh in the score.
- **Score:** a modified or deleted script or stylesheet weighs `0.05` (deleted `0.1`), all client files together at
  most `0.25`, times the usual coverage factor when a JavaScript coverage report covers them (otherwise 1).
- **Reach (phase 2):** with the Razor compiler, constant `<script src="~/js/x.js">`, `<link href="~/css/y.css">`
  and `asp-src-include` paths in views create edges from the view to the client file. A changed client file then
  reaches the actions that render it (through layouts, every page), gets a normal risk level and replaces the flat
  weight above. Files no view references keep the flat weight.
- **Lint and security:** ESLint JSON is already a supported lint format; for client files of a C# project farol reads
  it alongside the SARIF report (both can be given). The TypeScript built-in security rules (`innerHTML`, `eval`,
  `document.write`, `postMessage(…, "*")`, token formats) run on added lines of client `.js`/`.ts` files with the
  TypeScript scanner, as they do for TypeScript projects.

A TypeScript or React frontend that lives in the same repository outside `wwwroot` (its own `package.json` and
`tsconfig.json`) is still better served by its own farol config, as monorepos already do.

## Dependencies (NuGet)

New entries in `MANIFESTS`, `LOCKFILES` and `ECOSYSTEM_FILES.csharp`, and a module `src/dotnet/` (pure, like
`src/golang/gomod.ts`; DECISIONS entry for the new module name). XML is parsed by `cshelper manifest` (Node has no XML
parser and farol must not add one without a decision, the same reason `readToml` delegates to the Python helper).

- **Manifests:** `*.csproj` (`PackageReference Include/Version`, `VersionOverride`), `Directory.Packages.props`
  (Central Package Management: `PackageVersion`), legacy `packages.config`.
- **Lockfile:** `packages.lock.json` (when `RestorePackagesWithLockFile` is on).
- **Sections:** `PackageReference` (runtime) and `PrivateAssets="all"` / analyzers (dev, like `devDependencies`).
- **Versions:** NuGet ranges (`1.2.3` means `>= 1.2.3`, `[1.0,2.0)`, floating `1.*`) compared on their lowest
  version, reusing the existing semver bump logic. Floating versions are "cannot be compared" → critical, as for git
  URLs in npm.
- **Critical (global):** removed package, major bump, downgrade, `TargetFramework(s)` change, `LangVersion` change,
  `Sdk` change, `global.json` SDK version change (like Go's `go`/`toolchain` directives), lockfile changed without a
  manifest change.
- **Other `.csproj` changes** (new `Compile Remove`, `DefineConstants`, `Nullable`, `TreatWarningsAsErrors`, custom
  targets): `manifest-changed` (global), as for npm's non-dependency fields. Adding a `ProjectReference` is a
  dependency change on another project of the repo, not critical.

## Signals

| Signal | Proposed input | Notes |
|---|---|---|
| Diff coverage | **coverlet JSON** (`--collect:"XPlat Code Coverage;Format=json"` or `/p:CoverletOutputFormat=json`) | JSON, so no XML parser on the TS side: `module → file → class → method → Lines {n: hits}`. A line listed is executable; covered when hits > 0. Several test projects' files are merged like Go coverprofiles. |
| | Cobertura XML (optional) | the default coverlet/ReportGenerator output; converted to the coverlet shape by `cshelper cobertura`. Also useful for other languages later. |
| Lint | **SARIF 2.1** (`<ErrorLog>lint.sarif,version=2.1</ErrorLog>` in the build, or `dotnet build -p:ErrorLog=…`) | Roslyn analyzers (CA, IDE, StyleCop, any analyzer package) all write SARIF. SARIF is JSON and generic (CodeQL and Semgrep write it too), so this parser could serve every language. |
| Security | SARIF results whose rule ids are security rules: `CA2100`, `CA3001`–`CA3012`, `CA5350`–`CA5405` (.NET analyzers), `SCS*` (Security Code Scan) | mapped to high/medium/low by rule, as gosec and ruff `S` are today |
| Built-in security rules on added lines | `Html.Raw(`, `@Html.Raw`, `new HtmlString(`, `FromSqlRaw`/`ExecuteSqlRaw` with interpolation or concatenation, SQL text built by concatenation passed to `SqlCommand`/data-access `Query*`/`Execute*` methods, `BinaryFormatter`, `[AllowAnonymous]` added, `[IgnoreAntiforgeryToken]` added, `ValidateAntiForgeryToken` removed, secrets in `appsettings*.json` | detected by the helper on the syntax tree of changed files (not regex): it can report them in its output as findings with file and line, so strings and comments are not matched |
| Suppressions | `#pragma warning disable`, `[SuppressMessage]`, `[ExcludeFromCodeCoverage]`, `#nullable disable`, `// ReSharper disable`, the null-forgiving `!` operator (C#'s `as any`) | pragmas and comments come through `comments`; `!` and attributes need a small helper output addition (a `suppressions` list, or synthetic comment entries) |
| Vulnerabilities | `dotnet list package --vulnerable --include-transitive --format json` | JSON since .NET 8; direct vs transitive is in the report; severities map 1:1 |
| Modified tests | unchanged | role-based, language neutral |

## Contracts

For JSON APIs (`[ApiController]`, minimal APIs), the helper can describe each endpoint's request and response as
`ContractSchema` shapes, like FastAPI and Go handlers:

- **Request:** action parameters by binding source (`[FromBody]`, `[FromQuery]`, `[FromRoute]`, `[FromHeader]`,
  `[FromForm]`, `[FromServices]` skipped; complex types default to body in `[ApiController]`), required when
  non-nullable without default or with `[Required]`/`required`.
- **Response:** `ActionResult<T>`, `Task<T>`, `Results<Ok<T>, NotFound>`, `[ProducesResponseType(typeof(T), …)]`;
  `IActionResult` without attributes is `unknown` ("check by hand").
- **Shapes:** public properties of classes and records, `System.Text.Json` naming (`camelCase` by default,
  `[JsonPropertyName]`, `[JsonIgnore]`), nullable reference types for `null`, enums (as strings when
  `JsonStringEnumConverter` is registered, numbers otherwise: when unknown, the comparison says "dangerous").
- MVC actions that return views have no contract.

Done in phase 3; the comparison code in `src/contracts/compare.ts` is reused unchanged. Enums are compared by member
name whatever the converter.

## Changes on the TypeScript side

Small, mostly mechanical. Estimated by reading the current Go/Python branches:

| File | Change |
|---|---|
| `src/config/schema.ts` | `language: 'csharp'`; `csharp` options; `CSHARP_DEFAULT_ROLES`, default excludes; backend check message. Turning the `language === 'go' ? 'Go' : 'Python'` ternaries into a `LANGUAGES` table is worth doing first. |
| `src/cli/lang-workspace.ts` | `csHelperBinary()` (build + cache, like `goHelperBinary`), `readerFor` branch, `EXTENSIONS.csharp = ['.cs', '.cshtml', '.razor']` (now a list), `dotnetEnv()`; include `csharp` options in the cache key. The file is at 230 lines: the C# runner goes in its own file (`src/cli/cs-helper.ts`) to stay under 400. |
| `src/cli/analyze.ts` (line ~208), `signals.ts`, `routes.ts`, `impact.ts` | extension list and label from the language table |
| `src/classify/dependencies.ts` | `.csproj`/`Directory.Packages.props`/`packages.config` manifests; `packages.lock.json` lockfile; sections. Manifests are matched by **suffix** (`*.csproj`), unlike the fixed names today. |
| `src/dotnet/` (new) | NuGet manifest diff and version comparison (pure) |
| `src/signals/` | `dotnet.ts`: coverlet JSON, SARIF, `dotnet list package` JSON, C# suppressions |
| `src/report/` + `scripts/embed-assets.mjs` | `cs` (and `cshtml` as `cs`) entry in the syntax highlighting table; strings in `strings*.ts` |
| `src/decls/types.ts` | `kind: "view"` is a plain string already; optional `suppressions`/`findings` arrays if adopted |
| `src/classify/roles.ts`, `classify.ts`, `src/output/schema.ts` | new `client` role (precedence after `infra`, before `barrel`); classification of client files |
| `src/report/merge-score.ts`, `verdict.ts`, `html.ts` | `client` score items and section; SQL destructive findings in the security section |
| `src/classify/reasons.ts`, `docs/reasons.md` | new reasons `client-file-changed` (touches-existing) and `client-file-added` (info); maybe `view-unattributed` (info) for phase 1 views. `declarations-additive`, `dynamic-route`, `route-added` already cover C# code. |
| `action.yml`, `examples/` | `examples/workflow-csharp.yml` with `actions/setup-dotnet`, `dotnet restore`, `dotnet test --collect "XPlat Code Coverage;Format=json"`, SARIF error log, `dotnet list package --vulnerable` |

## Configuration

Proposed keys (all optional):

```jsonc
{
  "language": "csharp",
  "surface": "backend",
  "csharp": {
    // .csproj or .sln/.slnx globs relative to the project directory; default: every non-test .csproj below it
    "projects": ["src/**/*.csproj"],
    // Build configurations whose DefineConstants are read from the .csproj; edges are the union over all of them.
    // Default: every configuration of every project (Debug, Release and each one the .csproj declares).
    // Set it only to narrow the list.
    "configurations": [],
    // Extra preprocessor symbols, added to every configuration.
    "defines": [],
    // Methods whose delegate arguments are background entry points (TASK <name>), fully qualified.
    "entryCalls": ["MyCompany.Jobs.Scheduler.Every"],
    // Where Razor views and pages live, when not the defaults (Views/, Pages/, Areas/*/Views/).
    "viewRoots": []
  }
}
```

See [Build configurations](#build-configurations) for how several configurations are compiled and merged. Hashes do
not depend on the configuration (disabled text is hashed).

## Tests

Following `test/scenarios/go.test.ts` and `python.test.ts`:

- `test/fixtures/_base-cs/`: a small, **invented** ASP.NET Core solution with no NuGet packages (only the shared
  framework), so it compiles offline: one web project with a conventional route and one attribute-routed API
  controller, a service interface with two implementations registered in `Program.cs`, a base controller, an action
  filter attribute, two views with a layout and a partial, a hosted service, a class library project, a test project,
  a `.resx` file, a `Directory.Packages.props`, a second configuration with its own `DefineConstants`, a SQL
scripts folder and a `wwwroot/` with a site script, a stylesheet and a vendored `lib/` folder.
- Scenarios (`c1`…), each with golden `expected.json`:
  - `c1-new-action`: new action in a new controller → `isolated`, `route-added`;
  - `c2-new-action-existing-controller`: new method in an existing controller → `isolated`, `declarations-additive`;
  - `c3-service-changed`: implementation behind an interface changed → `touches-existing`, reaches only the actions
    that inject that interface;
  - `c4-base-controller-changed`: virtual method of the base controller changed → reaches every derived action;
  - `c5-filter-changed`: action filter attribute changed → reaches only decorated actions;
  - `c6-view-changed`: one view changed → its action only; `c7-layout-changed` → every view-rendering action;
  - `c8-conventional-route-changed`: startup pattern changed → `routes-not-additive`;
  - `c9-computed-route`: non-constant attribute template → `unknown` (`dynamic-route`);
  - `c10-ifdef-branch`: change only inside an inactive `#if` → still `touches-existing`;
  - `c10b-release-only-caller`: a new service called only from `#if !DEBUG` code of an existing action → reached by
    that action (`touches-existing`), proving the configuration union;
  - `c11-partial-class`: change in one part of a partial class;
  - `c12-comments-only` / `c13-xmldoc-only`: `isolated`;
  - `c14-resx-key-added` (additive) / `c15-resx-value-changed`;
  - `c16-package-major` (global), `c17-tfm-change` (global), `c18-directory-build-props` (global);
  - `c19-hosted-service`, `c20-minimal-api`, `c21-signalr-hub`;
  - `c22-sql-script` (new and modified SQL → `infra-file-changed`), `c23-sql-destructive` (phase 2 finding);
  - `c24-client-modified` (`client-file-changed`), `c25-client-added` (info, `isolated`), `c26-vendored-lib`
    (excluded), `c27-client-from-layout` (phase 2: reaches every view-rendering action);
  - signal fixtures: coverlet JSON, SARIF, `dotnet list package` JSON, suppressions.
- Unit tests for the TS pieces (`src/dotnet/` version comparison, SARIF and coverlet parsers) need no SDK.
- The scenario tests need the .NET SDK in CI (`actions/setup-dotnet`), as the Go tests need `go` and the Python
  tests need `python3`. The project rule "never skip tests" means the SDK becomes a CI requirement, not an optional
  skip.

## CI and the GitHub Action

A consuming workflow would look like this (sketch for `examples/workflow-csharp.yml`):

```yaml
- uses: actions/setup-dotnet@v4
  with: { global-json-file: global.json }
- run: dotnet restore                       # so the helper finds package references (optional but more precise)
- run: dotnet build --no-restore -p:ErrorLog=lint.sarif%2Cversion=2.1
- run: dotnet test --no-build --collect "XPlat Code Coverage;Format=json" --results-directory coverage
- run: dotnet list package --vulnerable --include-transitive --format json > audit.json
- uses: <farol action>
  with:
    coverage: coverage/**/coverage.json
    lint: lint.sarif
    audit: audit.json
```

The helper build is cached in `~/.cache/farol/cs-helper/` like the Go helper; keeping that directory in the CI cache
skips the build.

## Guarantees and how they hold for .NET

| Guarantee | How |
|---|---|
| No execution of analyzed code | No MSBuild evaluation or design-time build, no `dotnet restore`/`build` of the analyzed repo, no analyzers or source generators from the repo or its packages. `.csproj` files are read as XML data; package assemblies are loaded as metadata (`MetadataReference.CreateFromFile`), never into the runtime. The only code run is farol's helper, Roslyn and (phase 2) the SDK's Razor compiler. |
| No network | The helper builds against SDK-shipped Roslyn and needs no restore with network; it reads only the exported tree, the SDK and (if present) the NuGet global packages folder. |
| Fail closed | Parse errors in changed files → `parse-error` (`unknown`); non-constant routes → `dynamic-route`; unreadable `.csproj` conditions → problem on that file; unresolved symbols → name-based edges (more reach, never less); unattributed views → all candidate actions. |
| Deterministic | Sorted files, decls, edges and entries; `/` paths; no timestamps from the helper. |

## Known limits and fail-closed behavior

- **Source generators are not run.** Members they generate (mappers, regex, logging, gRPC bases, JSON contexts) are
  missing from the compilation. Calls to them resolve to nothing; the helper falls back to name-based edges, and
  partial methods without a body are kept as declarations with the signature hash.
- **MSBuild logic is not evaluated.** Conditions beyond `Configuration|Platform`, property functions, items added by
  targets and imports from packages are ignored and reported. Repos that compute `DefineConstants` or compile items
  dynamically need `csharp.defines`/`csharp.projects` set by hand.
- **Reflection-based dispatch** (plugins loaded by name, `Activator.CreateInstance`, MediatR-style handlers resolved
  by type at run time) is only reached through interface edges. MediatR could get a framework rule
  (`IRequestHandler<TRequest,…>` reached from `Send(new TRequest…)`), as Celery got one in Python.
- **Views in phase 1** over-approximate (all partials, all layouts in scope) and miss view → C# edges.
- **Conventional routes + `[HttpGet]`-less actions** give `ANY` entries; Datadog `usage` matching already treats
  `ANY` as matching any method.
- **Multi-targeting** (`TargetFrameworks` with several values): analyze the first (or a configured) TFM; `#if NET8_0`
  branches are hashed regardless.
- **Large solutions:** Roslyn compilations of a few hundred files take seconds; the Go helper's tree-hash cache
  applies unchanged. Semantic analysis of each file is independent and can run in parallel
  (`Parallel.ForEach` over syntax trees, sorted output).
- **.NET Framework (non-SDK `.csproj`, `packages.config`, `System.Web` MVC 5, Web Forms):** out of scope at first.
  The old project format lists every `Compile` item explicitly and can be read, and MVC 5 controllers follow the same
  conventions, but routes are in `RouteConfig.RegisterRoutes` and the framework reference assemblies are not in the
  .NET SDK. Possible later.

## Phased plan

Each phase ends with typecheck, lint and tests green, PROGRESS/DECISIONS updated, and `dist/` rebuilt.

1. **Phase 0 — groundwork (TS only).** Language table refactor (no behavior change); DECISIONS entries for
   `cs-helper/`, `src/dotnet/`, Roslyn sourcing and new config keys.
2. **Phase 1 — core analysis.** `cs-helper analyze`: projects from `.csproj` XML, compilation with SDK reference
   packs, declarations and hashes (incl. disabled text), edges (interfaces, overrides, attributes, name fallback),
   entry points for attribute-routed and conventionally routed controllers, minimal APIs, hosted services, `RUN`;
   views by convention; every build configuration unioned. Roles and excludes, with SQL as `infra` and the new
   `client` role for `wwwroot`. NuGet manifests and lockfile via `cshelper manifest`. Scenarios c1–c13,
   c16–c18. At the end, `farol analyze`, `routes` and `impact` work on a C# repo.
3. **Phase 2 — views and signals.** Razor compiler integration; Razor Pages; SignalR; `.resx` additive rule;
   coverlet JSON + Cobertura; SARIF lint and security; `dotnet list package`; suppressions; syntax highlighting;
   view → client file edges; destructive SQL findings.
4. **Phase 3 — contracts and frameworks.** API contracts; gRPC from `.proto`; MediatR/Hangfire/Quartz rules;
   `history` and `calibrate` checked on real C# history.

A useful first milestone to validate the idea before all of phase 1: a helper that only prints declarations, hashes
and controller entries, run on a real C# repository's recent merged PRs with `farol history`/`calibrate`, to see
whether the classification matches what reviewers would expect.

## Decisions taken

Decided on 2026-10-26 (recorded in DECISIONS.md, 2026-10-26 (9)):

1. **Roslyn source:** the assemblies the installed .NET SDK ships, referenced by path when the helper is built
   (option A). No NuGet package, no network.
2. **Views in phase 1:** the convention mapping with the "every partial is used by every view in scope"
   over-approximation is accepted; phase 2 makes it precise with the SDK's Razor compiler.
3. **Build configurations:** every configuration by default, deduplicated by symbol set, edges unioned
   ([Build configurations](#build-configurations)). `Debug` alone could miss the only caller of new code.
4. **SQL and `wwwroot`:** both included. SQL scripts are `infra` by default (plus destructive statement findings in
   phase 2); `wwwroot` files get the new `client` role.

Still open, to settle when the code is written:

- **`.editorconfig`:** `global` by default for now (DECISIONS (11)); a project can move it with `roles.global`.
- **SARIF for every language:** worth accepting it for TypeScript, Go and Python at the same time, since it would
  also take CodeQL and Semgrep results?
