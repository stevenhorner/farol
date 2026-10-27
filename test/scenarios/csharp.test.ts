import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Output } from '../../src/output/schema.js'
import { analyzeScenario, normalizeOutput } from '../helpers/analyze.js'
import { createScenarioRepo, FIXTURES_DIR } from '../helpers/repo.js'
import { runCli } from '../helpers/cli.js'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

/** Every MVC action of the base solution (HomeController and OrdersController derive from BaseController). */
const MVC = ['ANY /Home/About/{id?}', 'ANY /Home/Index/{id?}', 'GET /Orders/Details/{id?}', 'GET /Orders/Index/{id?}', 'POST /Orders/Cancel/{id?}']
const ALL = [
  ...MVC,
  'GET /Account/Profile/{id:int?}',
  'GET /api/Products/{sku}',
  'GET /api/health',
  'GET /api/prices/{sku}',
  'POST /Account/Profile/{id:int?}?handler=Save',
  'POST /api/Archive/{id}',
  'POST /api/Products/quote',
  'RPC shop.catalog.Catalog/GetProduct',
  'RPC shop.catalog.Catalog/ListProducts',
  'TASK AddOrUpdate nightly-report',
  'TASK Every purge',
  'TASK Shop.Web.Jobs.ReindexJob',
  'TASK Shop.Web.Workers.CleanupWorker',
  'WS /hubs/orders#OpenOrders',
  'WS /hubs/orders#Subscribe',
].sort()
const codes = (o: Output, code: string): string[] => o.reasons.filter((r) => r.code === code).map((r) => r.file ?? '')

