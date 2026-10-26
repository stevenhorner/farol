import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OutputSchema, type Output } from '../../src/output/schema.js'
import { combineScore, DEPENDENCY_WEIGHT, fileCoverage, LEFT_OUT_RISK, mergeScore, scoreGroups, scoreItems, scoreLevel } from '../../src/report/merge-score.js'
import { renderReport } from '../../src/report/markdown.js'
import { reviewParts } from '../../src/report/review-parts.js'
import { computeVerdict } from '../../src/report/verdict.js'
import { FIXTURES_DIR } from '../helpers/repo.js'

function golden(scenario: string): Output {
  return OutputSchema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, scenario, 'expected.json'), 'utf8')))
}

describe('merge risk score', () => {
  it('combines weights as the chance that at least one item breaks something', () => {
    expect(combineScore([])).toBe(0)
    expect(combineScore([{ weight: 0.5 }])).toBe(50)
    expect(combineScore([{ weight: 0.5 }, { weight: 0.5 }])).toBe(75)
    expect(scoreLevel(60)).toBe('high')
    expect(scoreLevel(30)).toBe('medium')
    expect(scoreLevel(29)).toBe('low')
  })

  it('ranks global and touches-existing PRs above isolated ones', () => {
    const global = mergeScore(golden('10-global-css')).score
    const touches = mergeScore(golden('05-shared-component')).score
    const isolated = mergeScore(golden('01-new-route')).score
    expect(global).toBeGreaterThan(isolated)
    expect(touches).toBeGreaterThan(isolated)
    // Calibrated weight: a global change alone is medium risk, not high.
    expect(scoreLevel(global)).toBe('medium')
  })

  it('gives added declaration-only files one point each, five for all of them together', () => {
    const o = golden('01-new-route')
    const added = o.risk.files.filter((f) => f.change === 'added').map((f) => f.path)
    expect(added.length).toBeGreaterThan(0)
    const mark = (n: number): Output => ({ ...o, files: o.files.map((f) => (added.slice(0, n).includes(f.path) ? { ...f, declarationsOnly: true as const } : f)) })
    const weights = (out: Output) => scoreItems(out).filter((i) => i.kind === 'change' && out.files.some((f) => f.path === i.file && f.declarationsOnly)).map((i) => i.weight)
    expect(weights(mark(1))).toEqual([0.01])
    const first = o.risk.files[0]
    if (first === undefined) throw new Error('the golden has risk files')
    const many: Output = { ...o, risk: { ...o.risk, files: Array.from({ length: 10 }, (_, i) => ({ ...first, path: `src/t${i}.types.ts`, change: 'added' as const })) }, files: Array.from({ length: 10 }, (_, i) => ({ path: `src/t${i}.types.ts`, status: 'added' as const, role: 'source' as const, linesAdded: 3, linesRemoved: 0, declarationsOnly: true as const })) }
    expect(combineScore(scoreItems(many))).toBeLessThanOrEqual(5)
  })

  it('weighs each changed file by its diff coverage: fully covered keeps 30% of its risk, uncovered all of it', () => {
    const o = golden('signals-coverage-lint')
    const changeOf = (out: Output) => scoreItems(out).find((i) => i.kind === 'change' && i.file === 'src/lib/format.ts')
    const withCoverage = (covered: number): Output => ({
      ...o,
      signals: { ...o.signals, coverage: { ...o.signals.coverage, files: o.signals.coverage.files.map((f) => (f.path === 'src/lib/format.ts' ? { ...f, changedExecutableLines: 10, coveredLines: covered, missingFromReport: false } : f)) } },
    })
    const none = changeOf(withCoverage(0))
    const full = changeOf(withCoverage(10))
    expect(none?.title).toContain('0% of changed lines covered')
    expect(full?.title).toContain('100% of changed lines covered')
    expect((full?.weight ?? 0) / (none?.weight ?? 1)).toBeCloseTo(0.3, 2)
    // Without a coverage report the risk stays whole (fail closed).
    const unverified = changeOf({ ...o, signals: { ...o.signals, coverage: { ...o.signals.coverage, status: 'not-provided', files: [] } } })
    expect(unverified?.weight).toBe(none?.weight)
    expect(scoreItems(o).every((i) => i.weight > 0 && i.weight < 1)).toBe(true)
  })

  it('groups items by file with the points each group is worth', () => {
    const groups = scoreGroups(scoreItems(golden('signals-coverage-lint')))
    expect(new Set(groups.map((g) => g.file)).size).toBe(groups.length)
    expect(groups.map((g) => g.points)).toEqual([...groups.map((g) => g.points)].sort((a, b) => b - a))
  })

  it('weighs a dependency change by how much its bump can break', () => {
    const o = golden('01-new-route')
    const change = (c: Partial<Output['dependencies']['changes'][number]>): Output['dependencies']['changes'][number] => ({ manifest: 'package.json', name: 'lib', section: 'dependencies', change: 'updated', from: '^1.0.0', to: '^1.1.0', bump: 'minor', direction: 'upgrade', critical: false, ...c })
    const weight = (c: Output['dependencies']['changes'][number]) => scoreItems({ ...o, dependencies: { ...o.dependencies, changes: [c] } }).find((i) => i.kind === 'dependency')?.weight
    expect(weight(change({}))).toBe(DEPENDENCY_WEIGHT.compatible)
    expect(weight(change({ from: '^0.37.0', to: '^0.39.1', critical: true, note: 'minor bump of a 0.x version is breaking' }))).toBe(DEPENDENCY_WEIGHT.mayBreak)
    expect(weight(change({ from: '^1.0.0', to: '^2.0.0', bump: 'major', critical: true }))).toBe(DEPENDENCY_WEIGHT.breaking)
    expect(weight(change({ change: 'removed', to: null, bump: null, direction: null, critical: true }))).toBe(DEPENDENCY_WEIGHT.breaking)
    expect(weight(change({ from: 'latest', to: 'next', bump: 'unknown', direction: null, critical: true }))).toBe(DEPENDENCY_WEIGHT.unknown)
  })

  it('splits findings off their file as parts of their own, with shares that add up to the score', () => {
    const o = golden('signals-coverage-lint')
    const at = { path: 'src/lib/format.ts', line: 9 }
    const out: Output = { ...o, signals: { ...o.signals, security: { ...o.signals.security, findings: [{ ...at, severity: 'high' as const, rule: 'bandit' as const, message: 'S608', text: 'q' }] } } }
    const { score, items } = mergeScore(out)
    const parts = reviewParts(items)
    expect(parts.reduce((n, p) => n + p.points, 0)).toBe(score)
    const finding = parts.find((p) => p.kind === 'finding' && p.items[0]?.kind === 'security')
    expect(finding).toMatchObject({ file: at.path, line: 9, must: true })
    const file = parts.find((p) => p.kind === 'file' && p.file === at.path)
    expect(file?.items.every((i) => i.kind !== 'security' && i.kind !== 'lint')).toBe(true)
    // The file's own points leave its findings out, in the verdict too.
    expect(computeVerdict(out).startHere.concat(computeVerdict(out).skim).find((f) => f.path === at.path)?.points).toBe(file?.own)
  })

  it('keeps a contract change and a vulnerable dependency as separate parts to check, in the comment too', () => {
    const o = golden('p10-contracts')
    const vulnerability = { package: 'lib', severity: 'high' as const, title: 'Prototype pollution', id: 'GHSA-1', url: null, cves: [], vulnerableRange: null, patchedVersions: null, relatedTo: ['lib'], kind: 'direct' as const }
    const out: Output = { ...o, signals: { ...o.signals, vulnerabilities: { ...o.signals.vulnerabilities, status: 'ok', related: [vulnerability] } } }
    const parts = reviewParts(mergeScore(out).items)
    expect([...new Set(parts.filter((p) => p.must).map((p) => p.kind))].sort()).toEqual(['contract', 'vulnerability'])
    const comment = renderReport(out)
    expect(comment).toContain('- [ ] Breaking API change')
    expect(comment).toContain('- [ ] Vulnerable dependency: high advisory on lib: Prototype pollution')
  })

  it('keeps half the risk of files left out of coverage on purpose instead of counting them as untested', () => {
    const o = golden('signals-coverage-lint')
    const path = 'src/lib/format.ts'
    const without: Output = { ...o, signals: { ...o.signals, coverage: { ...o.signals.coverage, files: o.signals.coverage.files.filter((f) => f.path !== path), excludedByProject: [path] } } }
    expect(fileCoverage(without).get(path)).toMatchObject({ factor: LEFT_OUT_RISK, ratio: null })
    const ignored: Output = { ...without, signals: { ...without.signals, coverage: { ...without.signals.coverage, excludedByProject: [], ignoredFiles: [path] } } }
    expect(fileCoverage(ignored).get(path)?.factor).toBe(LEFT_OUT_RISK)
  })

  it('counts a lint error on the line of a security finding once, and leaves out findings outside the project', () => {
    const o = golden('signals-coverage-lint')
    const at = { path: 'src/lib/format.ts', line: 9 }
    const withFindings = (role: Output['files'][number]['role']): Output => ({
      ...o,
      files: o.files.map((f) => (f.path === at.path ? { ...f, role } : f)),
      signals: {
        ...o.signals,
        security: { ...o.signals.security, findings: [{ ...at, severity: 'high', rule: 'bandit', message: 'S608: SQL built from strings', text: 'query = f"..."' }] },
        lint: { ...o.signals.lint, findings: [{ ...at, severity: 'error', rule: 'S608', message: 'SQL built from strings' }] },
      },
    })
    const kinds = (out: Output) => scoreItems(out).filter((i) => i.file === at.path && i.kind !== 'change').map((i) => i.kind)
    expect(kinds(withFindings('source'))).toEqual(['security'])
    expect(kinds(withFindings('excluded'))).toEqual([])
  })
})
