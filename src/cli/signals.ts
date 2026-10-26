import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { HELPER_EXTENSIONS, HELPER_LANGUAGES, type HelperLanguage } from '../config/languages.js'
import type { ChangedFile } from '../git/types.js'
import type { CoverageSignal, LintSignal, SecurityFinding, SecuritySignal, Signals, VulnerabilitiesSignal } from '../output/schema.js'
import { compareStrings } from '../output/order.js'
import { isCoveragePyReport, isPipAuditReport, isRuffReport, parseCoveragePyReport, parsePipAuditReport, parseRuffReport, pythonSuppressions } from '../signals/python.js'
import { goSuppressions, isGolangciReport, isGovulncheckReport, parseGoCoverProfile, parseGolangciReport, parseGovulncheckReport } from '../signals/go.js'
import { isDeclarationsOnlyModule, isScriptFile } from '../classify/declarations-only.js'
import { coverageSignal, listsUnloadedFiles, parseCoverageReport, ReportError } from '../signals/coverage.js'
import { coverageNotProvided, lintNotProvided, vulnerabilitiesNotProvided } from '../signals/index.js'
import { parseAuditReport, vulnerabilitiesSignal } from '../signals/audit.js'
import { securitySignal } from '../signals/security.js'
import { lintSignal, parseEslintReport } from '../signals/lint.js'
import { suppressionsSignal } from '../signals/suppressions.js'
import { testsModifiedSignal } from '../signals/tests-modified.js'
import { parseUsageFile, usageSignal, type Usage, type UsageInput } from '../signals/usage.js'
import type { Context } from './context.js'
import type { AnalysisRole } from '../classify/roles.js'

export interface SignalInputs {
  files: readonly ChangedFile[]
  roleOf: (path: string) => AnalysisRole | 'outside'
  /** Absolute path of the coverage report, if any was given. */
  coverage: string | undefined
  /** Absolute path of the ESLint report, if any was given. */
  eslint: string | undefined
  /** Head content of a repo-relative file. */
  readHead: (path: string) => string | undefined
  /** Whether a changed file is left out of coverage only. */
  coverageIgnored: (path: string) => boolean
  /** Absolute path of the npm/pnpm audit report, if any was given. */
  audit: string | undefined
  /** Packages this PR added or changed (vulnerabilities are matched against them). */
  changedPackages: ReadonlySet<string>
  /** Helper languages: the module path (Go coverprofile paths) and the comments of the changed files (suppressions). */
  lang?: { language: HelperLanguage; module: string; comments: readonly HelperComment[] }
}

type HelperComment = { file: string; line: number; text: string }

/** Suppressions each helper language reads from the comments of the changed files. */
const LANGUAGE_SUPPRESSIONS: Record<HelperLanguage, typeof goSuppressions> = { go: goSuppressions, python: pythonSuppressions }

type Read = { kind: 'missing'; message: string } | { kind: 'error'; message: string } | { kind: 'ok'; text: string }

