import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCli } from '../helpers/cli.js'
import { createScenarioRepo, FIXTURES_DIR, type ScenarioRepo } from '../helpers/repo.js'

const repos: ScenarioRepo[] = []
const tmp = mkdtempSync(join(tmpdir(), 'farol-report-'))
afterAll(() => {
  for (const r of repos) r.repo.cleanup()
  rmSync(tmp, { recursive: true, force: true })
})

describe('analyze + report through the built binary', () => {
  it('analyze with --coverage and --eslint, then report prints the comment', () => {
    const s = createScenarioRepo('signals-coverage-lint')
    repos.push(s)
    for (const name of ['coverage-final.json', 'eslint.json']) {
      writeFileSync(join(tmp, name), readFileSync(join(FIXTURES_DIR, 'signals-coverage-lint', 'reports', name), 'utf8').replaceAll('<root>', s.repo.dir))
    }
    const out = join(tmp, 'farol.json')
    const a = runCli(['--cwd', s.repo.dir, 'analyze', '--base', 'main', '--head', 'feature', '--coverage', join(tmp, 'coverage-final.json'), '--eslint', join(tmp, 'eslint.json'), '--out', out])
    expect(a.code).toBe(0)
    const r = runCli(['report', '--in', out])
    expect(r.code).toBe(0)
    expect(r.stdout.startsWith('<!-- farol -->\n')).toBe(true)
    expect(r.stdout).toContain('- **Diff coverage:** 44.4% (4 of 9 changed executable lines covered)')
    expect(r.stdout).toContain('- **Lint on changed lines:** 1 error, 1 warning')
    const [signals = '', details = ''] = r.stdout.split('<summary>Classification')
    // format.ts only gains functions (declaration-level additive) and discount.ts is new: nothing existing changed.
    expect(signals).not.toContain('isolated')
    expect(details).toContain('**Class:** `isolated`')
    expect(r.stdout).toContain(`analyzed commit ${s.head.slice(0, 12)}`)
  })

  it('exits 1 when the input is not an analyze result', () => {
    const bad = join(tmp, 'bad.json')
    writeFileSync(bad, '{"schemaVersion": 2}')
    const r = runCli(['report', '--in', bad])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('is not a farol analyze result')
    expect(runCli(['report', '--in', join(tmp, 'missing.json')]).code).toBe(1)
  })
})
