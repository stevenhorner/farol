import { z } from 'zod'
import type { ChangedFile } from '../git/types.js'
import { compareStrings } from '../output/order.js'
import type { SecurityFinding, SuppressionsSignal } from '../output/schema.js'
import type { Advisory } from './audit.js'
import { ReportError } from './coverage.js'
import type { LintMessage } from './lint.js'
import { reportPathToRepo } from './paths.js'

type Statements = { start: number; end: number; count: number; onLoad?: true }[]

function json(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ReportError(`the ${label} report is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

const CoveragePy = z.object({
  meta: z.object({}).loose(),
  files: z.record(z.string(), z.object({ executed_lines: z.array(z.number().int()), missing_lines: z.array(z.number().int()) }).loose()),
})

/** Whether a coverage report is coverage.py JSON (`coverage json`, `pytest --cov-report=json`). */
export function isCoveragePyReport(text: string): boolean {
  return text.includes('"executed_lines"') && text.includes('"missing_lines"')
}

/** coverage.py JSON: executed lines are covered statements, missing lines uncovered ones. */
export function parseCoveragePyReport(text: string, repoRoot: string, projectPrefix: string, canonical?: (path: string) => string): Map<string, Statements> {
  const parsed = CoveragePy.safeParse(json(text, 'coverage'))
  if (!parsed.success) throw new ReportError('the coverage report is not coverage.py JSON (coverage json)')
  const result = new Map<string, Statements>()
  for (const [file, entry] of Object.entries(parsed.data.files)) {
    const path = reportPathToRepo(file, repoRoot, projectPrefix, canonical)
    if (path === undefined) continue
    // A Python module that loads runs its import and def lines: a file where no line ran was never imported, so every
    // line counts as one that runs on load (see listsUnloadedFiles).
    result.set(path, [...entry.executed_lines.map((l) => ({ start: l, end: l, count: 1, onLoad: true as const })), ...entry.missing_lines.map((l) => ({ start: l, end: l, count: 0, onLoad: true as const }))])
  }
  return result
}

const Ruff = z.array(z.object({ code: z.string().nullable(), message: z.string(), filename: z.string(), location: z.object({ row: z.number().int() }).loose() }).loose())

/** Whether a lint report is `ruff check --output-format json` output. */
export function isRuffReport(text: string): boolean {
  return text.trimStart().startsWith('[') && text.includes('"location"') && text.includes('"filename"')
}

// flake8-bandit rules (ruff S…) with the worst consequences: credentials, injection, unsafe deserialization, TLS off.
const RUFF_HIGH = new Set(['S105', 'S106', 'S107', 'S301', 'S307', 'S501', 'S602', 'S604', 'S605', 'S608'])

/** ruff findings as lint messages; flake8-bandit (S…) findings are security findings too. */
export function parseRuffReport(text: string, repoRoot: string, projectPrefix: string, canonical?: (path: string) => string): { messages: LintMessage[]; sast: Omit<SecurityFinding, 'text'>[] } {
  const parsed = Ruff.safeParse(json(text, 'ruff'))
  if (!parsed.success) throw new ReportError('the lint report is not ruff JSON output (ruff check --output-format json)')
  const messages: LintMessage[] = []
  const sast: Omit<SecurityFinding, 'text'>[] = []
  for (const f of parsed.data) {
    const path = reportPathToRepo(f.filename, repoRoot, projectPrefix, canonical) ?? f.filename
    const rule = f.code ?? '(syntax)'
    messages.push({ path, line: f.location.row, rule, severity: 'error', message: f.message })
    if (/^S\d{3}$/.test(rule)) sast.push({ path, line: f.location.row, rule: 'bandit', severity: RUFF_HIGH.has(rule) ? 'high' : 'medium', message: `${rule}: ${f.message}` })
  }
  return { messages, sast }
}

const PipAudit = z.object({
  dependencies: z.array(z.object({ name: z.string(), version: z.string().optional(), vulns: z.array(z.object({ id: z.string(), fix_versions: z.array(z.string()).optional(), aliases: z.array(z.string()).optional(), description: z.string().optional() }).loose()).optional() }).loose()),
}).loose()

/** Whether an audit report is `pip-audit --format json` output. */
export function isPipAuditReport(text: string): boolean {
  return text.includes('"dependencies"') && text.includes('"vulns"')
}

/** pip-audit findings as advisories (pip-audit gives no severity: every advisory counts as moderate). */
export function parsePipAuditReport(text: string): { advisories: Advisory[]; dependsOn: Map<string, string[]> } {
  const parsed = PipAudit.safeParse(json(text, 'pip-audit'))
  if (!parsed.success) throw new ReportError('the audit report is not pip-audit JSON output (pip-audit --format json)')
  const advisories: Advisory[] = []
  const seen = new Set<string>()
  for (const dep of parsed.data.dependencies) {
    for (const v of dep.vulns ?? []) {
      if (seen.has(`${dep.name}\0${v.id}`)) continue
      seen.add(`${dep.name}\0${v.id}`)
      advisories.push({
        package: normalizeName(dep.name),
        severity: 'moderate',
        title: (v.description ?? v.id).split('\n')[0]?.slice(0, 200) ?? v.id,
        id: v.id,
        url: v.id.startsWith('PYSEC') || v.id.startsWith('GHSA') ? `https://osv.dev/vulnerability/${v.id}` : null,
        cves: [v.id, ...(v.aliases ?? [])].filter((a) => a.startsWith('CVE-')),
        vulnerableRange: dep.version ?? null,
        patchedVersions: v.fix_versions && v.fix_versions.length > 0 ? v.fix_versions.join(', ') : null,
        paths: [],
      })
    }
  }
  return { advisories: advisories.sort((a, b) => compareStrings(a.package, b.package) || compareStrings(a.id, b.id)), dependsOn: new Map() }
}

/** PEP 503 name normalization: `Foo_Bar.baz` and `foo-bar-baz` are the same distribution. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

const DIRECTIVES: [RegExp, SuppressionsSignal['items'][number]['kind']][] = [
  [/#\s*noqa\b/i, 'noqa'],
  [/#\s*type:\s*ignore\b/, 'type-ignore'],
  [/#\s*nosec\b/, 'nosec'],
  [/#\s*pragma:\s*no\s*cover\b/, 'no-cover'],
  [/#\s*pyright:\s*ignore\b/, 'pyright-ignore'],
  [/#\s*pylint:\s*disable\b/, 'pylint-disable'],
]

/** Suppression comments (`# noqa`, `# type: ignore`, `# nosec`, `# pragma: no cover`…) on lines a PR adds. */
export function pythonSuppressions(files: readonly ChangedFile[], comments: readonly { file: string; line: number; text: string }[]): SuppressionsSignal['items'] {
  const added = new Map(files.map((f) => [f.path, new Set(f.added.map((l) => l.line))]))
  const items: SuppressionsSignal['items'] = []
  for (const c of comments) {
    if (!added.get(c.file)?.has(c.line)) continue
    for (const [pattern, kind] of DIRECTIVES) if (pattern.test(c.text)) items.push({ path: c.file, line: c.line, kind, text: c.text.slice(0, 200) })
  }
  return items.sort((a, b) => compareStrings(a.path, b.path) || a.line - b.line)
}
