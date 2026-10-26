import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const ALL = [...MVC.slice(0, 4), 'GET /api/Products/{sku}', 'GET /api/health', 'GET /api/prices/{sku}', MVC[4] as string, 'TASK Shop.Web.Workers.CleanupWorker'].sort()
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
  // controller derives from ControllerBase and is not affected.
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
  // SQL scripts are infrastructure; wwwroot files are client code; vendored libraries are excluded.
  'c20-sql-and-client': {
    classification: 'touches-existing',
    affected: [],
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
    expect((JSON.parse(impact.stdout) as { routes: { key: string }[] }).routes.map((r) => r.key)).toEqual(['GET /api/Products/{sku}', 'GET /api/prices/{sku}'])
  }, 120_000)
})
