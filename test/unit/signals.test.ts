import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../../src/git/types.js'
import { coverageSignal, listsUnloadedFiles, parseCoverageReport, ReportError } from '../../src/signals/coverage.js'
import { lintSignal, parseEslintReport } from '../../src/signals/lint.js'
import { reportPathToRepo, toRanges } from '../../src/signals/paths.js'
import { testsModifiedSignal } from '../../src/signals/tests-modified.js'

const changed = (path: string, lines: number[], status: ChangedFile['status'] = 'modified'): ChangedFile => ({
  path,
  status,
  added: lines.map((line) => ({ line, text: '' })),
  removed: [],
  binary: false,
})

describe('paths and ranges', () => {
  it('groups contiguous lines', () => {
    expect(toRanges([5, 1, 2, 3, 9, 10, 2])).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
      { start: 9, end: 10 },
    ])
  })

  it('maps report paths to repo paths', () => {
    expect(reportPathToRepo('/repo/apps/web/src/a.ts', '/repo', 'apps/web')).toBe('apps/web/src/a.ts')
    expect(reportPathToRepo('src/a.ts', '/repo', 'apps/web')).toBe('apps/web/src/a.ts')
    expect(reportPathToRepo('C:\\repo\\src\\a.ts', 'C:/repo', '')).toBe('src/a.ts')
    expect(reportPathToRepo('/elsewhere/a.ts', '/repo', '')).toBeUndefined()
  })
})