function readReport(path: string | undefined, label: string, option: string): Read {
  if (path === undefined) return { kind: 'missing', message: `no ${label} report given (--${option} or signals.${option})` }
  if (!existsSync(path)) return { kind: 'missing', message: `${label} report not found at ${path}` }
  try {
    return { kind: 'ok', text: readFileSync(path, 'utf8') }
  } catch (error) {
    return { kind: 'error', message: `cannot read the ${label} report at ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Real path of an absolute report path that exists on disk; anything else unchanged. */
function canonical(path: string): string {
  if (!isAbsolute(path)) return path
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function asError(error: unknown): string {
  if (error instanceof ReportError) return error.message
  throw error
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const

/**
 * Go and Python static analysis: gosec issues (golangci-lint) or flake8-bandit findings (ruff) on added lines. Without
 * such a report nothing was verified for those files.
 */
function langSecurity(base: SecuritySignal, gosec: Omit<SecurityFinding, 'text'>[] | undefined, files: readonly ChangedFile[], readHead: (path: string) => string | undefined, skip: (path: string) => boolean, language: HelperLanguage): SecuritySignal {
  if (gosec === undefined) return { ...base, status: 'not-provided', message: HELPER_LANGUAGES[language].securityHint }
  const added = new Map(files.map((f) => [f.path, new Set(f.added.map((l) => l.line))]))
  const found = gosec
    .filter((g) => added.get(g.path)?.has(g.line) && !skip(g.path))
    .map((g) => ({ ...g, text: (readHead(g.path)?.split('\n')[g.line - 1] ?? '').trim().slice(0, 200) }))
  const findings = [...base.findings, ...found].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || compareStrings(a.path, b.path) || a.line - b.line)
  return { ...base, findings, summary: { high: findings.filter((f) => f.severity === 'high').length, medium: findings.filter((f) => f.severity === 'medium').length, low: findings.filter((f) => f.severity === 'low').length } }
}

/** Reads the reports produced by the workflow and computes every signal. Signals never change the class. */
export function computeSignals(ctx: Context, inputs: SignalInputs): Signals {
  let coverage: CoverageSignal
  const cov = readReport(inputs.coverage, 'coverage', 'coverage')
  if (cov.kind === 'missing') coverage = coverageNotProvided(cov.message)
  else if (cov.kind === 'error') coverage = { ...coverageNotProvided(cov.message), status: 'error' }
  else {
    try {
      const goProfile = inputs.lang !== undefined && cov.text.startsWith('mode:')
      const report = goProfile
        ? parseGoCoverProfile(cov.text, inputs.lang?.module ?? '', ctx.projectPrefix)
        : isCoveragePyReport(cov.text)
          ? parseCoveragePyReport(cov.text, ctx.repoRoot, ctx.projectPrefix, canonical)
          : parseCoverageReport(cov.text, ctx.repoRoot, ctx.projectPrefix, canonical)
      coverage = coverageSignal(report, inputs.files, inputs.roleOf, inputs.coverageIgnored, {
        missingIsExcluded: !goProfile && listsUnloadedFiles(report),
        declarationsOnly: (p) => isScriptFile(p) && isDeclarationsOnlyModule(p, inputs.readHead(p) ?? 'x('),
      })
    } catch (error) {
      coverage = { ...coverageNotProvided(asError(error)), status: 'error' }
    }
  }

  let lint: LintSignal
  let gosec: Omit<SecurityFinding, 'text'>[] | undefined
  const es = readReport(inputs.eslint, inputs.lang ? HELPER_LANGUAGES[inputs.lang.language].lintTool : 'ESLint', 'eslint')
  if (es.kind === 'missing') lint = lintNotProvided(es.message)
  else if (es.kind === 'error') lint = { ...lintNotProvided(es.message), status: 'error' }
  else {
    try {
      if (isGolangciReport(es.text)) {
        const parsed = parseGolangciReport(es.text, ctx.repoRoot, ctx.projectPrefix, canonical)
        gosec = parsed.gosec
        lint = lintSignal(parsed.messages, inputs.files)
      } else if (isRuffReport(es.text)) {
        const parsed = parseRuffReport(es.text, ctx.repoRoot, ctx.projectPrefix, canonical)
        gosec = parsed.sast
        lint = lintSignal(parsed.messages, inputs.files)
      } else lint = lintSignal(parseEslintReport(es.text, ctx.repoRoot, ctx.projectPrefix, canonical), inputs.files)
    } catch (error) {
      lint = { ...lintNotProvided(asError(error)), status: 'error' }
    }
  }

  let vulnerabilities: VulnerabilitiesSignal
  const au = readReport(inputs.audit, 'audit', 'audit')
  if (au.kind === 'missing') vulnerabilities = vulnerabilitiesNotProvided(au.message)
  else if (au.kind === 'error') vulnerabilities = { ...vulnerabilitiesNotProvided(au.message), status: 'error' }
  else {
    try {
      const report = isGovulncheckReport(au.text) ? parseGovulncheckReport(au.text) : isPipAuditReport(au.text) ? parsePipAuditReport(au.text) : parseAuditReport(au.text)
      vulnerabilities = vulnerabilitiesSignal(report, inputs.changedPackages)
    } catch (error) {
      vulnerabilities = { ...vulnerabilitiesNotProvided(asError(error)), status: 'error' }
    }
  }

  const notCode = (path: string): boolean => {
    const role = inputs.roleOf(path)
    return role === 'test' || role === 'story' || role === 'excluded'
  }
  // The TypeScript readers never see code of a helper language: its suppressions come from the helper's comments, its
  // static analysis from the language's linter (gosec through golangci-lint, flake8-bandit through ruff's S rules).
  const scripts = inputs.files.filter((f) => !HELPER_EXTENSIONS.some((e) => f.path.endsWith(e)))
  const suppressions = suppressionsSignal(scripts, inputs.readHead)
  let security = securitySignal(scripts, inputs.readHead, notCode)
  if (inputs.lang) {
    const own = LANGUAGE_SUPPRESSIONS[inputs.lang.language](inputs.files, inputs.lang.comments)
    suppressions.items = [...suppressions.items, ...own].sort((a, b) => compareStrings(a.path, b.path) || a.line - b.line)
    security = langSecurity(security, gosec, inputs.files, inputs.readHead, notCode, inputs.lang.language)
  }
  return { coverage, lint, security, vulnerabilities, suppressions, testsModified: testsModifiedSignal(inputs.files, inputs.roleOf) }
}

/** Traffic of the affected entry points from a usage report; undefined when none was given (the section is optional). */
export function computeUsage(path: string | undefined, input: UsageInput): Usage | undefined {
  if (path === undefined) return undefined
  const kind = input.surface === 'frontend' ? 'pages' : 'operations'
  const failed = (message: string): Usage => ({ status: 'error', message, source: '', from: '', to: '', kind, total: 0, matched: 0, affectedHits: 0, totalIssues: 0, matchedIssues: 0, affectedIssues: 0, entries: [], files: [], callers: [] })
  const read = readReport(path, 'usage', 'usage')
  if (read.kind !== 'ok') return failed(read.message)
  try {
    return usageSignal(parseUsageFile(read.text), input)
  } catch (error) {
    return failed(asError(error))
  }
}
