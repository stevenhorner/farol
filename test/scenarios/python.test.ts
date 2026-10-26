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

/** Expected class and affected entry points per Python scenario (FastAPI, src layout); the full output is golden. */
const SCENARIOS: Record<string, { classification: Output['classification']; affected: string[]; check?: (o: Output) => void }> = {
  // A new route on an existing router: nothing that existed changed.
  'p1-new-endpoint': {
    classification: 'isolated',
    affected: [],
    check: (o) => {
      expect(o.routes.added.map((r) => r.key)).toEqual(['GET /brands/count'])
    },
  },
  // Prefixes that are not literals: a settings default (settings = Settings(), API_V1_STR declared on the class) is
  // read; a value only known at runtime keeps the routes, with the expression as their path.
  'p11-settings-prefix': {
    classification: 'touches-existing',
    affected: ['GET /api/v1/{brand_id}'],
    check: (o) => {
      expect(o.diagnostics.dynamicRoutes).toEqual([])
      expect(o.routes.affected[0]?.key).toBe('GET /api/v1/{brand_id}')
    },
  },
  // A new route whose path is computed (issue #6): FastAPI serves it before GET /brands/{brand_id}, which it shadows;
  // farol cannot tell which URL it takes, so the PR is unknown instead of isolated.
  'p12-computed-path': {
    classification: 'unknown',
    affected: [],
    check: (o) => {
      expect(o.reasons.filter((r) => r.code === 'dynamic-route').map((r) => [r.file, r.detail])).toEqual([['src/shop/routers/brands.py', 'line 14: GET /brands{path(\'{brand_id}\')}: path computed at run time']])
      expect(o.diagnostics.dynamicRoutes).toHaveLength(1)
    },
  },
  // BrandService.find runs only behind GET /brands/{brand_id} (service.find resolved by method name).
  'p2-service-changed': { classification: 'touches-existing', affected: ['GET /brands/{brand_id}'] },
  // A field of the Brand model: both brand routes (annotations are runtime in FastAPI) and the worker script.
  'p3-model-field': { classification: 'touches-existing', affected: ['GET /brands', 'GET /brands/{brand_id}', 'RUN src/shop/worker.py'] },
  // Docstrings and comments change no declaration.
  'p4-docs-only': {
    classification: 'isolated',
    affected: [],
    check: (o) => {
      expect(o.reasons.map((r) => r.code)).toContain('declarations-additive')
    },
  },
  // fastapi 0.x → 1.0 is a major bump (critical); a new dev dependency and a ruff setting are not.
  'p5-dependency-major': {
    classification: 'global',
    affected: [],
    check: (o) => {
      expect(o.dependencies.changes.map((c) => [c.name, c.section, c.group ?? null, c.change, c.bump, c.critical])).toEqual([
        ['fastapi', 'dependencies', null, 'updated', 'major', true],
        ['ruff', 'devDependencies', 'dev', 'added', null, false],
      ])
      expect(o.reasons.some((r) => r.code === 'manifest-changed')).toBe(false)
    },
  },
  // Flask (blueprint), MCP tools/resources, Celery, Temporal and Django (ROOT_URLCONF, include, class-based views):
  // store.find_brand runs behind the routes, tool, activity and workflow that look a brand up, and nothing else.
  'p7-frameworks': {
    classification: 'touches-existing',
    affected: ['ACTIVITY load_brand', 'ANY /brands/<str:brand_id>/', 'TOOL brand', 'WORKFLOW BrandWorkflow', 'legacy DELETE /legacy/brands/<brand_id>', 'legacy GET /legacy/brands/<brand_id>', 'shop GET /brands/{brand_id}'],
  },
  // Two project classes have a find method; the audit route calls log.find with log: AuditLog annotated, so a change
  // to BrandService.find does not reach it (name-based resolution would).
  'p8-typed-calls': { classification: 'touches-existing', affected: ['GET /brands/{brand_id}'] },
  // Prefect: each @flow is an entry point (FLOW <name>, default name with hyphens); tasks run inside flows, so a change
  // to find_brand reaches the flow that calls the lookup task, not the nightly report.
  'p9-prefect': { classification: 'touches-existing', affected: ['FLOW brand-sync', 'GET /brands/{brand_id}'] },
  // Contracts: the Brand response renamed name to title; the create body gained a required owner and lost an enum
  // value; dry_run became required; list_brands gained an optional query parameter.
  'p10-contracts': {
    classification: 'touches-existing',
    affected: ['GET /brands', 'GET /brands/current/owner', 'GET /brands/{brand_id}', 'POST /brands', 'RUN src/shop/worker.py'],
    check: (o) => {
      const c = o.contracts
      expect(c?.summary).toEqual({ breaking: 3, dangerous: 0, safe: 0 })
      // `brand: CurrentBrand` (Annotated[Brand, Depends(…)] through an alias) is injected: Brand changing is no
      // change to what GET /brands/current/owner receives.
      expect(c?.entries.find((e) => e.key === 'GET /brands/current/owner')).toBeUndefined()
      const post = c?.entries.find((e) => e.key === 'POST /brands')
      expect(post?.changes.filter((x) => x.level === 'breaking').map((x) => `${x.where}: ${x.detail}`)).toEqual([
        'body.owner: new required field',
        'body.tier: enum values removed: enterprise',
        'query:dry_run: became required',
        'response.name: field removed',
      ])
      expect(c?.entries.find((e) => e.key === 'GET /brands')?.changes.map((x) => `${x.level} ${x.where}: ${x.detail}`)).toEqual([
        'breaking response[].name: field removed',
        'safe query:cursor: new optional parameter',
        'safe response[].logo: field added',
        'safe response[].title: field added',
      ])
    },
  },
  // The users router is no longer included: GET /me disappears although users.py did not change.
  'p6-router-removed': {
    classification: 'touches-existing',
    affected: [],
    check: (o) => {
      expect(o.reasons.map((r) => r.detail).join('\n')).toContain('entry point GET /me was removed')
    },
  },
}