/** Expected class and affected entry points per C# scenario (ASP.NET Core, no NuGet restore); full output is golden. */
const SCENARIOS: Record<string, { classification: Output['classification']; affected: string[]; check?: (o: Output) => void }> = {
  // A new controller with its view, and a new service registered in Program.cs: the registration is a declaration of
  // its own, so the startup code that runs before every endpoint did not change.
  'c1-new-controller': {
    classification: 'isolated',
    affected: [],
    check: (o) => {
      expect(o.routes.added.map((r) => r.key)).toEqual(['GET /Shipping/Quote/{id?}'])
      expect(codes(o, 'declarations-additive')).toEqual(['src/Shop.Web/Program.cs'])
    },
  },
  // A new action in an existing controller and its view: new declarations only.
  'c2-new-action': {
    classification: 'isolated',
    affected: [],
    check: (o) => {
      expect(o.routes.added.map((r) => r.key)).toEqual(['GET /Orders/Summary/{id?}'])
    },
  },
  // OrderService.Cancel runs behind IOrderService.Cancel (interface dispatch): only the action that cancels.
  'c3-service-changed': { classification: 'touches-existing', affected: ['POST /Orders/Cancel/{id?}'] },
  // A framework override of the base controller runs for every action of the controllers deriving from it; the API
  // controller derives from ControllerBase and is not affected. The worker calls HomeController.ResetCache (a static
  // method) and the middleware compares a type with typeof(OrdersController): neither runs a controller's overrides.
  'c4-base-controller-changed': { classification: 'touches-existing', affected: MVC },
  // The [AuditLog] attribute decorates Cancel only.
  'c5-filter-changed': { classification: 'touches-existing', affected: ['POST /Orders/Cancel/{id?}'] },
  // View() in Details renders Views/Orders/Details.cshtml.
  'c6-view-changed': { classification: 'touches-existing', affected: ['GET /Orders/Details/{id?}'] },
  // The layout is in scope of every view: every action that renders one.
  'c7-layout-changed': { classification: 'touches-existing', affected: MVC },
  // The conventional pattern changed: every conventionally routed action has a new URL.
  'c8-conventional-route-changed': {
    classification: 'touches-existing',
    affected: [],
    check: (o) => {
      expect(o.reasons.map((r) => r.detail).join('\n')).toContain('entry point GET /Orders/Details/{id?} was removed')
      expect(o.routes.added.map((r) => r.key)).toContain('GET /Orders/Details/{id:int?}')
    },
  },
  // A new endpoint whose path is computed at run time may take the URL of an existing one.
  'c9-computed-route': {
    classification: 'unknown',
    affected: [],
    check: (o) => {
      expect(codes(o, 'dynamic-route')).toEqual(['src/Shop.Web/Program.cs'])
    },
  },
  // Only the inactive #if LITE branch changed: the Lite configuration compiles it, and the hash includes it anyway.
  // The worker reads row.Details and row.Index() from a dynamic value: an unknown member reaches project members of that
  // name and shape, never controller actions, so the task does not reach Details.
  'c10-ifdef-branch': { classification: 'touches-existing', affected: ['GET /Orders/Details/{id?}'] },
  // New code called only from #if !DEBUG: the Release configuration sees the call, so the new file is reached by an
  // existing endpoint (a Debug-only analysis would call it disconnected).
  'c11-release-only-caller': {
    classification: 'touches-existing',
    affected: ['POST /Orders/Cancel/{id?}'],
    check: (o) => {
      expect(codes(o, 'new-file-reached-by-existing-route')).toEqual(['src/Shop.Core/Orders/CancellationLog.cs'])
    },
  },
  // Comments, XML docs and formatting change no hash.
  'c12-comments-only': { classification: 'isolated', affected: [], check: (o) => { expect(codes(o, 'declarations-additive')).toEqual(['src/Shop.Core/Orders/OrderService.cs']); } },
  // A new registration of new classes: additive, and the classes are not reached by existing code.
  'c13-new-registration': { classification: 'isolated', affected: [] },
  // A changed registration (singleton → scoped) changes the startup code of every endpoint.
  'c14-registration-changed': { classification: 'touches-existing', affected: ALL },
  'c15-package-major': {
    classification: 'global',
    affected: [],
    check: (o) => {
      expect(o.dependencies.changes.map((c) => `${c.name} ${c.from} → ${c.to} ${c.bump} ${c.critical}`)).toEqual(['Humanizer.Core 2.14.1 → 3.0.1 major true'])
    },
  },
  'c16-tfm-change': { classification: 'global', affected: [], check: (o) => { expect(o.reasons.find((r) => r.code === 'manifest-changed')?.detail).toBe('fields changed: property:TargetFramework'); } },
  'c17-directory-build-props': { classification: 'global', affected: [], check: (o) => { expect(codes(o, 'global-file-changed')).toEqual(['Directory.Build.props']); } },
  // A BackgroundService is an entry point of its own.
  'c18-hosted-service': { classification: 'touches-existing', affected: ['TASK Shop.Web.Workers.CleanupWorker'] },
  // An inline minimal API handler is compared endpoint by endpoint.
  'c19-minimal-api-handler': { classification: 'touches-existing', affected: ['GET /api/prices/{sku}'] },
  // SQL scripts are infrastructure; wwwroot files are client code (site.js is linked by the layout); vendored
  // libraries are excluded.
  'c20-sql-and-client': {
    classification: 'touches-existing',
    affected: MVC,
    check: (o) => {
      expect(codes(o, 'infra-file-changed')).toEqual(['sql/001_create_orders.sql', 'sql/002_add_customer.sql'])
      expect(codes(o, 'client-file-changed')).toEqual(['src/Shop.Web/wwwroot/js/site.js'])
      expect(codes(o, 'client-file-added')).toEqual(['src/Shop.Web/wwwroot/js/orders.js'])
      expect(codes(o, 'file-excluded')).toEqual(['src/Shop.Web/wwwroot/lib/jquery/jquery.min.js'])
    },
  },
  'c21-test-only': { classification: 'isolated', affected: [], check: (o) => { expect(codes(o, 'tests-modified')).toEqual(['tests/Shop.Core.Tests/OrderServiceTests.cs']); } },
  // A new test project and its line in the solution file: a test project's .csproj is a test file, not a manifest of
  // the app; the solution file is build configuration (infrastructure).
  'c23-test-project-added': {
    classification: 'touches-existing',
    affected: [],
    check: (o) => {
      expect(o.files.map((f) => `${f.path} ${f.role}`)).toEqual(['Shop.sln infra', 'tests/Shop.Web.Tests/HomeControllerTests.cs test', 'tests/Shop.Web.Tests/Shop.Web.Tests.csproj test'])
      expect(o.dependencies.changes).toEqual([])
    },
  },
  // Phase 2: views compiled with the SDK's Razor generator. The layout renders the Basket view component, whose view
  // is Components/Basket/Default.cshtml: every action that renders a view with the layout.
  'c24-component-view-changed': { classification: 'touches-existing', affected: MVC },
  // A Razor Page handler: only its own entry point (the page's GET handler does not run it).
  'c25-page-handler-changed': { classification: 'touches-existing', affected: ['POST /Account/Profile/{id:int?}?handler=Save'] },
  // A SignalR hub method: only its own entry point.
  'c26-hub-method-changed': { classification: 'touches-existing', affected: ['WS /hubs/orders#OpenOrders'] },
  // A script the layout links: every action that renders a view with the layout loads it.
  'c27-client-from-layout': {
    classification: 'touches-existing',
    affected: MVC,
    check: (o) => {
      expect(o.reasons.find((r) => r.code === 'client-file-changed')?.detail).toContain('loaded by 5 existing entry point(s)')
    },
  },
  // Razor cannot parse the view (an unclosed code block): farol cannot say what it does.
  'c28-razor-error': { classification: 'unknown', affected: ['GET /Orders/Details/{id?}'], check: (o) => { expect(codes(o, 'parse-error')).toContain('src/Shop.Web/Views/Orders/Details.cshtml'); } },
  // .resx files follow the i18n rule: a new key is additive, a changed value is not.
  'c29-resx-key-added': { classification: 'isolated', affected: [], check: (o) => { expect(codes(o, 'i18n-additive')).toEqual(['src/Shop.Web/Resources/Strings.resx']); } },
  'c30-resx-value-changed': { classification: 'touches-existing', affected: [], check: (o) => { expect(codes(o, 'i18n-not-additive')).toEqual(['src/Shop.Web/Resources/Strings.resx']); } },
  // Destructive SQL on added lines; commented-out statements and string literals never count.
  'c31-sql-destructive': {
    classification: 'touches-existing',
    affected: [],
    check: (o) => {
      expect(o.signals.security.findings.map((f) => `${f.line} ${f.rule} ${f.severity}`)).toEqual(['2 sql-destructive high', '4 sql-destructive high', '5 sql-destructive high'])
    },
  },
  // No view names _Unused: with the views compiled, changing it reaches nothing (by convention it reached every view).
  'c32-unused-partial-changed': { classification: 'touches-existing', affected: [], check: (o) => { expect(codes(o, 'existing-file-unreachable')).toEqual(['src/Shop.Web/Views/Shared/_Unused.cshtml']); } },
  // Code of a job registered with the project's scheduler (csharp.entryCalls): the job and the worker run it, not the
  // startup code of every endpoint that registers the job.
  'c33-scheduled-job-code': { classification: 'touches-existing', affected: ['TASK Every purge', 'TASK Shop.Web.Workers.CleanupWorker'] },
  // connection.Execute(…) on a SqlConnection from a package that was not restored is not ReportRunner.Execute.
  'c34-package-receiver': { classification: 'touches-existing', affected: [], check: (o) => { expect(codes(o, 'existing-file-unreachable')).toEqual(['src/Shop.Core/Reports/ReportRunner.cs']); } },
  // ProductQuote.Price renamed (response) and a required field added to QuoteRequest (body): both break clients.
  'c35-contract-breaking': { classification: 'touches-existing', affected: ['POST /api/Products/quote'], check: (o) => {
      expect(o.contracts?.summary).toEqual({ breaking: 1, dangerous: 0, safe: 0 })
      expect(o.contracts?.entries[0]?.changes.map((x) => `${x.level} ${x.where}: ${x.detail}`)).toEqual(['breaking body.country: new required field', 'breaking response.price: field removed', 'safe response.amount: field added'])
    } },
  // A gRPC method's code: only its RPC (the service is mapped with MapGrpcService).
  'c36-grpc-method-changed': { classification: 'touches-existing', affected: ['RPC shop.catalog.Catalog/GetProduct'] },
  // A field removed from a .proto message: every RPC of the service, and the contract of the one that returns it.
  'c37-proto-field-removed': { classification: 'touches-existing', affected: ['RPC shop.catalog.Catalog/GetProduct', 'RPC shop.catalog.Catalog/ListProducts'], check: (o) => {
      expect(codes(o, 'existing-file-modified')).toEqual(['src/Shop.Web/Protos/catalog.proto'])
      expect(o.contracts?.entries.map((e) => `${e.key} ${e.changes.map((x) => `${x.level} ${x.where}`).join()}`)).toEqual(['RPC shop.catalog.Catalog/GetProduct breaking response.tags', 'RPC shop.catalog.Catalog/ListProducts breaking response[].tags'])
    } },
  // A MediatR handler runs for the endpoint that sends its request, and a pipeline behavior for every request.
  'c38-mediatr-handler-changed': { classification: 'touches-existing', affected: ['POST /api/Archive/{id}'] },
  'c39-pipeline-behavior-changed': { classification: 'touches-existing', affected: ['POST /api/Archive/{id}'] },
  // A Hangfire recurring job's code and a Quartz IJob: each is an entry point of its own.
  'c40-hangfire-job-code': { classification: 'touches-existing', affected: ['TASK AddOrUpdate nightly-report'] },
  'c41-quartz-job-changed': { classification: 'touches-existing', affected: ['TASK Shop.Web.Jobs.ReindexJob'] },
  // row.Label() on a dynamic value cannot run a static method named Label.
  'c42-static-not-fallback': { classification: 'touches-existing', affected: [], check: (o) => { expect(codes(o, 'existing-file-unreachable')).toEqual(['src/Shop.Core/Reports/ReportLabels.cs']); } },
  // MSBuild settings imported only by test projects (by path, or by content: IsTestProject) are test files; settings
  // an app project imports stay global.
  'c43-test-build-props': { classification: 'isolated', affected: [], check: (o) => { expect(o.files.map((f) => `${f.path} ${f.role}`)).toEqual(['tests/Directory.Build.props test']); } },
  'c44-specs-build-props': { classification: 'isolated', affected: [], check: (o) => { expect(o.files.map((f) => `${f.path} ${f.role}`)).toEqual(['qa/Directory.Build.props test']); } },
  'c45-app-build-props': { classification: 'global', affected: [], check: (o) => { expect(codes(o, 'global-file-changed')).toEqual(['src/Shop.Web/Directory.Build.props']); } },
  // A new package and a new content item: dependency information, no build setting changed.
  'c22-package-added': {
    classification: 'isolated',
    affected: [],
    check: (o) => {
      expect(o.dependencies.changes.map((c) => `${c.change} ${c.name} ${c.critical}`)).toEqual(['added Serilog.AspNetCore false'])
    },
  },
}

