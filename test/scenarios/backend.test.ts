import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Output } from '../../src/output/schema.js'
import { analyzeScenario, normalizeOutput } from '../helpers/analyze.js'
import { runCli } from '../helpers/cli.js'
import { createScenarioRepo, FIXTURES_DIR } from '../helpers/repo.js'

const cleanups: (() => void)[] = []
afterAll(() => {
  for (const c of cleanups) c()
})

const BRAND_OPS = ['Mutation.renameBrand', 'Query.brand', 'Query.brands']

/** Expected class and affected operations per backend scenario; the full output is a golden file. */
const SCENARIOS: Record<string, { classification: Output['classification']; affected: string[]; check?: (o: Output) => void }> = {
  'b1-new-query': {
    classification: 'isolated',
    affected: [],
    check: (o) => {
      expect(o.routes.added.map((r) => r.key)).toEqual(['Query.topBrands'])
      expect(o.files.map((f) => [f.path, f.role, f.additive])).toEqual([
        ['src/resolvers/brand.ts', 'resolvers', true],
        ['src/schema/types.graphql', 'schema', true],
        ['src/services/top.ts', 'source', undefined],
      ])
    },
  },
  // A service used only by Query.me: the brand operations are untouched.
  'b2-service-changed': { classification: 'touches-existing', affected: ['Query.me'] },
  // Brand.name changed type: every operation that can return a Brand.
  'b3-schema-changed': { classification: 'touches-existing', affected: BRAND_OPS },
  // Only the Brand.posts resolver changed: operations returning Brand run it; Query.me does not.
  'b4-resolver-changed': { classification: 'touches-existing', affected: BRAND_OPS },
  // loaders.Post… is injected through the context: mapped by backend.context to src/loaders/post.ts.
  'b5-loader-changed': { classification: 'touches-existing', affected: BRAND_OPS },
  // lib/db.js is reached through the Core global (global.Core = …) used by services/legacy.js. Across modules the unit
  // is the module: renameBrand uses services/brands.ts, which loads legacy.js, so it is listed too (conservative).
  'b6-global-changed': { classification: 'touches-existing', affected: ['Mutation.renameBrand', 'Query.brands'] },
  'b7-rest': { classification: 'touches-existing', affected: ['POST /webhooks/stripe'] },
  // Command-line commands (commander) are entry points: a job used only by `shop report` affects that command alone.
  'b11-cli-command': {
    classification: 'touches-existing',
    affected: ['CLI report'],
    check: (o) => {
      expect(o.risk.totalPages).toBe(BRAND_OPS.length + 3 + 2)
    },
  },
  // A new endpoint whose path is computed (issue #6) is registered before POST /webhooks/stripe, which it can shadow:
  // farol cannot tell its URL, so the PR is unknown instead of isolated.
  'b10-rest-computed': {
    classification: 'unknown',
    affected: [],
    check: (o) => {
      expect(o.reasons.filter((r) => r.code === 'dynamic-route').map((r) => [r.file, r.detail])).toEqual([['src/rest/hooks.ts', "line 6: POST {hook('stripe')}: path computed at run time"]])
    },
  },
  // Contracts (graphql-js rules): a required argument on Query.brand, Post.title removed (every operation returning a
  // Brand reaches Post), an optional argument on Query.brands (dangerous for graphql-js).
  'b9-schema-breaking': {
    classification: 'touches-existing',
    affected: BRAND_OPS,
    check: (o) => {
      expect(o.contracts?.entries.map((e) => [e.key, e.level, e.changes.map((x) => x.detail)])).toEqual([
        ['Mutation.renameBrand', 'breaking', ['Post.title was removed.']],
        ['Query.brand', 'breaking', ['Post.title was removed.', 'A required arg locale on Query.brand was added.']],
        ['Query.brands', 'breaking', ['Post.title was removed.', 'An optional arg first on Query.brands was added.']],
      ])
    },
  },
  // A schema description is documentation: no behavior change.
  'b8-schema-description': { classification: 'isolated', affected: [] },
}

describe('backend scenarios (GraphQL and REST)', () => {
  for (const [scenario, spec] of Object.entries(SCENARIOS)) {
    it(scenario, async () => {
      const { output, cleanup } = await analyzeScenario(scenario)
      cleanups.push(cleanup)
      expect(output.surface).toBe('backend')
      expect(output.classification).toBe(spec.classification)
      expect(output.routes.affected.map((r) => r.key)).toEqual(spec.affected)
      spec.check?.(output)
      const golden = join(FIXTURES_DIR, scenario, 'expected.json')
      const actual = `${JSON.stringify(normalizeOutput(output), null, 2)}\n`
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) writeFileSync(golden, actual)
      expect(actual).toBe(readFileSync(golden, 'utf8'))
    })
  }

  it('lists GraphQL operations and REST endpoints with routes', () => {
    const s = createScenarioRepo('b1-new-query')
    cleanups.push(() => { s.repo.cleanup(); })
    const r = runCli(['--cwd', s.repo.dir, 'routes', '--ref', s.base])
    expect(r.code).toBe(0)
    const table = JSON.parse(r.stdout) as { routes: { key: string; modules: string[] }[] }
    expect(table.routes.map((x) => x.key)).toEqual(['GET /health', 'Mutation.renameBrand', 'POST /webhooks/stripe', 'Query.brand', 'Query.brands', 'Query.me'])
    expect(table.routes.find((x) => x.key === 'Query.me')?.modules).toEqual(['src/lib/format.ts', 'src/services/users.ts'])
  })
})