describe('Python scenarios', () => {
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
    }, 60_000)
  }

  it('lists the entry points with routes and what reaches a file with impact', () => {
    const s = createScenarioRepo('p2-service-changed')
    cleanups.push(() => {
      s.repo.cleanup()
    })
    const routes = runCli(['--cwd', s.repo.dir, 'routes', '--ref', s.base])
    expect(routes.code).toBe(0)
    expect((JSON.parse(routes.stdout) as { routes: { key: string }[] }).routes.map((r) => r.key)).toEqual(['GET /brands', 'GET /brands/{brand_id}', 'GET /health', 'GET /me', 'RUN src/shop/worker.py'])
    const impact = runCli(['--cwd', s.repo.dir, 'impact', 'src/shop/services/brands.py', '--ref', s.base])
    expect(impact.code).toBe(0)
    expect((JSON.parse(impact.stdout) as { routes: { key: string }[] }).routes.map((r) => r.key)).toEqual(['GET /brands', 'GET /brands/{brand_id}'])
  }, 60_000)

  it('keeps helper outputs between runs, keyed by tree', () => {
    const s = createScenarioRepo('p2-service-changed')
    cleanups.push(() => {
      s.repo.cleanup()
    })
    const cache = join(s.repo.dir, '.cache-test')
    const args = ['--cwd', s.repo.dir, '--verbose', 'analyze', '--base', s.base, '--head', s.head, '--cache-dir', cache]
    const first = runCli(args)
    const second = runCli(args)
    expect(first.code).toBe(0)
    expect(first.stderr).not.toContain('read from the cache')
    expect(second.stderr.match(/read from the cache/g)).toHaveLength(2)
    expect(JSON.parse(second.stdout)).toMatchObject({ classification: (JSON.parse(first.stdout) as { classification: string }).classification })
    expect(runCli([...args, '--no-cache']).stderr).not.toContain('read from the cache')
  }, 60_000)
})