describe('coverage', () => {
  const report = parseCoverageReport(
    JSON.stringify({
      '/repo/src/a.ts': {
        path: '/repo/src/a.ts',
        statementMap: { '0': { start: { line: 1 }, end: { line: 3 } }, '1': { start: { line: 2 }, end: { line: 2 } }, '2': { start: { line: 5 }, end: { line: 5 } } },
        s: { '0': 1, '1': 0, '2': 4 },
      },
    }),
    '/repo',
    '',
  )

  it('needs every intersecting statement to have run', () => {
    const s = coverageSignal(report, [changed('src/a.ts', [1, 2, 4, 5])], () => 'source')
    expect(s.files).toEqual([{ path: 'src/a.ts', changedExecutableLines: 3, coveredLines: 2, uncovered: [{ start: 2, end: 2 }], missingFromReport: false }])
  })

  it('only counts added/modified source code files', () => {
    const files = [changed('src/a.ts', [1], 'renamed'), changed('src/b.css', [1]), changed('src/c.test.ts', [1]), changed('src/d.d.ts', [1])]
    expect(coverageSignal(report, files, (p) => (p.includes('.test.') ? 'test' : 'source')).files).toEqual([])
  })

  it('leaves out files the project excludes from coverage, and does not count declarations-only files as untested', () => {
    const files = [changed('src/a.ts', [1, 2]), changed('src/types.ts', [1, 2, 3]), changed('src/gen.ts', [1, 2])]
    const missing = coverageSignal(report, files, () => 'source', () => false, { declarationsOnly: (p) => p === 'src/types.ts' })
    expect(missing.files.map((f) => [f.path, f.changedExecutableLines, f.missingFromReport])).toEqual([['src/a.ts', 2, false], ['src/gen.ts', 2, true], ['src/types.ts', 0, false]])
    const excluded = coverageSignal(report, files, () => 'source', () => false, { missingIsExcluded: true, declarationsOnly: (p) => p === 'src/types.ts' })
    expect(excluded.excludedByProject).toEqual(['src/gen.ts'])
    expect(excluded.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/types.ts'])
  })

  it('tells a report that lists files no test loaded from one that only lists loaded files', () => {
    expect(listsUnloadedFiles(report)).toBe(false)
    // Nothing ran, not even code that runs on load: the module never loaded, so the report lists unloaded files.
    expect(listsUnloadedFiles(new Map([...report, ['src/never.ts', [{ start: 1, end: 1, count: 0, onLoad: true }]]]))).toBe(true)
    // A module that loaded but whose functions never ran, and an empty module (an __init__.py), prove nothing.
    expect(listsUnloadedFiles(new Map([...report, ['src/idle.ts', [{ start: 2, end: 2, count: 0 }]]]))).toBe(false)
    expect(listsUnloadedFiles(new Map([...report, ['src/empty.ts', []]]))).toBe(false)
  })

  it('marks Istanbul statements outside every function as running on load', () => {
    const parsed = parseCoverageReport(
      JSON.stringify({ '/repo/src/b.ts': { path: '/repo/src/b.ts', statementMap: { '0': { start: { line: 1 }, end: { line: 1 } }, '1': { start: { line: 3 }, end: { line: 3 } } }, s: { '0': 0, '1': 0 }, fnMap: { '0': { loc: { start: { line: 2 }, end: { line: 4 } } } } } }),
      '/repo',
      '',
    )
    expect(parsed.get('src/b.ts')?.map((x) => x.onLoad ?? false)).toEqual([true, false])
    // Vitest's v8 provider: a file it never loaded is one "(empty-report)" function over the whole file.
    const vitest = parseCoverageReport(
      JSON.stringify({ '/repo/src/c.ts': { path: '/repo/src/c.ts', statementMap: { '0': { start: { line: 2 }, end: { line: 2 } } }, s: { '0': 0 }, fnMap: { '0': { name: '(empty-report)', loc: { start: { line: 1 }, end: { line: 9 } } } } } }),
      '/repo',
      '',
    )
    expect(listsUnloadedFiles(vitest)).toBe(true)
  })

  it('rejects files that are not Istanbul JSON', () => {
    expect(() => parseCoverageReport('[1]', '/repo', '')).toThrow(ReportError)
    expect(() => parseCoverageReport('nope', '/repo', '')).toThrow(/not valid JSON/)
  })
})

describe('lint', () => {
  it('caps findings at 50 and counts the rest', () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ ruleId: 'r', severity: i % 2 === 0 ? 2 : 1, message: 'm', line: i + 1 }))
    const parsed = parseEslintReport(JSON.stringify([{ filePath: '/repo/src/a.ts', messages }]), '/repo', '')
    const s = lintSignal(parsed, [changed('src/a.ts', Array.from({ length: 60 }, (_, i) => i + 1))])
    expect(s.changedLines).toEqual({ errors: 30, warnings: 30 })
    expect(s.findings).toHaveLength(50)
    expect(s.omittedFindings).toBe(10)
    expect(s.findings[0]?.severity).toBe('error')
    expect(s.findings[49]?.severity).toBe('warning')
  })

  it('names fatal parse errors', () => {
    const parsed = parseEslintReport(JSON.stringify([{ filePath: '/repo/a.ts', messages: [{ ruleId: null, fatal: true, severity: 2, message: 'Parsing error', line: 1 }] }]), '/repo', '')
    expect(parsed[0]?.rule).toBe('(fatal)')
  })
})

describe('tests modified', () => {
  it('lists modified, deleted and renamed tests, not new ones', () => {
    const files: ChangedFile[] = [
      { ...changed('src/a.test.ts', [], 'modified'), removed: [{ line: 1, text: '' }] },
      changed('src/b.test.ts', [], 'added'),
      changed('src/c.test.ts', [], 'deleted'),
      { ...changed('src/e.test.ts', [], 'renamed'), oldPath: 'src/d.test.ts' },
    ]
    expect(testsModifiedSignal(files, (p) => (p.endsWith('.test.ts') ? 'test' : 'source')).files).toEqual([
      { path: 'src/a.test.ts', status: 'modified', linesRemoved: 1 },
      { path: 'src/c.test.ts', status: 'deleted', linesRemoved: 0 },
      { path: 'src/e.test.ts', oldPath: 'src/d.test.ts', status: 'renamed', linesRemoved: 0 },
    ])
  })
})
