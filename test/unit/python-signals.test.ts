import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../../src/git/types.js'
import { isCoveragePyReport, isPipAuditReport, isRuffReport, parseCoveragePyReport, parsePipAuditReport, parseRuffReport, pythonSuppressions } from '../../src/signals/python.js'

const changed = (path: string, lines: number[]): ChangedFile => ({ path, status: 'modified', added: lines.map((line) => ({ line, text: '' })), removed: [] }) as unknown as ChangedFile

describe('Python reports', () => {
  it('reads coverage.py JSON (paths relative to the project directory)', () => {
    const text = JSON.stringify({ meta: { version: '7' }, files: { 'src/a.py': { executed_lines: [1, 2], missing_lines: [3] } } })
    expect(isCoveragePyReport(text)).toBe(true)
    expect(parseCoveragePyReport(text, '/repo', 'svc').get('svc/src/a.py')).toEqual([
      { start: 1, end: 1, count: 1, onLoad: true },
      { start: 2, end: 2, count: 1, onLoad: true },
      { start: 3, end: 3, count: 0, onLoad: true },
    ])
  })

  it('reads ruff JSON, with flake8-bandit rules as security findings', () => {
    const text = JSON.stringify([
      { code: 'F401', message: 'unused import', filename: '/repo/src/a.py', location: { row: 1, column: 1 } },
      { code: 'S608', message: 'Possible SQL injection', filename: '/repo/src/a.py', location: { row: 9, column: 1 } },
    ])
    expect(isRuffReport(text)).toBe(true)
    const { messages, sast } = parseRuffReport(text, '/repo', '')
    expect(messages.map((m) => [m.path, m.line, m.rule])).toEqual([
      ['src/a.py', 1, 'F401'],
      ['src/a.py', 9, 'S608'],
    ])
    expect(sast).toEqual([{ path: 'src/a.py', line: 9, rule: 'bandit', severity: 'high', message: 'S608: Possible SQL injection' }])
  })

  it('reads pip-audit JSON once per package and advisory', () => {
    const vuln = { id: 'PYSEC-2026-1', fix_versions: ['2.0'], aliases: ['CVE-2026-9'], description: 'Bad thing\nmore' }
    const text = JSON.stringify({ dependencies: [{ name: 'Some_Pkg', version: '1.0', vulns: [vuln, vuln] }, { name: 'ok', version: '1', vulns: [] }] })
    expect(isPipAuditReport(text)).toBe(true)
    expect(parsePipAuditReport(text).advisories).toEqual([
      { package: 'some-pkg', severity: 'moderate', title: 'Bad thing', id: 'PYSEC-2026-1', url: 'https://osv.dev/vulnerability/PYSEC-2026-1', cves: ['CVE-2026-9'], vulnerableRange: '1.0', patchedVersions: '2.0', paths: [] },
    ])
  })

  it('finds suppression comments on added lines', () => {
    const comments = [
      { file: 'a.py', line: 1, text: '# noqa: E402' },
      { file: 'a.py', line: 2, text: '# type: ignore[attr-defined]' },
      { file: 'a.py', line: 3, text: '# pragma: no cover' },
      { file: 'a.py', line: 4, text: '# nosec B608' },
      { file: 'a.py', line: 5, text: '# noqa' },
    ]
    expect(pythonSuppressions([changed('a.py', [1, 2, 3, 4])], comments).map((i) => i.kind)).toEqual(['noqa', 'type-ignore', 'no-cover', 'nosec'])
  })
})
