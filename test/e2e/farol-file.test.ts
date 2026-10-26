import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OutputSchema } from '../../src/output/schema.js'
import { runCli } from '../helpers/cli.js'
import { createScenarioRepo, type ScenarioRepo } from '../helpers/repo.js'

const repos: ScenarioRepo[] = []
afterAll(() => {
  for (const r of repos) r.repo.cleanup()
})

function scenario(): ScenarioRepo {
  const s = createScenarioRepo('05-shared-component')
  repos.push(s)
  return s
}

describe('.farol.json', () => {
  it('provides every parameter, paths relative to the file, found from a subdirectory', () => {
    const s = scenario()
    s.repo.write('.farol.json', JSON.stringify({ analyze: { base: 'main', head: 'feature', out: 'out/farol.json', pr: 7 }, html: { in: 'out/farol.json', out: 'out/farol.html', repo: 'acme/shop' } }))
    mkdirSync(join(s.repo.dir, 'src', 'deep'), { recursive: true })
    const a = runCli(['analyze'], { cwd: join(s.repo.dir, 'src', 'deep') })
    expect(a.stderr).toBe('')
    expect(a.code).toBe(0)
    const output = OutputSchema.parse(JSON.parse(readFileSync(join(s.repo.dir, 'out', 'farol.json'), 'utf8')))
    expect(output.classification).toBe('touches-existing')
    expect(output.pr).toBe(7)
    expect(runCli(['html'], { cwd: s.repo.dir }).code).toBe(0)
    expect(readFileSync(join(s.repo.dir, 'out', 'farol.html'), 'utf8')).toContain('https://github.com/acme/shop/pull/7/files#diff-')
    // report takes the incremental analysis too, like comment (paths relative to the file).
    s.repo.write('.farol.json', JSON.stringify({ report: { in: 'out/farol.json', sinceIn: 'out/farol.json', sinceReportUrl: 'https://example.com/since.html' } }))
    const r = runCli(['report'], { cwd: join(s.repo.dir, 'src', 'deep') })
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('Since the last push')
    expect(r.stdout).toContain('https://example.com/since.html')
  })

  it('command-line flags win over the file', () => {
    const s = scenario()
    s.repo.write('.farol.json', JSON.stringify({ analyze: { base: 'does-not-exist', head: 'feature' } }))
    const r = runCli(['analyze', '--base', 'main'], { cwd: s.repo.dir })
    expect(r.code).toBe(0)
    expect((JSON.parse(r.stdout) as { base: { ref: string } }).base.ref).toBe('main')
  })

  it('reports missing parameters, invalid files and an explicit --farol-file path', () => {
    const s = scenario()
    const missing = runCli(['analyze'], { cwd: s.repo.dir })
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('missing --base: pass it on the command line or set "analyze.base" in .farol.json')
    s.repo.write('.farol.json', JSON.stringify({ analyze: { bse: 'main' } }))
    const typo = runCli(['analyze'], { cwd: s.repo.dir })
    expect(typo.code).toBe(1)
    expect(typo.stderr).toContain('analyze: unknown key(s) "bse"')
    s.repo.write('ci/other.json', JSON.stringify({ cwd: '..', analyze: { base: 'main', head: 'feature' } }))
    const explicit = runCli(['--farol-file', join(s.repo.dir, 'ci', 'other.json'), 'analyze'], { cwd: s.repo.dir })
    expect(explicit.code).toBe(0)
  })
})