describe('C# scenarios', () => {
  for (const [scenario, spec] of Object.entries(SCENARIOS)) {
    it(scenario, async () => {
      const { output, cleanup } = await analyzeScenario(scenario)
      cleanups.push(cleanup)
      expect(output.diagnostics.error).toBeNull()
      expect(output.surface).toBe('backend')
      expect(output.classification).toBe(spec.classification)
      expect(output.routes.affected.map((r) => r.key)).toEqual(spec.affected)
      spec.check?.(output)
      const golden = join(FIXTURES_DIR, scenario, 'expected.json')
      const actual = `${JSON.stringify(normalizeOutput(output), null, 2)}\n`
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) writeFileSync(golden, actual)
      expect(actual).toBe(readFileSync(golden, 'utf8'))
    }, 120_000)
  }

  it('reads coverlet JSON, Cobertura XML, SARIF and dotnet list package reports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'farol-cs-reports-'))
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true })
    })
    const file = 'src/Shop.Core/Orders/OrderService.cs'
    // c3 adds lines 14 and 15 of OrderService.Cancel: the throw ran, the assignment did not.
    writeFileSync(join(dir, 'coverage.json'), JSON.stringify({ 'Shop.Core.dll': { [file]: { 'Shop.Core.Orders.OrderService': { 'System.Void Shop.Core.Orders.OrderService::Cancel(System.Int32)': { Lines: { 13: 1, 14: 1, 15: 0 }, Branches: [] } } } } }))
    writeFileSync(join(dir, 'coverage.cobertura.xml'), `<?xml version="1.0"?><coverage><sources><source>.</source></sources><packages><package><classes><class name="OrderService" filename="${file}"><lines><line number="13" hits="1"/><line number="14" hits="1"/><line number="15" hits="0"/></lines></class></classes></package></packages></coverage>`)
    writeFileSync(join(dir, 'lint.sarif'), JSON.stringify({ version: '2.1.0', runs: [{ results: [
      { ruleId: 'CA2100', level: 'warning', message: { text: 'Review SQL queries for security vulnerabilities' }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: 14 } } }] },
      { ruleId: 'IDE0005', level: 'note', message: { text: 'Using directive is unnecessary' }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: 1 } } }] },
    ] }] }))
    for (const coverage of ['coverage.json', 'coverage.cobertura.xml']) {
      const { output, cleanup } = await analyzeScenario('c3-service-changed', { coverage: join(dir, coverage), eslint: join(dir, 'lint.sarif') })
      cleanups.push(cleanup)
      expect(output.signals.coverage.status).toBe('ok')
      expect(output.signals.coverage.files.map((f) => `${f.path} ${f.coveredLines}/${f.changedExecutableLines}`)).toEqual([`${file} 1/2`])
      expect(output.signals.lint.changedLines).toEqual({ errors: 0, warnings: 1 })
      expect(output.signals.security.findings.map((f) => `${f.line} ${f.rule} ${f.severity}`)).toEqual(['14 dotnet-analyzer high'])
    }
    writeFileSync(join(dir, 'audit.json'), JSON.stringify({ version: 1, projects: [{ path: 'src/Shop.Core/Shop.Core.csproj', frameworks: [{ framework: 'net10.0', topLevelPackages: [{ id: 'Humanizer.Core', requestedVersion: '3.0.1', resolvedVersion: '3.0.1', vulnerabilities: [{ severity: 'High', advisoryurl: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' }] }] }] }] }))
    const { output, cleanup } = await analyzeScenario('c15-package-major', { audit: join(dir, 'audit.json') })
    cleanups.push(cleanup)
    expect(output.signals.vulnerabilities.related.map((v) => `${v.package} ${v.severity} ${v.kind} ${v.id}`)).toEqual(['Humanizer.Core high direct GHSA-xxxx-yyyy-zzzz'])
  }, 120_000)

  it('lists the entry points with routes and what reaches a file with impact', () => {
    const s = createScenarioRepo('c3-service-changed')
    cleanups.push(() => {
      s.repo.cleanup()
    })
    const routes = runCli(['--cwd', s.repo.dir, 'routes', '--ref', s.base])
    expect(routes.code).toBe(0)
    expect((JSON.parse(routes.stdout) as { routes: { key: string }[] }).routes.map((r) => r.key)).toEqual(ALL)
    const impact = runCli(['--cwd', s.repo.dir, 'impact', 'src/Shop.Core/Pricing/StandardPriceCalculator.cs', '--ref', s.base])
    expect(impact.code).toBe(0)
    // Orders/Index.cshtml injects IPriceCalculator (the view's code is compiled with the Razor generator); Cancel
    // redirects to nameof(Index). The quote action and the gRPC GetProduct
    // method price products too.
    expect((JSON.parse(impact.stdout) as { routes: { key: string }[] }).routes.map((r) => r.key)).toEqual(['GET /Orders/Index/{id?}', 'GET /api/Products/{sku}', 'GET /api/prices/{sku}', 'POST /Orders/Cancel/{id?}', 'POST /api/Products/quote', 'RPC shop.catalog.Catalog/GetProduct'])
  }, 120_000)
})
